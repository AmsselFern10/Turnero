'use strict'

const {
  llamarSiguiente,
  cancelarTurno,
  generarTurnoKiosko,
  consultarMiTurno
} = require('./service')

/**
 * Módulo de turnos — Rutas Fastify
 * Prefijo: /turnos
 */
module.exports = async function turnosRoutes (fastify) {

  // ── POST /turnos/llamar — EL ENDPOINT PRINCIPAL (RF-TURN-01) ──────────────
  // Rate limit: máx 5 llamados/seg por operador (RNF-SEG-07)
  fastify.post('/llamar', {
    preHandler: [fastify.authorizeRol('operador', 'supervisor')],
    config: {
      rateLimit: {
        max:        5,
        timeWindow: '1 second',
        keyGenerator: (req) => `turno:${req.user.id}`,  // por operador, no por IP
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: 'Rate limit',
          message: 'Máximo 5 llamados por segundo por operador.'
        })
      }
    },
    schema: {
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: {
          mesa_id: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { mesa_id } = request.body
    const operadorId   = request.user.id

    const resultado = await llamarSiguiente(fastify, {
      mesaId:     mesa_id,
      operadorId
    })

    // Broadcast WS a todos los canales (RF-WS-01)
    const { turno, vouchers_restantes, proximo_numero } = resultado

    await Promise.all([
      // TV: anuncia el nuevo número
      fastify.broadcast('tv:global', 'nuevo_llamado', {
        turno:       turno.numero,
        mesa_numero: turno.mesa_numero,
        mesa_nombre: turno.mesa_nombre,
        lote_numero: turno.lote_numero
      }),
      // Panel del operador: actualiza su panel
      fastify.broadcast(`mesa:${mesa_id}`, 'turno_llamado', {
        turno,
        proximo_numero,
        vouchers_restantes
      }),
      // Admin: KPI update
      fastify.broadcast('admin:all', 'kpi_update', {
        mesa_id,
        turno_numero:       turno.numero,
        vouchers_restantes
      })
    ])

    return reply.status(200).send({
      turno,
      proximo_numero,
      vouchers_restantes
    })
  })

  // ── POST /turnos/:id/cancelar — No se presentó (RF-TURN-05) ───────────────
  fastify.post('/:id/cancelar', {
    preHandler: [fastify.authorizeRol('operador', 'supervisor')],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } }
      },
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: { mesa_id: { type: 'integer' } }
      }
    }
  }, async (request, reply) => {
    const turnoId    = parseInt(request.params.id)
    const { mesa_id } = request.body
    const operadorId   = request.user.id

    const turno = await cancelarTurno(fastify, {
      turnoId,
      operadorId,
      mesaId: mesa_id
    })

    // Notificar al admin
    await fastify.broadcast('admin:all', 'turno_cancelado', {
      turno_id:    turno.id,
      turno_numero: turno.numero,
      mesa_id
    })

    return reply.status(200).send({ message: 'Turno cancelado', turno })
  })

  // ── POST /turnos/:id/rellamar — Re-llamar turno actual (RF-MESA / TV) ─────────
  fastify.post('/:id/rellamar', {
    preHandler: [fastify.authorizeRol('operador', 'supervisor')],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } }
      },
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: { mesa_id: { type: 'integer' } }
      }
    }
  }, async (request, reply) => {
    const turnoId     = parseInt(request.params.id)
    const { mesa_id } = request.body
    const operadorId  = request.user.id

    const { rows: [turno] } = await fastify.db.query(
      `SELECT t.id, t.numero, t.mesa_id, m.numero AS mesa_numero, m.nombre AS mesa_nombre, l.numero_lote
       FROM turnos t
       JOIN mesas m ON t.mesa_id = m.id
       JOIN lotes_voucher l ON t.lote_id = l.id
       WHERE t.id = $1 AND t.mesa_id = $2 AND t.estado = 'en_atencion'`,
      [turnoId, mesa_id]
    )

    if (!turno) {
      return reply.status(404).send({ error: 'Turno en atención no encontrado en esta mesa' })
    }

    // Re-anunciar a la TV pública con tipo 'rellamado'
    await Promise.all([
      fastify.broadcast('tv:global', 'rellamado', {
        turno:       turno.numero,
        mesa_numero: turno.mesa_numero,
        mesa_nombre: turno.mesa_nombre,
        lote_numero: turno.numero_lote
      }),
      fastify.db.query(
        `INSERT INTO audit_log (mesa_id, turno_id, operador_id, accion, metadata_json, ip_origen)
         VALUES ($1, $2, $3, 'TURNO_RELLAMADO', $4, $5)`,
        [mesa_id, turnoId, operadorId, JSON.stringify({ numero: turno.numero }), request.ip]
      )
    ])

    return reply.status(200).send({ message: 'Turno re-llamado con éxito', turno })
  })

  // ── GET /turnos/estado — Snapshot para reconexión WS (RF-WS-05) ───────────
  fastify.get('/estado', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: { mesa_id: { type: 'integer' } }
      }
    }
  }, async (request, reply) => {
    const mesaId = request.query.mesa_id

    const [loteResult, turnoResult, contadorResult] = await Promise.all([
      fastify.db.query(
        `SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado, estado
         FROM lotes_voucher WHERE estado = 'activo' LIMIT 1`
      ),
      mesaId ? fastify.db.query(
        `SELECT id, numero, llamado_en, estado FROM turnos
         WHERE mesa_id = $1 AND estado = 'en_atencion' LIMIT 1`,
        [mesaId]
      ) : Promise.resolve({ rows: [] }),
      mesaId ? fastify.db.query(
        `SELECT COUNT(*) FROM turnos
         WHERE mesa_id = $1 AND estado = 'atendido' AND creado_en::date = CURRENT_DATE`,
        [mesaId]
      ) : Promise.resolve({ rows: [{ count: '0' }] })
    ])

    const lote = loteResult.rows[0] || null

    return reply.send({
      lote,
      turno_actual:   turnoResult.rows[0] || null,
      atendidos_hoy:  parseInt(contadorResult.rows[0].count),
      proximo_numero: lote ? lote.ultimo_numero_llamado + 1 : null
    })
  })

  // ── POST /turnos/generar — Kiosko web (RF-GEN-02) ─────────────────────────
  fastify.post('/generar', async (request, reply) => {
    const resultado = await generarTurnoKiosko(fastify, { ip: request.ip })

    await fastify.broadcast('admin:all', 'kiosko_turno_generado', {
      numero: resultado.numero
    })

    return reply.status(201).send(resultado)
  })

  // ── GET /turnos/mi-turno/:token — Consulta kiosko (RF-GEN-03) ─────────────
  fastify.get('/mi-turno/:token', {
    schema: {
      params: {
        type: 'object',
        properties: { token: { type: 'string', minLength: 64, maxLength: 64 } }
      }
    }
  }, async (request, reply) => {
    const resultado = await consultarMiTurno(fastify, { token: request.params.token })
    return reply.send(resultado)
  })

  // ── GET /turnos/historial — Últimos N turnos del día ──────────────────────
  fastify.get('/historial', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limite:   { type: 'integer', default: 20, minimum: 1, maximum: 100 },
          mesa_id:  { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    const { limite = 20, mesa_id } = request.query

    const params  = [limite]
    let whereClause = `WHERE t.creado_en::date = CURRENT_DATE`

    if (mesa_id) {
      params.push(mesa_id)
      whereClause += ` AND t.mesa_id = $${params.length}`
    }

    const { rows } = await fastify.db.query(
      `SELECT t.id, t.numero, t.estado, t.origen,
              t.llamado_en, t.finalizado_en,
              t.duracion_atencion_seg,
              m.numero AS mesa_numero, m.nombre AS mesa_nombre,
              u.nombre_completo AS operador_nombre
       FROM turnos t
       LEFT JOIN mesas m ON t.mesa_id = m.id
       LEFT JOIN usuarios u ON t.operador_id = u.id
       ${whereClause}
       ORDER BY t.llamado_en DESC NULLS LAST
       LIMIT $1`,
      params
    )

    return reply.send({ turnos: rows })
  })
}
