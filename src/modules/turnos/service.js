'use strict'

/**
 * Servicio de turnos — Lógica central del sistema.
 *
 * FUNCIÓN PRINCIPAL: llamarSiguiente()
 *   Ejecuta todo en UNA transacción atómica:
 *   1. Finaliza el turno anterior de la mesa (si existe)
 *   2. Obtiene el siguiente número del lote con FOR UPDATE (anti race-condition)
 *   3. Crea el nuevo turno en estado 'en_atencion'
 *   4. Avanza el contador del lote
 *   5. Emite alerta si el lote se agotó
 *   6. Retorna datos para broadcast WS
 */

/**
 * Llamar siguiente turno — 1 clic, 1 transacción.
 *
 * @param {object} fastify
 * @param {object} opts
 * @param {number} opts.mesaId
 * @param {number} opts.operadorId
 * @returns {object} Datos del turno creado
 */
async function llamarSiguiente (fastify, { mesaId, operadorId }) {
  const client = await fastify.db.connect()

  try {
    await client.query('BEGIN')

    // ── Paso 1: Verificar que la mesa existe y está activa ─────────────────
    const { rows: [mesa] } = await client.query(
      `SELECT id, numero, nombre, estado, operador_id
       FROM mesas WHERE id = $1`,
      [mesaId]
    )

    if (!mesa) {
      throw Object.assign(new Error('Mesa no encontrada'), { statusCode: 404 })
    }
    if (mesa.estado !== 'activa') {
      throw Object.assign(new Error(`Mesa en estado "${mesa.estado}". Solo mesas activas pueden llamar.`), { statusCode: 409 })
    }
    if (mesa.operador_id !== operadorId) {
      throw Object.assign(new Error('Esta mesa no te está asignada'), { statusCode: 403 })
    }

    // ── Paso 2: Obtener y bloquear el lote activo (FOR UPDATE) ────────────
    // Este bloqueo a nivel de fila es la PRIMERA y PRINCIPAL defensa
    // contra race conditions. Solo una transacción puede estar aquí a la vez.
    const { rows: [lote] } = await client.query(
      `SELECT id, numero_lote, numero_desde, numero_hasta, ultimo_numero_llamado, estado
       FROM lotes_voucher
       WHERE estado = 'activo'
       FOR UPDATE`,   // ← mutex de fila: garantiza orden serial
    )

    if (!lote) {
      throw Object.assign(new Error('No hay un lote activo. El admin debe activar un lote antes de llamar turnos.'), { statusCode: 409 })
    }

    // ── Paso 3: Verificar que el lote no está agotado ─────────────────────
    if (lote.ultimo_numero_llamado >= lote.numero_hasta) {
      await client.query('ROLLBACK')

      // Marcar lote como agotado (si no lo está ya)
      await fastify.db.query(
        `UPDATE lotes_voucher SET estado = 'agotado', fecha_cierre = NOW()
         WHERE id = $1 AND estado = 'activo'`,
        [lote.id]
      )

      await fastify.broadcast('admin:all', 'lote_agotado', {
        lote_id:     lote.id,
        numero_lote: lote.numero_lote,
        numero_hasta: lote.numero_hasta
      })

      throw Object.assign(new Error('El lote de vouchers se ha agotado. El admin debe extenderlo o crear uno nuevo.'), { statusCode: 409 })
    }

    const nuevoNumero = lote.ultimo_numero_llamado + 1

    // ── Paso 4: Finalizar turno anterior de esta mesa (si existe) ─────────
    await client.query(
      `UPDATE turnos SET estado = 'atendido'
       WHERE mesa_id = $1 AND estado = 'en_atencion'`,
      [mesaId]
    )
    // El trigger fn_calcular_duraciones_turno se dispara aquí automáticamente

    // ── Paso 5: Avanzar el contador del lote ──────────────────────────────
    await client.query(
      `UPDATE lotes_voucher
       SET ultimo_numero_llamado = $1
       WHERE id = $2`,
      [nuevoNumero, lote.id]
    )

    // ── Paso 6: Crear el nuevo turno ──────────────────────────────────────
    // En el flujo voucher_fisico los turnos nacen directamente en 'en_atencion'
    const { rows: [turnoNuevo] } = await client.query(
      `INSERT INTO turnos
         (numero, lote_id, estado, origen, mesa_id, operador_id, llamado_en)
       VALUES
         ($1, $2, 'en_atencion', 'voucher_fisico', $3, $4, NOW())
       RETURNING id, numero, llamado_en`,
      [nuevoNumero, lote.id, mesaId, operadorId]
    )
    // El trigger fn_audit_turno se dispara aquí automáticamente (TURNO_LLAMADO)

    await client.query('COMMIT')

    // ── Paso 7: Verificar si se agotó el lote tras este llamado ───────────
    const vouchersRestantes = lote.numero_hasta - nuevoNumero
    const umbralAlerta = parseInt(
      (await fastify.db.query(
        `SELECT valor FROM configuracion WHERE clave = 'alerta_vouchers_restantes'`
      )).rows[0]?.valor || '20'
    )

    if (nuevoNumero >= lote.numero_hasta) {
      // Lote completamente agotado
      await fastify.db.query(
        `UPDATE lotes_voucher SET estado = 'agotado', fecha_cierre = NOW() WHERE id = $1`,
        [lote.id]
      )
      await fastify.broadcast('admin:all', 'lote_agotado', {
        lote_id:          lote.id,
        numero_lote:      lote.numero_lote,
        numero_hasta:     lote.numero_hasta,
        ultimo_llamado:   nuevoNumero
      })
    } else if (vouchersRestantes <= umbralAlerta) {
      // Alerta de vouchers bajos (RF-LOTE-07)
      await fastify.broadcast('admin:all', 'lote_alerta_vouchers', {
        lote_id:           lote.id,
        numero_lote:       lote.numero_lote,
        vouchers_restantes: vouchersRestantes,
        numero_hasta:      lote.numero_hasta
      })
    }

    return {
      turno: {
        id:          turnoNuevo.id,
        numero:      turnoNuevo.numero,
        llamado_en:  turnoNuevo.llamado_en,
        mesa_id:     mesaId,
        mesa_numero: mesa.numero,
        mesa_nombre: mesa.nombre,
        lote_numero: lote.numero_lote
      },
      vouchers_restantes: vouchersRestantes,
      proximo_numero:     nuevoNumero + 1 <= lote.numero_hasta ? nuevoNumero + 1 : null
    }

  } catch (err) {
    // Solo hacer ROLLBACK si la transacción no fue commiteada ni revertida ya
    try { await client.query('ROLLBACK') } catch (_) {}
    throw err
  } finally {
    client.release()
  }
}

