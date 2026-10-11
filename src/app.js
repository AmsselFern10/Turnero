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

  // Cache de idempotencia para POST /turnos/llamar (protege timeout + reintento = 2 turnos)
  // Map en memoria: { [Idempotency-Key]: responseBody } con TTL de 60s por entrada.
  // Suficiente para LAN de un solo nodo; en multi-nodo usar Redis.
  app.decorate('_idempotencyCache', new Map())
  app.decorate('_idempotencyPromises', new Map())

  // ── Plugins de seguridad ────────────────────────────────────────────────────
  await app.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net"],
        connectSrc:     ["'self'", "ws:", "wss:"],
        styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc:        ["'self'", "https://fonts.gstatic.com"],
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
    prefix: '/',
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  })

  // ── WebSocket Hub ───────────────────────────────────────────────────────────
  await app.register(require('@fastify/websocket'), {
    options: {
      maxPayload: 16384,          // 16 KB máx para prevenir ataques de memoria (WS-004)
      perMessageDeflate: false     // Deshabilitar zlib para rendimiento óptimo en LAN (WS-016)
    }
  })
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

  // ── Errores no controlados — contrato de respuesta (RNF-MAN-05) ───────────
  // Nunca filtra texto interno de la BD al cliente.
  // El ID de correlacion permite rastrear el error en los logs del servidor.
  app.setErrorHandler((error, request, reply) => {
    const correlationId = require('crypto').randomUUID().slice(0, 8).toUpperCase()

    // Log completo en el servidor (incluye stack y mensaje real de PG)
    app.log.error({
      err:           error,
      url:           request.url,
      method:        request.method,
      correlationId,
      pgCode:        error.code,
      pgConstraint:  error.constraint
    }, 'Unhandled error')

    const status = error.statusCode || error.status || 500

    // Errores de negocio ya formateados con { error: { codigo, mensaje } }
    if (error.error?.codigo) {
      return reply.status(status).send({ error: error.error })
    }

    // Errores de validacion de schema de Fastify
    if (error.validation) {
      return reply.status(400).send({
        error: {
          codigo:  'validacion_invalida',
          mensaje: 'Revise los datos ingresados.'
        }
      })
    }

    // 401 con mensaje de servicio
    if (status === 401) {
      return reply.status(401).send({
        error: {
          codigo:  'credenciales_invalidas',
          mensaje: 'Usuario o contrasena incorrectos.'
        }
      })
    }

    // 403
    if (status === 403) {
      return reply.status(403).send({
        error: {
          codigo:  'sin_permiso',
          mensaje: 'No tiene permiso para esta accion.'
        }
      })
    }

    // 500 y otros — nunca exponer detalles internos
    return reply.status(500).send({
      error: {
        codigo:  'error_interno',
        mensaje: `No pudimos completar la accion. Intente de nuevo. Codigo: ${correlationId}`
      }
    })
  })

  return app
}

module.exports = buildApp
