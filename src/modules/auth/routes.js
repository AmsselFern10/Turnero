'use strict'

const { login, logout, refresh } = require('./service')

/**
 * Módulo de autenticación — Rutas Fastify
 * Prefijo: /auth
 */
module.exports = async function authRoutes (fastify) {

  // ── POST /auth/login ───────────────────────────────────────────────────────
  fastify.post('/login', {
    config: {
      rateLimit: {
        max:         10,
        timeWindow:  '5 minutes',
        ban:         5,      // 5 bans → bloqueo 15min (RNF-SEG-08)
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Demasiados intentos fallidos. Intente en 15 minutos.'
        })
      }
    },
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
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
      maxAge:   7 * 24 * 60 * 60  // 7 días
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
      ip:     request.ip
    })

    reply.clearCookie('refresh_token', { path: '/auth/refresh' })
    return reply.status(200).send({ message: 'Sesión cerrada' })
  })

  // ── POST /auth/refresh ─────────────────────────────────────────────────────
  fastify.post('/refresh', async (request, reply) => {
    const refreshToken = request.cookies?.refresh_token
    if (!refreshToken) {
      return reply.status(401).send({ error: 'Refresh token no encontrado' })
    }

    const { token } = await refresh(fastify, { refreshToken })
    return reply.status(200).send({ token })
  })

  // ── GET /auth/mesas — Grilla de selección de mesa post-login (RF-AUTH-03) ──
  fastify.get('/mesas', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT m.id, m.numero, m.nombre, m.estado,
              u.nombre_completo AS operador_nombre
       FROM mesas m
       LEFT JOIN usuarios u ON m.operador_id = u.id
       WHERE m.estado IN ('activa', 'inactiva')
       ORDER BY m.numero`
    )
    return reply.send({ mesas: rows })
  })

  // ── POST /auth/seleccionar-mesa — Operador se auto-asigna a mesa libre (RF-AUTH-03 / RF-AUTH-07) ──
  fastify.post('/seleccionar-mesa', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: {
          mesa_id: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    const { mesa_id } = request.body
    const userId = request.user.id

    // 1. Validar que el operador no está asignado a otra mesa (RF-AUTH-07)
    const { rows: mesasOcupadas } = await fastify.db.query(
      `SELECT id, numero FROM mesas WHERE operador_id = $1 AND id != $2 AND estado != 'inactiva'`,
      [userId, mesa_id]
    )
    if (mesasOcupadas.length > 0) {
      return reply.status(409).send({
        error: `Ya tienes asignada la Mesa ${mesasOcupadas[0].numero}. Un operador no puede estar en dos mesas simultáneamente.`
      })
    }

    // 2. Validar que la mesa destino no esté ocupada por otro operador
    const { rows: [mesaDestino] } = await fastify.db.query(
      `SELECT id, numero, nombre, operador_id, estado FROM mesas WHERE id = $1`,
      [mesa_id]
    )
    if (!mesaDestino) {
      return reply.status(404).send({ error: 'Mesa no encontrada' })
    }
    if (mesaDestino.operador_id && mesaDestino.operador_id !== userId && mesaDestino.estado === 'activa') {
      return reply.status(409).send({ error: 'La mesa seleccionada ya está ocupada por otro operador' })
    }

    // 3. Asignar operador a la mesa
    const { rows: [mesaActualizada] } = await fastify.db.query(
      `UPDATE mesas SET operador_id = $1, estado = 'activa' WHERE id = $2 RETURNING id, numero, nombre, estado, operador_id`,
      [userId, mesa_id]
    )

    await fastify.db.query(
      `INSERT INTO audit_log (mesa_id, operador_id, accion, ip_origen)
       VALUES ($1, $2, 'OPERADOR_AUTO_ASIGNADO', $3)`,
      [mesa_id, userId, request.ip]
    )

    await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa: mesaActualizada })

    return reply.status(200).send({ mesa: mesaActualizada })
  })
}
