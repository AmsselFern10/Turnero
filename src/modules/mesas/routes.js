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
              COALESCE(th.atendidos_hoy, 0)::integer AS atendidos_hoy,
              th.tiempo_promedio_seg::integer AS tiempo_promedio_seg
       FROM mesas m
       LEFT JOIN usuarios u ON m.operador_id = u.id
       LEFT JOIN turnos t ON t.mesa_id = m.id AND t.estado = 'en_atencion'
       LEFT JOIN (
         SELECT mesa_id,
                COUNT(*) AS atendidos_hoy,
                ROUND(AVG(duracion_atencion_seg)) AS tiempo_promedio_seg
         FROM turnos
         WHERE estado = 'atendido' AND creado_en >= date_trunc('day', NOW())
         GROUP BY mesa_id
       ) th ON th.mesa_id = m.id
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

    try {
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
        `UPDATE mesas SET operador_id = $1::bigint, estado = CASE WHEN $1::bigint IS NOT NULL THEN 'activa' ELSE 'inactiva' END
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

      // Notificar a todos los clientes admin
      await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa })
      // Notificar a logins abiertos: la lista de mesas disponibles cambia
      await fastify.broadcast('tv:global', 'mesas_disponibles_actualizadas', {
        mesa,
        accion: operador_id ? 'tomada' : 'liberada'
      })
      // Si hay un operador asignado: notificar al login para auto-redirigir al operador afectado.
      // Se emite a tv:global porque el login escucha ese canal sin auth.
      if (operador_id && mesa.estado === 'activa') {
        await fastify.broadcast('tv:global', 'operador_asignado_por_admin', {
          operador_id: Number(operador_id),
          mesa: { id: mesa.id, numero: mesa.numero, nombre: mesa.nombre, estado: mesa.estado }
        })
      }

      return reply.send({ mesa })
    } catch (err) {

      if (err.code === '23505') {
        return reply.status(409).send({
          error: 'Este operador ya se encuentra asignado a otra mesa (conflicto de concurrencia).'
        })
      }
      throw err
    }
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

  // ── PATCH /mesas/:id — Editar mesa (número y nombre) (RF-ADM-04) ───────────
  fastify.patch('/:id', {
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      body: {
        type: 'object',
        properties: {
          numero: { type: 'integer', minimum: 1 },
          nombre: { type: 'string', minLength: 1, maxLength: 60 }
        }
      }
    }
  }, async (request, reply) => {
    const mesaId = parseInt(request.params.id)
    const { numero, nombre } = request.body

    const campos = []
    const vals = []
    let idx = 1

    if (numero !== undefined) {
      const { rows: conflicto } = await fastify.db.query(
        'SELECT id FROM mesas WHERE numero = $1 AND id != $2', [numero, mesaId]
      )
      if (conflicto.length > 0) {
        return reply.status(409).send({ error: `El número de mesa ${numero} ya está asignado a otra ventanilla.` })
      }
      campos.push(`numero = $${idx++}`)
      vals.push(numero)
    }

    if (nombre !== undefined) {
      campos.push(`nombre = $${idx++}`)
      vals.push(nombre)
    }

    if (campos.length === 0) {
      return reply.status(400).send({ error: 'No hay campos para actualizar' })
    }

    vals.push(mesaId)
    const { rows: [mesa] } = await fastify.db.query(
      `UPDATE mesas SET ${campos.join(', ')} WHERE id = $${idx}
       RETURNING id, numero, nombre, estado, operador_id`,
      vals
    )

    if (!mesa) return reply.status(404).send({ error: 'Mesa no encontrada' })

    await fastify.db.query(
      `INSERT INTO audit_log (mesa_id, operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, $2, 'ADMIN_ACTION', $3, $4)`,
      [mesaId, request.user.id, request.ip, JSON.stringify({ tipo: 'MESA_EDITADA', numero, nombre })]
    )

    await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa })
    return reply.send({ mesa })
  })

  // ── DELETE /mesas/:id — Eliminar mesa (RF-ADM-04) ──────────────────────────
  fastify.delete('/:id', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const mesaId = parseInt(request.params.id)

    // Validar que no tenga turno en atención activo
    const { rows: turnosActivos } = await fastify.db.query(
      `SELECT id, numero FROM turnos WHERE mesa_id = $1 AND estado = 'en_atencion'`,
      [mesaId]
    )
    if (turnosActivos.length > 0) {
      return reply.status(409).send({
        error: `No se puede eliminar la mesa: tiene el turno #${turnosActivos[0].numero} en atención activo.`
      })
    }

    // Desasignar operador primero
    await fastify.db.query('UPDATE mesas SET operador_id = NULL WHERE id = $1', [mesaId])

    try {
      const { rows: [mesa] } = await fastify.db.query(
        `DELETE FROM mesas WHERE id = $1 RETURNING id, numero, nombre`,
        [mesaId]
      )

      if (!mesa) return reply.status(404).send({ error: 'Mesa no encontrada' })

      await fastify.db.query(
        `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
         VALUES ($1, 'ADMIN_ACTION', $2, $3)`,
        [request.user.id, request.ip, JSON.stringify({ tipo: 'MESA_ELIMINADA', mesa_id: mesaId, numero: mesa.numero })]
      )

      await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa_eliminada_id: mesaId })
      return reply.send({ success: true, message: `Mesa ${mesa.numero} eliminada exitosamente.` })
    } catch (err) {
      // Si tiene historial que impide eliminación física, inactivar la mesa
      await fastify.db.query(
        `UPDATE mesas SET estado = 'inactiva', operador_id = NULL WHERE id = $1`,
        [mesaId]
      )
      await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa_desactivada_id: mesaId })
      return reply.send({
        success: true,
        message: 'Mesa desactivada y desasignada debido a registros históricos vinculados.'
      })
    }
  })
}
