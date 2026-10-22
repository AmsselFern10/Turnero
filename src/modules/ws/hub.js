'use strict'

const fp = require('fastify-plugin')
const crypto = require('crypto')

/**
 * WebSocket Hub — Centro de difusión en tiempo real institucional (v2.1)
 *
 * Canales (RF-WS-02):
 *   mesa:<id>       → Panel del operador de ventanilla
 *   tv:global       → Pantallas públicas TV de auditorio 1080p
 *   admin:all       → Panel de administración y supervisión
 *   kiosko:<token>  → Pantalla de seguimiento móvil del estudiante
 *
 * Protocolo de mensaje (RF-WS-07):
 *   { tipo: string, payload: object, seq: number, timestamp: string }
 *
 * Invariantes implementadas:
 *   1. Auto-sincronización con secuencia monotónica `seq` y snapshot.
 *   2. Autorización estricta por canal (Cero IDOR).
 *   3. Backpressure y maxPayload para clientes lentos (Cero OOM).
 *   4. Recuperación autónoma ante caídas de Redis o red (Cero crash en LAN).
 *   5. Difusión post-COMMIT con degradación local.
 *   6. Heartbeat simétrico (ping/pong W3C + aplicación) sin falsos cortes.
 */

// Identificador único de esta instancia de Node.js para evitar rebotes en Redis Pub/Sub
const INSTANCE_ID = crypto.randomUUID()

/** @type {Map<string, Set<WebSocket>>} canal → Set de conexiones */
const suscriptores = new Map()

/** @type {Map<number|string, Set<WebSocket>>} userId → Set de conexiones */
const userSockets = new Map()

/** @type {Map<string, number>} canal → último número de secuencia monotónico */
const canalSeqs = new Map()

// Caché en memoria para snapshots de TV y Kiosko (evita N+1 en reconexiones masivas - WS-012)
let snapshotCacheTv = null
let snapshotCacheTvTime = 0
let snapshotCacheKiosko = null
let snapshotCacheKioskoTime = 0
const SNAPSHOT_CACHE_TTL = 3000 // 3 segundos

/**
 * Valida y normaliza el canal solicitado según el rol y credenciales del usuario (WS-002: Anti-IDOR).
 * @param {object} user
 * @param {string} canalSolicitado
 * @param {number|null} queryMesaId
 * @returns {string} Canal normalizado autorizado
 */
function validarCanalAutorizado (user, canalSolicitado, queryMesaId) {
  // 1. Estudiante / Kiosko: únicamente su canal de turno tokenizado o canal público
  if (user.rol === 'kiosko' || (canalSolicitado && (canalSolicitado.startsWith('kiosko:') || canalSolicitado === 'kiosko:publico'))) {
    return canalSolicitado
  }

  // 2. Pantalla pública TV
  if (user.rol === 'tv' || user.id === 0 || canalSolicitado === 'tv:global') {
    return 'tv:global'
  }

  // 3. Administrador: acceso a admin:all, tv:global o cualquier mesa
  if (user.rol === 'admin') {
    if (canalSolicitado === 'admin:all' || canalSolicitado === 'tv:global' || canalSolicitado.startsWith('mesa:')) {
      return canalSolicitado
    }
    return 'admin:all'
  }

  // 3. Operador: únicamente su mesa asignada o display público
  if (user.rol === 'operador') {
    if (canalSolicitado === 'tv:global' || canalSolicitado === 'lote:activo') {
      return canalSolicitado
    }
    const mesaAsignada = user.mesa_id !== null && user.mesa_id !== undefined ? Number(user.mesa_id) : null
    if (!mesaAsignada) {
      const err = new Error('Operador sin mesa asignada')
      err.statusCode = 403
      throw err
    }
    // Si solicita una mesa distinta a la suya, rechazar (Anti-IDOR)
    if (canalSolicitado && canalSolicitado !== `mesa:${mesaAsignada}`) {
      const err = new Error('No tiene autorización para escuchar otra mesa')
      err.statusCode = 403
      throw err
    }
    if (queryMesaId && Number(queryMesaId) !== mesaAsignada) {
      const err = new Error('No tiene autorización para escuchar otra mesa')
      err.statusCode = 403
      throw err
    }
    return `mesa:${mesaAsignada}`
  }

  // 4. Estudiante / Kiosko: únicamente su canal de turno tokenizado
  if (canalSolicitado && canalSolicitado.startsWith('kiosko:')) {
    return canalSolicitado
  }

  const err = new Error('Canal no autorizado para este perfil')
  err.statusCode = 403
  throw err
}

