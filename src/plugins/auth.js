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
    let verified = false
    try {
      await request.jwtVerify()
      verified = true
    } catch (err) {
      const cookieToken = request.cookies?.turnero_token
      if (cookieToken) {
        try {
          request.user = fastify.jwt.verify(cookieToken)
          verified = true
        } catch (_) {}
      }
    }

    if (!verified) {
      return reply.status(401).send({ error: 'Token inválido o expirado' })
    }

    // 1. Verificar si la sesión fue reemplazada por un inicio de sesión más reciente en otro dispositivo (Opción A)
    const sesionActivaJti = await fastify.redis.get(`user_active_session:${request.user.id}`)
    if (sesionActivaJti && sesionActivaJti !== request.user.jti) {
      return reply.status(401).send({ error: 'Su sesión fue cerrada porque se inició sesión en otro dispositivo', codigo: 'sesion_reemplazada' })
    }

    // 2. Verificar blacklist (logout)
    const isBlacklisted = await fastify.redis.get(`bl:${request.user.jti}`)
    if (isBlacklisted) {
      return reply.status(401).send({ error: 'Sesión cerrada' })
    }

    // Verificar si la contraseña fue cambiada con posterioridad a la emisión del token
    const pwdChangedAt = await fastify.redis.get(`pwd_changed:${request.user.id}`)
    if (pwdChangedAt && request.user.iat && Number(pwdChangedAt) > request.user.iat) {
      return reply.status(401).send({ error: 'Contraseña modificada. Inicie sesión nuevamente.', codigo: 'password_cambiada' })
    }

    // Verificar que el usuario sigue activo y sincronizar rol actual desde la base de datos
    const { rows } = await fastify.db.query(
      'SELECT activo, rol FROM usuarios WHERE id = $1 AND eliminado_en IS NULL',
      [request.user.id]
    )
    if (!rows[0] || !rows[0].activo) {
      return reply.status(403).send({ error: 'Usuario desactivado o no encontrado' })
    }
    // Mantener sincronizado el rol actual si fue modificado en caliente
    request.user.rol = rows[0].rol
  })

  /**
   * Factory de preHandler que verifica rol.
   * Ejemplo: preHandler: [fastify.authorizeRol('admin')]
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

