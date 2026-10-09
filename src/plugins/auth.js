'use strict'

const fp = require('fastify-plugin')

/**
 * Plugin de autenticación JWT para Fastify.
 *
 * Expone:
 *   app.authenticate           → hook para rutas protegidas (cualquier rol)
 *   app.authorizeRol(...roles) → hook factory para restricción por rol
 *
 * Implementa:
 *   - JWT en header Authorization: Bearer <token>
 *   - Refresh token en cookie HttpOnly (RNF-SEG-05)
 *   - Blacklist de tokens revocados en Redis (RF-AUTH-04, RNF-SEG-04)
 *
 * Uso en rutas:
 *   fastify.get('/ruta', { preHandler: [fastify.authenticate] }, handler)
 *   fastify.get('/admin', { preHandler: [fastify.authorizeRol('admin')] }, handler)
 */
async function authPlugin (fastify) {
  await fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET,
    sign:   { expiresIn: process.env.JWT_EXPIRES_IN || '2h' }
  })

  /**
   * Verifica que el request tenga un JWT válido y no esté en la blacklist.
   */
  fastify.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify()
    } catch (err) {
      return reply.status(401).send({ error: 'Token inválido o expirado' })
    }

    // Verificar blacklist (logout)
    const isBlacklisted = await fastify.redis.get(`bl:${request.user.jti}`)
    if (isBlacklisted) {
      return reply.status(401).send({ error: 'Sesión cerrada' })
    }

    // Verificar que el usuario sigue activo
    const { rows } = await fastify.db.query(
      'SELECT activo FROM usuarios WHERE id = $1',
      [request.user.id]
    )
    if (!rows[0]?.activo) {
      return reply.status(403).send({ error: 'Usuario desactivado' })
    }
  })

  /**
   * Factory de preHandler que verifica rol.
   * Ejemplo: preHandler: [fastify.authorizeRol('admin', 'supervisor')]
   */
  fastify.decorate('authorizeRol', function (...roles) {
    return async function (request, reply) {
      await fastify.authenticate(request, reply)
      if (reply.sent) return  // authenticate ya respondió con error

      if (!roles.includes(request.user.rol)) {
        return reply.status(403).send({
          error: `Acceso denegado. Roles permitidos: ${roles.join(', ')}`
        })
      }
    }
  })
}

module.exports = fp(authPlugin, { name: 'auth', dependencies: ['db', 'redis'] })
