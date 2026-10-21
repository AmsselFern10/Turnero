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
       LEFT JOIN usuarios u ON m.operador_id = u.id AND u.eliminado_en IS NULL
       LEFT JOIN turnos t ON t.mesa_id = m.id AND t.estado = 'en_atencion' AND t.llamado_en >= CURRENT_DATE
       LEFT JOIN (
         SELECT mesa_id,
                COUNT(*) AS atendidos_hoy,
                ROUND(AVG(duracion_atencion_seg)) AS tiempo_promedio_seg
         FROM turnos
         WHERE estado = 'atendido' AND creado_en >= date_trunc('day', NOW())
         GROUP BY mesa_id
       ) th ON th.mesa_id = m.id
       WHERE m.estado != 'eliminada' AND m.eliminado_en IS NULL
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

    const { rows: conflicto } = await fastify.db.query(
      `SELECT id FROM mesas WHERE numero = $1 AND estado != 'eliminada' AND eliminado_en IS NULL`,
      [numero]
    )
    if (conflicto.length > 0) {
      return reply.status(409).send({ error: `El número de mesa ${numero} ya está asignado a otra ventanilla.` })
    }

    const { rows: [mesa] } = await fastify.db.query(
      `INSERT INTO mesas (numero, nombre) VALUES ($1, $2)
       RETURNING id, numero, nombre, estado`,
      [numero, nombre]
    )

    return reply.status(201).send({ mesa })
  })

  // ── PATCH /mesas/:id/asignar — Asignar operador a mesa (RF-ADM-04) ─────────
  fastify.patch('/:id/asignar', {
    preHandler: [fastify.authorizeRol('admin')],
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
    const mesaId = parseInt(request.params.id)
    const { operador_id } = request.body
    try {
      // Validar si la mesa actual está siendo operada por un admin
      const { rows: [mesaActual] } = await fastify.db.query(
        `SELECT m.id, m.numero, m.operador_id, u.rol AS operador_rol, u.nombre_completo AS operador_nombre
         FROM mesas m
         LEFT JOIN usuarios u ON m.operador_id = u.id
         WHERE m.id = $1`,
        [mesaId]
      )
      if (!mesaActual) return reply.status(404).send({ error: 'Mesa no encontrada' })

      if (mesaActual.operador_id && mesaActual.operador_rol === 'admin' && mesaActual.operador_id !== request.user.id) {
        return reply.status(403).send({
          error: `Esta mesa está siendo operada por el administrador ${mesaActual.operador_nombre}. Solo él puede liberar o reasignar su mesa.`
        })
      }

      // Validar que el operador no está ya asignado a otra mesa (RF-AUTH-07)
      if (operador_id) {
        const { rows } = await fastify.db.query(
          `SELECT id, numero FROM mesas
           WHERE operador_id = $1 AND id != $2 AND estado NOT IN ('inactiva', 'eliminada')`,
          [operador_id, mesaId]
        )

        if (rows.length > 0) {
          return reply.status(409).send({
            error: `Este operador ya está asignado a la Mesa ${rows[0].numero}. Un operador no puede estar en dos mesas.`
          })
        }
      }

      // Si se reasigna o libera la mesa, cerrar cualquier turno en atención previo como cancelado
      const { rows: turnosACancelar } = await fastify.db.query(
        `UPDATE turnos
         SET estado = 'cancelado', finalizado_en = NOW()
         WHERE mesa_id = $1 AND estado = 'en_atencion'
         RETURNING id, numero`,
        [mesaId]
      )
      for (const t of turnosACancelar) {
        await fastify.db.query(
          `INSERT INTO audit_log (mesa_id, operador_id, turno_id, accion, ip_origen, metadata_json)
           VALUES ($1, $2, $3, 'TURNO_CANCELADO', $4, $5)`,
          [mesaId, request.user.id, t.id, request.ip, JSON.stringify({ motivo: 'mesa_reasignada_o_liberada_admin', turno_numero: t.numero })]
        )
        await fastify.broadcast('admin:all', 'turno_cancelado', { turno_id: t.id, turno_numero: t.numero, mesa_id: mesaId })
        await fastify.broadcast('lote:activo', 'rezagados_actualizados', { accion: 'cancelado', turno_id: t.id, turno_numero: t.numero, mesa_id: mesaId })
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

      // Notificar al admin
      await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa })
      // Notificar a logins abiertos: la lista de mesas disponibles cambia
      await fastify.broadcast('tv:global', 'mesas_disponibles_actualizadas', {
        mesa,
        accion: operador_id ? 'tomada' : 'liberada'
      })
      // Si hay un operador asignado: notificar al login para auto-redirigir al operador afectado.
      if (operador_id && mesa.estado === 'activa') {
        await fastify.broadcast('tv:global', 'operador_asignado_por_admin', {
          operador_id: Number(operador_id),
          mesa: { id: mesa.id, numero: mesa.numero, nombre: mesa.nombre, estado: mesa.estado }
        })
      }
      // F-2: Si se quita el operador (libera la mesa), notificar al canal mesa para que
      // el panel del operador que estaba trabajando vea el aviso inmediato y no siga actuando.
      if (!operador_id) {
        await fastify.broadcast(`mesa:${mesaId}`, 'mesa_inactivada', { mesa, motivo: 'operador_removido_por_admin' })
        if (mesaActual.operador_id) {
          await fastify.broadcast('tv:global', 'operador_desasignado_por_admin', {
            operador_id: Number(mesaActual.operador_id),
            mesa_id: mesaId
          })
        }
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
    preHandler: [fastify.authorizeRol('admin', 'operador')],
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

    const { rows: [mesaActual] } = await fastify.db.query(
      `SELECT m.id, m.numero, m.operador_id, u.rol AS operador_rol, u.nombre_completo AS operador_nombre
       FROM mesas m
       LEFT JOIN usuarios u ON m.operador_id = u.id
       WHERE m.id = $1`,
      [mesaId]
    )
    if (!mesaActual) return reply.status(404).send({ error: 'Mesa no encontrada' })

    // Operadores solo pueden pausar/activar su propia mesa (no inactivar)
    if (request.user.rol === 'operador') {
      if (estado === 'inactiva') {
        return reply.status(403).send({ error: 'Los operadores no pueden inactivar mesas.' })
      }
      if (mesaActual.operador_id !== request.user.id) {
        return reply.status(403).send({ error: 'Solo puedes cambiar el estado de tu propia mesa' })
      }
    }

    // Si un admin está operando la mesa, solo él puede modificar su estado
    if (mesaActual.operador_id && mesaActual.operador_rol === 'admin' && mesaActual.operador_id !== request.user.id) {
      return reply.status(403).send({
        error: `Esta mesa está siendo operada por el administrador ${mesaActual.operador_nombre}. Solo él puede cambiar el estado de su mesa.`
      })
    }

    // Al inactivar: si hay turno en atención, se cierra como cancelado (no concluido)
    if (estado === 'inactiva') {
      const { rows: turnosInactivados } = await fastify.db.query(
        `UPDATE turnos
         SET estado = 'cancelado', finalizado_en = NOW()
         WHERE mesa_id = $1 AND estado = 'en_atencion'
         RETURNING id, numero`,
        [mesaId]
      )
      for (const t of turnosInactivados) {
        await fastify.db.query(
          `INSERT INTO audit_log (mesa_id, operador_id, turno_id, accion, ip_origen, metadata_json)
           VALUES ($1, $2, $3, 'TURNO_CANCELADO', $4, $5)`,
          [mesaId, request.user.id, t.id, request.ip, JSON.stringify({ motivo: 'mesa_inactivada_admin', turno_numero: t.numero })]
        )
        await fastify.broadcast('admin:all', 'turno_cancelado', { turno_id: t.id, turno_numero: t.numero, mesa_id: mesaId })
        await fastify.broadcast('lote:activo', 'rezagados_actualizados', { accion: 'cancelado', turno_id: t.id, turno_numero: t.numero, mesa_id: mesaId })
      }
    }

    // Al inactivar: liberar operador asignado. Al pausar: mantener asignación.
    const updateQuery = estado === 'inactiva'
      ? `UPDATE mesas SET estado = $1, operador_id = NULL WHERE id = $2
         RETURNING id, numero, nombre, estado, operador_id`
      : `UPDATE mesas SET estado = $1 WHERE id = $2
         RETURNING id, numero, nombre, estado, operador_id`

    const { rows: [mesa] } = await fastify.db.query(updateQuery, [estado, mesaId])

    if (!mesa) return reply.status(404).send({ error: 'Mesa no encontrada' })

    const accionLog = estado === 'activa' ? 'MESA_ACTIVADA' : estado === 'pausada' ? 'MESA_PAUSADA' : 'MESA_INACTIVADA'
    await fastify.db.query(
      `INSERT INTO audit_log (mesa_id, operador_id, accion, ip_origen)
       VALUES ($1, $2, $3, $4)`,
      [mesaId, request.user.id, accionLog, request.ip]
    )

    // Notificar al panel del operador en esa mesa para que reaccione en tiempo real
    const eventoMesa = estado === 'activa' ? 'mesa_activada' : estado === 'pausada' ? 'mesa_pausada' : 'mesa_inactivada'
    await fastify.broadcast(`mesa:${mesaId}`, eventoMesa, { mesa })
    await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa })
    await fastify.broadcast('tv:global', 'mesas_disponibles_actualizadas', { mesa, accion: estado === 'inactiva' ? 'eliminada' : 'actualizada' })
    if (estado === 'inactiva' && mesaActual.operador_id) {
      await fastify.broadcast('tv:global', 'operador_desasignado_por_admin', {
        operador_id: Number(mesaActual.operador_id),
        mesa_id: mesaId
      })
    }

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
        "SELECT id FROM mesas WHERE numero = $1 AND id != $2 AND estado != 'eliminada' AND eliminado_en IS NULL",
        [numero, mesaId]
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

    // Validar si la mesa está siendo operada por otro admin
    const { rows: [mesaActual] } = await fastify.db.query(
      `SELECT m.id, m.numero, m.operador_id, u.rol AS operador_rol, u.nombre_completo AS operador_nombre
       FROM mesas m
       LEFT JOIN usuarios u ON m.operador_id = u.id
       WHERE m.id = $1`,
      [mesaId]
    )
    if (!mesaActual) return reply.status(404).send({ error: 'Mesa no encontrada' })

    if (mesaActual.operador_id && mesaActual.operador_rol === 'admin' && mesaActual.operador_id !== request.user.id) {
      return reply.status(403).send({
        error: `No se puede eliminar la mesa: está siendo operada por el administrador ${mesaActual.operador_nombre}.`
      })
    }

    // 1. Validar si tiene turno en atención con operador realmente asignado
    const { rows: turnosConOperador } = await fastify.db.query(
      `SELECT t.id, t.numero, m.operador_id, u.nombre_completo AS operador_nombre
       FROM turnos t
       JOIN mesas m ON t.mesa_id = m.id
       LEFT JOIN usuarios u ON m.operador_id = u.id
       WHERE t.mesa_id = $1 AND t.estado = 'en_atencion' AND m.operador_id IS NOT NULL`,
      [mesaId]
    )
    if (turnosConOperador.length > 0) {
      return reply.status(409).send({
        error: `No se puede eliminar la ventanilla mientras el operador ${turnosConOperador[0].operador_nombre || 'asignado'} tenga el turno #${turnosConOperador[0].numero} en atención activo.`
      })
    }

    // 2. Si hay turno huérfano (sin operador), cerrarlo como cancelado
    const { rows: turnosHuerfanos } = await fastify.db.query(
      `UPDATE turnos
       SET estado = 'cancelado', finalizado_en = NOW()
       WHERE mesa_id = $1 AND estado = 'en_atencion'
       RETURNING id, numero`,
      [mesaId]
    )
    for (const th of turnosHuerfanos) {
      await fastify.db.query(
        `INSERT INTO audit_log (mesa_id, turno_id, accion, ip_origen, metadata_json)
         VALUES ($1, $2, 'TURNO_CANCELADO', $3, $4)`,
        [mesaId, th.id, request.ip, JSON.stringify({ motivo: 'eliminacion_mesa_turno_huerfano', turno_numero: th.numero })]
      )
      await fastify.broadcast('admin:all', 'turno_cancelado', { turno_id: th.id, turno_numero: th.numero, mesa_id: mesaId })
      await fastify.broadcast('lote:activo', 'rezagados_actualizados', { accion: 'cancelado', turno_id: th.id, turno_numero: th.numero, mesa_id: mesaId })
    }


    // Desasignar operador primero
    await fastify.db.query('UPDATE mesas SET operador_id = NULL WHERE id = $1', [mesaId])

    // Marcar como eliminada permanentemente (libera el número de mesa para volver a usarlo)
    const { rows: [mesa] } = await fastify.db.query(
      `UPDATE mesas
       SET estado = 'eliminada', operador_id = NULL, eliminado_en = NOW()
       WHERE id = $1 AND estado != 'eliminada'
       RETURNING id, numero, nombre`,
      [mesaId]
    )

    if (!mesa) return reply.status(404).send({ error: 'Mesa no encontrada o ya eliminada' })

    await fastify.db.query(
      `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, 'ADMIN_ACTION', $2, $3)`,
      [request.user.id, request.ip, JSON.stringify({ tipo: 'MESA_ELIMINADA', mesa_id: mesaId, numero: mesa.numero })]
    )

    await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa_eliminada_id: mesaId })
    await fastify.broadcast('tv:global', 'mesas_disponibles_actualizadas', {
      mesa: { id: mesaId, numero: mesa.numero, estado: 'eliminada' },
      accion: 'tomada'
    })
    // F-3: Notificar al panel del operador que tenía esta mesa para que vea el aviso inmediato
    await fastify.broadcast(`mesa:${mesaId}`, 'mesa_inactivada', { mesa: { id: mesaId, numero: mesa.numero }, motivo: 'mesa_eliminada_por_admin' })

    return reply.send({ success: true, message: `Mesa ${mesa.numero} eliminada exitosamente.` })
  })
}

