'use strict'

const fastify = require('fastify')

/**
 * Crea y configura la instancia de Fastify.
 * Separado de server.js para facilitar pruebas unitarias (inject).
 */
async function buildApp (opts = {}) {
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      // Formato legible en desarrollo, JSON puro en producción (para Pino)
      transport: process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined
    },
    // Campos estándar en cada log (RNF-MAN-04)
    genReqId: () => require('crypto').randomUUID(),
    ...opts
  })

  // ── Plugins de infraestructura ──────────────────────────────────────────────
  await app.register(require('./plugins/db'))       // Pool de PostgreSQL via pgBouncer
  await app.register(require('./plugins/redis'))    // Redis (caché + pub/sub)
  await app.register(require('./plugins/auth'))     // JWT + cookies HttpOnly

  // ── Plugins de seguridad ────────────────────────────────────────────────────
  await app.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'"],
        connectSrc:     ["'self'", "ws:", "wss:"],
        styleSrc:       ["'self'", "'unsafe-inline'"],  // Alpine.js necesita inline
        fontSrc:        ["'self'"],
        imgSrc:         ["'self'", "data:"]
      }
    }
  })

  await app.register(require('@fastify/cors'), {
    origin: process.env.NODE_ENV === 'development' ? true : process.env.ALLOWED_ORIGINS?.split(','),
    credentials: true
  })

  // Rate limiting global (por IP) — RNF-SEG-07
  await app.register(require('@fastify/rate-limit'), {
    global: false,  // Se aplica por ruta, no globalmente
    redis: app.redis
  })

  // Cookies (para refresh token HttpOnly — RNF-SEG-05)
  await app.register(require('@fastify/cookie'))

  // Servir archivos estáticos del frontend (RNF-DIS-06 — funciona sin Internet)
  await app.register(require('@fastify/static'), {
    root: require('path').join(__dirname, 'public'),
    prefix: '/'
  })

  // ── WebSocket Hub ───────────────────────────────────────────────────────────
  await app.register(require('@fastify/websocket'))
  await app.register(require('./modules/ws/hub'))

  // ── Módulos de dominio ──────────────────────────────────────────────────────
  await app.register(require('./modules/auth/routes'),   { prefix: '/auth' })
  await app.register(require('./modules/mesas/routes'),  { prefix: '/mesas' })
  await app.register(require('./modules/lotes/routes'),  { prefix: '/lotes' })
  await app.register(require('./modules/turnos/routes'), { prefix: '/turnos' })
  await app.register(require('./modules/admin/routes'),  { prefix: '/admin' })

  // ── Health check ────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: require('../package.json').version
  }))

  // ── Errores no controlados (RNF-MAN-05) ────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    app.log.error({ err: error, url: request.url }, 'Unhandled error')
    reply.status(error.statusCode || 500).send({
      error: process.env.NODE_ENV === 'development' ? error.message : 'Error interno del servidor'
    })
  })

  return app
}

module.exports = buildApp
