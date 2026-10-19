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
      transport: process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined
    },
    genReqId: () => require('crypto').randomUUID(),
    // 64 KB max por request — previene body inflado
    bodyLimit: 65536,
    // Corta conexiones lentas o colgadas (coincide con statement_timeout de PG)
    requestTimeout: 30000,
    ...opts
  })

  await app.register(require('./plugins/db'))
  await app.register(require('./plugins/redis'))
  await app.register(require('./plugins/auth'))

  app.decorate('_idempotencyCache', new Map())
  app.decorate('_idempotencyPromises', new Map())

  // Semaforo: solo 1 reporte XLS concurrente
  app.decorate('_reporteSemaforo', 0)

  // Under-Pressure: rechaza peticiones no esenciales bajo carga alta
  await app.register(require('@fastify/under-pressure'), {
    maxEventLoopDelay: 200,
    maxHeapUsedBytes:  400 * 1024 * 1024,
    maxRssBytes:       500 * 1024 * 1024,
    retryAfter:        10,
    message:           'Servidor ocupado. Intente en unos segundos.',
    exposeStatusRoute: false
  })

  await app.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net"],
        connectSrc: ["'self'", "ws:", "wss:"],
        styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc:    ["'self'", "https://fonts.gstatic.com"],
        imgSrc:     ["'self'", "data:"]
      }
    }
  })

  await app.register(require('@fastify/cors'), {
    origin: process.env.NODE_ENV === 'development' ? true : process.env.ALLOWED_ORIGINS?.split(','),
    credentials: true
  })

  await app.register(require('@fastify/rate-limit'), {
    global: false,
    redis: app.redis
  })

  await app.register(require('@fastify/cookie'))

  // Cache diferenciado: HTML=no-cache, vendor/fonts/css=7d, resto=1h
  await app.register(require('@fastify/static'), {
    root: require('path').join(__dirname, 'public'),
    prefix: '/',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        // HTML: nunca cachear — siempre la versión más reciente
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Expires', '0')
      } else if (filePath.includes('/vendor/') || filePath.includes('/assets/fonts/')) {
        // Vendor y fuentes: inmutables — versión fijada en el nombre de archivo
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
      } else if (filePath.includes('/css/')) {
        // CSS precompilado: cachear 1 hora
        res.setHeader('Cache-Control', 'public, max-age=3600')
      } else {
        // JS de aplicación (api.js, ws-client.js, utils.js, pages/*.js):
        // NO cachear — cambian durante el desarrollo y en deploys
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Expires', '0')
      }
    }
  })

  await app.register(require('@fastify/websocket'), {
    options: { maxPayload: 16384, perMessageDeflate: false }
  })
  await app.register(require('./modules/ws/hub'))



  await app.register(require('./modules/auth/routes'),   { prefix: '/auth' })
  await app.register(require('./modules/mesas/routes'),  { prefix: '/mesas' })
  await app.register(require('./modules/lotes/routes'),  { prefix: '/lotes' })
  await app.register(require('./modules/turnos/routes'), { prefix: '/turnos' })
  await app.register(require('./modules/admin/routes'),  { prefix: '/admin' })
  await app.register(require('./modules/kiosko/routes'), { prefix: '/kiosko' })

  // Health check con DB + Redis + RAM (exento de under-pressure)
  app.get('/health', { config: { underPressure: false } }, async (request, reply) => {
    const start = Date.now()
    const checks = {}
    let overallOk = true

    try {
      await app.db.query('SELECT 1')
      checks.db = { ok: true, latencyMs: Date.now() - start }
    } catch (err) {
      checks.db = { ok: false, error: err.message }
      overallOk = false
    }

    const redisStart = Date.now()
    try {
      await app.redis.ping()
      checks.redis = { ok: true, latencyMs: Date.now() - redisStart }
    } catch (err) {
      checks.redis = { ok: false, error: err.message }
      overallOk = false
    }

    const mem = process.memoryUsage()
    checks.memory = {
      heapUsedMB:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB:       Math.round(mem.rss       / 1024 / 1024)
    }

    const lagStart = Date.now()
    await new Promise(resolve => setImmediate(resolve))
    checks.eventLoopLagMs = Date.now() - lagStart

    return reply.status(overallOk ? 200 : 503).send({
      status:    overallOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version:   require('../package.json').version,
      uptimeSec: Math.round(process.uptime()),
      checks
    })
  })




  app.setErrorHandler((error, request, reply) => {
    const correlationId = require('crypto').randomUUID().slice(0, 8).toUpperCase()
    app.log.error({ err: error, url: request.url, method: request.method, correlationId, pgCode: error.code, pgConstraint: error.constraint }, 'Unhandled error')
    const status = error.statusCode || error.status || 500
    if (error.error?.codigo) return reply.status(status).send({ error: error.error })
    if (error.validation) return reply.status(400).send({ error: { codigo: 'validacion_invalida', mensaje: 'Revise los datos ingresados.' } })
    if (status === 401) return reply.status(401).send({ error: { codigo: 'credenciales_invalidas', mensaje: 'Usuario o contrasena incorrectos.' } })
    if (status === 403) return reply.status(403).send({ error: { codigo: 'sin_permiso', mensaje: 'No tiene permiso para esta accion.' } })
    if (status === 503) return reply.status(503).header('Retry-After', '10').send({ error: { codigo: 'servidor_ocupado', mensaje: 'Servidor ocupado. Intente en unos segundos.' } })
    return reply.status(500).send({ error: { codigo: 'error_interno', mensaje: `No pudimos completar la accion. Codigo: ${correlationId}` } })
  })

  return app
}

module.exports = buildApp
