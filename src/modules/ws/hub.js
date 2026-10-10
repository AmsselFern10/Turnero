'use strict'

const fp = require('fastify-plugin')

/**
 * WebSocket Hub — Centro de difusión en tiempo real
 *
 * Canales (RF-WS-02):
 *   mesa:<id>   → Panel del operador
 *   tv:global   → Pantallas públicas TV
 *   admin:all   → Panel de administración
 *
 * Protocolo de mensaje (RF-WS-07):
 *   { tipo: string, payload: object, timestamp: string }
 *
 * Heartbeat (RF-WS-06):
 *   Ping cada 30s. Conexiones sin pong en 60s son cerradas.
 *
 * Reconexión (RF-WS-04):
 *   El cliente implementa backoff exponencial. Al reconectar,
 *   el servidor envía snapshot del estado actual (RF-WS-05).
 */

/** @type {Map<string, Set<WebSocket>>} canal → Set de conexiones */
const suscriptores = new Map()

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
}

/**
 * Desuscribe una conexión WS de todos sus canales.
 * @param {WebSocket} ws
 */
function desuscribir (ws) {
  for (const [canal, conns] of suscriptores) {
    conns.delete(ws)
    if (conns.size === 0) suscriptores.delete(canal)
  }
}

/**
 * Envía un mensaje a todos los suscriptores de un canal.
 * Conexiones cerradas son eliminadas automáticamente.
 * @param {string} canal
 * @param {string} tipo
 * @param {object} payload
 */
function broadcast (canal, tipo, payload) {
  const conns = suscriptores.get(canal)
  if (!conns || conns.size === 0) return

  const mensaje = JSON.stringify({
    tipo,
    payload,
    timestamp: new Date().toISOString()
  })

  for (const ws of conns) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(mensaje)
    } else {
      conns.delete(ws)
    }
  }
}

/**
 * Envía un snapshot del estado actual al reconectar (RF-WS-05).
 * @param {WebSocket} ws
 * @param {object} fastify
 * @param {object} user
 */
async function enviarSnapshot (ws, fastify, user) {
  try {
    // Estado del lote activo
    const { rows: [lote] } = await fastify.db.query(
      `SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado, estado
       FROM lotes_voucher WHERE estado = 'activo' LIMIT 1`
    )

    // Si es operador de mesa → snapshot de su mesa actual
    if (user.rol === 'operador' && user.mesa_id) {
      const { rows: [turnoActual] } = await fastify.db.query(
        `SELECT id, numero, llamado_en, estado
         FROM turnos WHERE mesa_id = $1 AND estado = 'en_atencion' LIMIT 1`,
        [user.mesa_id]
      )

      const { rows: [{ count }] } = await fastify.db.query(
        `SELECT COUNT(*) FROM turnos
         WHERE mesa_id = $1 AND estado = 'atendido' AND creado_en::date = CURRENT_DATE`,
        [user.mesa_id]
      )

      ws.send(JSON.stringify({
        tipo: 'snapshot',
        payload: {
          turno_actual: turnoActual || null,
          atendidos_hoy: parseInt(count),
          lote: lote || null,
          proximo_numero: lote ? lote.ultimo_numero_llamado + 1 : null
        },
        timestamp: new Date().toISOString()
      }))
    }

    // Si es TV → snapshot del historial reciente
    if (user.canal === 'tv:global') {
      const { rows: historial } = await fastify.db.query(
        `SELECT t.numero, m.nombre AS mesa_nombre, t.llamado_en
         FROM turnos t
         JOIN mesas m ON t.mesa_id = m.id
         WHERE t.estado IN ('en_atencion', 'atendido')
           AND t.creado_en::date = CURRENT_DATE
         ORDER BY t.llamado_en DESC
         LIMIT 5`
      )

      ws.send(JSON.stringify({
        tipo: 'snapshot',
        payload: { historial, lote: lote || null },
        timestamp: new Date().toISOString()
      }))
    }
  } catch (err) {
    fastify.log.error({ err }, 'Error enviando snapshot WS')
  }
}

