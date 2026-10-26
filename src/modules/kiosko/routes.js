'use strict'

const {
  getKioskoEstado,
  generarTurno,
  consultarMiTurno
} = require('./service')

/**
 * Módulo de Autoservicio Kiosko — Rutas públicas sin autenticación (v2.1)
 * Prefijo: /kiosko
 */
module.exports = async function kioskoRoutes (fastify) {

  // ── GET /kiosko/estado — Estado público en vivo del Kiosko (RF-GEN-01) ─────
  fastify.get('/estado', async (request, reply) => {
    const estado = await getKioskoEstado(fastify)
    return reply.status(200).send(estado)
  })

  // ── POST /kiosko/generar y POST /kiosko/turnos — Generación de turno táctil ────────────
  const generarOpts = {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '3 seconds',
        keyGenerator: (req) => `kiosko_gen:${req.headers['x-device-id'] || req.ip}`,
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: {
            codigo: 'espere_antes_de_reintentar',
            mensaje: 'Demasiadas solicitudes. Espere unos segundos antes de solicitar otro turno.'
          }
        })
      }
    }
  }

  const generarHandler = async (request, reply) => {
    const idempotencyKey = request.headers['idempotency-key'] || request.body?.idempotency_key
    const cacheKey       = idempotencyKey ? `kiosko_idem:${idempotencyKey}` : null

    if (cacheKey) {
      if (fastify._idempotencyCache?.has(cacheKey)) {
        return reply.status(201).send(fastify._idempotencyCache.get(cacheKey))
      }
      if (fastify._idempotencyPromises?.has(cacheKey)) {
        const enVuelo = await fastify._idempotencyPromises.get(cacheKey)
        return reply.status(201).send(enVuelo)
      }
    }

    const deviceId       = request.headers['x-device-id'] || request.body?.device_id
    const esTablet       = request.query?.modo === 'tablet' || request.body?.modo === 'tablet'
    const reqHost        = request.headers['x-forwarded-host'] || request.headers.host
    const reqProtocol    = request.headers['x-forwarded-proto'] || (request.raw.socket.encrypted ? 'https' : 'http')

    const operacion = (async () => {
      const resultado = await generarTurno(fastify, {
        ip: request.ip,
        idempotencyKey,
        deviceId,
        esTablet,
        reqHost,
        reqProtocol
      })

      // Broadcast no bloqueante a administradores, operarios y smartphones en espera
      setImmediate(async () => {
        try {
          const { rows: [esperaData] } = await fastify.db.query(
            `SELECT
               COUNT(*)::int AS count,
               (SELECT numero FROM turnos
                WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()
                ORDER BY sesion ASC, numero ASC LIMIT 1) AS proximo
             FROM turnos
             WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()`
          )
          const enEspera = esperaData?.count || 0
          const proximo = esperaData?.proximo ?? null
          await Promise.allSettled([
            fastify.broadcast('admin:all', 'kiosko_turno_generado', {
              numero: resultado.numero,
              posicion: resultado.posicion_en_cola,
              turnos_en_espera: enEspera,
              proximo_numero: proximo
            }),
            fastify.broadcast('lote:activo', 'proximo_actualizado', {
              proximo_numero: proximo,
              vouchers_restantes: enEspera,
              modo: 'kiosko_web'
            }),
            fastify.broadcast('kiosko:publico', 'llamados', {
              proximo_numero: proximo,
              turnos_esperando: enEspera
            })
          ])
        } catch (wsErr) {
          fastify.log.warn({ wsErr }, 'Error emitiendo kiosko_turno_generado')
        }
      })

      // Impresión automática en modalidad asistida (tablet)
      if (esTablet) {
        try {
          const { rows: cfgRows } = await fastify.db.query(
            `SELECT clave, valor FROM configuracion
             WHERE clave IN ('kiosko_impresion_automatica', 'impresora_activa', 'impresora_ip', 'impresora_puerto', 'impresora_canal', 'impresora_ancho_papel')`
          )
          const cfgMap = {}
          for (const r of cfgRows) cfgMap[r.clave] = r.valor

          const canal = cfgMap.impresora_canal || 'directa'
          const impresionAutomatica = cfgMap.kiosko_impresion_automatica === 'true'
          const impresoraActiva = cfgMap.impresora_activa === 'true'
          const anchoPapel = cfgMap.impresora_ancho_papel || '58'

          // Solo enviar directo por red TCP si el canal configurado es 'directa'
          if (impresionAutomatica && impresoraActiva && canal === 'directa') {
            const { imprimirTicketESCPOS } = require('./printer')
            const ahora = new Date()
            try {
              await imprimirTicketESCPOS(fastify, {
                numero:       resultado.numero,
                formato:      `#${String(resultado.numero).padStart(3, '0')}`,
                modulo:       'Módulo de Matrículas',
                tracking_url: resultado.tracking_url || '',
                fecha: ahora.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }),
                hora:  ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
              }, { forzar: true, anchoPapel })
              resultado.impresion = { ok: true, mensaje: 'Comprobante impreso de inmediato.' }
              fastify.log.info({ numero: resultado.numero }, '[Kiosko] Impresión automática OK')
            } catch (printErr) {
              fastify.log.warn({ code: printErr.code, message: printErr.message }, '[Kiosko] Impresión automática falló (turno preservado)')
              resultado.impresion = {
                ok: false,
                codigo: printErr.code || 'ERROR_IMPRESORA',
                mensaje: printErr.code === 'IMPRESORA_INACTIVA' || printErr.code === 'IP_NO_CONFIGURADA'
                  ? 'Impresora de tickets no configurada o inactiva en el sistema.'
                  : printErr.code === 'ECONNREFUSED'
                    ? 'No se pudo conectar a la impresora de tickets. Verifique que esté encendida.'
                    : printErr.code === 'TIMEOUT'
                      ? 'La impresora de tickets no respondió a tiempo.'
                      : `Error de impresora: ${printErr.message}`
              }
            }
          }
        } catch (cfgErr) {
          fastify.log.warn({ cfgErr }, '[Kiosko] Error comprobando configuración de impresora')
        }
      }

      return resultado
    })()

    if (cacheKey && fastify._idempotencyPromises) {
      fastify._idempotencyPromises.set(cacheKey, operacion)
    }

    let resultadoFinal
    try {
      resultadoFinal = await operacion
    } finally {
      if (cacheKey && fastify._idempotencyPromises) {
        fastify._idempotencyPromises.delete(cacheKey)
      }
    }

    if (cacheKey && fastify._idempotencyCache) {
      fastify._idempotencyCache.set(cacheKey, resultadoFinal)
      setTimeout(() => fastify._idempotencyCache.delete(cacheKey), 60_000)
    }

    return reply.status(201).send(resultadoFinal)
  }

  fastify.post('/generar', generarOpts, generarHandler)
  fastify.post('/turnos', generarOpts, generarHandler)

  // ── GET /kiosko/mi-turno/:token — Alias de consulta de turno ──────────────
  fastify.get('/mi-turno/:token', {
    schema: {
      params: {
        type: 'object',
        properties: { token: { type: 'string', minLength: 64, maxLength: 64 } }
      }
    }
  }, async (request, reply) => {
    const { token } = request.params
    const cacheKey = `mi_turno:${token}`

    // Intentar servir desde cache Redis (TTL 4s)
    try {
      const cached = await fastify.redis.get(cacheKey)
      if (cached) {
        return reply.header('X-Cache', 'HIT').send(JSON.parse(cached))
      }
    } catch (_) { /* Redis fallo — continuar sin cache */ }

    const resultado = await consultarMiTurno(fastify, { token })

    // Guardar en cache 4 segundos (solo si el turno sigue en espera)
    if (resultado.estado === 'esperando') {
      try {
        await fastify.redis.set(cacheKey, JSON.stringify(resultado), 'EX', 4)
      } catch (_) {}
    }

    return reply.header('X-Cache', 'MISS').status(200).send(resultado)
  })

  // ── POST /kiosko/imprimir — Impresion directa ESC/POS a impresora de red ───
  //
  // Body: { numero, formato, modulo, tracking_url }
  // 200: { ok: true, mensaje }
  // 409: { ok: false, codigo: "IMPRESORA_INACTIVA" | "IP_NO_CONFIGURADA", mensaje }
  // 503: { ok: false, codigo: "TIMEOUT" | "ECONNREFUSED" | ..., mensaje }
  fastify.post('/imprimir', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '5 seconds',
        keyGenerator: (req) => `kiosko_print:${req.ip}`,
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: { codigo: 'espere_antes_de_reintentar', mensaje: 'Demasiadas solicitudes de impresion.' }
        })
      }
    }
  }, async (request, reply) => {
    const { imprimirTicketESCPOS } = require('./printer')
    const { numero, formato, modulo, tracking_url, ip, puerto } = request.body || {}

    if (!numero) {
      return reply.status(400).send({ ok: false, codigo: 'DATOS_INCOMPLETOS', mensaje: 'Se requiere el numero de turno.' })
    }

    const ahora = new Date()
    const ticket = {
      numero,
      formato:      formato || `#${String(numero).padStart(3, '0')}`,
      modulo:       modulo || 'Modulo General de Matriculas',
      tracking_url: tracking_url || '',
      fecha: ahora.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      hora:  ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    }

    const opcionesPrint = {}
    if (ip && String(ip).trim() !== '') {
      opcionesPrint.ip = String(ip).trim()
      opcionesPrint.forzar = true
    }
    if (puerto) {
      opcionesPrint.puerto = Number(puerto)
    }

    try {
      await imprimirTicketESCPOS(fastify, ticket, opcionesPrint)
      fastify.log.info({ numero, ip: request.ip, destinoIp: opcionesPrint.ip || 'servidor' }, 'Voucher impreso via ESC/POS')
      return reply.status(200).send({ ok: true, mensaje: `Voucher ${ticket.formato} enviado a la impresora.` })
    } catch (err) {
      fastify.log.warn({ code: err.code, message: err.message }, 'Error de impresora ESC/POS')

      if (err.code === 'IMPRESORA_INACTIVA' || err.code === 'IP_NO_CONFIGURADA') {
        return reply.status(409).send({ ok: false, codigo: err.code, mensaje: err.message })
      }

      const msg = err.code === 'ECONNREFUSED'
        ? 'No se pudo conectar a la impresora. Verifique que este encendida y en la red.'
        : err.code === 'TIMEOUT'
          ? 'La impresora no respondio a tiempo. Verifique la conexion de red.'
          : `Error de impresora: ${err.message}`

      return reply.status(503).send({ ok: false, codigo: err.code || 'ERROR_IMPRESORA', mensaje: msg })
    }
  })
}