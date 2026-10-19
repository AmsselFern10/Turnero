/**
 * Suite de Verificacion de WebSockets y Tiempo Real
 *
 * Valida conexion con JWT, suscripcion a canales segmentados (mesa, tv, admin),
 * heartbeat (ping/pong) y transmision reactiva de llamados.
 *
 * Requiere: Servidor HTTP/WS, Redis y Base de Datos corriendo.
 * Ejecucion: node tests/ws-suite.test.js
 */

const WebSocket = require('ws')
const { Pool } = require('pg')
const Redis = require('ioredis')
require('dotenv').config()

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE_HTTP = process.env.APP_URL || `http://localhost:${PORT}`
const BASE_WS = BASE_HTTP.replace('http', 'ws')

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runSuite() {
  console.log('======================================================================')
  console.log('SUITE DE VERIFICACION COMPLETA — WEBSOCKET Y TIEMPO REAL')
  console.log('======================================================================\n')

  let passed = 0
  let failed = 0

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`)
      passed++
    } else {
      console.error(`  [FAIL] ${message}`)
      failed++
    }
  }

  // ── PREPARACIÓN DEL ENTORNO DE BD Y REDIS ────────────────────────────────
  console.log('0. Preparando entorno de pruebas...')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const redis = new Redis(process.env.REDIS_URL, { password: process.env.REDIS_PASSWORD })

  // Limpiar límites de tasa previos en Redis
  const rateLimitKeys = await redis.keys('fastify-rate-limit-*')
  if (rateLimitKeys.length > 0) await redis.del(...rateLimitKeys)

  // Activar Lote y Mesas para pruebas de atención
  await pool.query("SET app.permitir_retroceso_lote = 'on'")
  await pool.query("UPDATE mesas SET estado = 'activa', operador_id = NULL")
  await pool.query("UPDATE lotes_voucher SET estado = 'cerrado' WHERE estado = 'activo'")
  await pool.query("UPDATE lotes_voucher SET estado = 'activo', ultimo_numero_llamado = 0 WHERE id = (SELECT id FROM lotes_voucher ORDER BY id ASC LIMIT 1)")
  await pool.query("DELETE FROM turnos")
  await pool.query("UPDATE configuracion SET valor = 'voucher_fisico' WHERE clave = 'modo_generacion_turnos'")

  // ── 1. LOGIN ADMIN Y OPERADOR PARA OBTENER TOKENS ────────────────────────
  console.log('\n1. Autenticación preliminar...')
  const resAdmin = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'soporte' })
  })
  const dataAdmin = await resAdmin.json()
  const tokenAdmin = dataAdmin.token
  assert(!!tokenAdmin, 'Login exitoso de Administrador')

  const resOp = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'op1', password: 'Operador2026!' })
  })
  const dataOp = await resOp.json()
  const tokenOp = dataOp.token
  assert(!!tokenOp, 'Login exitoso de Operador 1')

  // Asignar operador1 a Mesa 1
  const resSel = await fetch(`${BASE_HTTP}/auth/seleccionar-mesa`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokenOp}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ mesa_id: 1 })
  })
  assert(resSel.ok, 'Operador 1 vinculado a Mesa 1')

  // ── 2. PRUEBA DE PANTALLA PÚBLICA TV Y SNAPSHOT (WS-019) ──────────────────
  console.log('\n2. Pantalla pública TV (tv:global) y snapshot con mesa_numero...')
  await new Promise((resolve) => {
    const wsTv = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)

    wsTv.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.tipo === 'snapshot') {
        assert(msg.payload !== undefined, 'Snapshot de TV recibido correctamente')
        assert(msg.payload.lote !== undefined, 'Snapshot incluye estado del lote')
        wsTv.close()
        resolve()
      }
    })

    wsTv.on('error', (err) => {
      assert(false, `Error en socket TV: ${err.message}`)
      resolve()
    })
  })

  // ── 3. PRUEBA DE HEARTBEAT SIMÉTRICO CLIENTE/SERVIDOR (WS-001) ───────────
  console.log('\n3. Heartbeat simétrico: Ping de aplicación y respuesta Pong...')
  await new Promise((resolve) => {
    const wsPing = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)

    wsPing.on('open', () => {
      // Cliente envía ping de aplicación
      wsPing.send(JSON.stringify({ tipo: 'ping', payload: { clientTime: Date.now() } }))
    })

    wsPing.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.tipo === 'pong') {
        assert(msg.payload && msg.payload.serverTime !== undefined, 'Servidor respondió con pong de aplicación inmediato (WS-001 resuelto)')
        wsPing.close()
        resolve()
      }
    })

    wsPing.on('error', () => resolve())
  })

  // ── 4. PRUEBA DE AUTORIZACIÓN Y ANTI-IDOR (WS-002) ────────────────────────
  console.log('\n4. Seguridad y Anti-IDOR: Aislamiento estricto de canales...')

  // 4a. Operador intentando suscribirse a admin:all
  await new Promise((resolve) => {
    const wsIdorAdmin = new WebSocket(`${BASE_WS}/ws?token=${tokenOp}&canal=admin:all`)

    wsIdorAdmin.on('open', () => {
      assert(false, 'FALLO: Operador pudo suscribirse a admin:all')
      wsIdorAdmin.close()
      resolve()
    })

    wsIdorAdmin.on('unexpected-response', (req, res) => {
      assert(res.statusCode === 403, 'Rechazo previo al upgrade con HTTP 403 para operador en admin:all (WS-002/WS-006)')
      resolve()
    })

    wsIdorAdmin.on('close', (code) => {
      if (code === 4403 || code === 1008) {
        assert(true, `Socket cerrado con código de política ${code}`)
      }
      resolve()
    })

    wsIdorAdmin.on('error', () => resolve())
  })

  // 4b. Operador intentando suscribirse a mesa ajena (mesa:2)
  await new Promise((resolve) => {
    const wsIdorMesa = new WebSocket(`${BASE_WS}/ws?token=${tokenOp}&canal=mesa:2&mesa_id=2`)

    wsIdorMesa.on('open', () => {
      assert(false, 'FALLO: Operador pudo suscribirse a mesa ajena mesa:2')
      wsIdorMesa.close()
      resolve()
    })

    wsIdorMesa.on('unexpected-response', (req, res) => {
      assert(res.statusCode === 403, 'Rechazo previo al upgrade con HTTP 403 para operador en mesa ajena (Anti-IDOR)')
      resolve()
    })

    wsIdorMesa.on('close', (code) => {
      if (code === 4403 || code === 1008) {
        assert(true, `Socket cerrado con código de política ${code}`)
      }
      resolve()
    })

    wsIdorMesa.on('error', () => resolve())
  })

  // 4c. Operador suscribiéndose a su propia mesa (mesa:1) -> Debe ser aceptado
  await new Promise((resolve) => {
    const wsPermitido = new WebSocket(`${BASE_WS}/ws?token=${tokenOp}&canal=mesa:1&mesa_id=1`)

    wsPermitido.on('open', () => {
      assert(true, 'Operador autorizado exitosamente en su propia mesa:1')
      wsPermitido.close()
      resolve()
    })

    wsPermitido.on('error', (err) => {
      assert(false, `Error en socket permitido: ${err.message}`)
      resolve()
    })
  })

  // ── 5. PRUEBA DE TICKET EFÍMERO DE UN SOLO USO (WS-005) ───────────────────
  console.log('\n5. Ticket efímero de conexión (WS-005)...')
  const resTicket = await fetch(`${BASE_HTTP}/auth/ws-ticket`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokenAdmin}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  })
  const { ticket } = await resTicket.json()
  assert(!!ticket, 'Ticket efímero generado exitosamente')

  // Conectar con ticket
  await new Promise((resolve) => {
    const wsTicket = new WebSocket(`${BASE_WS}/ws?ticket=${ticket}&canal=admin:all`)

    wsTicket.on('open', () => {
      assert(true, 'Conexión WS exitosa utilizando ticket efímero')
      wsTicket.close()
      resolve()
    })

    wsTicket.on('error', (err) => {
      assert(false, `Fallo al conectar con ticket: ${err.message}`)
      resolve()
    })
  })

  // Reusar el mismo ticket (Debe ser rechazado inmediatamente con 401)
  await new Promise((resolve) => {
    const wsTicketReused = new WebSocket(`${BASE_WS}/ws?ticket=${ticket}&canal=admin:all`)

    wsTicketReused.on('open', () => {
      assert(false, 'FALLO: Se permitió reusar un ticket efímero de un solo uso')
      wsTicketReused.close()
      resolve()
    })

    wsTicketReused.on('unexpected-response', (req, res) => {
      assert(res.statusCode === 401, 'Rechazo previo al upgrade con HTTP 401 al reintentar ticket consumido')
      resolve()
    })

    wsTicketReused.on('error', () => resolve())
  })

  // ── 6. DIFUSIÓN DE LLAMADO CON SECUENCIA MONOTÓNICA Y ESTADO COMPLETO ─────
  console.log('\n6. Difusión de llamado (seq monotónico, TV con historial y Admin kpi_update)...')
  await new Promise(async (resolve) => {
    const wsTv = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
    const wsMesa = new WebSocket(`${BASE_WS}/ws?token=${tokenOp}&canal=mesa:1&mesa_id=1`)
    const wsAdmin = new WebSocket(`${BASE_WS}/ws?token=${tokenAdmin}&canal=admin:all`)

    let tvRecibio = false
    let mesaRecibio = false
    let adminRecibio = false

    wsTv.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.tipo === 'nuevo_llamado') {
        tvRecibio = true
        assert(msg.seq > 0, `TV recibió evento con secuencia monotónica seq=${msg.seq} (WS-007)`)
        assert(Array.isArray(msg.payload.historial), 'TV recibió historial consolidado (estado completo)')
      }
    })

    wsMesa.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.tipo === 'turno_llamado') {
        mesaRecibio = true
        assert(msg.seq > 0, `Mesa recibió turno_llamado con secuencia monotónica seq=${msg.seq}`)
      }
    })

    wsAdmin.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.tipo === 'kpi_update') {
        adminRecibio = true
        assert(msg.seq > 0, `Admin recibió kpi_update con secuencia monotónica seq=${msg.seq} (WS-010)`)
      }
    })

    // Esperar a que los sockets estén abiertos
    await sleep(250)

    // Invocar llamado de turno en mesa 1
    const resLlamar = await fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenOp}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ mesa_id: 1 })
    })

    if (!resLlamar.ok) {
      const errBody = await resLlamar.text()
      console.warn(`Llamar respondió error: ${resLlamar.status} - ${errBody}`)
    } else {
      console.log('Llamado ejecutado exitosamente.')
    }

    // Esperar entrega de eventos
    await sleep(600)

    assert(tvRecibio, 'TV recibió notificación de nuevo llamado')
    assert(mesaRecibio, 'Mesa 1 recibió notificación de turno llamado')
    assert(adminRecibio, 'Admin recibió notificación push kpi_update')

    wsTv.close()
    wsMesa.close()
    wsAdmin.close()
    resolve()
  })

  // ── 7. PRUEBA DE LOGOUT Y REVOCACIÓN DE SOCKETS ACTIVOS (WS-008) ──────────
  console.log('\n7. Cierre de sesión y revocación inmediata de sockets (WS-008)...')
  await new Promise(async (resolve) => {
    // Iniciar sesión con op2
    const resOp2 = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'op2', password: 'Operador2026!' })
    })
    const { token: tokenOp2, usuario: userOp2 } = await resOp2.json()

    // Conectar socket
    const wsOp2 = new WebSocket(`${BASE_WS}/ws?token=${tokenOp2}&canal=tv:global`)
    let socketCerradoPorLogout = false

    wsOp2.on('open', async () => {
      await sleep(150)
      // Ejecutar logout
      await fetch(`${BASE_HTTP}/auth/logout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenOp2}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      })
    })

    wsOp2.on('close', (code, reason) => {
      if (code === 4401) {
        socketCerradoPorLogout = true
        assert(true, 'Socket activo revocado y cerrado inmediatamente tras logout con código 4401 (WS-008 resuelto)')
      }
      resolve()
    })

    setTimeout(() => {
      if (!socketCerradoPorLogout) {
        assert(false, 'FALLO: El socket permaneció abierto tras llamar a /auth/logout')
        wsOp2.close()
        resolve()
      }
    }, 2500)
  })

  // ── CIERRE DE CONEXIONES DE PRUEBA ────────────────────────────────────────
  await pool.end()
  await redis.quit()

  // ── RESUMEN FINAL ────────────────────────────────────────────────────────
  console.log('\n======================================================================')
  console.log(`🏁 RESULTADOS: ${passed} pasadas, ${failed} fallidas`)
  console.log('======================================================================')

  if (failed > 0) process.exit(1)
  process.exit(0)
}

runSuite().catch(err => {
  console.error('[FATAL] Error en suite de pruebas:', err)
  process.exit(1)
})