// Exportar funciones de difusión para usar en módulos de dominio
module.exports.broadcast   = broadcast
module.exports.suscribir   = suscribir
module.exports.desuscribir = desuscribir

// Plugin de Fastify envuelto con fastify-plugin para exponer decorate('broadcast') globalmente
async function hubPlugin (fastify) {
  const HEARTBEAT_INTERVAL = 30_000  // 30s (RF-WS-06)
  const DEAD_TIMEOUT       = 60_000  // 60s sin pong → cerrar

  /**
   * Endpoint WebSocket autenticado (RF-WS-03).
   *
   * Query params:
   *   token  → JWT del usuario
   *   canal  → 'mesa:<id>' | 'tv:global' | 'admin:all'
   */
  fastify.get('/ws', { websocket: true }, async (connection, request) => {
    const ws = connection.socket || connection

    // ── Autenticación en el handshake (RF-WS-03) ──────────────────────────
    let user
    const canalSolicitado = request.query.canal || 'tv:global'
    try {
      const token = request.query.token
      if (token) {
        user = fastify.jwt.verify(token)

        // Verificar blacklist
        const bl = await fastify.redis.get(`bl:${user.jti}`)
        if (bl) throw new Error('Token revocado')
      } else if (canalSolicitado === 'tv:global') {
        // Display público pasivo 1080p para Smart TVs / Proyectores en auditorio (RF-TV-04)
        user = { id: 0, rol: 'tv', canal: 'tv:global' }
      } else {
        throw new Error('Token requerido')
      }
    } catch {
      ws.send(JSON.stringify({ tipo: 'error', payload: { message: 'No autorizado' } }))
      ws.close(1008, 'No autorizado')
      return
    }

    const canal = request.query.canal || (user.rol === 'admin' || user.rol === 'supervisor' ? 'admin:all' : 'tv:global')
    user.canal  = canal
    user.mesa_id = request.query.mesa_id ? parseInt(request.query.mesa_id) : null

    // ── Suscribir al canal ─────────────────────────────────────────────────
    suscribir(canal, ws)
    fastify.log.info({ user: user.id, canal }, 'WS conectado')

    // ── Snapshot inicial (RF-WS-05) ────────────────────────────────────────
    await enviarSnapshot(ws, fastify, user)

    // ── Heartbeat (RF-WS-06) ──────────────────────────────────────────────
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    const heartbeat = setInterval(() => {
      if (!ws.isAlive) {
        clearInterval(heartbeat)
        ws.terminate()
        return
      }
      ws.isAlive = false
      ws.ping()
    }, HEARTBEAT_INTERVAL)

    // ── Desconexión ────────────────────────────────────────────────────────
    ws.on('close', () => {
      clearInterval(heartbeat)
      desuscribir(ws)
      fastify.log.info({ user: user.id, canal }, 'WS desconectado')
    })

    ws.on('error', (err) => {
      fastify.log.warn({ err, user: user.id }, 'WS error')
    })
  })

  // Suscribir Redis Pub/Sub → difunde mensajes entre instancias del servidor
  fastify.redisSub.subscribe('ws:broadcast', (err) => {
    if (err) fastify.log.error({ err }, 'Error suscribiendo Redis Pub/Sub')
  })

  fastify.redisSub.on('message', (channel, message) => {
    try {
      const { canal, tipo, payload } = JSON.parse(message)
      broadcast(canal, tipo, payload)
    } catch (err) {
      fastify.log.warn({ err }, 'Mensaje Redis malformado')
    }
  })

  // Helper para que otros módulos puedan difundir via Redis (multi-instancia)
  fastify.decorate('broadcast', async function (canal, tipo, payload) {
    await fastify.redis.publish('ws:broadcast', JSON.stringify({ canal, tipo, payload }))
  })
}

module.exports = fp(hubPlugin, { name: 'ws-hub' })
module.exports.broadcast   = broadcast
module.exports.suscribir   = suscribir
module.exports.desuscribir = desuscribir

