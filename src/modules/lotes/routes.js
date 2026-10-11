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
       LEFT JOIN usuarios u ON lv.creado_por = u.id
       ORDER BY lv.numero_lote DESC`
    )
    return reply.send({ lotes: rows })
  })

  // ── GET /lotes/activo — Estado del lote activo ────────────────────────────
  fastify.get('/activo', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { rows: [lote] } = await fastify.db.query(
      `SELECT id, numero_lote, numero_desde, numero_hasta,
              ultimo_numero_llamado, estado,
              numero_hasta - ultimo_numero_llamado AS vouchers_restantes,
              ROUND((ultimo_numero_llamado::numeric / numero_hasta) * 100, 1) AS progreso_pct
       FROM lotes_voucher WHERE estado = 'activo' LIMIT 1`
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

    const { rows: [lote] } = await fastify.db.query(
      `INSERT INTO lotes_voucher (numero_desde, numero_hasta, creado_por)
       VALUES ($1, $2, $3)
       RETURNING id, numero_lote, numero_desde, numero_hasta, estado`,
      [numero_desde, numero_hasta, request.user.id]
    )

    await fastify.db.query(
      `INSERT INTO audit_log (lote_id, operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, $2, 'LOTE_CREADO', $3, $4)`,
      [lote.id, request.user.id, request.ip, JSON.stringify({
        numero_desde, numero_hasta, numero_lote: lote.numero_lote
      })]
    )

    await fastify.broadcast('admin:all', 'lote_creado', { lote })

    return reply.status(201).send({ lote })
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

      await fastify.broadcast('admin:all', 'lote_activado', { lote })

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

    await fastify.broadcast('admin:all', 'lote_pausado', { lote })

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
          nuevo_numero_hasta: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const loteId          = parseInt(request.params.id)
    const { nuevo_numero_hasta } = request.body

    // Verificar que la extensión es válida
    const { rows: [lote] } = await fastify.db.query(
      `SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado
       FROM lotes_voucher WHERE id = $1`,
      [loteId]
    )

    if (!lote) return reply.status(404).send({ error: 'Lote no encontrado' })

    if (nuevo_numero_hasta <= lote.numero_hasta) {
      return reply.status(400).send({
        error: `El nuevo límite (${nuevo_numero_hasta}) debe ser mayor al actual (${lote.numero_hasta})`
      })
    }

    const { rows: [loteActualizado] } = await fastify.db.query(
      `UPDATE lotes_voucher
       SET numero_hasta = $1,
           estado = CASE WHEN estado = 'agotado' THEN 'activo' ELSE estado END
       WHERE id = $2
       RETURNING id, numero_lote, numero_hasta, ultimo_numero_llamado, estado`,
      [nuevo_numero_hasta, loteId]
    )

    await fastify.db.query(
      `INSERT INTO audit_log (lote_id, operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, $2, 'LOTE_EXTENDIDO', $3, $4)`,
      [loteId, request.user.id, request.ip, JSON.stringify({
        numero_hasta_anterior: lote.numero_hasta,
        numero_hasta_nuevo:    nuevo_numero_hasta
      })]
    )

    await fastify.broadcast('admin:all', 'lote_extendido', {
      lote:                loteActualizado,
      vouchers_agregados:  nuevo_numero_hasta - lote.numero_hasta
    })

    return reply.send({
      lote: loteActualizado,
      message: `Lote ${lote.numero_lote} extendido: vouchers ${lote.numero_hasta + 1}–${nuevo_numero_hasta} disponibles inmediatamente.`
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

    await fastify.broadcast('admin:all', 'lote_cerrado', { lote })

    return reply.send({
      lote,
      message: `Lote ${lote.numero_lote} cerrado. Puede crear un nuevo lote desde 1.`
    })
  })
}

