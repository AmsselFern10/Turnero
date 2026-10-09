'use strict'

/**
 * Módulo de mesas — Rutas Fastify
 * Prefijo: /mesas
 */
module.exports = async function mesasRoutes (fastify) {

  // ── GET /mesas — Listar mesas con estado actual ───────────────────────────
  fastify.get('/', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT m.id, m.numero, m.nombre, m.estado,
              u.id AS operador_id, u.nombre_completo AS operador_nombre,
              -- Turno actual en esta mesa
              t.numero AS turno_actual,
              t.llamado_en,
              -- Atendidos hoy
              (SELECT COUNT(*) FROM turnos
               WHERE mesa_id = m.id AND estado = 'atendido'
                 AND creado_en::date = CURRENT_DATE) AS atendidos_hoy,
              -- Tiempo promedio de atención hoy (segundos)
              (SELECT ROUND(AVG(duracion_atencion_seg))
               FROM turnos
               WHERE mesa_id = m.id AND estado = 'atendido'
                 AND duracion_atencion_seg IS NOT NULL
                 AND creado_en::date = CURRENT_DATE) AS tiempo_promedio_seg
       FROM mesas m
       LEFT JOIN usuarios u ON m.operador_id = u.id
       LEFT JOIN turnos t ON t.mesa_id = m.id AND t.estado = 'en_atencion'
       ORDER BY m.numero`
    )
    return reply.send({ mesas: rows })
  })

  // ── POST /mesas — Crear mesa (RF-ADM-04) ──────────────────────────────────
  fastify.post('/', {
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      body: {
        type: 'object',
        required: ['numero', 'nombre'],
        properties: {
          numero: { type: 'integer', minimum: 1 },
          nombre: { type: 'string', minLength: 1, maxLength: 60 }
        }
      }
    }
  }, async (request, reply) => {
    const { numero, nombre } = request.body

    const { rows: [mesa] } = await fastify.db.query(
      `INSERT INTO mesas (numero, nombre) VALUES ($1, $2)
       RETURNING id, numero, nombre, estado`,
      [numero, nombre]
    )

    return reply.status(201).send({ mesa })
  })

  // ── PATCH /mesas/:id/asignar — Asignar operador a mesa (RF-ADM-04) ─────────
  fastify.patch('/:id/asignar', {
    preHandler: [fastify.authorizeRol('admin', 'supervisor')],
    schema: {
      body: {
        type: 'object',
        required: ['operador_id'],
        properties: {
          operador_id: { type: ['integer', 'null'] }
        }
      }
    }
  }, async (request, reply) => {
    const mesaId     = parseInt(request.params.id)
    const { operador_id } = request.body

    // Validar que el operador no está ya asignado a otra mesa (RF-AUTH-07)
    if (operador_id) {
      const { rows } = await fastify.db.query(
        `SELECT id, numero FROM mesas
         WHERE operador_id = $1 AND id != $2 AND estado != 'inactiva'`,
        [operador_id, mesaId]
      )

      if (rows.length > 0) {
        return reply.status(409).send({
          error: `Este operador ya está asignado a la Mesa ${rows[0].numero}. Un operador no puede estar en dos mesas.`
        })
      }
    }

    const { rows: [mesa] } = await fastify.db.query(
      `UPDATE mesas SET operador_id = $1, estado = CASE WHEN $1 IS NOT NULL THEN 'activa' ELSE 'inactiva' END
       WHERE id = $2
       RETURNING id, numero, nombre, estado, operador_id`,
      [operador_id, mesaId]
    )

    if (!mesa) return reply.status(404).send({ error: 'Mesa no encontrada' })

    await fastify.db.query(
      `INSERT INTO audit_log (mesa_id, operador_id, accion, ip_origen)
       VALUES ($1, $2, 'OPERADOR_ASIGNADO', $3)`,
      [mesaId, request.user.id, request.ip]
    )

    // Notificar a todos los clientes
    await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa })

    return reply.send({ mesa })
  })

  // ── PATCH /mesas/:id/estado — Pausar/activar mesa (RF-ADM-05) ─────────────
  fastify.patch('/:id/estado', {
    preHandler: [fastify.authorizeRol('admin', 'supervisor', 'operador')],
    schema: {
      body: {
        type: 'object',
        required: ['estado'],
        properties: {
          estado: { type: 'string', enum: ['activa', 'pausada', 'inactiva'] }
        }
      }
    }
  }, async (request, reply) => {
    const mesaId      = parseInt(request.params.id)
    const { estado }  = request.body

    // Operadores solo pueden pausar/activar su propia mesa
    if (request.user.rol === 'operador') {
      const { rows: [mesa] } = await fastify.db.query(
        `SELECT operador_id FROM mesas WHERE id = $1`, [mesaId]
      )
      if (mesa?.operador_id !== request.user.id) {
        return reply.status(403).send({ error: 'Solo puedes cambiar el estado de tu propia mesa' })
      }
    }

    const { rows: [mesa] } = await fastify.db.query(
      `UPDATE mesas SET estado = $1 WHERE id = $2
       RETURNING id, numero, nombre, estado`,
      [estado, mesaId]
    )

    if (!mesa) return reply.status(404).send({ error: 'Mesa no encontrada' })

    const accionLog = estado === 'activa' ? 'MESA_ACTIVADA' : estado === 'pausada' ? 'MESA_PAUSADA' : 'MESA_INACTIVADA'
    await fastify.db.query(
      `INSERT INTO audit_log (mesa_id, operador_id, accion, ip_origen)
       VALUES ($1, $2, $3, $4)`,
      [mesaId, request.user.id, accionLog, request.ip]
    )

    await fastify.broadcast(`mesa:${mesaId}`, `mesa_${estado}`, { mesa })
    await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa })

    return reply.send({ mesa })
  })
}