/**
 * Suscribe una conexión WS a un canal.
 * @param {string} canal
 * @param {WebSocket} ws
 */
function suscribir (canal, ws) {
  if (!suscriptores.has(canal)) {
    suscriptores.set(canal, new Set())
  }
  suscriptores.get(canal).add(ws)

  if (!ws.canales) ws.canales = new Set()
  ws.canales.add(canal)

  if (ws.userId !== undefined && ws.userId !== null) {
    const uid = String(ws.userId)
    if (!userSockets.has(uid)) {
      userSockets.set(uid, new Set())
    }
    userSockets.get(uid).add(ws)
  }
}

/**
 * Desuscribe una conexión WS de todos sus canales y mapas en O(1).
 * @param {WebSocket} ws
 */
function desuscribir (ws) {
  if (ws.canales) {
    for (const canal of ws.canales) {
      const conns = suscriptores.get(canal)
      if (conns) {
        conns.delete(ws)
        if (conns.size === 0) suscriptores.delete(canal)
      }
    }
    ws.canales.clear()
  }

  if (ws.userId !== undefined && ws.userId !== null) {
    const uid = String(ws.userId)
    if (userSockets.has(uid)) {
      const userConns = userSockets.get(uid)
      userConns.delete(ws)
      if (userConns.size === 0) userSockets.delete(uid)
    }
  }
}

/**
 * Difunde un mensaje a todos los suscriptores locales de un canal con control de backpressure.
 * @param {string} canal
 * @param {string} tipo
 * @param {object} payload
 * @param {number|null} customSeq
 * @param {object|null} logger
 * @returns {number} Número de secuencia monotónico asignado
 */
function broadcastLocal (canal, tipo, payload, customSeq = null, logger = null) {
  const conns = suscriptores.get(canal)
  if (!conns || conns.size === 0) return 0

  const seq = customSeq !== null ? customSeq : ((canalSeqs.get(canal) || 0) + 1)
  if (customSeq === null) canalSeqs.set(canal, seq)

  // Invalidar caché de TV ante nuevos llamados
  if (canal === 'tv:global') {
    snapshotCacheTv = null
  }

  const mensaje = JSON.stringify({
    tipo,
    payload,
    seq,
    timestamp: new Date().toISOString()
  })

  // Umbral de Backpressure: 512 KB (WS-004)
  const MAX_BUFFERED_AMOUNT = 512 * 1024

  for (const ws of conns) {
    if (ws.readyState === 1 /* OPEN */) {
      if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        if (logger) logger.warn({ userId: ws.userId, canal }, 'Desconectando socket lento por exceso de backpressure')
        try { ws.close(1008, 'Buffer excedido') } catch (_) {}
        conns.delete(ws)
        continue
      }
      ws.send(mensaje)
    } else {
      conns.delete(ws)
    }
  }

  return seq
}

/**
 * Envía un snapshot del estado actual al conectar o reconectar (RF-WS-05).
 * @param {WebSocket} ws
 * @param {object} fastify
 * @param {object} user
 */
