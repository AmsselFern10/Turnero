'use strict'

const {
  llamarSiguiente,
  cancelarTurno,
  generarTurnoKiosko,
  consultarMiTurno
} = require('./service')

/**
 * Módulo de turnos — Rutas Fastify
 * Prefijo: /turnos
 */
module.exports = async function turnosRoutes (fastify) {

  // ── POST /turnos/llamar — EL ENDPOINT PRINCIPAL (RF-TURN-01) ──────────────
  // Rate limit: máx 5 llamados/seg por operador (RNF-SEG-07)
  fastify.post('/llamar', {
    preHandler: [fastify.authorizeRol('operador', 'supervisor')],
    config: {
      rateLimit: {
        max:        30,
        timeWindow: '1 second',
        keyGenerator: (req) => {
          if (req.user?.id) return `turno:${req.user.id}`
          const auth = req.headers?.authorization
          if (auth && auth.startsWith('Bearer ')) {
            try {
              const decoded = fastify.jwt.decode(auth.slice(7))
              if (decoded?.id) return `turno:${decoded.id}`
            } catch (_) {}
          }
          return `turno:${req.ip}`
        },
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: 'Rate limit',
          message: 'Máximo 30 llamadas por segundo por operador.'
        })
      }
    },
    schema: {
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: {
          mesa_id: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { mesa_id } = request.body
    const operadorId   = request.user.id

    // ── Idempotency-Key: protege timeout + reintento = 2 turnos ──────────────
    const iKey = request.headers['idempotency-key']
    if (iKey) {
      // 1. Servir desde caché si ya completó
      if (fastify._idempotencyCache?.has(iKey)) {
        fastify.log.info({ iKey, mesa_id }, '[IDEM] Servido desde cache')
        return reply.status(200).send(fastify._idempotencyCache.get(iKey))
      }
      // 2. Coalescing: Si hay un request en vuelo con la misma key, esperar a que termine
      if (fastify._idempotencyPromises?.has(iKey)) {
        fastify.log.info({ iKey, mesa_id }, '[IDEM] Esperando request concurrente en vuelo')
        const resultadoEnVuelo = await fastify._idempotencyPromises.get(iKey)
        return reply.status(200).send(resultadoEnVuelo)
      }
    }

    const operacionLlamar = (async () => {
      const resultado = await llamarSiguiente(fastify, {
        mesaId:     mesa_id,
        operadorId
      })

      const { turno, vouchers_restantes, proximo_numero, es_idempotente } = resultado

      // Si fue reintento/doble-clic idempotente, no re-anunciar a TV ni recargar cola
      if (!es_idempotente) {
        // Broadcast seguro desacoplado: se despacha en background post-commit sin queries extra a BD
        // El payload sale directamente de la transacción. Un fallo de WS no bloquea la respuesta ni causa 500.
        setImmediate(async () => {
          try {
            await Promise.allSettled([
              // TV: anuncia el nuevo número (payload de la transacción, 0 queries extra a BD)
              fastify.broadcast('tv:global', 'nuevo_llamado', {
                evento_id:      crypto.randomUUID(),
                turno:          turno.numero,
                numero:         turno.numero,
                mesa_numero:    turno.mesa_numero,
                mesa_nombre:    turno.mesa_nombre,
                lote_numero:    turno.lote_numero,
                proximo_numero: proximo_numero,
                llamado_en:     turno.llamado_en,
                historial:      []
              }),
              // Panel del operador: actualiza su panel
              fastify.broadcast(`mesa:${mesa_id}`, 'turno_llamado', {
                turno,
                proximo_numero,
                vouchers_restantes
              }),
              // Canal unificado de progreso de lote (RF-TURN-09): 1 broadcast, 0 queries extra a BD
              fastify.broadcast('lote:activo', 'proximo_actualizado', {
                lote:               turno.lote_numero,
                ultimo_llamado:     turno.numero,
                proximo_numero,
                vouchers_restantes
              }),
              // Admin: KPI update
              fastify.broadcast('admin:all', 'kpi_update', {
                mesa_id,
                turno_numero:       turno.numero,
                vouchers_restantes,
                tipo_evento:        'llamado'
              })
            ])
          } catch (broadcastErr) {
            fastify.log.error({ err: broadcastErr, mesa_id, turno_id: turno.id }, 'Error no fatal en broadcast WS post-commit')
          }
        })
      }

      return { turno, proximo_numero, vouchers_restantes }
    })()

    if (iKey && fastify._idempotencyPromises) {
      fastify._idempotencyPromises.set(iKey, operacionLlamar)
    }

    let responseBody
    try {
      responseBody = await operacionLlamar
    } finally {
      if (iKey && fastify._idempotencyPromises) {
        fastify._idempotencyPromises.delete(iKey)
      }
    }

    // Guardar en cache de idempotencia para proteger reintentos posteriores tras timeout
    if (iKey && fastify._idempotencyCache) {
      fastify._idempotencyCache.set(iKey, responseBody)
      setTimeout(() => fastify._idempotencyCache.delete(iKey), 60_000)
    }

    return reply.status(200).send(responseBody)
  })

  // ── POST /turnos/:id/cancelar — No se presentó (RF-TURN-05) ───────────────
  fastify.post('/:id/cancelar', {
    preHandler: [fastify.authorizeRol('operador', 'supervisor')],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } }
      },
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: { mesa_id: { type: 'integer' } }
      }
    }
  }, async (request, reply) => {
    const turnoId    = parseInt(request.params.id)
    const { mesa_id } = request.body
    const operadorId   = request.user.id

    const turno = await cancelarTurno(fastify, {
      turnoId,
      operadorId,
      mesaId: mesa_id
    })

    // Notificar al admin
    await fastify.broadcast('admin:all', 'turno_cancelado', {
      turno_id:    turno.id,
      turno_numero: turno.numero,
      mesa_id
    })

    return reply.status(200).send({ message: 'Turno cancelado', turno })
  })

  // ── POST /turnos/:id/rellamar — Re-llamar turno actual (RF-MESA / TV) ─────────
  fastify.post('/:id/rellamar', {
    preHandler: [fastify.authorizeRol('operador', 'supervisor')],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } }
      },
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: { mesa_id: { type: 'integer' } }
      }
    }
  }, async (request, reply) => {
    const mesa_id = parseInt(request.body.mesa_id)
    const operadorId  = request.user.id

    // Cooldown de 3 s por mesa para evitar re-llamados espurios o saturación de TV
    if (!fastify._cooldownsRellamado) {
      fastify._cooldownsRellamado = new Map()
    }
    const ahora = Date.now()
    const ultimoRellamado = fastify._cooldownsRellamado.get(mesa_id) || 0
    if (ahora - ultimoRellamado < 3000) {
      return reply.status(429).send({ error: 'Debe esperar 3 segundos entre re-llamados a la TV' })
    }

    // El servidor re-llama el turno en_atencion de esa mesa (fuente de verdad en BD)
    const { rows: [turno] } = await fastify.db.query(
      `SELECT t.id, t.numero, t.mesa_id, m.numero AS mesa_numero, m.nombre AS mesa_nombre, l.numero_lote
       FROM turnos t
       JOIN mesas m ON t.mesa_id = m.id
       JOIN lotes_voucher l ON t.lote_id = l.id
       WHERE t.mesa_id = $1 AND t.estado = 'en_atencion'
       LIMIT 1`,
      [mesa_id]
    )

    if (!turno) {
      return reply.status(409).send({ error: 'No hay turno en atención en esta mesa para re-llamar' })
    }

    // Registrar cooldown
    fastify._cooldownsRellamado.set(mesa_id, ahora)

    const evento_id = crypto.randomUUID()
    const payloadRellamado = {
      evento_id,
      turno:       turno.numero,
      numero:      turno.numero,
      mesa_numero: turno.mesa_numero,
      mesa_nombre: turno.mesa_nombre,
      lote_numero: turno.numero_lote,
      llamado_en:  new Date().toISOString()
    }

    // Re-anunciar a la TV pública con evento propio 'turno_rellamado' (y alias 'rellamado')
    await Promise.all([
      fastify.broadcast('tv:global', 'turno_rellamado', payloadRellamado),
      fastify.broadcast('tv:global', 'rellamado', payloadRellamado),
      fastify.db.query(
        `INSERT INTO audit_log (mesa_id, turno_id, operador_id, accion, metadata_json, ip_origen)
         VALUES ($1, $2, $3, 'TURNO_RELLAMADO', $4, $5)`,
        [mesa_id, turno.id, operadorId, JSON.stringify({ numero: turno.numero, evento_id }), request.ip]
      )
    ])

    return reply.status(200).send({ message: 'Turno re-llamado con éxito', turno })
  })

  // ── GET /turnos/estado — Snapshot para reconexión WS (1 sola query consolidada) ─
  fastify.get('/estado', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: { mesa_id: { type: 'integer' } }
      }
    }
  }, async (request, reply) => {
    const mesaId = request.query.mesa_id || null

    // Exactamente 1 query consolidada a PostgreSQL (presupuesto 1 query)
    const { rows: [estadoData] } = await fastify.db.query(
      `SELECT
         (SELECT row_to_json(l) FROM (
            SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado, estado
            FROM lotes_voucher WHERE estado = 'activo' LIMIT 1
          ) l) AS lote,
         (CASE WHEN $1::int IS NOT NULL THEN
            (SELECT row_to_json(m) FROM (
               SELECT id, numero, nombre, estado
               FROM mesas WHERE id = $1::int
             ) m)
          ELSE NULL END) AS mesa,
         (CASE WHEN $1::int IS NOT NULL THEN
            (SELECT row_to_json(t) FROM (
               SELECT id, numero, llamado_en, estado
               FROM turnos WHERE mesa_id = $1::int AND estado = 'en_atencion'
               LIMIT 1
             ) t)
          ELSE NULL END) AS turno_actual,
         (CASE WHEN $1::int IS NOT NULL THEN
            (SELECT COUNT(*)::int
             FROM turnos
             WHERE mesa_id = $1::int AND estado = 'atendido' AND llamado_en >= CURRENT_DATE
            )
          ELSE 0 END) AS atendidos_hoy,
         (SELECT json_agg(u) FROM (
            SELECT t.numero, m.numero AS mesa_numero, m.nombre AS mesa_nombre, t.llamado_en
            FROM turnos t
            JOIN mesas m ON t.mesa_id = m.id
            WHERE t.estado IN ('en_atencion', 'atendido')
              AND t.creado_en >= CURRENT_DATE
            ORDER BY t.llamado_en DESC
            LIMIT 10
          ) u) AS ultimos_turnos`,
      [mesaId]
    )

    const lote = estadoData?.lote || null

    return reply.send({
      lote,
      mesa:           estadoData?.mesa || null,
      turno_actual:   estadoData?.turno_actual || null,
      atendidos_hoy:  estadoData?.atendidos_hoy || 0,
      ultimos_turnos: estadoData?.ultimos_turnos || [],
      proximo_numero: lote && lote.ultimo_numero_llamado < lote.numero_hasta ? lote.ultimo_numero_llamado + 1 : null
    })
  })

  // ── POST /turnos/generar — Kiosko web (RF-GEN-02) ─────────────────────────
  // Rate limit: 1 turno por IP cada 3 segundos para evitar generacion masiva
  fastify.post('/generar', {
    config: {
      rateLimit: {
        max: 1,
        timeWindow: '3 seconds',
        keyGenerator: (req) => `kiosko:${req.ip}`,
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: { codigo: 'espere_antes_de_reintentar', mensaje: 'Solo puede generar un turno cada 3 segundos.' }
        })
      }
    }
  }, async (request, reply) => {
    // Verificar limite de turnos en espera (maximo 200 simultaneos)
    const { rows: [{ total }] } = await fastify.db.query(
      `SELECT COUNT(*)::int AS total FROM turnos WHERE estado = 'esperando'`
    )
    if (total >= 200) {
      return reply.status(503).header('Retry-After', '30').send({
        error: { codigo: 'cola_llena', mensaje: 'La cola de espera esta llena. Intente en unos minutos.' }
      })
    }

    const resultado = await generarTurnoKiosko(fastify, { ip: request.ip })

    await fastify.broadcast('admin:all', 'kiosko_turno_generado', { numero: resultado.numero })

    return reply.status(201).send(resultado)
  })

  // ── GET /turnos/mi-turno/:token — Consulta kiosko (RF-GEN-03) ─────────────
  // Cache Redis 4 segundos: multiples consultas del mismo estudiante = 1 query a BD
  fastify.get('/mi-turno/:token', {
    schema: {
      params: {
        type: 'object',
        properties: { token: { type: 'string', minLength: 64, maxLength: 64 } }
      }
    }
  }, async (request, reply) => {
    const token = request.params.token
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

    return reply.header('X-Cache', 'MISS').send(resultado)
  })

  // ── GET /turnos/historial — Últimos N turnos del día ──────────────────────
  fastify.get('/historial', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limite:   { type: 'integer', default: 20, minimum: 1, maximum: 100 },
          mesa_id:  { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    const { limite = 20, mesa_id } = request.query

    const params  = [limite]
    let whereClause = `WHERE t.creado_en >= date_trunc('day', NOW())`

    if (mesa_id) {
      params.push(mesa_id)
      whereClause += ` AND t.mesa_id = $${params.length}`
    }

    const { rows } = await fastify.db.query(
      `SELECT t.id, t.numero, t.estado, t.origen,
              t.llamado_en, t.finalizado_en,
              t.duracion_atencion_seg,
              m.numero AS mesa_numero, m.nombre AS mesa_nombre,
              u.nombre_completo AS operador_nombre
       FROM turnos t
       LEFT JOIN mesas m ON t.mesa_id = m.id
       LEFT JOIN usuarios u ON t.operador_id = u.id
       ${whereClause}
       ORDER BY t.llamado_en DESC NULLS LAST
       LIMIT $1`,
      params
    )

    return reply.send({ turnos: rows })
  })

  // ── GET /turnos/configuracion-publica — Parámetros públicos para TV y Kiosko ──
  fastify.get('/configuracion-publica', async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT clave, valor FROM configuracion WHERE clave IN ('voz_anuncio_activa', 'kiosko_web_activo', 'alerta_vouchers_restantes')`
    )
    const configMap = {
      voz_anuncio_activa: true,
      kiosko_web_activo: false,
      alerta_vouchers_restantes: 20
    }
    for (const r of rows) {
      if (r.clave === 'voz_anuncio_activa') configMap.voz_anuncio_activa = r.valor !== 'false'
      else if (r.clave === 'kiosko_web_activo') configMap.kiosko_web_activo = r.valor === 'true'
      else if (r.clave === 'alerta_vouchers_restantes') configMap.alerta_vouchers_restantes = parseInt(r.valor, 10) || 20
    }
    return reply.send(configMap)
  })
}
