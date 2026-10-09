'use strict'

/**
 * Módulo de administración — Rutas Fastify
 * Prefijo: /admin
 * Acceso: admin y supervisor
 */
module.exports = async function adminRoutes (fastify) {

  // ── GET /admin/kpis — KPIs en tiempo real (RF-ADM-01) ────────────────────
  fastify.get('/kpis', {
    preHandler: [fastify.authorizeRol('admin', 'supervisor')]
  }, async (request, reply) => {
    const [kpisTurnos, loteActivo, mesasActivas] = await Promise.all([
      fastify.db.query(`
        SELECT
          COUNT(*) FILTER (WHERE estado = 'atendido')                        AS atendidos_hoy,
          COUNT(*) FILTER (WHERE estado = 'cancelado')                       AS cancelados_hoy,
          COUNT(*) FILTER (WHERE estado = 'en_atencion')                     AS en_atencion_ahora,
          ROUND(AVG(duracion_atencion_seg) FILTER (WHERE estado = 'atendido' AND duracion_atencion_seg IS NOT NULL)) AS promedio_seg
        FROM turnos
        WHERE creado_en::date = CURRENT_DATE
      `),
      fastify.db.query(`
        SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado, estado,
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

    return reply.send({
      atendidos_hoy:     parseInt(t.atendidos_hoy),
      cancelados_hoy:    parseInt(t.cancelados_hoy),
      en_atencion_ahora: parseInt(t.en_atencion_ahora),
      promedio_seg:      t.promedio_seg ? parseInt(t.promedio_seg) : null,
      mesas_activas:     parseInt(m.activas),
      mesas_pausadas:    parseInt(m.pausadas),
      lote:              loteActivo.rows[0] || null
    })
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
          rol:            { type: 'string', enum: ['operador', 'supervisor', 'admin'] }
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
          rol:             { type: 'string', enum: ['operador', 'supervisor', 'admin'] },
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
    if (request.body.rol !== undefined) {
      campos.push(`rol = $${i++}`)
      vals.push(request.body.rol)
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

    await fastify.db.query(
      `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, 'USUARIO_EDITADO', $2, $3)`,
      [request.user.id, request.ip, JSON.stringify({ usuario_editado_id: userId })]
    )

    return reply.send({ usuario })
  })

  // ── GET /admin/auditoria — Historial por fecha (RF-ADM-09) ───────────────
  fastify.get('/auditoria', {
    preHandler: [fastify.authorizeRol('admin', 'supervisor')],
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
       WHERE al.timestamp::date = $1
       ORDER BY al.timestamp DESC
       LIMIT $2 OFFSET $3`,
      [fecha, limite, offset]
    )

    return reply.send({ registros: rows, pagina, limite })
  })

  // ── GET /admin/reporte/csv — Exportar reporte del día (RF-ADM-08) ─────────
  fastify.get('/reporte/csv', {
    preHandler: [fastify.authorizeRol('admin', 'supervisor')],
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
       WHERE t.creado_en::date = $1
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
      `UPDATE configuracion
       SET valor = $1, actualizado_en = NOW(), actualizado_por = $2
       WHERE clave = $3
       RETURNING clave, valor, descripcion`,
      [valor, request.user.id, clave]
    )

    if (!cfg) return reply.status(404).send({ error: `Clave de configuración '${clave}' no encontrada` })

    await fastify.db.query(
      `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
       VALUES ($1, 'CONFIG_MODIFICADA', $2, $3)`,
      [request.user.id, request.ip, JSON.stringify({ clave, valor })]
    )

    await fastify.broadcast('admin:all', 'config_actualizada', { clave, valor })

    return reply.send({ configuracion: cfg })
  })
}
