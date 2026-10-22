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

// Cache de umbral de alerta (TTL 5 min) — evita una query extra en cada llamado
let _alertaUmbralCache = null
let _alertaUmbralExpira = 0
const ALERTA_CACHE_TTL_MS = 5 * 60 * 1000

async function _getAlertaUmbral (fastify) {
  if (_alertaUmbralCache !== null && Date.now() < _alertaUmbralExpira) {
    return _alertaUmbralCache
  }
  const { rows: [cfg] } = await fastify.db.query(
    `SELECT valor FROM configuracion WHERE clave = 'alerta_vouchers_restantes' LIMIT 1`
  )
  _alertaUmbralCache = parseInt(cfg?.valor || '20', 10)
  _alertaUmbralExpira = Date.now() + ALERTA_CACHE_TTL_MS
  return _alertaUmbralCache
}
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
  try {
    const { rows } = await fastify.db.query(
      `SELECT * FROM fn_llamar_siguiente($1, $2)`,
      [mesaId, operadorId]
    )

    const r = rows[0]
    if (!r) {
      throw Object.assign(new Error('Error inesperado al llamar turno'), { statusCode: 500 })
    }

    return {
      turno: {
        id:          r.turno_id,
        numero:      r.turno_numero,
        llamado_en:  r.llamado_en,
        mesa_id:     r.mesa_id,
        mesa_numero: r.mesa_numero,
        mesa_nombre: r.mesa_nombre,
        lote_numero: r.lote_numero,
        origen:      r.modo || 'voucher_fisico'
      },
      vouchers_restantes: r.vouchers_restantes,
      proximo_numero:     r.proximo_numero,
      es_idempotente:     r.es_idempotente,
      es_lote_agotado:    Boolean(r.es_lote_agotado),
      lote_id:            r.lote_id,
      lote_numero:        r.lote_numero,
      numero_hasta:       r.numero_hasta,
      ultimo_llamado:     r.ultimo_llamado,
      modo:               r.modo || 'voucher_fisico'
    }
  } catch (err) {
    const msg = err.message || ''
    if (msg.includes('no encontrada')) {
      throw Object.assign(new Error(msg), { statusCode: 404, codigo: 'mesa_no_encontrada' })
    }
    if (msg.includes('no te esta asignada') || msg.includes('no te está asignada')) {
      throw Object.assign(new Error(msg), { statusCode: 403, codigo: 'mesa_no_asignada' })
    }
    if (msg.includes('No hay turnos en espera')) {
      throw Object.assign(new Error('No hay turnos en espera en este momento.'), { statusCode: 409, codigo: 'sin_turnos_en_espera' })
    }
    if (err.code === '23505' || msg.includes('ux_turnos_lote_numero')) {
      throw Object.assign(
        new Error('Conflicto con la numeración del lote: el número de turno ya existe en la base de datos. Verifique el contador del lote en Configuración.'),
        { statusCode: 409, codigo: 'turno_duplicado_lote' }
      )
    }
    if (err.code === '23505' || msg.includes('ux_turnos_kiosko_dia_numero')) {
      throw Object.assign(
        new Error('Conflicto con la numeración de kiosko: el turno ya fue emitido hoy.'),
        { statusCode: 409, codigo: 'turno_duplicado_kiosko' }
      )
    }
    if (msg.includes('Solo mesas activas') || msg.includes('lote activo') || msg.includes('agotado')) {
      throw Object.assign(new Error(msg), { statusCode: 409, codigo: 'lote_o_mesa_invalida' })
    }
    throw err
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
     RETURNING id, numero, lote_id, token_consulta`,
    [turnoId, mesaId]
  )

  if (rows.length === 0) {
    throw Object.assign(
      new Error('Turno no encontrado o no está en atención en esta mesa'),
      { statusCode: 404, codigo: 'turno_no_encontrado' }
    )
  }

  return rows[0]
}

/**
 * Obtener turnos rezagados (cancelados) de la jornada actual
 */
async function obtenerRezagados (fastify) {
  const { rows } = await fastify.db.query(
    `SELECT t.id, t.numero, t.estado, t.origen, t.llamado_en, t.finalizado_en,
            t.mesa_id, m.numero AS mesa_numero, m.nombre AS mesa_nombre,
            t.operador_id, u.nombre_completo AS operador_nombre
     FROM turnos t
     LEFT JOIN mesas m ON t.mesa_id = m.id
     LEFT JOIN usuarios u ON t.operador_id = u.id
     WHERE t.estado = 'cancelado'
       AND t.fecha_turno = fn_fecha_hoy()
     ORDER BY t.finalizado_en DESC NULLS LAST, t.id DESC`
  )
  return rows
}

/**
 * Atender turno rezagado (atómico mediante fn_atender_rezagado)
 */
async function atenderRezagado (fastify, { turnoId, mesaId, operadorId }) {
  try {
    const { rows } = await fastify.db.query(
      `SELECT * FROM fn_atender_rezagado($1, $2, $3)`,
      [turnoId, mesaId, operadorId]
    )

    const r = rows[0]
    if (!r) {
      throw Object.assign(new Error('Error inesperado al atender rezagado'), { statusCode: 500 })
    }

    return {
      turno: {
        id:          r.turno_id,
        numero:      r.turno_numero,
        llamado_en:  r.llamado_en,
        mesa_id:     r.mesa_id,
        mesa_numero: r.mesa_numero,
        mesa_nombre: r.mesa_nombre,
        lote_numero: r.lote_numero,
        origen:      r.origen || 'voucher_fisico',
        token_consulta: r.token_consulta
      },
      vouchers_restantes: r.vouchers_restantes,
      proximo_numero:     r.proximo_numero,
      es_rezagado:        true
    }
  } catch (err) {
    const msg = err.message || ''
    if (msg.includes('no encontrada') || (msg.includes('Turno') && msg.includes('no encontrado'))) {
      throw Object.assign(new Error(msg), { statusCode: 404, codigo: 'no_encontrado' })
    }
    if (msg.includes('no te esta asignada') || msg.includes('no te está asignada')) {
      throw Object.assign(new Error(msg), { statusCode: 403, codigo: 'mesa_no_asignada' })
    }
    if (msg.includes('ya fue atendido') || msg.includes('no está disponible') || msg.includes('no esta disponible') || msg.includes('Solo mesas activas')) {
      throw Object.assign(new Error(msg), { statusCode: 409, codigo: 'turno_no_disponible' })
    }
    throw err
  }
}

const kioskoService = require('../kiosko/service')

/**
 * Generar turno para kiosko web (RF-GEN-02 con numeración propia).
 */
async function generarTurnoKiosko (fastify, opts) {
  return kioskoService.generarTurno(fastify, opts)
}

/**
 * Consultar posición en cola por token (RF-GEN-03).
 */
async function consultarMiTurno (fastify, opts) {
  return kioskoService.consultarMiTurno(fastify, opts)
}

module.exports = {
  llamarSiguiente,
  cancelarTurno,
  obtenerRezagados,
  atenderRezagado,
  generarTurnoKiosko,
  consultarMiTurno
}

