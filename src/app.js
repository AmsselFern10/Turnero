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

  // ── Filtro de aislamiento: solo el kiosko de estudiantes es accesible desde Internet ──
  function isPrivateIp (rawIp) {
    if (!rawIp) return true
    const ip = rawIp.replace(/^::ffff:/, '').trim()
    if (ip === '::1' || ip === 'localhost' || ip === '127.0.0.1') return true
    if (ip.startsWith('10.')) return true
    if (ip.startsWith('192.168.')) return true
    if (ip.startsWith('169.254.')) return true
    if (ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) return true
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true
    return false
  }

  let _urlPublicaCache = null
  let _urlPublicaCacheExpira = 0
  async function getUrlPublicaHost (fApp) {
    const now = Date.now()
    if (_urlPublicaCache !== null && now < _urlPublicaCacheExpira) {
      return _urlPublicaCache
    }
    try {
      const { rows } = await fApp.db.query("SELECT valor FROM configuracion WHERE clave = 'kiosko_url_publica' LIMIT 1")
      const val = (rows[0]?.valor || '').trim()
      if (val) {
        try {
          const u = new URL(val.startsWith('http') ? val : `http://${val}`)
          _urlPublicaCache = u.host.toLowerCase()
        } catch (_) {
          _urlPublicaCache = val.toLowerCase()
        }
      } else {
        _urlPublicaCache = ''
      }
    } catch (_) {
      _urlPublicaCache = ''
    }
    _urlPublicaCacheExpira = now + 5000
    return _urlPublicaCache
  }

  app.addHook('onRequest', async (request, reply) => {
    const publicHost = await getUrlPublicaHost(app)
    const reqHost = (request.headers['x-forwarded-host'] || request.headers.host || '').toLowerCase()
    const clientIp = request.headers['cf-connecting-ip'] || request.headers['x-real-ip'] || request.ip

    const esHostPublico = Boolean(publicHost && (reqHost === publicHost || reqHost.startsWith(`${publicHost}:`)))
    const esIpPublica = !isPrivateIp(clientIp)
    const esAccesoPublico = esHostPublico || esIpPublica

    if (esAccesoPublico) {
      const urlPath = request.url.split('?')[0]

      // Redirigir root a /kiosko.html
      if (urlPath === '/' || urlPath === '') {
        return reply.redirect('/kiosko.html')
      }

      // Rutas permitidas públicamente (kiosko para estudiantes, tablet asistida y sus recursos)
      const rutasPermitidas = [
        '/kiosko.html',
        '/kiosko/estado',
        '/kiosko/generar',
        '/turnos/generar',
        '/turnos/configuracion-publica',
        '/kiosko/turnos',
        '/kiosko/imprimir',
        '/health'
      ]

      const esRutaPermitida =
        rutasPermitidas.includes(urlPath) ||
        urlPath.startsWith('/kiosko/mi-turno/') ||
        urlPath.startsWith('/turnos/mi-turno/') ||
        urlPath.startsWith('/css/') ||
        urlPath.startsWith('/vendor/') ||
        urlPath.startsWith('/assets/') ||
        urlPath.startsWith('/js/')

      // Si es WebSocket, solo permitir canales de kiosko
      if (urlPath === '/ws') {
        const canal = request.query?.canal || ''
        if (canal === 'kiosko:publico' || canal.startsWith('kiosko:')) {
          return // Permitido
        }
        return reply.code(403).send({ error: { codigo: 'acceso_restringido', mensaje: 'Canal no disponible desde acceso público.' } })
      }

      if (!esRutaPermitida) {
        if (urlPath.endsWith('.html')) {
          return reply.code(403).type('text/html').send(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Acceso Restringido</title></head><body style="font-family:sans-serif;background:#EEF2F6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="background:#fff;padding:2rem;border-radius:1rem;border:1px solid #CBD5E1;max-width:400px;text-align:center;"><h2>Acceso Restringido</h2><p style="color:#64748B;font-size:0.9rem;">Este módulo solo está disponible desde la red local institucional (LAN/WiFi del campus).</p><a href="/kiosko.html" style="color:#1D4ED8;text-decoration:none;font-weight:bold;">Ir al Kiosko de Estudiantes</a></div></body></html>'
          )
        }
        return reply.code(403).send({
          error: {
            codigo: 'acceso_restringido_red_local',
            mensaje: 'Este módulo solo está disponible desde la red local institucional.'
          }
        })
      }
    }
  })

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
