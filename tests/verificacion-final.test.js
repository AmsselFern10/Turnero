/**
 * ==============================================================================
 * VERIFICACION FINAL: TV, PANEL DE MESA, ADMIN Y KIOSKO EN VIVO
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Simula 3 Paneles de Operador, 1 Pantalla TV, 1 Admin y 3 Smartphones (Kiosko)
 * validando los 11 escenarios en tiempo real solicitados por el usuario.
 * ==============================================================================
 */

'use strict'

const WebSocket = require('ws')
const { Pool } = require('pg')
const Redis = require('ioredis')
const crypto = require('crypto')
require('dotenv').config()

const buildApp = require('../src/app')

const TEST_PORT = 3099
const BASE_HTTP = `http://127.0.0.1:${TEST_PORT}`
const BASE_WS = `ws://127.0.0.1:${TEST_PORT}`

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run () {
  console.log('======================================================================')
  console.log(' VERIFICACION FINAL: TV, PANEL DE MESA, ADMIN Y KIOSKO EN VIVO')
  console.log('======================================================================\n')

  let passedCount = 0
  let failedCount = 0

  function assert (cond, testName, details = '') {
    if (cond) {
      console.log(`  [OK] ${testName}`)
      passedCount++
    } else {
      console.error(`  [FAIL] ${testName}${details ? ' -> ' + details : ''}`)
      failedCount++
    }
  }

  // 1. Conexión de base de datos directa para assertions
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:turnero@localhost:5432/turnero'
  })
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

  // Limpiar límites de rate limiting en Redis para pruebas limpias
  const rateLimitKeys = await redis.keys('fastify-rate-limit-*')
  if (rateLimitKeys.length > 0) await redis.del(...rateLimitKeys)

  // Preparar BD antes de iniciar
  await pool.query("SET app.permitir_retroceso_lote = 'on'")
  await pool.query("UPDATE mesas SET estado = 'activa', operador_id = NULL WHERE id IN (1, 2, 3)")
  await pool.query("UPDATE lotes_voucher SET estado = 'cerrado' WHERE estado = 'activo'")
  await pool.query("UPDATE lotes_voucher SET estado = 'activo', ultimo_numero_llamado = 0 WHERE id = 1")
  await pool.query("DELETE FROM turnos")
  await pool.query("DELETE FROM kiosko_contador_diario")
  await pool.query("UPDATE configuracion SET valor = 'false' WHERE clave = 'kiosko_web_activo'")
  await pool.query("UPDATE configuracion SET valor = 'voucher_fisico' WHERE clave = 'modo_generacion_turnos'")

  // 2. Levantar servidor Fastify en TEST_PORT
  console.log('[1/4] Levantando servidor de pruebas en puerto ' + TEST_PORT + '...')
  const app = await buildApp({
    logger: false
  })
  await app.listen({ port: TEST_PORT, host: '127.0.0.1' })

  // 3. Autenticación y preparación de tokens
  console.log('[2/4] Autenticando usuarios (Admin y 3 Operadores)...')
  const resAdmin = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'soporte' })
  }).then(r => r.json())
  const tokenAdmin = resAdmin.token

  const tokensOp = []
  for (let i = 1; i <= 3; i++) {
    const resOp = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `op${i}`, password: 'Operador2026!' })
    }).then(r => r.json())
    tokensOp.push(resOp.token)

    // Seleccionar mesa i
    const resSel = await fetch(`${BASE_HTTP}/auth/seleccionar-mesa`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resOp.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ mesa_id: i })
    })
    if (!resSel.ok) {
      console.error(`Error seleccionando mesa ${i}:`, resSel.status, await resSel.text())
    }
  }

  // 4. Conectar WebSockets para cada pantalla
  console.log('[3/4] Conectando pantallas: 3 Paneles, 1 TV, 1 Admin, 3 Celulares...')

  // Clientes simulados
  const paneles = [
    { id: 1, mesaId: 1, token: tokensOp[0], msgs: [], ws: null, state: {} },
    { id: 2, mesaId: 2, token: tokensOp[1], msgs: [], ws: null, state: {} },
    { id: 3, mesaId: 3, token: tokensOp[2], msgs: [], ws: null, state: {} }
  ]

  const tv = { msgs: [], ws: null, state: { cola: [] } }
  const admin = { msgs: [], ws: null, state: {} }
  const celulares = [
    { id: 1, msgs: [], ws: null, state: {} },
    { id: 2, msgs: [], ws: null, state: {} },
    { id: 3, msgs: [], ws: null, state: {} }
  ]

  function conectarWS (url, client) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      client.ws = ws
      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          resolve(ws)
        }
      }, 1500)

      ws.on('unexpected-response', (req, res) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          reject(new Error(`WS upgrade rejected with HTTP ${res.statusCode} on ${url}`))
        }
      })
      ws.on('error', (err) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          reject(err)
        }
      })
      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString())
          client.msgs.push(parsed)
          if (parsed.tipo === 'snapshot') {
            client.state.snapshot = parsed.payload
            if (!resolved) {
              resolved = true
              clearTimeout(timeout)
              resolve(ws)
            }
          }
          if (parsed.tipo === 'nuevo_llamado') client.state.ultimoLlamado = parsed.payload
          if (parsed.tipo === 'turno_llamado') client.state.turnoActual = parsed.payload.turno
          if (parsed.tipo === 'proximo_actualizado') {
            client.state.proximoNumero = parsed.payload.proximo_numero
            client.state.vouchersRestantes = parsed.payload.vouchers_restantes
          }
          if (parsed.tipo === 'llamados') {
            client.state.ultimoLlamado = parsed.payload.ultimo_llamado
            client.state.turnosEsperando = parsed.payload.turnos_esperando
          }
          if (parsed.tipo === 'config_actualizada') client.state.config = parsed.payload
        } catch (_) {}
      })
    })
  }

  // Conectar TV
  await conectarWS(`${BASE_WS}/ws?canal=tv:global`, tv)
  assert(tv.msgs.some(m => m.tipo === 'snapshot'), 'TV conectada a canal tv:global y recibió snapshot inicial')

  // Conectar Admin
  await conectarWS(`${BASE_WS}/ws?canal=admin:all&token=${tokenAdmin}`, admin)
  assert(admin.msgs.some(m => m.tipo === 'snapshot'), 'Admin conectado a canal admin:all y recibió snapshot')

  // Conectar 3 Paneles
  for (const p of paneles) {
    await conectarWS(`${BASE_WS}/ws?canal=mesa:${p.mesaId}&token=${p.token}`, p)
    assert(p.msgs.some(m => m.tipo === 'snapshot'), `Panel Mesa ${p.mesaId} conectado y recibió snapshot`)
  }

  // Conectar 3 Celulares
  for (const c of celulares) {
    await conectarWS(`${BASE_WS}/ws?canal=kiosko:publico`, c)
    assert(c.msgs.some(m => m.tipo === 'snapshot'), `Celular ${c.id} conectado a kiosko:publico y recibió snapshot`)
  }

  console.log('\n[4/4] EJECUTANDO PRUEBAS DE VERIFICACION INTEGRAL...')
  console.log('----------------------------------------------------------------------')

  // ── PRUEBA 1: Modo voucher, un llamado ────────────────────────────────────
  console.log('\n>> PRUEBA 1: Modo voucher, un llamado (Panel 1 llama turno #1)')
  const msgsTvBeforeP1 = tv.msgs.length
  const msgsAdminBeforeP1 = admin.msgs.length
  const msgsPanel1BeforeP1 = paneles[0].msgs.length

  const resLlamar1 = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${paneles[0].token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({ mesa_id: 1 })
  }).then(r => r.json())

  await sleep(150) // Pausa breve para broadcast desacoplado

  const tvLlamado1 = tv.msgs.slice(msgsTvBeforeP1).find(m => m.tipo === 'nuevo_llamado')
  const panel1Llamado1 = paneles[0].msgs.slice(msgsPanel1BeforeP1).find(m => m.tipo === 'turno_llamado')
  const adminLlamado1 = admin.msgs.slice(msgsAdminBeforeP1).find(m => m.tipo === 'kpi_update')

  assert(resLlamar1.turno && resLlamar1.turno.numero === 1, 'Turno #1 generado atómicamente para Mesa 1')
  assert(tvLlamado1 && tvLlamado1.payload.numero === 1 && tvLlamado1.payload.mesa_numero === 1, 'TV recibió nuevo_llamado con Turno 1 y Mesa 1 (número público)')
  assert(panel1Llamado1 && panel1Llamado1.payload.turno.numero === 1, 'Panel 1 recibió turno_llamado con Turno 1')
  assert(adminLlamado1 && adminLlamado1.payload.turno_numero === 1, 'Admin recibió kpi_update con Turno 1')
  assert(tvLlamado1 && tvLlamado1.payload.proximo_numero === 2, 'Próximo turno proyectado es #2 en TV y Paneles')

  // Contar mensajes recibidos: exactamente 1 acción por pantalla
  const tvNuevosLlamados = tv.msgs.slice(msgsTvBeforeP1).filter(m => m.tipo === 'nuevo_llamado')
  assert(tvNuevosLlamados.length === 1, 'TV recibió exactamente 1 mensaje nuevo_llamado (cero duplicados)')

  // ── PRUEBA 2: Ráfaga de 5 llamados casi simultáneos desde 3 mesas ─────────
  console.log('\n>> PRUEBA 2: Ráfaga de 5 llamados casi a la vez desde 3 mesas')
  await sleep(1600)
  const msgsTvBeforeRafaga = tv.msgs.length

  const batch1 = await Promise.all([
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${paneles[0].token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: 1 })
    }).then(r => r.json()),
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${paneles[1].token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: 2 })
    }).then(r => r.json()),
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${paneles[2].token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: 3 })
    }).then(r => r.json())
  ])

  await sleep(1600)

  const batch2 = await Promise.all([
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${paneles[0].token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: 1 })
    }).then(r => r.json()),
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${paneles[1].token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: 2 })
    }).then(r => r.json())
  ])

  const dataRafaga = [...batch1, ...batch2]
  await sleep(250)

  const numerosObtenidos = dataRafaga.map(d => d.turno?.numero).sort((a, b) => a - b)
  assert(
    JSON.stringify(numerosObtenidos) === JSON.stringify([2, 3, 4, 5, 6]),
    'Ráfaga de 5 llamadas produjo turnos estrictamente secuenciales [2, 3, 4, 5, 6] sin repetidos ni saltos'
  )

  const tvEventosRafaga = tv.msgs.slice(msgsTvBeforeRafaga).filter(m => m.tipo === 'nuevo_llamado')
  const numerosEnTv = tvEventosRafaga.map(m => m.payload.numero).sort((a, b) => a - b)
  assert(
    JSON.stringify(numerosEnTv) === JSON.stringify([2, 3, 4, 5, 6]),
    'TV recibió los 5 anuncios ordenados para la cola audiovisual'
  )

  // ── PRUEBA 3: Re-llamado en medio de la ráfaga ─────────────────────────────
  console.log('\n>> PRUEBA 3: Re-llamado (segundo aviso) desde Mesa 2')
  const msgsTvBeforeRellamar = tv.msgs.length

  // Obtener turno actual de Mesa 2
  const { rows: [turnoMesa2] } = await pool.query(
    "SELECT id, numero FROM turnos WHERE mesa_id = 2 AND estado = 'en_atencion' ORDER BY llamado_en DESC LIMIT 1"
  )

  const resRellamar = await fetch(`${BASE_HTTP}/turnos/${turnoMesa2.id}/rellamar`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${paneles[1].token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ mesa_id: 2 })
  })
  assert(resRellamar.ok, 'Petición POST /turnos/:id/rellamar respondida con 200')

  await sleep(150)

  const tvRellamados = tv.msgs.slice(msgsTvBeforeRellamar).filter(m => m.tipo === 'turno_rellamado')
  const tvRellamadoAlias = tv.msgs.slice(msgsTvBeforeRellamar).filter(m => m.tipo === 'rellamado')

  assert(tvRellamados.length === 1, 'TV recibió exactamente 1 mensaje turno_rellamado para segundo aviso')
  assert(tvRellamadoAlias.length === 0, 'Cero mensajes duplicados de alias "rellamado" recibidos por la TV')
  assert(tvRellamados[0].payload.numero === turnoMesa2.numero, 'Re-llamado corresponde exactamente al turno de Mesa 2')

  // ── PRUEBA 4: Doble clic en "Llamar siguiente" ───────────────────────────
  console.log('\n>> PRUEBA 4: Doble clic con Idempotency-Key en "Llamar siguiente"')
  await sleep(1600)
  const doubleKey = crypto.randomUUID()
  const msgsTvBeforeDoble = tv.msgs.length

  const [reqA, reqB] = await Promise.all([
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${paneles[2].token}`, 'Content-Type': 'application/json', 'Idempotency-Key': doubleKey },
      body: JSON.stringify({ mesa_id: 3 })
    }).then(r => r.json()),
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${paneles[2].token}`, 'Content-Type': 'application/json', 'Idempotency-Key': doubleKey },
      body: JSON.stringify({ mesa_id: 3 })
    }).then(r => r.json())
  ])

  await sleep(150)

  assert(reqA.turno.id === reqB.turno.id, 'Doble clic devolvió el mismo objeto de turno')
  assert(reqA.turno.numero === reqB.turno.numero, `Doble clic devolvió el mismo número (#${reqA.turno.numero})`)

  const tvEventosDoble = tv.msgs.slice(msgsTvBeforeDoble).filter(m => m.tipo === 'nuevo_llamado')
  assert(tvEventosDoble.length === 1, 'Doble clic creó exactamente 1 anuncio en TV (cero turnos fantasma)')

  // ── PRUEBA 5: Kiosko activo, 3 celulares toman turno ──────────────────────
  console.log('\n>> PRUEBA 5: Activación de Kiosko en caliente y toma de 3 turnos táctiles')
  const msgsKioskoBeforeActivar = celulares[0].msgs.length

  // Admin activa Kiosko en caliente
  await fetch(`${BASE_HTTP}/admin/configuracion/kiosko_web_activo`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: 'true' })
  })
  await fetch(`${BASE_HTTP}/admin/configuracion/modo_generacion_turnos`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: 'kiosko_web' })
  })

  await sleep(150)

  const cfgKioskoRecibida = celulares[0].msgs.slice(msgsKioskoBeforeActivar).find(
    m => m.tipo === 'config_actualizada' && m.payload.clave === 'kiosko_web_activo'
  )
  assert(
    cfgKioskoRecibida && cfgKioskoRecibida.payload.valor === 'true',
    'Celulares en canal kiosko:publico recibieron config_actualizada (kiosko_web_activo: true) sin recargar'
  )

  const msgsTvBeforeKioskoTurnos = tv.msgs.length
  const msgsAdminBeforeKioskoTurnos = admin.msgs.length

  // Celulares 1, 2, 3 generan turno
  const turnosCelulares = []
  for (let i = 1; i <= 3; i++) {
    const resTurno = await fetch(`${BASE_HTTP}/kiosko/turnos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify({
        deviceId: `device_test_${i}`,
        modo: 'celular'
      })
    }).then(r => r.json())
    turnosCelulares.push(resTurno)
    celulares[i - 1].state.miTurno = resTurno
  }

  await sleep(200)

  assert(
    turnosCelulares[0].numero === 1 && turnosCelulares[1].numero === 2 && turnosCelulares[2].numero === 3,
    'Numeración del kiosko es propia e incremental (#1, #2, #3)'
  )

  const tvAnunciosKiosko = tv.msgs.slice(msgsTvBeforeKioskoTurnos).filter(m => m.tipo === 'nuevo_llamado')
  assert(
    tvAnunciosKiosko.length === 0,
    'La TV NO anunció nada al tomar turno en kiosko (permanece en silencio hasta que un operador llame)'
  )

  const adminKioskoEvents = admin.msgs.slice(msgsAdminBeforeKioskoTurnos).filter(m => m.tipo === 'kiosko_turno_generado')
  assert(
    adminKioskoEvents.length === 3,
    'Admin recibió eventos kiosko_turno_generado en tiempo real con turnos en espera'
  )

  // Doble toque en Kiosko con misma key
  const keyDobleKiosko = crypto.randomUUID()
  const [tkA, tkB] = await Promise.all([
    fetch(`${BASE_HTTP}/kiosko/turnos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyDobleKiosko },
      body: JSON.stringify({ deviceId: 'device_test_dup', modo: 'tablet' })
    }).then(r => r.json()),
    fetch(`${BASE_HTTP}/kiosko/turnos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyDobleKiosko },
      body: JSON.stringify({ deviceId: 'device_test_dup', modo: 'tablet' })
    }).then(r => r.json())
  ])
  assert(tkA.numero === tkB.numero && tkA.token === tkB.token, 'Doble toque en Kiosko creó exactamente 1 turno (#4)')

  // ── PRUEBA 6: Operador llama turno del Kiosko ─────────────────────────────
  console.log('\n>> PRUEBA 6: Operador llama turno del Kiosko (#1 convocado a Mesa 1)')
  await sleep(1600)
  const msgsCelularesBeforeCall = celulares.map(c => c.msgs.length)
  const msgsTvBeforeCallKiosko = tv.msgs.length

  const resLlamarKiosko = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${paneles[0].token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({ mesa_id: 1 })
  }).then(r => r.json())

  await sleep(200)

  assert(resLlamarKiosko.turno.numero === 1 && resLlamarKiosko.turno.origen === 'kiosko_web', 'Operador en Mesa 1 llamó al Turno Kiosko #1')

  const tvAnuncioKioskoLlamado = tv.msgs.slice(msgsTvBeforeCallKiosko).find(m => m.tipo === 'nuevo_llamado')
  assert(
    tvAnuncioKioskoLlamado && tvAnuncioKioskoLlamado.payload.numero === 1 && tvAnuncioKioskoLlamado.payload.mesa_numero === 1,
    'TV anunció "Turno 1 a Mesa 1"'
  )

  // Verificar aviso al celular 1 y actualización a celulares 2 y 3
  const avisoCelular1 = celulares[0].msgs.slice(msgsCelularesBeforeCall[0]).find(
    m => m.tipo === 'llamados' && m.payload.ultimo_llamado
  )
  assert(
    avisoCelular1 && avisoCelular1.payload.ultimo_llamado.numero === 1 && avisoCelular1.payload.ultimo_llamado.mesa_numero === 1,
    'Celular 1 recibió aviso en vivo: convocado a Mesa 1'
  )

  const avisoCelular2 = celulares[1].msgs.slice(msgsCelularesBeforeCall[1]).find(
    m => m.tipo === 'llamados' && m.payload.ultimo_llamado
  )
  assert(
    avisoCelular2 && avisoCelular2.payload.ultimo_llamado.numero === 1,
    'Celulares 2 y 3 se enteraron del llamado y recalculan su posición (0 y 1 personas antes)'
  )

  // ── PRUEBA 7: Admin apaga y enciende Kiosko en caliente ───────────────────
  console.log('\n>> PRUEBA 7: Admin apaga y re-enciende Kiosko en caliente')
  const msgsKioskoBeforeToggle = celulares[0].msgs.length

  // Apagar kiosko
  await fetch(`${BASE_HTTP}/admin/configuracion/kiosko_web_activo`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: 'false' })
  })
  await sleep(100)

  // Encender kiosko
  await fetch(`${BASE_HTTP}/admin/configuracion/kiosko_web_activo`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: 'true' })
  })
  await sleep(150)

  const eventosConfig = celulares[0].msgs.slice(msgsKioskoBeforeToggle).filter(
    m => m.tipo === 'config_actualizada' && m.payload.clave === 'kiosko_web_activo'
  )
  assert(
    eventosConfig.length === 2 && eventosConfig[0].payload.valor === 'false' && eventosConfig[1].payload.valor === 'true',
    'Kiosko recibió eventos de apagado y re-encendido en tiempo real sin recargar página'
  )

  // ── PRUEBA 8: Cambio de modo en caliente (voucher a kiosko y viceversa) ───
  console.log('\n>> PRUEBA 8: Cambio de modo operativo en caliente')
  const msgsTvBeforeModo = tv.msgs.length
  const msgsPanelBeforeModo = paneles[0].msgs.length

  // Cambiar a voucher_fisico
  await fetch(`${BASE_HTTP}/admin/configuracion/modo_generacion_turnos`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${tokenAdmin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: 'voucher_fisico' })
  })
  await sleep(150)

  const tvConfigModo = tv.msgs.slice(msgsTvBeforeModo).find(
    m => m.tipo === 'config_actualizada' && m.payload.clave === 'modo_generacion_turnos'
  )
  const panelConfigModo = paneles[0].msgs.slice(msgsPanelBeforeModo).find(
    m => m.tipo === 'config_actualizada' && m.payload.clave === 'modo_generacion_turnos'
  )

  assert(tvConfigModo && tvConfigModo.payload.valor === 'voucher_fisico', 'TV recibió cambio a modo voucher_fisico en caliente')
  assert(panelConfigModo && panelConfigModo.payload.valor === 'voucher_fisico', 'Paneles recibieron cambio a modo voucher_fisico en caliente')

  // ── PRUEBA 9: Corte de red simulado (recuperación autónoma con snapshot) ──
  console.log('\n>> PRUEBA 9: Corte de red simulado y recuperación con snapshot')

  // Desconectar sockets
  tv.ws.close()
  admin.ws.close()
  paneles[0].ws.close()
  celulares[0].ws.close()
  await sleep(200)

  // Re-conectar simulando fin del corte
  tv.msgs = []
  admin.msgs = []
  paneles[0].msgs = []
  celulares[0].msgs = []

  await Promise.all([
    conectarWS(`${BASE_WS}/ws?canal=tv:global`, tv),
    conectarWS(`${BASE_WS}/ws?canal=admin:all&token=${tokenAdmin}`, admin),
    conectarWS(`${BASE_WS}/ws?canal=mesa:1&token=${paneles[0].token}`, paneles[0]),
    conectarWS(`${BASE_WS}/ws?canal=kiosko:publico`, celulares[0])
  ])

  assert(tv.msgs.some(m => m.tipo === 'snapshot'), 'TV reconectada y recuperó snapshot completo de estado')
  assert(admin.msgs.some(m => m.tipo === 'snapshot'), 'Admin reconectado y recuperó snapshot de KPIs y mesas')
  assert(paneles[0].msgs.some(m => m.tipo === 'snapshot'), 'Panel Mesa 1 reconectado y recuperó snapshot de su turno en atención')
  assert(celulares[0].msgs.some(m => m.tipo === 'snapshot'), 'Celular reconectado y recuperó snapshot de posición')

  // ── PRUEBA 10: Reinicio del servidor simulado ─────────────────────────────
  console.log('\n>> PRUEBA 10: Reinicio de servidor simulado (cierre ordenado y re-apertura)')
  // Cierre ordenado del servidor
  await app.close()
  await sleep(300)

  // Re-levantar servidor
  const newApp = await buildApp({ logger: false })
  await newApp.listen({ port: TEST_PORT, host: '127.0.0.1' })

  // Re-conectar clientes tras reinicio
  const tvReinit = { msgs: [] }
  await conectarWS(`${BASE_WS}/ws?canal=tv:global`, tvReinit)
  assert(tvReinit.msgs.some(m => m.tipo === 'snapshot'), 'TV reconectó tras reinicio del servidor sin alertas duplicadas')

  const adminReinit = { msgs: [] }
  await conectarWS(`${BASE_WS}/ws?canal=admin:all&token=${tokenAdmin}`, adminReinit)
  assert(adminReinit.msgs.some(m => m.tipo === 'snapshot'), 'Admin reconectó tras reinicio del servidor y recuperó métricas')

  // ── PRUEBA 11: Una conexión por pantalla y 0 mensajes duplicados ──────────
  console.log('\n>> PRUEBA 11: Verificación de conexiones únicas y cero duplicados')
  assert(tvReinit.ws.readyState === WebSocket.OPEN, 'TV mantiene exactamente 1 conexión WebSocket activa')
  assert(adminReinit.ws.readyState === WebSocket.OPEN, 'Admin mantiene exactamente 1 conexión WebSocket activa')

  // Limpieza final
  tvReinit.ws.close()
  adminReinit.ws.close()
  await newApp.close()
  await pool.end()
  await redis.quit()

  console.log('\n----------------------------------------------------------------------')
  console.log(`TOTAL DE PRUEBAS EJECUTADAS: ${passedCount + failedCount}`)
  console.log(`  PASARON:  ${passedCount}`)
  console.log(`  FALLARON: ${failedCount}`)
  console.log('----------------------------------------------------------------------\n')

  if (failedCount > 0) {
    process.exit(1)
  }
}

run().catch(err => {
  console.error('[FATAL] Error ejecutando suite de verificación:', err)
  process.exit(1)
})
