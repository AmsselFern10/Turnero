'use strict'

/**
 * Módulo de administración — Rutas Fastify
 * Prefijo: /admin
 * Acceso: admin y supervisor
 */
module.exports = async function adminRoutes (fastify) {

  // ── GET /admin/kpis — KPIs en tiempo real (RF-ADM-01) ────────────────────
  // Cache Redis 1 s: el panel admin refresca cada segundo via WS kpi_update;
  // esta ruta es el snapshot inicial y la usan los supervisores — limitar queries.
  fastify.get('/kpis', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const CACHE_KEY = 'admin:kpis'
    try {
      const cached = await fastify.redis.get(CACHE_KEY)
      if (cached) return reply.header('X-Cache', 'HIT').send(JSON.parse(cached))
    } catch (_) {}

    const [kpisTurnos, loteActivo, mesasActivas] = await Promise.all([
      fastify.db.query(`
        SELECT
          COUNT(*) FILTER (WHERE estado = 'atendido')                        AS atendidos_hoy,
          COUNT(*) FILTER (WHERE estado = 'cancelado')                       AS cancelados_hoy,
          COUNT(*) FILTER (WHERE estado = 'en_atencion')                     AS en_atencion_ahora,
          COUNT(*) FILTER (WHERE estado = 'esperando')                       AS esperando_hoy,
          ROUND(AVG(duracion_atencion_seg) FILTER (WHERE estado = 'atendido' AND duracion_atencion_seg IS NOT NULL)) AS promedio_seg
        FROM turnos
        WHERE creado_en >= date_trunc('day', NOW())
      `),
      fastify.db.query(`
        SELECT id, numero_lote, numero_desde, numero_hasta, ultimo_numero_llamado, estado,
               numero_hasta - ultimo_numero_llamado AS vouchers_restantes,
               ROUND((ultimo_numero_llamado::numeric / NULLIF(numero_hasta,0)) * 100, 1) AS progreso_pct
        FROM lotes_voucher WHERE estado = 'activo' LIMIT 1
      `),
      fastify.db.query(`
        SELECT COUNT(*) FILTER (WHERE estado = 'activa')  AS activas,
               COUNT(*) FILTER (WHERE estado = 'pausada') AS pausadas
        FROM mesas
      `)
    ])

    const t = kpisTurnos.rows[0]
    const m = mesasActivas.rows[0]

    const resultado = {
      atendidos_hoy:     parseInt(t.atendidos_hoy),
      cancelados_hoy:    parseInt(t.cancelados_hoy),
      en_atencion_ahora: parseInt(t.en_atencion_ahora),
      turnos_en_espera:  parseInt(t.esperando_hoy || 0),
      promedio_seg:      t.promedio_seg ? parseInt(t.promedio_seg) : null,
      mesas_activas:     parseInt(m.activas),
      mesas_pausadas:    parseInt(m.pausadas),
      lote:              loteActivo.rows[0] || null
    }

    try { await fastify.redis.set(CACHE_KEY, JSON.stringify(resultado), 'EX', 1) } catch (_) {}

    return reply.header('X-Cache', 'MISS').send(resultado)
  })

  // ── GET /admin/usuarios — Listar usuarios (RF-ADM-06) ────────────────────
  fastify.get('/usuarios', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT u.id, u.username, u.nombre_completo, u.rol, u.activo, u.creado_en,
              m.id     AS mesa_id,
              m.numero AS mesa_numero,
              m.nombre AS mesa_nombre
       FROM usuarios u
       LEFT JOIN mesas m ON m.operador_id = u.id AND m.estado NOT IN ('inactiva', 'eliminada')
       WHERE u.eliminado_en IS NULL
       ORDER BY u.rol, u.nombre_completo`
    )
    return reply.send({ usuarios: rows })
  })

  // ── POST /admin/usuarios — Crear usuario (RF-ADM-06) ─────────────────────
  fastify.post('/usuarios', {
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      body: {
        type: 'object',
        required: ['username', 'nombre_completo', 'password', 'rol'],
        properties: {
          username:       { type: 'string', minLength: 3, maxLength: 30 },
          nombre_completo:{ type: 'string', minLength: 2, maxLength: 100 },
          password:       { type: 'string', minLength: 4, maxLength: 128 },
          rol:            { type: 'string', enum: ['operador', 'admin'] }
        }
      }
    }
  }, async (request, reply) => {
    const { username, nombre_completo, password, rol } = request.body

    const { rows: conflicto } = await fastify.db.query(
      'SELECT id FROM usuarios WHERE LOWER(username) = LOWER($1) AND eliminado_en IS NULL',
      [username]
    )
    if (conflicto.length > 0) {
      return reply.status(409).send({ error: `El usuario '${username}' ya existe.` })
    }

    const bcrypt = require('bcrypt')
    const hash   = await bcrypt.hash(password, parseInt(process.env.BCRYPT_COST || '12'))

    const { rows: [usuario] } = await fastify.db.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, nombre_completo, rol, activo`,
      [username, nombre_completo, hash, rol]
    )

    await fastify.db.query(
      `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, 'USUARIO_CREADO', $2, $3)`,
      [request.user.id, request.ip, JSON.stringify({ username, rol })]
    )

    return reply.status(201).send({ usuario })
  })

  // ── PATCH /admin/usuarios/:id — Editar usuario (RF-ADM-06) ───────────────
  fastify.patch('/usuarios/:id', {
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      body: {
        type: 'object',
        properties: {
          nombre_completo: { type: 'string', minLength: 2, maxLength: 100 },
          username:        { type: 'string', minLength: 3, maxLength: 50 },
          rol:             { type: 'string', enum: ['operador', 'admin'] },
          activo:          { type: 'boolean' },
          password:        { type: 'string', minLength: 4, maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    const userId = parseInt(request.params.id)
    const campos = []
    const vals   = []
    let i = 1

    if (request.body.nombre_completo !== undefined) {
      campos.push(`nombre_completo = $${i++}`)
      vals.push(request.body.nombre_completo)
    }
    if (request.body.username !== undefined) {
      const { rows: conflicto } = await fastify.db.query(
        'SELECT id FROM usuarios WHERE LOWER(username) = LOWER($1) AND id != $2 AND eliminado_en IS NULL',
        [request.body.username, userId]
      )
      if (conflicto.length > 0) {
        return reply.status(409).send({ error: `El usuario '${request.body.username}' ya existe.` })
      }
      campos.push(`username = $${i++}`)
      vals.push(request.body.username)
    }
    if (request.body.rol !== undefined) {
      campos.push(`rol = $${i++}`)
      vals.push(request.body.rol)
    }
    if (userId === request.user.id) {
      if (request.body.activo === false) {
        return reply.status(400).send({ error: 'No puede desactivar su propia cuenta mientras tiene la sesión activa.' })
      }
      if (request.body.rol && request.body.rol !== 'admin') {
        return reply.status(400).send({ error: 'No puede degradar su propio rol de administrador.' })
      }
    }

    // Protección: no dejar al sistema sin ningún admin activo
    if (request.body.activo === false) {
      const { rows: [admCount] } = await fastify.db.query(
        `SELECT COUNT(*) AS total FROM usuarios WHERE rol = 'admin' AND activo = true AND id != $1`,
        [userId]
      )
      if (parseInt(admCount.total, 10) === 0) {
        return reply.status(400).send({ error: 'No se puede desactivar al único administrador activo del sistema. Active otro administrador primero.' })
      }
    }

    if (request.body.activo !== undefined) {
      campos.push(`activo = $${i++}`)
      vals.push(request.body.activo)

      // Si se desactiva el usuario, cancelar turnos en atención de sus mesas y liberarlas
      if (request.body.activo === false) {
        const { rows: mesasUsuario } = await fastify.db.query(
          `SELECT id FROM mesas WHERE operador_id = $1`, [userId]
        )
        for (const m of mesasUsuario) {
          const { rows: turnosCanc } = await fastify.db.query(
            `UPDATE turnos SET estado = 'cancelado', finalizado_en = NOW()
             WHERE mesa_id = $1 AND estado = 'en_atencion'
             RETURNING id, numero`,
            [m.id]
          )
          for (const tc of turnosCanc) {
            await fastify.db.query(
              `INSERT INTO audit_log (mesa_id, operador_id, turno_id, accion, ip_origen, metadata_json)
               VALUES ($1, $2, $3, 'TURNO_CANCELADO', $4, $5)`,
              [m.id, request.user.id, tc.id, request.ip, JSON.stringify({ motivo: 'usuario_desactivado_por_admin', turno_numero: tc.numero })]
            )
            await fastify.broadcast('admin:all', 'turno_cancelado', { turno_id: tc.id, turno_numero: tc.numero, mesa_id: m.id })
            await fastify.broadcast('lote:activo', 'rezagados_actualizados', { accion: 'cancelado', turno_id: tc.id, turno_numero: tc.numero, mesa_id: m.id })
          }
        }
        const { rows: mesasLiberadas } = await fastify.db.query(
          `UPDATE mesas SET operador_id = NULL, estado = 'inactiva'
           WHERE operador_id = $1
           RETURNING id, numero, nombre, estado, operador_id`,
          [userId]
        )
        for (const mesa of mesasLiberadas) {
          await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa })
          await fastify.broadcast('tv:global', 'mesas_disponibles_actualizadas', { mesa, accion: 'liberada' })
          // F-4a: notificar al panel del operador afectado para aviso inmediato
          await fastify.broadcast(`mesa:${mesa.id}`, 'mesa_inactivada', { mesa, motivo: 'usuario_desactivado_por_admin' })
        }
      }
    }
    if (request.body.password) {
      const bcrypt = require('bcrypt')
      campos.push(`password_hash = $${i++}`)
      vals.push(await bcrypt.hash(request.body.password, parseInt(process.env.BCRYPT_COST || '12')))
    }

    if (campos.length === 0) {
      return reply.status(400).send({ error: 'No hay campos para actualizar' })
    }

    vals.push(userId)
    const { rows: [usuario] } = await fastify.db.query(
      `UPDATE usuarios SET ${campos.join(', ')} WHERE id = $${i}
       RETURNING id, username, nombre_completo, rol, activo`,
      vals
    )

    if (!usuario) return reply.status(404).send({ error: 'Usuario no encontrado' })

    await fastify.db.query(
      `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, 'USUARIO_EDITADO', $2, $3)`,
      [request.user.id, request.ip, JSON.stringify({ usuario_editado_id: userId })]
    )

    return reply.send({ usuario })
  })

  // -- DELETE /admin/usuarios/:id -- Eliminar usuario (RF-ADM-06) ----------
  fastify.delete('/usuarios/:id', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const userId = parseInt(request.params.id)

    if (userId === request.user.id) {
      return reply.status(400).send({ error: 'No puede eliminar su propia cuenta mientras tiene la sesion activa.' })
    }

    // Proteccion: no eliminar al unico admin activo
    const { rows: [uTarget] } = await fastify.db.query(
      'SELECT rol FROM usuarios WHERE id = $1 AND eliminado_en IS NULL', [userId]
    )
    if (!uTarget) return reply.status(404).send({ error: 'Usuario no encontrado o ya eliminado' })

    if (uTarget.rol === 'admin') {
      const { rows: [admCount] } = await fastify.db.query(
        `SELECT COUNT(*) AS total FROM usuarios WHERE rol = 'admin' AND activo = true AND eliminado_en IS NULL AND id != $1`,
        [userId]
      )
      if (parseInt(admCount.total, 10) === 0) {
        return reply.status(400).send({ error: 'No se puede eliminar al único administrador activo del sistema.' })
      }
    }

    // Si el usuario tenía mesas asignadas, cancelar turnos en atención y liberarlas
    const { rows: mesasUsuario } = await fastify.db.query(
      `SELECT id FROM mesas WHERE operador_id = $1`, [userId]
    )
    for (const m of mesasUsuario) {
      const { rows: turnosCanc } = await fastify.db.query(
        `UPDATE turnos SET estado = 'cancelado', finalizado_en = NOW()
         WHERE mesa_id = $1 AND estado = 'en_atencion'
         RETURNING id, numero`,
        [m.id]
      )
      for (const tc of turnosCanc) {
        await fastify.db.query(
          `INSERT INTO audit_log (mesa_id, operador_id, turno_id, accion, ip_origen, metadata_json)
           VALUES ($1, $2, $3, 'TURNO_CANCELADO', $4, $5)`,
          [m.id, request.user.id, tc.id, request.ip, JSON.stringify({ motivo: 'usuario_eliminado_por_admin', turno_numero: tc.numero })]
        )
        await fastify.broadcast('admin:all', 'turno_cancelado', { turno_id: tc.id, turno_numero: tc.numero, mesa_id: m.id })
        await fastify.broadcast('lote:activo', 'rezagados_actualizados', { accion: 'cancelado', turno_id: tc.id, turno_numero: tc.numero, mesa_id: m.id })
      }
    }

    // Desasignar de cualquier mesa y guardar cuáles eran para broadcast WS
    const { rows: mesasLiberadas } = await fastify.db.query(
      `UPDATE mesas SET operador_id = NULL, estado = 'inactiva'
       WHERE operador_id = $1
       RETURNING id, numero, nombre, estado, operador_id`,
      [userId]
    )

    // Borrado lógico permanente: libera el username para que pueda ser reusado si se crea de nuevo
    const { rows: [usuario] } = await fastify.db.query(
      `UPDATE usuarios
       SET eliminado_en = NOW(), activo = false
       WHERE id = $1 AND eliminado_en IS NULL
       RETURNING id, username`,
      [userId]
    )
    if (!usuario) return reply.status(404).send({ error: 'Usuario no encontrado' })

    await fastify.db.query(
      `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, 'ADMIN_ACTION', $2, $3)`,
      [request.user.id, request.ip, JSON.stringify({ tipo: 'USUARIO_ELIMINADO', usuario_eliminado_id: userId, username: usuario.username })]
    )

    for (const mesa of mesasLiberadas) {
      await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa })
      await fastify.broadcast('tv:global', 'mesas_disponibles_actualizadas', { mesa, accion: 'liberada' })
      // F-4b: notificar al panel del operador eliminado para aviso inmediato
      await fastify.broadcast(`mesa:${mesa.id}`, 'mesa_inactivada', { mesa, motivo: 'usuario_eliminado_por_admin' })
    }

    await fastify.broadcast('admin:all', 'usuario_eliminado', { id: userId, username: usuario.username })

    return reply.send({ success: true, message: `Usuario ${usuario.username} eliminado exitosamente.` })
  })


  // ── GET /admin/auditoria — Historial por fecha (RF-ADM-09) ───────────────
  fastify.get('/auditoria', {
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          fecha:  { type: 'string', format: 'date' },
          pagina: { type: 'integer', minimum: 1, default: 1 },
          limite: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async (request, reply) => {
    const fecha  = request.query.fecha || new Date().toISOString().slice(0, 10)
    const pagina = request.query.pagina || 1
    const limite = request.query.limite || 50
    const offset = (pagina - 1) * limite

    const { rows, rowCount } = await fastify.db.query(
      `SELECT al.id, al.accion, al.timestamp, al.ip_origen, al.metadata_json,
              u.nombre_completo AS operador_nombre,
              m.numero AS mesa_numero,
              t.numero AS turno_numero,
              lv.numero_lote
       FROM audit_log al
       LEFT JOIN usuarios u ON al.operador_id = u.id
       LEFT JOIN mesas m ON al.mesa_id = m.id
       LEFT JOIN turnos t ON al.turno_id = t.id
       LEFT JOIN lotes_voucher lv ON al.lote_id = lv.id
       WHERE al.timestamp >= ($1::date)::timestamptz AND al.timestamp < (($1::date + 1)::timestamptz)
       ORDER BY al.timestamp DESC, al.id DESC
       LIMIT $2 OFFSET $3`,
      [fecha, limite, offset]
    )

    return reply.send({ registros: rows, pagina, limite })
  })

  // ── GET /admin/reporte/csv — Exportar reporte del día (RF-ADM-08) (Retrocompatibilidad) ──
  fastify.get('/reporte/csv', {
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          fecha: { type: 'string', format: 'date' }
        }
      }
    }
  }, async (request, reply) => {
    const fecha = request.query.fecha || new Date().toISOString().slice(0, 10)

    const { rows } = await fastify.db.query(
      `SELECT t.numero AS turno, m.numero AS mesa, u.nombre_completo AS operador,
              t.origen, t.estado,
              t.llamado_en, t.finalizado_en,
              t.duracion_espera_seg, t.duracion_atencion_seg,
              lv.numero_lote AS lote
       FROM turnos t
       LEFT JOIN mesas m ON t.mesa_id = m.id
       LEFT JOIN usuarios u ON t.operador_id = u.id
       LEFT JOIN lotes_voucher lv ON t.lote_id = lv.id
       WHERE t.creado_en >= ($1::date)::timestamptz AND t.creado_en < (($1::date + 1)::timestamptz)
       ORDER BY t.llamado_en ASC NULLS LAST`,
      [fecha]
    )

    // Generar CSV
    const headers = ['turno','mesa','operador','lote','origen','estado','llamado_en','finalizado_en','duracion_espera_seg','duracion_atencion_seg']
    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))
    ].join('\n')

    return reply
      .header('Content-Type', 'text/csv')
      .header('Content-Disposition', `attachment; filename="reporte_${fecha}.csv"`)
      .send(csv)
  })

  // ── GET /admin/reportes/datos — Consulta filtrada de reportes y métricas ────
  fastify.get('/reportes/datos', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const { fecha, mesa_id, operador_id, estado } = request.query
    const fechaRef = fecha || new Date().toISOString().slice(0, 10)

    const params = [fechaRef]
    let whereExtra = ''
    let idx = 2

    if (mesa_id) {
      whereExtra += ` AND t.mesa_id = $${idx++}`
      params.push(parseInt(mesa_id))
    }
    if (operador_id) {
      whereExtra += ` AND t.operador_id = $${idx++}`
      params.push(parseInt(operador_id))
    }
    if (estado && estado !== 'todos') {
      whereExtra += ` AND t.estado = $${idx++}`
      params.push(estado)
    }

    // 1. KPIs Agregados
    // - promedio_*: NULL cuando no hay atendidos (no 0) para que el cliente muestre "--"
    // - mesas_activas: mesas que tuvieron actividad ese día (con turnos registrados)
    const { rows: [kpis] } = await fastify.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE t.estado = 'atendido') AS total_atendidos,
         COUNT(*) FILTER (WHERE t.estado = 'cancelado') AS total_cancelados,
         COUNT(*) AS total_turnos,
         ROUND(AVG(t.duracion_atencion_seg) FILTER (WHERE t.estado = 'atendido')) AS promedio_atencion_seg,
         ROUND(AVG(t.duracion_espera_seg)   FILTER (WHERE t.estado = 'atendido')) AS promedio_espera_seg,
         COUNT(DISTINCT t.mesa_id) FILTER (WHERE t.mesa_id IS NOT NULL) AS mesas_con_actividad
       FROM turnos t
       WHERE t.creado_en >= ($1::date)::timestamptz
         AND t.creado_en <  (($1::date + 1)::timestamptz)
         ${whereExtra}`,
      params
    )

    // mesas_activas = mesas con estado='activa' y operador asignado AHORA (visión operativa real)
    // Se calcula siempre sin filtros de fecha para que refleje la configuración actual
    const { rows: [mesasOpRows] } = await fastify.db.query(
      `SELECT COUNT(*) AS mesas_activas
       FROM mesas
       WHERE estado = 'activa' AND operador_id IS NOT NULL`
    )

    // 2. Resumen por Mesa — solo mesas con actividad en la fecha O actualmente activas con operador
    // HAVING filtra mesas sin ningún turno en la fecha que además estén inactivas o sin operador
    const { rows: mesasResumen } = await fastify.db.query(
      `SELECT
         m.id AS mesa_id,
         m.numero AS mesa_numero,
         m.nombre AS mesa_nombre,
         m.estado AS mesa_estado,
         COUNT(t.id) FILTER (WHERE t.estado = 'atendido') AS atendidos,
         COUNT(t.id) FILTER (WHERE t.estado = 'cancelado') AS cancelados,
         COUNT(t.id) AS total_turnos_dia,
         ROUND(AVG(t.duracion_atencion_seg) FILTER (WHERE t.estado = 'atendido')) AS promedio_atencion_seg
       FROM mesas m
       LEFT JOIN turnos t ON t.mesa_id = m.id
         AND t.creado_en >= ($1::date)::timestamptz
         AND t.creado_en <  (($1::date + 1)::timestamptz)
       GROUP BY m.id, m.numero, m.nombre, m.estado, m.operador_id
       HAVING COUNT(t.id) > 0 OR (m.estado = 'activa' AND m.operador_id IS NOT NULL)
       ORDER BY m.numero ASC`,
      [fechaRef]
    )

    // 3. Listado Detallado de Turnos
    const { rows: turnos } = await fastify.db.query(
      `SELECT
         t.id, t.numero, t.estado, t.origen,
         t.llamado_en, t.finalizado_en,
         t.duracion_atencion_seg, t.duracion_espera_seg,
         m.numero AS mesa_numero, m.nombre AS mesa_nombre,
         u.nombre_completo AS operador_nombre,
         lv.numero_lote AS lote_numero
       FROM turnos t
       LEFT JOIN mesas m ON t.mesa_id = m.id
       LEFT JOIN usuarios u ON t.operador_id = u.id
       LEFT JOIN lotes_voucher lv ON t.lote_id = lv.id
       WHERE t.creado_en >= ($1::date)::timestamptz
         AND t.creado_en <  (($1::date + 1)::timestamptz)
         ${whereExtra}
       ORDER BY t.llamado_en DESC NULLS LAST, t.id DESC
       LIMIT 500`,
      params
    )

    // Serializar preservando null para promedios (el frontend mostrará '--')
    const toInt = v => (v === null || v === undefined) ? null : parseInt(v, 10)
    const toIntZero = v => parseInt(v || '0', 10)

    return reply.send({
      fecha: fechaRef,
      kpis: {
        total_atendidos:      toIntZero(kpis?.total_atendidos),
        total_cancelados:     toIntZero(kpis?.total_cancelados),
        total_turnos:         toIntZero(kpis?.total_turnos),
        promedio_atencion_seg: toInt(kpis?.promedio_atencion_seg),   // null → '--' en cliente
        promedio_espera_seg:   toInt(kpis?.promedio_espera_seg),     // null → '--' en cliente
        mesas_activas:         toIntZero(mesasOpRows?.mesas_activas)  // mesas activas con operador ahora
      },
      mesas_resumen: mesasResumen.map(m => ({
        mesa_id:               m.mesa_id,
        mesa_numero:           m.mesa_numero,
        mesa_nombre:           m.mesa_nombre,
        mesa_estado:           m.mesa_estado,
        atendidos:             toIntZero(m.atendidos),
        cancelados:            toIntZero(m.cancelados),
        promedio_atencion_seg: toInt(m.promedio_atencion_seg)         // null → '--' en cliente
      })),
      turnos
    })
  })


  // ── GET /admin/reportes/exportar-xls — Exportar reporte Excel XLS ────────────
  // Semaforo: solo 1 descarga concurrente para evitar saturar BD y RAM.
  const semáforoReporte = async (request, reply) => {
    if (fastify._reporteSemaforo >= 1) {
      return reply.status(429).header('Retry-After', '15').send({
        error: { codigo: 'reporte_en_proceso', mensaje: 'Ya hay un reporte generándose. Intente en unos segundos.' }
      })
    }
  }
  fastify.get('/reportes/exportar-xls', {
    preHandler: [fastify.authorizeRol('admin'), semáforoReporte]
  }, async (request, reply) => {
    fastify._reporteSemaforo++
    try {
    const { fecha, mesa_id, operador_id, estado } = request.query
    const fechaRef = fecha || new Date().toISOString().slice(0, 10)

    const params = [fechaRef]
    let whereExtra = ''
    let idx = 2

    if (mesa_id) {
      whereExtra += ` AND t.mesa_id = $${idx++}`
      params.push(parseInt(mesa_id))
    }
    if (operador_id) {
      whereExtra += ` AND t.operador_id = $${idx++}`
      params.push(parseInt(operador_id))
    }
    if (estado && estado !== 'todos') {
      whereExtra += ` AND t.estado = $${idx++}`
      params.push(estado)
    }

    const { rows: [kpis] } = await fastify.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE t.estado = 'atendido') AS total_atendidos,
         COUNT(*) FILTER (WHERE t.estado = 'cancelado') AS total_cancelados,
         COUNT(*) AS total_turnos,
         COALESCE(ROUND(AVG(t.duracion_atencion_seg) FILTER (WHERE t.estado = 'atendido')), 0) AS promedio_atencion_seg,
         COALESCE(ROUND(AVG(t.duracion_espera_seg) FILTER (WHERE t.estado = 'atendido')), 0) AS promedio_espera_seg,
         COUNT(DISTINCT t.mesa_id) FILTER (WHERE t.mesa_id IS NOT NULL) AS mesas_activas
       FROM turnos t
       WHERE t.creado_en >= ($1::date)::timestamptz
         AND t.creado_en < (($1::date + 1)::timestamptz)
         ${whereExtra}`,
      params
    )

    const { rows: turnos } = await fastify.db.query(
      `SELECT
         t.id, t.numero, t.estado, t.origen,
         t.llamado_en, t.finalizado_en,
         t.duracion_atencion_seg, t.duracion_espera_seg,
         m.numero AS mesa_numero, m.nombre AS mesa_nombre,
         u.nombre_completo AS operador_nombre,
         lv.numero_lote AS lote_numero
       FROM turnos t
       LEFT JOIN mesas m ON t.mesa_id = m.id
       LEFT JOIN usuarios u ON t.operador_id = u.id
       LEFT JOIN lotes_voucher lv ON t.lote_id = lv.id
       WHERE t.creado_en >= ($1::date)::timestamptz
         AND t.creado_en < (($1::date + 1)::timestamptz)
         ${whereExtra}
       ORDER BY t.llamado_en ASC NULLS LAST`,
      params
    )

    const formatSeg = (seg) => {
      if (!seg && seg !== 0) return '--';
      const m = Math.floor(seg / 60);
      const s = seg % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    const formatHora = (iso) => {
      if (!iso) return '--';
      const d = new Date(iso);
      return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // Armar tabla HTML con especificación XML/HTML para Microsoft Excel
    const xlsContent = `
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <!--[if gte mso 9]>
  <xml>
    <x:ExcelWorkbook>
      <x:ExcelWorksheets>
        <x:ExcelWorksheet>
          <x:Name>Reporte ${fechaRef}</x:Name>
          <x:WorksheetOptions>
            <x:DisplayGridlines/>
          </x:WorksheetOptions>
        </x:ExcelWorksheet>
      </x:ExcelWorksheets>
    </x:ExcelWorkbook>
  </xml>
  <![endif]-->
  <style>
    body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; }
    .title { font-size: 15pt; font-weight: bold; color: #1D4ED8; }
    .subtitle { font-size: 10pt; color: #475569; margin-bottom: 12px; }
    .kpi-table { border-collapse: collapse; margin-bottom: 18px; }
    .kpi-table th { background-color: #EEF2F6; color: #1E293B; font-weight: bold; border: 1px solid #CBD5E1; padding: 6px 12px; text-align: center; }
    .kpi-table td { background-color: #FFFFFF; font-weight: bold; font-size: 12pt; border: 1px solid #CBD5E1; padding: 6px 12px; text-align: center; color: #0F172A; }
    .data-table { border-collapse: collapse; width: 100%; }
    .data-table th { background-color: #1D4ED8; color: #FFFFFF; font-weight: bold; border: 1px solid #1E40AF; padding: 7px 10px; text-align: center; }
    .data-table td { border: 1px solid #E2E8F0; padding: 6px 10px; font-size: 10pt; }
    .num { mso-number-format:"\\@"; text-align: center; font-family: monospace; font-weight: bold; }
    .center { text-align: center; }
    .text { text-align: left; }
  </style>
</head>
<body>
  <div class="title">TURNERO DE MATRÍCULAS 2026 — REPORTE OPERATIVO</div>
  <div class="subtitle">Fecha de atención: <strong>${fechaRef}</strong> | Generado el: ${new Date().toLocaleString('es-ES')}</div>

  <h3>RESUMEN DE JORNADA</h3>
  <table class="kpi-table">
    <tr>
      <th>Total Atendidos</th>
      <th>Total Cancelados</th>
      <th>Tiempo Medio Atención</th>
      <th>Tiempo Medio Espera</th>
      <th>Mesas Operativas</th>
    </tr>
    <tr>
      <td>${kpis?.total_atendidos || 0}</td>
      <td>${kpis?.total_cancelados || 0}</td>
      <td>${formatSeg(parseInt(kpis?.promedio_atencion_seg || '0', 10))}</td>
      <td>${formatSeg(parseInt(kpis?.promedio_espera_seg || '0', 10))}</td>
      <td>${kpis?.mesas_activas || 0}</td>
    </tr>
  </table>

  <h3>DETALLE DE TURNOS</h3>
  <table class="data-table">
    <thead>
      <tr>
        <th>Turno</th>
        <th>Ventanilla</th>
        <th>Operador</th>
        <th>Lote</th>
        <th>Origen</th>
        <th>Estado</th>
        <th>Hora Llamado</th>
        <th>Hora Fin</th>
        <th>Espera (mm:ss)</th>
        <th>Atención (mm:ss)</th>
      </tr>
    </thead>
    <tbody>
      ${turnos.map(t => `
        <tr>
          <td class="num">#${String(t.numero).padStart(3, '0')}</td>
          <td class="center">${t.mesa_numero ? 'Mesa ' + t.mesa_numero : '--'}</td>
          <td class="text">${t.operador_nombre || 'Sin asignar'}</td>
          <td class="center">${t.lote_numero ? 'Lote ' + t.lote_numero : '--'}</td>
          <td class="center">${t.origen || 'voucher_fisico'}</td>
          <td class="center">${t.estado}</td>
          <td class="center">${formatHora(t.llamado_en)}</td>
          <td class="center">${formatHora(t.finalizado_en)}</td>
          <td class="num">${formatSeg(t.duracion_espera_seg)}</td>
          <td class="num">${formatSeg(t.duracion_atencion_seg)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</body>
</html>
`.trim();

    return reply
      .header('Content-Type', 'application/vnd.ms-excel; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="reporte_turnero_${fechaRef}.xls"`)
      .send(xlsContent)
    } finally {
      fastify._reporteSemaforo--
    }
  })

  // ── GET /admin/configuracion — Obtener parámetros (RF-ADM-07) ─────────────
  fastify.get('/configuracion', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT clave, valor, descripcion, actualizado_en FROM configuracion ORDER BY clave`
    )
    const configMap = {}
    for (const r of rows) {
      configMap[r.clave] = r.valor
    }
    return reply.send({ configuracion: configMap, lista: rows })
  })

  // ── PATCH /admin/configuracion — Actualizar parámetro (RF-ADM-07) ─────────
  fastify.patch('/configuracion/:clave', {
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      body: {
        type: 'object',
        required: ['valor'],
        properties: {
          valor: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { clave } = request.params
    const { valor } = request.body

    const validadores = {
      alerta_vouchers_restantes: (v) => {
        const n = parseInt(v, 10)
        if (isNaN(n) || n < 1 || n > 500) {
          return 'El umbral de alerta de vouchers debe ser un número entero entre 1 y 500.'
        }
        return null
      },
      tv_escala_turnos: (v) => {
        const n = parseInt(v, 10)
        if (isNaN(n) || n < 75 || n > 140) {
          return 'La escala de números de TV debe ser un número entero entre 75 y 140.'
        }
        return null
      },
      tv_escala_principal: (v) => {
        const n = parseInt(v, 10)
        if (isNaN(n) || n < 75 || n > 140) {
          return 'La escala del turno principal de TV debe ser un número entero entre 75 y 140.'
        }
        return null
      },
      tv_escala_secundaria: (v) => {
        const n = parseInt(v, 10)
        if (isNaN(n) || n < 75 || n > 140) {
          return 'La escala de turnos anteriores de TV debe ser un número entero entre 75 y 140.'
        }
        return null
      },
      voz_anuncio_activa: (v) => {
        if (v !== 'true' && v !== 'false') {
          return 'El valor de voz de anuncio debe ser "true" o "false".'
        }
        return null
      },
      mostrar_estimado_espera: (v) => {
        if (v !== 'true' && v !== 'false') {
          return 'El valor de mostrar estimado de espera debe ser "true" o "false".'
        }
        return null
      },
      kiosko_web_activo: (v) => {
        if (v !== 'true' && v !== 'false') {
          return 'El estado del Kiosko Web debe ser "true" o "false".'
        }
        return null
      },
      modo_generacion_turnos: (v) => {
        if (v !== 'voucher_fisico' && v !== 'kiosko_web') {
          return 'El modo de generación de turnos debe ser "voucher_fisico" o "kiosko_web".'
        }
        return null
      },
      kiosko_modo_uso: (v) => {
        if (v !== 'estudiante' && v !== 'empleado' && v !== 'asistido') {
          return 'La modalidad de uso del kiosko debe ser "asistido" o "estudiante".'
        }
        return null
      },
      kiosko_tope_diario: (v) => {
        const n = parseInt(v, 10)
        if (isNaN(n) || n < 0 || n > 99999) {
          return 'El tope diario de turnos del kiosko debe ser un número entero mayor o igual a 0 (0 = sin límite).'
        }
        return null
      },
      kiosko_url_base: (v) => {
        if (typeof v !== 'string' || v.length > 255) {
          return 'La dirección local del kiosko no debe superar los 255 caracteres.'
        }
        const trimmed = v.trim()
        if (trimmed.length > 0) {
          if (!/^https?:\/\//i.test(trimmed)) {
            return 'La dirección local debe ser una URL válida que empiece con http:// o https://'
          }
          if (trimmed.includes('localhost') || trimmed.includes('127.0.0.1')) {
            return 'No se permite usar "localhost" ni "127.0.0.1". Ingrese una dirección IP local accesible en la red.'
          }
        }
        return null
      },
      kiosko_url_publica: (v) => {
        if (typeof v !== 'string' || v.length > 255) {
          return 'La dirección pública del kiosko no debe superar los 255 caracteres.'
        }
        const trimmed = v.trim()
        if (trimmed.length > 0) {
          if (!/^https?:\/\//i.test(trimmed)) {
            return 'La dirección pública debe ser una URL válida que empiece con http:// o https://'
          }
          if (trimmed.includes('localhost') || trimmed.includes('127.0.0.1')) {
            return 'No se permite usar "localhost" ni "127.0.0.1". Ingrese una dirección pública o dominio accesible desde Internet.'
          }
        }
        return null
      },
      impresora_activa: (v) => {
        if (v !== 'true' && v !== 'false') {
          return 'El estado de la impresora debe ser "true" o "false".'
        }
        return null
      },
      kiosko_impresion_automatica: (v) => {
        if (v !== 'true' && v !== 'false') {
          return 'El ajuste de impresión automática debe ser "true" o "false".'
        }
        return null
      },
      impresora_ip: (v) => {
        if (typeof v !== 'string' || v.length > 45) {
          return 'La dirección IP de la impresora no debe superar los 45 caracteres.'
        }
        return null
      },
      impresora_puerto: (v) => {
        const n = parseInt(v, 10)
        if (isNaN(n) || n < 1 || n > 65535) {
          return 'El puerto de la impresora debe ser un número entre 1 y 65535 (estándar: 9100).'
        }
        return null
      },
      zona_horaria: (v) => {
        if (typeof v !== 'string' || v.trim().length === 0 || v.length > 80) {
          return 'La zona horaria debe ser una cadena válida no vacía (máximo 80 caracteres).'
        }
        return null
      },
      fondo_imagen_url: (v) => {
        if (typeof v !== 'string' || v.length > 1000) {
          return 'La dirección o ruta de la imagen no debe superar los 1000 caracteres.'
        }
        const trimmed = v.trim()
        if (trimmed.length > 0) {
          if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('/') && !trimmed.startsWith('data:image/')) {
            return 'La URL de la imagen debe ser una dirección válida (http://, https://, ruta local / o data:image).'
          }
        }
        return null
      },
      fondo_imagen_activa: (v) => {
        if (v !== 'true' && v !== 'false') {
          return 'El estado de la imagen de fondo debe ser "true" o "false".'
        }
        return null
      }
    }

    const validador = validadores[clave]
    if (!validador) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        mensaje: `La clave de configuración "${clave}" no es válida`,
        message: `La clave de configuración "${clave}" no es válida`
      })
    }

    const errorValidacion = validador(valor)
    if (errorValidacion) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        mensaje: errorValidacion,
        message: errorValidacion
      })
    }

    const { rows: [cfg] } = await fastify.db.query(
      `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por)
       VALUES ($3, $1, NOW(), $2)
       ON CONFLICT (clave) DO UPDATE
       SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por
       RETURNING clave, valor, descripcion`,
      [valor, request.user.id, clave]
    )

    // Sincronización automática bidireccional entre kiosko_web_activo y modo_generacion_turnos
    if (clave === 'kiosko_web_activo') {
      const nuevoModo = valor === 'true' ? 'kiosko_web' : 'voucher_fisico'
      await fastify.db.query(
        `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por)
         VALUES ('modo_generacion_turnos', $1, NOW(), $2)
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por`,
        [nuevoModo, request.user.id]
      )
      await Promise.all([
        fastify.broadcast('admin:all', 'config_actualizada', { clave: 'modo_generacion_turnos', valor: nuevoModo }),
        fastify.broadcast('tv:global', 'config_actualizada', { clave: 'modo_generacion_turnos', valor: nuevoModo }),
        fastify.broadcast('kiosko:publico', 'config_actualizada', { clave: 'modo_generacion_turnos', valor: nuevoModo }),
        fastify.broadcast('lote:activo', 'config_actualizada', { clave: 'modo_generacion_turnos', valor: nuevoModo })
      ])
    } else if (clave === 'modo_generacion_turnos') {
      const nuevoActivo = valor === 'kiosko_web' ? 'true' : 'false'
      await fastify.db.query(
        `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por)
         VALUES ('kiosko_web_activo', $1, NOW(), $2)
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por`,
        [nuevoActivo, request.user.id]
      )
      await Promise.all([
        fastify.broadcast('admin:all', 'config_actualizada', { clave: 'kiosko_web_activo', valor: nuevoActivo }),
        fastify.broadcast('tv:global', 'config_actualizada', { clave: 'kiosko_web_activo', valor: nuevoActivo }),
        fastify.broadcast('kiosko:publico', 'config_actualizada', { clave: 'kiosko_web_activo', valor: nuevoActivo }),
        fastify.broadcast('lote:activo', 'config_actualizada', { clave: 'kiosko_web_activo', valor: nuevoActivo })
      ])
    }

    await fastify.db.query(
      `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, 'CONFIG_MODIFICADA', $2, $3)`,
      [request.user.id, request.ip, JSON.stringify({ clave, valor })]
    )

    await Promise.all([
      fastify.broadcast('admin:all', 'config_actualizada', { clave, valor }),
      fastify.broadcast('tv:global', 'config_actualizada', { clave, valor }),
      fastify.broadcast('kiosko:publico', 'config_actualizada', { clave, valor }),
      fastify.broadcast('lote:activo', 'config_actualizada', { clave, valor })
    ])

    return reply.send({ configuracion: cfg, clave: cfg.clave, valor: cfg.valor })
  })

  // ── POST /admin/configuracion/subir-fondo — Subir y guardar archivo local de fondo ───
  fastify.post('/configuracion/subir-fondo', {
    bodyLimit: 15 * 1024 * 1024,
    preHandler: [fastify.authorizeRol('admin')],
    schema: {
      body: {
        type: 'object',
        required: ['data'],
        properties: {
          data: { type: 'string' },
          nombre: { type: 'string' },
          activar: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { data, nombre, activar } = request.body

    if (!data || typeof data !== 'string') {
      return reply.code(400).send({ statusCode: 400, message: 'No se recibieron datos de imagen.' })
    }

    let mimeType = 'image/jpeg'
    let base64Data = data
    const matches = data.match(/^data:([A-Za-z0-9-+/]+);base64,(.+)$/)
    if (matches && matches.length === 3) {
      mimeType = matches[1].toLowerCase()
      base64Data = matches[2]
    }

    const mimeToExt = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/svg+xml': 'svg'
    }

    const ext = mimeToExt[mimeType] || 'jpg'
    const buffer = Buffer.from(base64Data, 'base64')

    if (buffer.length > 10 * 1024 * 1024) {
      return reply.code(400).send({ statusCode: 400, message: 'La imagen no debe superar los 10 MB.' })
    }

    const fs = require('fs')
    const path = require('path')
    const uploadsDir = path.join(__dirname, '../../public/assets/uploads')
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true })
    }

    const fileName = `fondo_${Date.now()}.${ext}`
    const filePath = path.join(uploadsDir, fileName)
    fs.writeFileSync(filePath, buffer)

    const urlRelativa = `/assets/uploads/${fileName}`

    // Actualizar fondo_imagen_url en BD
    await fastify.db.query(
      `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por)
       VALUES ('fondo_imagen_url', $1, NOW(), $2)
       ON CONFLICT (clave) DO UPDATE
       SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por`,
      [urlRelativa, request.user.id]
    )

    let estaActiva = 'true'
    if (activar !== undefined) {
      estaActiva = activar ? 'true' : 'false'
      await fastify.db.query(
        `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por)
         VALUES ('fondo_imagen_activa', $1, NOW(), $2)
         ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por`,
        [estaActiva, request.user.id]
      )
    }

    await fastify.db.query(
      `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, 'CONFIG_MODIFICADA', $2, $3)`,
      [request.user.id, request.ip, JSON.stringify({ clave: 'fondo_imagen_url', fileName, url: urlRelativa, bytes: buffer.length })]
    )

    await Promise.all([
      fastify.broadcast('admin:all', 'config_actualizada', { clave: 'fondo_imagen_url', valor: urlRelativa }),
      fastify.broadcast('tv:global', 'config_actualizada', { clave: 'fondo_imagen_url', valor: urlRelativa }),
      fastify.broadcast('kiosko:publico', 'config_actualizada', { clave: 'fondo_imagen_url', valor: urlRelativa }),
      fastify.broadcast('lote:activo', 'config_actualizada', { clave: 'fondo_imagen_url', valor: urlRelativa })
    ])
    if (activar !== undefined) {
      await Promise.all([
        fastify.broadcast('admin:all', 'config_actualizada', { clave: 'fondo_imagen_activa', valor: estaActiva }),
        fastify.broadcast('tv:global', 'config_actualizada', { clave: 'fondo_imagen_activa', valor: estaActiva }),
        fastify.broadcast('kiosko:publico', 'config_actualizada', { clave: 'fondo_imagen_activa', valor: estaActiva }),
        fastify.broadcast('lote:activo', 'config_actualizada', { clave: 'fondo_imagen_activa', valor: estaActiva })
      ])
    }

    return reply.send({
      ok: true,
      url: urlRelativa,
      activa: estaActiva === 'true',
      mensaje: 'Imagen subida y guardada exitosamente en el servidor.'
    })
  })

  // ── POST /admin/impresora/probar — Imprimir ticket de prueba (#000) ────────
  fastify.post('/impresora/probar', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const { imprimirTicketESCPOS } = require('../kiosko/printer')
    const { ip, puerto } = request.body || {}

    const ahora = new Date()
    const { rows: rowsUrl } = await fastify.db.query("SELECT valor FROM configuracion WHERE clave = 'kiosko_url_base'")
    const urlBase = rowsUrl[0]?.valor || 'http://localhost:3000'
    const tracking_url = `${urlBase.replace(/\/$/, '')}/kiosko/mi-turno/prueba-000`

    const ticket = {
      numero: 0,
      formato: '#000',
      modulo: 'MODULO DE MATRICULA - PRUEBA',
      tracking_url,
      fecha: ahora.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    }

    try {
      await imprimirTicketESCPOS(fastify, ticket, { ip, puerto, forzar: true })

      await fastify.db.query(
        `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
         VALUES ($1, 'CONFIG_MODIFICADA', $2, $3)`,
        [request.user.id, request.ip, JSON.stringify({ detalle: 'Impresión de prueba ESC/POS enviada', ticket: '#000', ip, puerto })]
      )

      return reply.send({
        ok: true,
        mensaje: 'Ticket de prueba #000 enviado con éxito a la impresora.'
      })
    } catch (err) {
      fastify.log.warn({ code: err.code, message: err.message }, 'Error al enviar ticket de prueba a impresora')

      const msg = err.code === 'ECONNREFUSED'
        ? `No se pudo conectar a la impresora en ${ip || 'la IP configurada'}:${puerto || 9100}. Verifique que esté encendida y en la misma red local.`
        : err.code === 'TIMEOUT'
          ? `La impresora no respondió a tiempo (Timeout). Verifique la dirección IP.`
          : err.code === 'IP_NO_CONFIGURADA'
            ? 'Ingrese una dirección IP válida para la impresora.'
            : (err.message || 'Error al comunicar con la impresora térmica.')

      return reply.status(503).send({
        ok: false,
        codigo: err.code || 'ERROR_IMPRESORA',
        message: msg
      })
    }
  })
}


