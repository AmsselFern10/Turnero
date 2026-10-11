'use strict'

const { login, logout, refresh } = require('./service')
const { AUDIT_ACCIONES } = require('../audit-acciones')

/**
 * Modulo de autenticacion — Rutas Fastify
 * Prefijo: /auth
 *
 * Endpoints:
 *   POST /auth/login
 *   POST /auth/logout
 *   POST /auth/refresh
 *   GET  /auth/me                  — Estado de sesion para recargas de index.html
 *   GET  /auth/mesas/disponibles   — Solo mesas activas sin operador (INC-2)
 *   POST /auth/seleccionar-mesa    — Check-and-set atomico (INC-4)
 *   POST /auth/liberar-mesa        — Libera mesa propia (INC-3)
 */
module.exports = async function authRoutes (fastify) {

  // ── POST /auth/login ───────────────────────────────────────────────────────
  fastify.post('/login', {
    config: {
      rateLimit: {
        max:         process.env.NODE_ENV === 'production' ? 5 : 100, // RNF-SEG-08: 5 en prod, 100 en dev/stress
        timeWindow:  '5 minutes',
        ban:         5,
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: { codigo: 'demasiados_intentos', mensaje: 'Demasiados intentos. Intente de nuevo en 15 minutos.' }
        })
      }
    },
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        additionalProperties: false,
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 30 },
          password: { type: 'string', minLength: 1, maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    const { username, password } = request.body
    const ip = request.ip

    const { token, refreshToken, usuario } = await login(fastify, { username, password, ip })

    // Refresh token en cookie HttpOnly (RNF-SEG-05)
    reply.setCookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path:     '/auth/refresh',
      maxAge:   7 * 24 * 60 * 60  // 7 dias
    })

    return reply.status(200).send({ token, usuario })
  })

  // ── POST /auth/logout ──────────────────────────────────────────────────────
  fastify.post('/logout', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    await logout(fastify, {
      userId: request.user.id,
      jti:    request.user.jti,
      exp:    request.user.exp,   // claim ya decodificado por fastify.authenticate
      ip:     request.ip
    })

    reply.clearCookie('refresh_token', { path: '/auth/refresh' })
    if (fastify.desconectarUsuario) {
      fastify.desconectarUsuario(request.user.id)
    }
    return reply.status(200).send({ message: 'Sesion cerrada' })
  })

  // ── POST /auth/ws-ticket — Ticket efímero de un solo uso (30s) para WebSocket (WS-005) ──
  fastify.post('/ws-ticket', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const ticket = require('crypto').randomUUID()
    const payload = JSON.stringify({
      id:            request.user.id,
      username:      request.user.username,
      rol:           request.user.rol,
      mesa_id:       request.user.mesa_id || null
    })
    await fastify.redis.setex(`ws_ticket:${ticket}`, 30, payload)
    return reply.status(200).send({ ticket })
  })

  // ── POST /auth/refresh ─────────────────────────────────────────────────────
  fastify.post('/refresh', async (request, reply) => {
    const refreshToken = request.cookies?.refresh_token
    if (!refreshToken) {
      return reply.status(401).send({
        error: { codigo: 'sesion_expirada', mensaje: 'Sesion expirada. Inicie sesion nuevamente.' }
      })
    }

    const { token } = await refresh(fastify, { refreshToken })
    return reply.status(200).send({ token })
  })

  // ── GET /auth/me — Estado de sesion para recargas de index.html (INC-3) ───
  // Permite que index.html decida si mostrar login, modal de mesa o redirigir.
  fastify.get('/me', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = request.user.id

    const { rows } = await fastify.db.query(
      `SELECT u.id, u.username, u.nombre_completo AS nombre, u.rol,
              m.id AS mesa_id, m.numero AS mesa_numero, m.nombre AS mesa_nombre, m.estado AS mesa_estado
       FROM usuarios u
       LEFT JOIN mesas m ON m.operador_id = u.id AND m.estado != 'inactiva'
       WHERE u.id = $1 AND u.activo = true`,
      [userId]
    )

    if (!rows[0]) {
      return reply.status(401).send({
        error: { codigo: 'sesion_expirada', mensaje: 'Sesion expirada.' }
      })
    }

    const row = rows[0]
    const mesaAsignada = row.mesa_id
      ? { id: row.mesa_id, numero: row.mesa_numero, nombre: row.mesa_nombre, estado: row.mesa_estado }
      : null

    return reply.send({
      usuario: {
        id:            row.id,
        username:      row.username,
        nombre:        row.nombre,
        rol:           row.rol,
        mesa_asignada: mesaAsignada
      }
    })
  })

  // ── GET /auth/mesas/disponibles — Solo mesas activas y sin operador (INC-2) ─
  // El filtro va en el backend. El frontend muestra exactamente lo que recibe.
  // GET /mesas (todas) queda para el panel admin con validacion de rol.
  fastify.get('/mesas/disponibles', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    // Solo operadores llegan aqui (admin va directo a /admin.html)
    const { rows } = await fastify.db.query(
      `SELECT m.id, m.numero, m.nombre, m.estado
       FROM mesas m
       WHERE m.estado = 'activa'
         AND m.operador_id IS NULL
       ORDER BY m.numero`
    )
    return reply.send({ mesas: rows })
  })

  // ── GET /auth/mesas — Mantener por retrocompatibilidad; solo rol admin ──
  // (el operador usa /auth/mesas/disponibles)
  fastify.get('/mesas', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const rol = request.user.rol
    let query, params

    if (rol === 'operador') {
      // Operador: redirigir semanticamente a disponibles
      query = `SELECT m.id, m.numero, m.nombre, m.estado
               FROM mesas m
               WHERE m.estado = 'activa' AND m.operador_id IS NULL
               ORDER BY m.numero`
      params = []
    } else {
      // Admin: todas las mesas
      query = `SELECT m.id, m.numero, m.nombre, m.estado,
                      u.nombre_completo AS operador_nombre
               FROM mesas m
               LEFT JOIN usuarios u ON m.operador_id = u.id
               ORDER BY m.numero`
      params = []
    }

    const { rows } = await fastify.db.query(query, params)
    return reply.send({ mesas: rows })
  })

  // ── POST /auth/seleccionar-mesa — Check-and-set atomico (INC-4) ───────────
  // Todos los roles pueden operar una mesa (operador, admin).
  fastify.post('/seleccionar-mesa', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['mesa_id'],
        additionalProperties: false,
        properties: {
          mesa_id: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { mesa_id } = request.body
    const userId = request.user.id

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')

      // ── Check-and-set atomico: una sola sentencia UPDATE ──────────────────
      // Si la mesa existe, esta activa Y no tiene operador → la asigna.
      // 0 filas = mesa ocupada, inactiva o no existe.
      const { rows: updated } = await client.query(
        `UPDATE mesas SET operador_id = $1
         WHERE id = $2
           AND estado = 'activa'
           AND operador_id IS NULL
         RETURNING id, numero, nombre, estado`,
        [userId, mesa_id]
      )

      if (updated.length === 0) {
        // Determinar la causa exacta para respuesta semántica
        const { rows: [mesa] } = await client.query(
          `SELECT id, estado, operador_id FROM mesas WHERE id = $1`,
          [mesa_id]
        )

        await client.query('ROLLBACK')

        if (!mesa) {
          return reply.status(404).send({
            error: { codigo: 'mesa_no_encontrada', mensaje: 'La mesa ya no existe.' }
          })
        }

        // Idempotencia: si la mesa ya es del propio operador → 200
        if (mesa.operador_id === userId) {
          const { rows: [mesaActual] } = await fastify.db.query(
            `SELECT id, numero, nombre, estado FROM mesas WHERE id = $1`, [mesa_id]
          )
          return reply.status(200).send({ mesa: mesaActual })
        }

        if (mesa.estado === 'inactiva') {
          return reply.status(409).send({
            error: { codigo: 'mesa_inactiva', mensaje: 'Esta mesa ya no esta activa.' }
          })
        }

        // mesa.operador_id != null y != userId
        return reply.status(409).send({
          error: { codigo: 'mesa_ocupada', mensaje: 'Esta mesa acaba de ser tomada por otro operador.' }
        })
      }

      const mesaAsignada = updated[0]

      // ── Auditar en la misma transaccion (INC-1: usar AUDIT_ACCIONES) ──────
      await client.query(
        `INSERT INTO audit_log (mesa_id, operador_id, accion, ip_origen, metadata_json)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          mesa_id,
          userId,
          AUDIT_ACCIONES.OPERADOR_ASIGNADO,
          request.ip,
          JSON.stringify({ modo: 'auto_asignacion', mesa_numero: mesaAsignada.numero })
        ]
      )

      await client.query('COMMIT')

      // Notificar al panel admin (actualiza tabla de mesas)
      await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa: mesaAsignada })
      // Notificar a TODOS los logins abiertos: alguien tomó esta mesa — actualizar grilla
      await fastify.broadcast('tv:global', 'mesas_disponibles_actualizadas', {
        mesa: mesaAsignada,
        accion: 'tomada'
      })

      return reply.status(200).send({ mesa: mesaAsignada })

    } catch (err) {
      await client.query('ROLLBACK')

      // 23505 = unique_violation: operador ya tiene otra mesa (ux_mesas_operador_unico)
      if (err.code === '23505' && err.constraint === 'ux_mesas_operador_unico') {
        // Buscar cual es su mesa actual para devolver en el modal (INC-3)
        const { rows: [mesaActual] } = await fastify.db.query(
          `SELECT id, numero, nombre, estado FROM mesas WHERE operador_id = $1`,
          [userId]
        )
        return reply.status(409).send({
          error: {
            codigo:       'operador_ya_asignado',
            mensaje:      'Ya tiene una mesa asignada.',
            mesa_actual:  mesaActual || null
          }
        })
      }

      throw err
    } finally {
      client.release()
    }
  })

  // ── POST /auth/liberar-mesa — El usuario libera su mesa (INC-3) ──────────
  // Todos los roles que operan una mesa pueden liberarla.
  // Al liberar: la mesa vuelve a 'activa' sin operador → reaparece en la grilla.

  fastify.post('/liberar-mesa', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const userId = request.user.id

    const client = await fastify.db.connect()
    try {
      await client.query('BEGIN')

      // La mesa vuelve a 'activa' (disponible) al liberarse — no 'inactiva'
      const { rows: [mesa] } = await client.query(
        `UPDATE mesas SET operador_id = NULL, estado = 'activa'
         WHERE operador_id = $1
         RETURNING id, numero, nombre, estado`,
        [userId]
      )

      if (!mesa) {
        await client.query('ROLLBACK')
        return reply.status(200).send({ liberada: false })
      }

      await client.query(
        `INSERT INTO audit_log (mesa_id, operador_id, accion, ip_origen)
         VALUES ($1, $2, $3, $4)`,
        [mesa.id, userId, AUDIT_ACCIONES.OPERADOR_LIBERADO, request.ip]
      )

      await client.query('COMMIT')

      // Notificar a admin y a todos los logins en grilla
      await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa })
      await fastify.broadcast('tv:global', 'mesas_disponibles_actualizadas', {
        mesa,
        accion: 'liberada'
      })

      return reply.status(200).send({ liberada: true, mesa })

    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })
}