async function enviarSnapshot (ws, fastify, user) {
  try {
    const now = Date.now()

    // 1. Pantalla pública TV (con caché rápida de 3s para evitar N+1 tras reconexión masiva)
    if (user.canal === 'tv:global') {
      if (snapshotCacheTv && (now - snapshotCacheTvTime < SNAPSHOT_CACHE_TTL)) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            tipo: 'snapshot',
            payload: snapshotCacheTv,
            timestamp: new Date().toISOString()
          }))
        }
        return
      }

      const { rows: [snapData] } = await fastify.db.query(
        `SELECT
           (SELECT valor FROM configuracion WHERE clave = 'modo_generacion_turnos' LIMIT 1) AS modo,
           (SELECT row_to_json(l) FROM (
              SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado, estado
              FROM lotes_voucher WHERE estado = 'activo' LIMIT 1
            ) l) AS lote,
           (SELECT numero FROM turnos
            WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()
            ORDER BY sesion ASC, numero ASC LIMIT 1
           ) AS proximo_kiosko,
           (SELECT json_agg(h) FROM (
              SELECT t.numero, m.numero AS mesa_numero, m.nombre AS mesa_nombre, t.llamado_en
              FROM turnos t
              JOIN mesas m ON t.mesa_id = m.id
              WHERE t.estado IN ('en_atencion', 'atendido')
                AND t.creado_en >= CURRENT_DATE
                AND (
                  ((SELECT valor FROM configuracion WHERE clave = 'modo_generacion_turnos' LIMIT 1) = 'kiosko_web' AND t.origen = 'kiosko_web')
                  OR
                  ((SELECT COALESCE(valor, 'voucher_fisico') FROM configuracion WHERE clave = 'modo_generacion_turnos' LIMIT 1) != 'kiosko_web' AND t.origen = 'voucher_fisico')
                )
              ORDER BY t.llamado_en DESC
              LIMIT 5
            ) h) AS historial`
      )

      const modo = snapData?.modo || 'voucher_fisico'
      const lote = snapData?.lote || null
      const historial = snapData?.historial || []
      const ultimoLlamado = historial.length > 0 ? historial[0] : null
      const proximoNumero = modo === 'kiosko_web'
        ? (snapData?.proximo_kiosko || null)
        : (lote ? (lote.ultimo_numero_llamado < lote.numero_hasta ? lote.ultimo_numero_llamado + 1 : null) : null)

      const payload = {
        ultimo_llamado: ultimoLlamado,
        historial: historial.slice(1, 5), // Exactamente los 4 turnos precedentes
        proximo_numero: proximoNumero,
        lote: modo === 'kiosko_web' ? null : lote,
        modo
      }

      snapshotCacheTv = payload
      snapshotCacheTvTime = now

      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          tipo: 'snapshot',
          payload,
          timestamp: new Date().toISOString()
        }))
      }
      return
    }

    // 2. Operador de ventanilla — snapshot consolidado
    if (user.rol === 'operador' && user.mesa_id) {
      const [resConfig, resLote, resMesa] = await Promise.all([
        fastify.db.query(
          `SELECT valor FROM configuracion WHERE clave = 'modo_generacion_turnos' LIMIT 1`
        ),
        fastify.db.query(
          `SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado, estado
           FROM lotes_voucher WHERE estado = 'activo' LIMIT 1`
        ),
        fastify.db.query(
          `SELECT
             (SELECT row_to_json(t) FROM (
                SELECT id, numero, llamado_en, estado
                FROM turnos
                WHERE mesa_id = $1 AND estado = 'en_atencion' AND fecha_turno = fn_fecha_hoy()
                LIMIT 1
              ) t) AS turno_actual,
             (SELECT COUNT(*)::int
              FROM turnos
              WHERE mesa_id = $1 AND estado = 'atendido' AND fecha_turno = fn_fecha_hoy()
             ) AS atendidos_hoy,
             (SELECT COUNT(*)::int
              FROM turnos
              WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()
             ) AS turnos_en_espera,
             (SELECT numero
              FROM turnos
              WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()
              ORDER BY sesion ASC, numero ASC LIMIT 1
             ) AS proximo_kiosko`,
          [user.mesa_id]
        )
      ])

      const modo = resConfig.rows[0]?.valor || 'voucher_fisico'
      const lote = resLote.rows[0] || null
      const mesaData = resMesa.rows[0] || { turno_actual: null, atendidos_hoy: 0 }
      const turnoActual = mesaData.turno_actual || null
      const count = mesaData.atendidos_hoy || 0

      let proximoNumero = null
      let vouchersRestantes = 0

      if (modo === 'kiosko_web') {
        proximoNumero = mesaData.proximo_kiosko || null
        vouchersRestantes = mesaData.turnos_en_espera || 0
      } else {
        proximoNumero = lote && lote.ultimo_numero_llamado < lote.numero_hasta ? lote.ultimo_numero_llamado + 1 : null
        vouchersRestantes = lote ? Math.max(0, lote.numero_hasta - lote.ultimo_numero_llamado) : 0
      }

      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          tipo: 'snapshot',
          payload: {
            turno_actual: turnoActual,
            atendidos_hoy: count,
            lote: modo === 'kiosko_web' ? null : lote,
            proximo_numero: proximoNumero,
            vouchers_restantes: vouchersRestantes,
            modo
          },
          timestamp: new Date().toISOString()
        }))
      }
      return
    }

    // 3. Panel de Administración (admin:all)
    if (user.canal === 'admin:all') {
      const [resCfg, resLote, resEsperando] = await Promise.all([
        fastify.db.query(`SELECT valor FROM configuracion WHERE clave = 'modo_generacion_turnos' LIMIT 1`),
        fastify.db.query(
          `SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado, estado
           FROM lotes_voucher WHERE estado = 'activo' LIMIT 1`
        ),
        fastify.db.query(
          `SELECT COUNT(*)::int AS count FROM turnos
           WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()`
        )
      ])

      const modo = resCfg.rows[0]?.valor || 'voucher_fisico'
      const lote = resLote.rows[0] || null
      const enEspera = resEsperando.rows[0]?.count || 0

      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          tipo: 'snapshot',
          payload: {
            lote: modo === 'kiosko_web' ? null : lote,
            turnos_en_espera: enEspera,
            modo
          },
          timestamp: new Date().toISOString()
        }))
      }
      return
    }

    // 4. Canal público Kiosko para smartphones (con caché rápida de 3s para evitar N+1 tras reconexión masiva)
    if (user.canal === 'kiosko:publico') {
      if (snapshotCacheKiosko && (now - snapshotCacheKioskoTime < SNAPSHOT_CACHE_TTL)) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            tipo: 'snapshot',
            payload: snapshotCacheKiosko,
            timestamp: new Date().toISOString()
          }))
        }
        return
      }

      const { rows } = await fastify.db.query(
        `SELECT
           (SELECT json_agg(h) FROM (
              SELECT t.numero, m.numero AS mesa_numero, m.nombre AS mesa_nombre, t.llamado_en
              FROM turnos t
              JOIN mesas m ON t.mesa_id = m.id
              WHERE t.estado IN ('en_atencion', 'atendido')
                AND t.creado_en >= CURRENT_DATE
              ORDER BY t.llamado_en DESC
              LIMIT 10
            ) h) AS ultimos_llamados,
           (SELECT COUNT(*)::int FROM mesas WHERE estado = 'activa') AS mesas_activas,
           (SELECT COUNT(*)::int FROM turnos WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()) AS turnos_esperando,
           (SELECT numero FROM turnos WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy() ORDER BY sesion ASC, numero ASC LIMIT 1) AS proximo_numero`
      )
      const data = rows[0] || {}
      const ultimosLlamados = data.ultimos_llamados || []
      const ultimoLlamado = ultimosLlamados.length > 0 ? ultimosLlamados[0] : null

      const payload = {
        ultimo_llamado: ultimoLlamado,
        ultimos_llamados: ultimosLlamados,
        mesas_activas: data.mesas_activas || 0,
        turnos_esperando: data.turnos_esperando || 0,
        proximo_numero: data.proximo_numero || null
      }

      snapshotCacheKiosko = payload
      snapshotCacheKioskoTime = now

      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          tipo: 'snapshot',
          payload,
          timestamp: new Date().toISOString()
        }))
      }
      return
    }
  } catch (err) {
    fastify.log.error({ err }, 'Error enviando snapshot WS')
  }
}