/**
 * Cancelar turno — "No se presentó" (RF-TURN-05)
 */
async function cancelarTurno (fastify, { turnoId, operadorId, mesaId }) {
  const { rows } = await fastify.db.query(
    `UPDATE turnos
     SET estado = 'cancelado'
     WHERE id = $1 AND mesa_id = $2 AND estado = 'en_atencion'
     RETURNING id, numero, lote_id`,
    [turnoId, mesaId]
  )

  if (rows.length === 0) {
    throw Object.assign(
      new Error('Turno no encontrado o no está en atención en esta mesa'),
      { statusCode: 404 }
    )
  }

  return rows[0]
}

/**
 * Generar turno para kiosko web (RF-GEN-02)
 * Crea un turno en estado 'esperando' cuando el módulo kiosko está activo.
 */
async function generarTurnoKiosko (fastify, { ip }) {
  // Verificar que el módulo kiosko está activo
  const { rows: [cfg] } = await fastify.db.query(
    `SELECT valor FROM configuracion WHERE clave = 'kiosko_web_activo'`
  )

  if (cfg?.valor !== 'true') {
    throw Object.assign(new Error('El módulo kiosko no está activo'), { statusCode: 503 })
  }

  const client = await fastify.db.connect()

  try {
    await client.query('BEGIN')

    // Obtener lote activo con lock
    const { rows: [lote] } = await client.query(
      `SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado
       FROM lotes_voucher WHERE estado = 'activo' FOR UPDATE`
    )

    if (!lote) {
      throw Object.assign(new Error('No hay lote activo'), { statusCode: 409 })
    }

    if (lote.ultimo_numero_llamado >= lote.numero_hasta) {
      throw Object.assign(new Error('Lote agotado'), { statusCode: 409 })
    }

    const nuevoNumero = lote.ultimo_numero_llamado + 1

    await client.query(
      `UPDATE lotes_voucher SET ultimo_numero_llamado = $1 WHERE id = $2`,
      [nuevoNumero, lote.id]
    )

    const token = require('crypto').randomBytes(32).toString('hex')

    const { rows: [turno] } = await client.query(
      `INSERT INTO turnos (numero, lote_id, estado, origen, token_consulta)
       VALUES ($1, $2, 'esperando', 'kiosko_web', $3)
       RETURNING id, numero, token_consulta, creado_en`,
      [nuevoNumero, lote.id, token]
    )

    await client.query('COMMIT')

    return {
      numero:         turno.numero,
      token:          turno.token_consulta,
      creado_en:      turno.creado_en,
      lote_numero:    lote.numero_lote,
      posicion_en_cola: nuevoNumero - lote.ultimo_numero_llamado // aprox
    }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw err
  } finally {
    client.release()
  }
}

/**
 * Consultar posición en cola por token (RF-GEN-03)
 */
async function consultarMiTurno (fastify, { token }) {
  const { rows: [turno] } = await fastify.db.query(
    `SELECT t.id, t.numero, t.estado, t.llamado_en, t.creado_en,
            lv.ultimo_numero_llamado,
            m.nombre AS mesa_nombre
     FROM turnos t
     JOIN lotes_voucher lv ON t.lote_id = lv.id
     LEFT JOIN mesas m ON t.mesa_id = m.id
     WHERE t.token_consulta = $1`,
    [token]
  )

  if (!turno) {
    throw Object.assign(new Error('Turno no encontrado'), { statusCode: 404 })
  }

  const posicion = Math.max(0, turno.numero - turno.ultimo_numero_llamado)

  return {
    numero:     turno.numero,
    estado:     turno.estado,
    posicion:   posicion,
    llamado_en: turno.llamado_en,
    mesa:       turno.mesa_nombre
  }
}

module.exports = { llamarSiguiente, cancelarTurno, generarTurnoKiosko, consultarMiTurno }
