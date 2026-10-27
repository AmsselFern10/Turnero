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
  app.decorate('_mesaLlamarPromises', new Map())

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
    hsts: false,
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        connectSrc: ["'self'", "ws:", "wss:"],
        styleSrc:   ["'self'", "'unsafe-inline'"],
        fontSrc:    ["'self'"],
        imgSrc:     ["'self'", "data:", "blob:"],
        upgradeInsecureRequests: null
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

  // ── Aislamiento estricto de acceso por túnel público ────────────────────────
  // Por la dirección pública (túnel) solo se alcanza el kiosko; la TV y el admin no se exponen.
  let _cachedPublicHost = null
  let _lastHostCheck = 0

  app.addHook('onRequest', async (request, reply) => {
    const rawHeader = request.headers['x-forwarded-host'] || request.headers.host || ''
    const rawHost = rawHeader.split(',')[0].trim().split(':')[0].toLowerCase()
    if (!rawHost) return

    // Comprobar si es un túnel público conocido o la URL pública configurada
    const esTunelConocido = rawHost.includes('loca.lt') ||
      rawHost.includes('ngrok') ||
      rawHost.includes('trycloudflare.com')

    let esHostPublico = esTunelConocido

    if (!esHostPublico) {
      const now = Date.now()
      if (now - _lastHostCheck > 30000) {
        _lastHostCheck = now
        try {
          const { rows } = await app.db.query(
            "SELECT valor FROM configuracion WHERE clave = 'kiosko_url_publica' LIMIT 1"
          )
          const val = rows[0]?.valor
          if (val) {
            try {
              _cachedPublicHost = new URL(val).hostname.toLowerCase()
            } catch (_) {
              _cachedPublicHost = val.split('/')[0].split(':')[0].toLowerCase()
            }
          } else {
            _cachedPublicHost = null
          }
        } catch (_) {}
      }
      if (_cachedPublicHost && rawHost === _cachedPublicHost) {
        esHostPublico = true
      }
    }

    if (esHostPublico) {
      const path = request.url.split('?')[0]
      // Si entra a la raíz en el túnel público, redirigir directo al kiosko
      if (path === '/' || path === '/index.html') {
        return reply.redirect('/kiosko.html')
      }

      // Permitir únicamente rutas del ecosistema de kiosko y assets estáticos
      const esRutaPermitida = path.startsWith('/kiosko') ||
        path.startsWith('/turnos/generar') ||
        path.startsWith('/turnos/mi-turno') ||
        path.startsWith('/turnos/posicion') ||
        path.startsWith('/turnos/estado-kiosko') ||
        path.startsWith('/css/') ||
        path.startsWith('/js/') ||
        path.startsWith('/vendor/') ||
        path.startsWith('/assets/') ||
        path === '/favicon.ico'

      // Para WebSockets en el túnel público, solo permitir canales de kiosko
      if (path === '/ws') {
        const canal = request.query?.canal || ''
        if (!canal.startsWith('kiosko:')) {
          return reply.status(403).send({ error: 'Acceso no permitido por este canal en la red pública' })
        }
        return
      }

      if (!esRutaPermitida) {
        return reply.status(404).send({ error: 'Ruta no encontrada' })
      }
    }
  })

  // Función generadora de pantalla limpia 403 sin exponer HTML del admin
  function generarPantalla403 () {
    return `<!DOCTYPE html>
<html lang="es" class="h-full">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Acceso Restringido (403) — Turnero 2026</title>
  <link rel="stylesheet" href="/css/base.css">
  <link rel="stylesheet" href="/css/components.css">
  <link rel="stylesheet" href="/css/tailwind.css">
  <link rel="icon" href="data:,">
</head>
<body class="h-full flex items-center justify-center bg-[#EEF2F6] p-4 text-slate-800 antialiased font-sans">
  <main class="w-full max-w-md bg-white border border-[#CBD5E1] rounded-2xl p-6 sm:p-8 shadow-sm text-center">
    <div class="w-16 h-16 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center mx-auto mb-4">
      <svg class="w-8 h-8 stroke-[1.5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
      </svg>
    </div>
    <div class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono-num font-bold bg-rose-100 text-rose-800 border border-rose-200 mb-3">
      ERROR 403 • ACCESO PROHIBIDO
    </div>
    <h1 class="text-xl font-bold text-slate-900 tracking-tight mb-2">No tiene permiso para acceder a esta sección</h1>
    <p class="text-xs text-slate-500 leading-relaxed mb-6">
      Esta sección está reservada exclusivamente para administradores del sistema. Su cuenta no cuenta con permisos para ver ni gestionar este panel.
    </p>
    <div class="space-y-2.5">
      <a href="/index.html?logout=1" style="background-color: #1D4ED8; color: #ffffff !important; text-decoration: none;" class="w-full h-11 font-bold text-xs rounded-xl flex items-center justify-center gap-2 shadow-xs transition-colors hover:opacity-90">
        <svg class="w-4 h-4 stroke-[2]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
        </svg>
        <span style="color: #ffffff;">Iniciar sesión con otra cuenta</span>
      </a>
      <a href="/panel_mesa.html" style="background-color: #f1f5f9; color: #334155; text-decoration: none;" class="w-full h-10 font-semibold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-colors hover:bg-slate-200">
        <svg class="w-4 h-4 stroke-[1.75]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
        </svg>
        <span>Volver a mi panel de ventanilla</span>
      </a>
    </div>
  </main>
</body>
</html>`
  }

  // Protección estricta del panel de administración decidida por el servidor (401 / 403)
  const handleAdminPageAccess = async (request, reply) => {
    let token = request.cookies?.turnero_token
    if (!token && request.headers.authorization?.startsWith('Bearer ')) {
      token = request.headers.authorization.slice(7)
    }

    if (!token) {
      if (request.headers.accept?.includes('application/json')) {
        return reply.status(401).send({ error: 'No autenticado' })
      }
      return reply.redirect('/index.html')
    }

    let decoded
    try {
      decoded = app.jwt.verify(token)
    } catch (_) {
      reply.clearCookie('turnero_token', { path: '/' })
      if (request.headers.accept?.includes('application/json')) {
        return reply.status(401).send({ error: 'Token inválido o expirado' })
      }
      return reply.redirect('/index.html')
    }

    const isBlacklisted = await app.redis.get(`bl:${decoded.jti}`)
    if (isBlacklisted) {
      reply.clearCookie('turnero_token', { path: '/' })
      if (request.headers.accept?.includes('application/json')) {
        return reply.status(401).send({ error: 'Sesión cerrada' })
      }
      return reply.redirect('/index.html')
    }

    const { rows } = await app.db.query(
      'SELECT id, username, rol, activo FROM usuarios WHERE id = $1 AND eliminado_en IS NULL',
      [decoded.id]
    )
    const user = rows[0]
    if (!user || !user.activo) {
      reply.clearCookie('turnero_token', { path: '/' })
      if (request.headers.accept?.includes('application/json')) {
        return reply.status(401).send({ error: 'Usuario no encontrado o inactivo' })
      }
      return reply.redirect('/index.html')
    }

    if (user.rol !== 'admin') {
      if (request.headers.accept?.includes('application/json')) {
        return reply.status(403).send({ error: 'No tiene permiso para acceder a esta sección' })
      }
      return reply.status(403).type('text/html').send(generarPantalla403())
    }

    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
    reply.header('Pragma', 'no-cache')
    reply.header('Expires', '0')
    return reply.type('text/html').sendFile('admin.html')
  }

  app.get('/admin.html', handleAdminPageAccess)
  app.get('/admin', handleAdminPageAccess)

  app.setErrorHandler((error, request, reply) => {
    const correlationId = require('crypto').randomUUID().slice(0, 8).toUpperCase()
    app.log.error({ err: error, url: request.url, method: request.method, correlationId, pgCode: error.code, pgConstraint: error.constraint }, 'Unhandled error')
    const status = error.statusCode || error.status || 500
    if (error.error?.codigo) return reply.status(status).send({ error: error.error })
    if (error.codigo) return reply.status(status).send({ error: { codigo: error.codigo, mensaje: error.message } })
    if (status === 409) return reply.status(409).send({ error: { codigo: error.codigo || 'conflicto', mensaje: error.message || 'Conflicto al procesar la solicitud.' } })
    if (status === 404) return reply.status(404).send({ error: { codigo: error.codigo || 'no_encontrado', mensaje: error.message || 'Recurso no encontrado.' } })
    if (error.validation) return reply.status(400).send({ error: { codigo: 'validacion_invalida', mensaje: 'Revise los datos ingresados.' } })
    if (status === 401) return reply.status(401).send({ error: { codigo: 'credenciales_invalidas', mensaje: 'Usuario o contrasena incorrectos.' } })
    if (status === 403) return reply.status(403).send({ error: { codigo: 'sin_permiso', mensaje: 'No tiene permiso para esta accion.' } })
    if (status === 503) return reply.status(503).header('Retry-After', '10').send({ error: { codigo: 'servidor_ocupado', mensaje: 'Servidor ocupado. Intente en unos segundos.' } })
    return reply.status(500).send({ error: { codigo: 'error_interno', mensaje: `No pudimos completar la accion. Codigo: ${correlationId}` } })
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




  return app
}

module.exports = buildApp
