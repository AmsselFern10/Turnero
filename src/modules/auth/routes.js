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
}
