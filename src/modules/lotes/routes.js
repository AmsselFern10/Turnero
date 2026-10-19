'use strict'

/**
 * Módulo de lotes de vouchers — Rutas Fastify
 * Prefijo: /lotes
 * Solo admin puede gestionar lotes (RF-LOTE-*)
 */
module.exports = async function lotesRoutes (fastify) {

  // ── GET /lotes — Listar todos los lotes ───────────────────────────────────
  fastify.get('/', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT lv.id, lv.numero_lote, lv.numero_desde, lv.numero_hasta,
              lv.ultimo_numero_llamado, lv.estado,
              lv.fecha_creacion, lv.fecha_activacion, lv.fecha_cierre,
              u.nombre_completo AS creado_por_nombre,
              -- Progreso calculado
              CASE WHEN lv.numero_hasta > 0
                THEN ROUND((lv.ultimo_numero_llamado::numeric / lv.numero_hasta) * 100, 1)
                ELSE 0
              END AS progreso_pct,
              lv.numero_hasta - lv.ultimo_numero_llamado AS vouchers_restantes
       FROM lotes_voucher lv
       LEFT JOIN usuarios u ON lv.creado_por = u.id AND u.eliminado_en IS NULL
       WHERE lv.estado != 'eliminado' AND lv.eliminado_en IS NULL
       ORDER BY lv.numero_lote DESC`
    )
    return reply.send({ lotes: rows })
  })

  // ── GET /lotes/activo — Estado del lote activo (o agotado en sala) ────────
  fastify.get('/activo', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { rows: [lote] } = await fastify.db.query(
      `SELECT id, numero_lote, numero_desde, numero_hasta,
              ultimo_numero_llamado, estado,
              numero_hasta - ultimo_numero_llamado AS vouchers_restantes,
              ROUND((ultimo_numero_llamado::numeric / numero_hasta) * 100, 1) AS progreso_pct
       FROM lotes_voucher
       WHERE estado IN ('activo', 'agotado') AND eliminado_en IS NULL
       ORDER BY (CASE WHEN estado = 'activo' THEN 1 ELSE 2 END), id DESC
       LIMIT 1`
    )

    return reply.send({ lote: lote || null })
  })

  // ── POST /lotes — Crear nuevo lote (RF-LOTE-01) ───────────────────────────
  fastify.post('/', {
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      body: {
        type: 'object',
        required: ['numero_hasta'],
        properties: {
          numero_desde:  { type: 'integer', minimum: 1, default: 1 },
          numero_hasta:  { type: 'integer', minimum: 2 }
        }
      }
    }
  }, async (request, reply) => {
    const { numero_desde = 1, numero_hasta } = request.body

    if (numero_hasta <= numero_desde) {
      return reply.status(400).send({
        error: `numero_hasta (${numero_hasta}) debe ser mayor que numero_desde (${numero_desde})`
      })
    }

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')

      // Bloqueo exclusivo: solo un admin puede crear+activar a la vez
      const { rows: [loteActivoExistente] } = await client.query(
        `SELECT id, numero_lote FROM lotes_voucher WHERE estado = 'activo' LIMIT 1 FOR UPDATE`
      )

      const { rows: [lote] } = await client.query(
        `INSERT INTO lotes_voucher (numero_desde, numero_hasta, creado_por)
         VALUES ($1, $2, $3)
         RETURNING id, numero_lote, numero_desde, numero_hasta, estado, fecha_creacion`,
        [numero_desde, numero_hasta, request.user.id]
      )

      let activado = false
      let mensaje

      if (!loteActivoExistente) {
        // No hay lote activo — activar inmediatamente en la misma transacción
        const { rows: [loteActivado] } = await client.query(
          `UPDATE lotes_voucher
             SET estado = 'activo', fecha_activacion = NOW()
           WHERE id = $1
           RETURNING id, numero_lote, numero_desde, numero_hasta, estado,
                     fecha_creacion, fecha_activacion, ultimo_numero_llamado`,
          [lote.id]
        )
        Object.assign(lote, loteActivado)
        activado = true
        mensaje = `Lote ${lote.numero_lote} creado y activado (${numero_desde} → ${numero_hasta})`

        await client.query(
          `INSERT INTO audit_log (lote_id, operador_id, accion, ip_origen, metadata_json)
           VALUES ($1, $2, 'LOTE_ACTIVADO', $3, $4)`,
          [lote.id, request.user.id, request.ip, JSON.stringify({ auto_activado: true, numero_lote: lote.numero_lote })]
        )
      } else {
        mensaje = `Lote ${lote.numero_lote} creado. Ya existe un Lote ${loteActivoExistente.numero_lote} activo en sala.`
      }

      await client.query(
        `INSERT INTO audit_log (lote_id, operador_id, accion, ip_origen, metadata_json)
         VALUES ($1, $2, 'LOTE_CREADO', $3, $4)`,
        [lote.id, request.user.id, request.ip, JSON.stringify({ numero_desde, numero_hasta, numero_lote: lote.numero_lote, auto_activado: activado })]
      )

      await client.query('COMMIT')

      // Broadcasts fuera de la transacción
      await fastify.broadcast('admin:all', 'lote_creado', { lote })
      if (activado) {
        await fastify.broadcast('admin:all', 'lote_activado', { lote })
        // Desbloquea paneles de operador que esperaban un lote activo
        await fastify.broadcast('lote:activo', 'proximo_actualizado', {
          lote_id: lote.id,
          numero_lote: lote.numero_lote,
          proximo: numero_desde
        })
        await fastify.broadcast('tv:global', 'lote_activado', { lote })
      }

      return reply.status(201).send({ lote, activado, mensaje })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // ── PATCH /lotes/:id/activar (RF-LOTE-03) ─────────────────────────────────
  fastify.patch('/:id/activar', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const loteId = parseInt(request.params.id)

    try {
      // Verificar que no haya otro lote activo (garantía extra — el UNIQUE index lo impide)
      const { rows: [activo] } = await fastify.db.query(
        `SELECT id, numero_lote FROM lotes_voucher WHERE estado = 'activo' LIMIT 1`
      )

      if (activo && activo.id !== loteId) {
        return reply.status(409).send({
          error: `Ya hay un lote activo (Lote ${activo.numero_lote}). Debe pausarlo o cerrarlo primero.`
        })
      }

      const { rows: [lote] } = await fastify.db.query(
        `UPDATE lotes_voucher
         SET estado = 'activo', fecha_activacion = COALESCE(fecha_activacion, NOW())
         WHERE id = $1 AND estado IN ('preparado', 'pausado')
         RETURNING id, numero_lote, numero_hasta, ultimo_numero_llamado, estado`,
        [loteId]
      )

      if (!lote) {
        return reply.status(400).send({ error: 'El lote no puede activarse desde su estado actual' })
      }

      await fastify.db.query(
        `INSERT INTO audit_log (lote_id, operador_id, accion, ip_origen)
         VALUES ($1, $2, 'LOTE_ACTIVADO', $3)`,
        [loteId, request.user.id, request.ip]
      )

      await Promise.allSettled([
        fastify.broadcast('admin:all', 'lote_activado', { lote }),
        fastify.broadcast('lote:activo', 'proximo_actualizado', {
          lote:               lote.numero_lote,
          ultimo_llamado:     lote.ultimo_numero_llamado,
          proximo_numero:     lote.ultimo_numero_llamado < lote.numero_hasta ? lote.ultimo_numero_llamado + 1 : null,
          vouchers_restantes: Math.max(0, lote.numero_hasta - lote.ultimo_numero_llamado),
          modo:               'voucher_fisico'
        })
      ])

      return reply.send({ lote })
    } catch (err) {
      if (err.code === '23505') {
        return reply.status(409).send({
          error: 'Ya existe otro lote activo en el sistema (conflicto de concurrencia).'
        })
      }
      throw err
    }
  })

  // ── PATCH /lotes/:id/pausar (RF-LOTE-04) ──────────────────────────────────
  fastify.patch('/:id/pausar', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const loteId = parseInt(request.params.id)

    const { rows: [lote] } = await fastify.db.query(
      `UPDATE lotes_voucher SET estado = 'pausado'
       WHERE id = $1 AND estado = 'activo'
       RETURNING id, numero_lote, ultimo_numero_llamado`,
      [loteId]
    )

    if (!lote) {
      return reply.status(400).send({ error: 'Solo se puede pausar el lote activo' })
    }

    await fastify.db.query(
      `INSERT INTO audit_log (lote_id, operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, $2, 'LOTE_PAUSADO', $3, $4)`,
      [loteId, request.user.id, request.ip,
       JSON.stringify({ ultimo_numero_llamado: lote.ultimo_numero_llamado })]
    )

    await Promise.allSettled([
      fastify.broadcast('admin:all', 'lote_pausado', { lote }),
      // F-6: notificar a paneles de operadores que el lote ya no tiene turnos disponibles
      fastify.broadcast('lote:activo', 'lote_pausado', {
        lote,
        proximo_numero:     null,
        vouchers_restantes: 0
      })
    ])

    return reply.send({ lote, message: `Lote ${lote.numero_lote} pausado. Continúa desde el ${lote.ultimo_numero_llamado + 1} mañana.` })
  })

  // ── PATCH /lotes/:id/extender — Extensión en caliente (RF-LOTE-06) ────────
  fastify.patch('/:id/extender', {
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      body: {
        type: 'object',
        required: ['nuevo_numero_hasta'],
        properties: {
          nuevo_numero_hasta: { type: 'integer', minimum: 1, maximum: 100000 }
        }
      }
    }
  }, async (request, reply) => {
    const loteId = parseInt(request.params.id, 10)
    const { nuevo_numero_hasta } = request.body

    if (!Number.isInteger(loteId) || isNaN(loteId)) {
      return reply.status(400).send({ error: 'Identificador de lote no válido' })
    }

    if (!Number.isInteger(nuevo_numero_hasta) || nuevo_numero_hasta < 1) {
      return reply.status(400).send({ error: 'El nuevo límite debe ser un número entero mayor que 0.' })
    }

    // Verificar lote existente y estado
    const { rows: [lote] } = await fastify.db.query(
      `SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado, estado
       FROM lotes_voucher WHERE id = $1`,
      [loteId]
    )

    if (!lote) return reply.status(404).send({ error: 'Lote no encontrado' })

    // Validar estado del lote (RF-LOTE: cerrado no puede extenderse; activo, agotado y pausado sí)
    if (lote.estado === 'cerrado') {
      return reply.status(400).send({
        error: `El Lote ${lote.numero_lote} está cerrado definitivamente y no puede extenderse. Cree un nuevo lote.`
      })
    }

    if (!['activo', 'agotado', 'pausado'].includes(lote.estado)) {
      return reply.status(400).send({
        error: `El Lote ${lote.numero_lote} no se encuentra en un estado que permita extensión (estado actual: ${lote.estado}).`
      })
    }

    if (nuevo_numero_hasta <= lote.numero_hasta) {
      return reply.status(400).send({
        error: `El nuevo límite (#${nuevo_numero_hasta}) debe ser mayor al actual (#${lote.numero_hasta}).`
      })
    }

    const cantidadAdicionada = nuevo_numero_hasta - lote.numero_hasta
    const MAX_EXTENSION_CANTIDAD = 5000
    if (cantidadAdicionada > MAX_EXTENSION_CANTIDAD) {
      return reply.status(400).send({
        error: `No se pueden adicionar más de 5,000 turnos en una sola extensión (se intentó adicionar ${cantidadAdicionada}).`
      })
    }

    if (nuevo_numero_hasta > 100000) {
      return reply.status(400).send({
        error: 'El límite máximo absoluto para un lote es 100,000 turnos.'
      })
    }

    const { rows: [loteActualizado] } = await fastify.db.query(
      `UPDATE lotes_voucher
       SET numero_hasta = $1,
           estado = CASE WHEN estado = 'agotado' THEN 'activo' ELSE estado END,
           fecha_cierre = CASE WHEN estado = 'agotado' THEN NULL ELSE fecha_cierre END
       WHERE id = $2
       RETURNING id, numero_lote, numero_hasta, ultimo_numero_llamado, estado`,
      [nuevo_numero_hasta, loteId]
    )

    await fastify.db.query(
      `INSERT INTO audit_log (lote_id, operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, $2, 'LOTE_EXTENDIDO', $3, $4)`,
      [loteId, request.user.id, request.ip, JSON.stringify({
        numero_hasta_anterior: lote.numero_hasta,
        numero_hasta_nuevo:    nuevo_numero_hasta,
        cantidad_adicionada:   cantidadAdicionada,
        estado_previo:         lote.estado,
        estado_nuevo:          loteActualizado.estado
      })]
    )

    await Promise.allSettled([
      fastify.broadcast('admin:all', 'lote_extendido', {
        lote:                loteActualizado,
        vouchers_agregados:  cantidadAdicionada
      }),
      fastify.broadcast('lote:activo', 'proximo_actualizado', {
        lote:               loteActualizado.numero_lote,
        ultimo_llamado:     loteActualizado.ultimo_numero_llamado,
        proximo_numero:     loteActualizado.ultimo_numero_llamado < nuevo_numero_hasta ? loteActualizado.ultimo_numero_llamado + 1 : null,
        vouchers_restantes: Math.max(0, nuevo_numero_hasta - loteActualizado.ultimo_numero_llamado),
        modo:               'voucher_fisico'
      }),
      // TV: notificar extensión para actualizar próximo número visible
      fastify.broadcast('tv:global', 'lote_extendido', {
        lote:                loteActualizado,
        vouchers_agregados:  cantidadAdicionada,
        proximo_numero:      loteActualizado.ultimo_numero_llamado < nuevo_numero_hasta ? loteActualizado.ultimo_numero_llamado + 1 : null,
        vouchers_restantes:  Math.max(0, nuevo_numero_hasta - loteActualizado.ultimo_numero_llamado)
      })
    ])

    return reply.send({
      lote: loteActualizado,
      message: `Lote ${lote.numero_lote} extendido: ahora llega hasta #${nuevo_numero_hasta}.`
    })
  })

  // ── PATCH /lotes/:id/cerrar (RF-LOTE-08) ──────────────────────────────────
  fastify.patch('/:id/cerrar', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const loteId = parseInt(request.params.id)

    const { rows: [lote] } = await fastify.db.query(
      `UPDATE lotes_voucher
       SET estado = 'cerrado', fecha_cierre = NOW()
       WHERE id = $1 AND estado NOT IN ('cerrado')
       RETURNING id, numero_lote, ultimo_numero_llamado`,
      [loteId]
    )

    if (!lote) {
      return reply.status(400).send({ error: 'Lote no encontrado o ya está cerrado' })
    }

    await fastify.db.query(
      `INSERT INTO audit_log (lote_id, operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, $2, 'LOTE_CERRADO', $3, $4)`,
      [loteId, request.user.id, request.ip,
       JSON.stringify({ ultimo_numero_llamado: lote.ultimo_numero_llamado })]
    )

    await Promise.allSettled([
      fastify.broadcast('admin:all', 'lote_cerrado', { lote }),
      // F-7: notificar a paneles de operadores que el lote fue cerrado definitivamente
      fastify.broadcast('lote:activo', 'lote_cerrado', {
        lote,
        proximo_numero:     null,
        vouchers_restantes: 0
      })
    ])

    return reply.send({
      lote,
      message: `Lote ${lote.numero_lote} cerrado. Puede crear un nuevo lote desde 1.`
    })
  })

  // ── PATCH /lotes/:id/ajustar-contador (Plan B — RF-LOTE-09) ───────────────
  // Permite al admin corregir el contador del lote cuando vouchers físicos
  // fueron atendidos durante una caída del sistema (registros manuales en papel).
  //
  // Validaciones:
  //   1. El lote debe existir y estar en estado 'activo' o 'pausado'
  //   2. nuevo_ultimo >= numero_desde  (no retroceder antes del inicio)
  //   3. nuevo_ultimo <= numero_hasta  (no superar el límite declarado)
  //   4. Si se retrocede, se requiere motivo y confirmacion_retroceso=true
  //   5. Registra en audit_log con valor anterior, nuevo valor, motivo e IP
  fastify.patch('/:id/ajustar-contador', {
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      body: {
        type: 'object',
        required: ['nuevo_ultimo_llamado', 'motivo'],
        properties: {
          nuevo_ultimo_llamado:  { type: 'integer', minimum: 0 },
          motivo:                { type: 'string', minLength: 5, maxLength: 500 },
          confirmacion_retroceso: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const loteId = parseInt(request.params.id)
    const { nuevo_ultimo_llamado, motivo, confirmacion_retroceso = false } = request.body

    // Leer el lote actual — FOR UPDATE para evitar race con llamar_siguiente
    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')

      const { rows: [lote] } = await client.query(
        `SELECT id, numero_lote, numero_desde, numero_hasta, ultimo_numero_llamado, estado
         FROM lotes_voucher
         WHERE id = $1
         FOR UPDATE`,
        [loteId]
      )

      if (!lote) {
        await client.query('ROLLBACK')
        return reply.status(404).send({ error: { codigo: 'lote_no_encontrado', mensaje: 'Lote no encontrado' } })
      }

      // Solo activo o pausado — no se puede ajustar un lote preparado, cerrado o agotado
      if (!['activo', 'pausado'].includes(lote.estado)) {
        await client.query('ROLLBACK')
        return reply.status(400).send({
          error: {
            codigo: 'estado_invalido',
            mensaje: `Solo se puede ajustar el contador de un lote activo o pausado. Estado actual: ${lote.estado}`
          }
        })
      }

      // Validar rango
      if (nuevo_ultimo_llamado < lote.numero_desde - 1) {
        await client.query('ROLLBACK')
        return reply.status(400).send({
          error: {
            codigo: 'fuera_de_rango',
            mensaje: `El nuevo valor (${nuevo_ultimo_llamado}) no puede ser menor al inicio del lote (${lote.numero_desde})`
          }
        })
      }

      if (nuevo_ultimo_llamado > lote.numero_hasta) {
        await client.query('ROLLBACK')
        return reply.status(400).send({
          error: {
            codigo: 'fuera_de_rango',
            mensaje: `El nuevo valor (${nuevo_ultimo_llamado}) supera el límite del lote (${lote.numero_hasta})`
          }
        })
      }

      // Si es retroceso, exigir confirmación explícita
      const esRetroceso = nuevo_ultimo_llamado < lote.ultimo_numero_llamado
      if (esRetroceso && !confirmacion_retroceso) {
        await client.query('ROLLBACK')
        return reply.status(409).send({
          error: {
            codigo: 'retroceso_no_confirmado',
            mensaje: `Está retrocediendo el contador de ${lote.ultimo_numero_llamado} a ${nuevo_ultimo_llamado}. Envíe confirmacion_retroceso=true para confirmar.`
          }
        })
      }

      // Si es un retroceso confirmado, autorizar explícitamente en la transacción
      if (esRetroceso) {
        await client.query("SET LOCAL app.permitir_retroceso_lote = 'true'")
      }

      // Aplicar el ajuste
      const { rows: [loteActualizado] } = await client.query(
        `UPDATE lotes_voucher
         SET ultimo_numero_llamado = $1,
             estado = CASE WHEN estado = 'agotado' AND $1 < numero_hasta THEN 'activo' ELSE estado END
         WHERE id = $2
         RETURNING id, numero_lote, numero_desde, numero_hasta, ultimo_numero_llamado, estado`,
        [nuevo_ultimo_llamado, loteId]
      )

      // Auditoría inmutable — solo INSERT, nunca UPDATE/DELETE
      await client.query(
        `INSERT INTO audit_log (lote_id, operador_id, accion, ip_origen, metadata_json)
         VALUES ($1, $2, 'LOTE_CONTADOR_AJUSTADO', $3, $4)`,
        [loteId, request.user.id, request.ip, JSON.stringify({
          valor_anterior:      lote.ultimo_numero_llamado,
          valor_nuevo:         nuevo_ultimo_llamado,
          es_retroceso:        esRetroceso,
          motivo,
          ajustado_por:        request.user.username || request.user.id,
          numero_hasta:        lote.numero_hasta
        })]
      )

      await client.query('COMMIT')

      // Notificar al panel admin en tiempo real
      await Promise.allSettled([
        fastify.broadcast('admin:all', 'lote_contador_ajustado', {
          lote: loteActualizado,
          valor_anterior: lote.ultimo_numero_llamado,
          motivo
        }),
        // Notificar a paneles de operadores para actualizar próximo número y vouchers restantes
        fastify.broadcast('lote:activo', 'proximo_actualizado', {
          lote:               loteActualizado.numero_lote,
          ultimo_llamado:     nuevo_ultimo_llamado,
          proximo_numero:     nuevo_ultimo_llamado < loteActualizado.numero_hasta ? nuevo_ultimo_llamado + 1 : null,
          vouchers_restantes: Math.max(0, loteActualizado.numero_hasta - nuevo_ultimo_llamado),
          modo:               'voucher_fisico'
        })
      ])

      return reply.send({
        lote: loteActualizado,
        message: `Contador del Lote ${lote.numero_lote} ajustado: ${lote.ultimo_numero_llamado} → ${nuevo_ultimo_llamado}. El próximo turno a llamar será el ${nuevo_ultimo_llamado + 1}.`
      })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // ── DELETE /lotes/:id — Eliminar lote ──────────────────────────────────────
  fastify.delete('/:id', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const loteId = parseInt(request.params.id)

    const { rows: [lote] } = await fastify.db.query(
      `SELECT id, numero_lote, estado, ultimo_numero_llamado FROM lotes_voucher WHERE id = $1 AND estado != 'eliminado'`,
      [loteId]
    )

    if (!lote) return reply.status(404).send({ error: 'Lote no encontrado o ya eliminado' })

    // Si el lote nunca tuvo llamados y está en estado preparado, se puede eliminar físicamente o lógicamente
    // Si ya tuvo llamados, se marca eliminado permanentemente para no romper el historial de vouchers
    const { rows: [loteEliminado] } = await fastify.db.query(
      `UPDATE lotes_voucher
       SET estado = 'eliminado', eliminado_en = NOW()
       WHERE id = $1
       RETURNING id, numero_lote`,
      [loteId]
    )

    await fastify.db.query(
      `INSERT INTO audit_log (lote_id, operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, $2, 'ADMIN_ACTION', $3, $4)`,
      [loteId, request.user.id, request.ip, JSON.stringify({ tipo: 'LOTE_ELIMINADO', numero_lote: lote.numero_lote })]
    )

    await fastify.broadcast('admin:all', 'lote_actualizado', { lote_eliminado_id: loteId })

    return reply.send({ success: true, message: `Lote ${lote.numero_lote} eliminado exitosamente.` })
  })
}