// Plugin Fastify envuelto con fastify-plugin
async function hubPlugin (fastify) {
  const HEARTBEAT_INTERVAL = 30_000 // 30s (RF-WS-06)

  /**
   * Endpoint WebSocket autenticado y protegido contra IDOR (RF-WS-02, RF-WS-03).
   *
   * Query params:
   *   ticket → Ticket efímero de un solo uso (30s) (Recomendado - WS-005)
   *   token  → JWT del usuario (Alternativo)
   *   canal  → 'mesa:<id>' | 'tv:global' | 'admin:all' | 'kiosko:<token>'
   */
  fastify.get('/ws', {
    websocket: true,
    preValidation: async (request, reply) => {
      // 1. Validar Origin en producción para prevenir CSWSH (WS-006)
      const origin = request.headers.origin
      if (origin && process.env.NODE_ENV === 'production') {
        const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
        if (allowed.length > 0 && !allowed.includes(origin)) {
          return reply.code(403).send({ error: 'Origin no permitido' })
        }
      }

      // 2. Extraer credenciales (Ticket efímero o JWT)
      const ticket = request.query.ticket
      const token = request.query.token
      const canalSolicitado = request.query.canal || 'tv:global'

      let user = null

      if (ticket) {
        // Consumir ticket efímero de Redis atómicamente con GETDEL (WS-005)
        let rawTicket = null
        if (fastify.redis.getdel) {
          rawTicket = await fastify.redis.getdel(`ws_ticket:${ticket}`)
        } else {
          rawTicket = await fastify.redis.get(`ws_ticket:${ticket}`)
          if (rawTicket) await fastify.redis.del(`ws_ticket:${ticket}`)
        }

        if (!rawTicket) {
          return reply.code(401).send({ error: 'Ticket de conexión inválido o expirado' })
        }
        try {
          user = JSON.parse(rawTicket)
        } catch (_) {
          return reply.code(401).send({ error: 'Ticket malformado' })
        }
      } else if (token) {
        try {
          user = fastify.jwt.verify(token)
          const bl = await fastify.redis.get(`bl:${user.jti}`)
          if (bl) {
            return reply.code(401).send({ error: 'Token revocado' })
          }
        } catch (_) {
          return reply.code(401).send({ error: 'Token JWT inválido o expirado' })
        }
      } else if (canalSolicitado === 'tv:global') {
        // Pantalla pública pasiva de auditorio (RF-TV-04)
        user = { id: 0, rol: 'tv', username: 'tv_display' }
      } else if (canalSolicitado.startsWith('kiosko:')) {
        // Pantalla de seguimiento móvil del estudiante (RF-GEN-03)
        user = { id: 0, rol: 'kiosko', username: 'kiosko_guest' }
      } else {
        return reply.code(401).send({ error: 'Autenticación requerida para acceder al canal solicitado' })
      }

      // 3. Validar canal autorizado y blindar contra IDOR (WS-002)
      try {
        if (user.rol === 'operador') {
          const { rows: [mesaRow] } = await fastify.db.query(
            `SELECT id FROM mesas WHERE operador_id = $1 AND estado != 'inactiva' LIMIT 1`,
            [user.id]
          )
          user.mesa_id = mesaRow ? Number(mesaRow.id) : null
        }
        const queryMesaId = request.query.mesa_id ? parseInt(request.query.mesa_id, 10) : null
        const canalAutorizado = validarCanalAutorizado(user, canalSolicitado, queryMesaId)
        request.wsUser = user
        request.wsCanal = canalAutorizado
        request.wsMesaId = user.mesa_id || queryMesaId || null
      } catch (err) {
        return reply.code(err.statusCode || 403).send({ error: err.message })
      }
    }
  }, async (connection, request) => {
    const ws = connection.socket || connection
    const user = request.wsUser
    const canal = request.wsCanal

    user.canal = canal
    user.mesa_id = request.wsMesaId

    ws.userId = user.id
    ws.isAlive = true

    // Garantizar UNA SOLA CONEXIÓN activa por usuario: si ya tenía sockets abiertos,
    // terminarlos de inmediato antes de suscribir el nuevo socket.
    if (user.id && user.id !== 0) {
      fastify.desconectarUsuario(user.id, 'Sesión reemplazada por nueva conexión')
    }

    // Suscribir socket al canal verificado
    suscribir(canal, ws)
    if (canal.startsWith('mesa:')) {
      // Auto-suscribir al operador al canal de progreso del lote (RF-TURN-09: 1 socket, cero queries extra)
      suscribir('lote:activo', ws)
    }
    fastify.log.info({ user: user.id, rol: user.rol, canal }, 'WS conectado y verificado')

    // Snapshot inicial
    await enviarSnapshot(ws, fastify, user)

    // Listener de pong nativo RFC 6455
    ws.on('pong', () => { ws.isAlive = true })

    // Manejo de mensajes entrantes del cliente (WS-001)
    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        try { ws.close(1003, 'Frames binarios no soportados') } catch (_) {}
        return
      }

      try {
        const msg = JSON.parse(data.toString())

        // 1. Responder a ping de aplicación con pong de aplicación inmediato (WS-001)
        if (msg.tipo === 'ping') {
          ws.isAlive = true
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              tipo: 'pong',
              payload: { serverTime: Date.now() },
              timestamp: new Date().toISOString()
            }))
          }
          return
        }

        // 2. Pong de aplicación
        if (msg.tipo === 'pong') {
          ws.isAlive = true
          return
        }

        // 3. Solicitud explícita de snapshot tras reconexión (RF-WS-05)
        if (msg.tipo === 'solicitar_snapshot') {
          await enviarSnapshot(ws, fastify, user)
          return
        }

        // 4. Vista previa en vivo de escala de TV desde panel admin (sin esperar guardado en BD)
        if (msg.tipo === 'preview_escala_tv') {
          if (user.rol === 'admin' || user.rol === 'supervisor') {
            await fastify.broadcast('tv:global', 'preview_escala_tv', msg.payload)
          }
          return
        }
      } catch (err) {
        fastify.log.warn({ err }, 'Mensaje WS malformado recibido')
      }
    })

    // Desconexión limpia
    ws.on('close', () => {
      desuscribir(ws)
      fastify.log.info({ user: user.id, canal }, 'WS desconectado')
    })

    ws.on('error', (err) => {
      fastify.log.warn({ err, user: user.id }, 'WS error en conexión')
      desuscribir(ws)
    })
  })

  // ── Heartbeat unificado global (WS-011: 1 solo timer en event loop) ────────
  const globalHeartbeatTimer = setInterval(() => {
    for (const conns of suscriptores.values()) {
      for (const ws of conns) {
        if (!ws.isAlive) {
          fastify.log.debug({ userId: ws.userId }, 'Terminando socket zombi por falta de respuesta')
          try { ws.terminate() } catch (_) {}
          continue
        }
        ws.isAlive = false
        try { ws.ping() } catch (_) {}
      }
    }
  }, HEARTBEAT_INTERVAL)

  // ── Redis Pub/Sub con resiliencia multi-instancia (WS-003) ─────────────────
  fastify.redisSub.subscribe('ws:broadcast', (err) => {
    if (err) fastify.log.error({ err }, 'Error suscribiendo canal Redis Pub/Sub')
  })

  fastify.redisSub.on('message', (channel, message) => {
    try {
      const msg = JSON.parse(message)
      // Si el mensaje fue publicado por esta misma instancia, ignorar para evitar duplicar
      if (msg.instanceId === INSTANCE_ID) return

      broadcastLocal(msg.canal, msg.tipo, msg.payload, msg.seq, fastify.log)
    } catch (err) {
      fastify.log.warn({ err }, 'Mensaje Redis Pub/Sub malformado')
    }
  })

  // ── Helper global fastify.broadcast con degradación local (RNF-DIS-04) ─────
  fastify.decorate('broadcast', async function (canal, tipo, payload) {
    // Invalidar cachés de snapshot si el evento altera el estado visible
    if (canal === 'tv:global' || canal === 'kiosko:publico' || tipo === 'llamados' || tipo === 'nuevo_llamado' || tipo === 'turno_llamado') {
      snapshotCacheTv = null
      snapshotCacheKiosko = null
    }

    // 1. Difundir SIEMPRE localmente en memoria (Garantiza entrega en LAN aún con Redis caído)
    const seq = broadcastLocal(canal, tipo, payload, null, fastify.log)

    // 2. Difundir a otras instancias vía Redis Pub/Sub si Redis está disponible
    try {
      if (fastify.redis && fastify.redis.status === 'ready') {
        await fastify.redis.publish('ws:broadcast', JSON.stringify({
          instanceId: INSTANCE_ID,
          canal,
          tipo,
          payload,
          seq
        }))
      }
    } catch (redisErr) {
      fastify.log.warn({ err: redisErr }, 'Fallo de publicación a Redis Pub/Sub. Difusión local mantenida.')
    }

    return seq
  })

  // ── Helper para desconectar sockets por usuario en Logout (WS-008) ────────
  fastify.decorate('desconectarUsuario', function (userId, motivo = 'Sesión cerrada') {
    const uid = String(userId)
    const conns = userSockets.get(uid)
    if (conns) {
      for (const ws of Array.from(conns)) {
        try {
          ws.close(4401, motivo)
          // Desuscribir de inmediato de todos los canales para evitar sockets zombis en memoria
          desuscribir(ws)
          if (typeof ws.terminate === 'function') {
            setImmediate(() => {
              try { ws.terminate() } catch (_) {}
            })
          }
        } catch (_) {}
      }
      userSockets.delete(uid)
    }
  })

  // Limpieza al cerrar la aplicación Fastify
  fastify.addHook('onClose', async () => {
    clearInterval(globalHeartbeatTimer)
    // Cerrar ordenadamente todos los sockets con código 1001 (WS-020)
    for (const conns of suscriptores.values()) {
      for (const ws of conns) {
        try { ws.close(1001, 'Servidor reiniciando') } catch (_) {}
      }
    }
    suscriptores.clear()
    userSockets.clear()
  })
}

module.exports = fp(hubPlugin, { name: 'ws-hub' })
module.exports.broadcastLocal = broadcastLocal
module.exports.suscribir = suscribir
module.exports.desuscribir = desuscribir
module.exports.validarCanalAutorizado = validarCanalAutorizado

