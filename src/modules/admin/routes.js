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
      `SELECT id, username, nombre_completo, rol, activo, creado_en
       FROM usuarios ORDER BY rol, nombre_completo`
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
          password:       { type: 'string', minLength: 8, maxLength: 128 },
          rol:            { type: 'string', enum: ['operador', 'admin', 'admin'] }
        }
      }
    }
  }, async (request, reply) => {
    const { username, nombre_completo, password, rol } = request.body
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
          rol:             { type: 'string', enum: ['operador', 'admin', 'admin'] },
          activo:          { type: 'boolean' },
          password:        { type: 'string', minLength: 8, maxLength: 128 }
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
        'SELECT id FROM usuarios WHERE username = $1 AND id != $2', [request.body.username, userId]
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
        return reply.status(400).send({ error: 'No puede desactivar su propio usuario mientras tiene la sesión activa.' })
      }
      if (request.body.rol && request.body.rol !== 'admin') {
        return reply.status(400).send({ error: 'No puede degradar su propio rol de administrador.' })
      }
    }

    if (request.body.activo !== undefined) {
      campos.push(`activo = $${i++}`)
      vals.push(request.body.activo)
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

  // ── DELETE /admin/usuarios/:id — Eliminar usuario (RF-ADM-06) ─────────────
  fastify.delete('/usuarios/:id', {
    preHandler: [fastify.authorizeRol('admin')]
  }, async (request, reply) => {
    const userId = parseInt(request.params.id)

    if (userId === request.user.id) {
      return reply.status(400).send({ error: 'No puede eliminar su propio usuario mientras tiene la sesión activa.' })
    }

    // Desasignar de cualquier mesa primero
    await fastify.db.query('UPDATE mesas SET operador_id = NULL, estado = \'inactiva\' WHERE operador_id = $1', [userId])

    try {
      const { rows: [usuario] } = await fastify.db.query(
        'DELETE FROM usuarios WHERE id = $1 RETURNING id, username',
        [userId]
      )
      if (!usuario) return reply.status(404).send({ error: 'Usuario no encontrado' })

      await fastify.db.query(
        `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
         VALUES ($1, 'ADMIN_ACTION', $2, $3)`,
        [request.user.id, request.ip, JSON.stringify({ tipo: 'USUARIO_ELIMINADO', usuario_eliminado_id: userId, username: usuario.username })]
      )
      return reply.send({ success: true, message: `Usuario ${usuario.username} eliminado.` })
    } catch (err) {
      if (err.code === '23503') {
        await fastify.db.query('UPDATE usuarios SET activo = false WHERE id = $1', [userId])
        return reply.send({ success: true, message: 'Usuario desactivado debido a registros históricos vinculados.' })
      }
      throw err
    }
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

    // 2. Resumen por Mesa
    const { rows: mesasResumen } = await fastify.db.query(
      `SELECT
         m.id AS mesa_id,
         m.numero AS mesa_numero,
         m.nombre AS mesa_nombre,
         COUNT(t.id) FILTER (WHERE t.estado = 'atendido') AS atendidos,
         COUNT(t.id) FILTER (WHERE t.estado = 'cancelado') AS cancelados,
         COALESCE(ROUND(AVG(t.duracion_atencion_seg) FILTER (WHERE t.estado = 'atendido')), 0) AS promedio_atencion_seg
       FROM mesas m
       LEFT JOIN turnos t ON t.mesa_id = m.id
         AND t.creado_en >= ($1::date)::timestamptz
         AND t.creado_en < (($1::date + 1)::timestamptz)
       GROUP BY m.id, m.numero, m.nombre
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
         AND t.creado_en < (($1::date + 1)::timestamptz)
         ${whereExtra}
       ORDER BY t.id DESC
       LIMIT 500`,
      params
    )

    return reply.send({
      fecha: fechaRef,
      kpis: {
        total_atendidos: parseInt(kpis?.total_atendidos || '0', 10),
        total_cancelados: parseInt(kpis?.total_cancelados || '0', 10),
        total_turnos: parseInt(kpis?.total_turnos || '0', 10),
        promedio_atencion_seg: parseInt(kpis?.promedio_atencion_seg || '0', 10),
        promedio_espera_seg: parseInt(kpis?.promedio_espera_seg || '0', 10),
        mesas_activas: parseInt(kpis?.mesas_activas || '0', 10)
      },
      mesas_resumen: mesasResumen.map(m => ({
        mesa_id: m.mesa_id,
        mesa_numero: m.mesa_numero,
        mesa_nombre: m.mesa_nombre,
        atendidos: parseInt(m.atendidos || '0', 10),
        cancelados: parseInt(m.cancelados || '0', 10),
        promedio_atencion_seg: parseInt(m.promedio_atencion_seg || '0', 10)
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

    const { rows: [cfg] } = await fastify.db.query(
      `INSERT INTO configuracion (clave, valor, actualizado_en, actualizado_por)
       VALUES ($3, $1, NOW(), $2)
       ON CONFLICT (clave) DO UPDATE
       SET valor = EXCLUDED.valor, actualizado_en = NOW(), actualizado_por = EXCLUDED.actualizado_por
       RETURNING clave, valor, descripcion`,
      [valor, request.user.id, clave]
    )

    await fastify.db.query(
      `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, 'CONFIG_MODIFICADA', $2, $3)`,
      [request.user.id, request.ip, JSON.stringify({ clave, valor })]
    )

    await Promise.all([
      fastify.broadcast('admin:all', 'config_actualizada', { clave, valor }),
      fastify.broadcast('tv:global', 'config_actualizada', { clave, valor })
    ])

    return reply.send({ configuracion: cfg })
  })
}

