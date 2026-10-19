/**
 * Pruebas de Carga y Estres — 10 Ventanillas y 2 Pantallas TV
 *
 * Simula 10 ventanillas concurrentes y multiples pantallas TV recibiendo
 * difusiones continuas de nuevos llamados a traves de WebSockets.
 *
 * Requiere: Servidor HTTP/WS y Base de Datos corriendo.
 * Ejecucion: node tests/panel-tv-stress.test.js
 */

const WebSocket = require('ws')
const { Pool } = require('pg')
const crypto = require('crypto')
const bcrypt = require('bcrypt')
require('dotenv').config()

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE_HTTP = process.env.APP_URL || `http://localhost:${PORT}`
const BASE_WS = BASE_HTTP.replace('http', 'ws')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
  console.log('======================================================================')
  console.log('PRUEBAS DE CARGA Y ESTRES — 10 MESAS + 2 TV (WEBSOCKET)')
  console.log('======================================================================\n')

  const connectionString = process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER || 'turnero_app'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  const pool = new Pool({ connectionString })
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

  // Limpiar límites de tasa en Redis
  const Redis = require('ioredis')
  const redis = new Redis(process.env.REDIS_URL || `redis://:${process.env.REDIS_PASSWORD || 'turnero_redis'}@${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT_EXPOSED || 6379}`, { password: process.env.REDIS_PASSWORD || 'turnero_redis' })
  const rlKeys = await redis.keys('fastify-rate-limit-*')
  if (rlKeys.length > 0) await redis.del(...rlKeys)

  // ── FASE 0: PREPARACIÓN DE 10 MESAS Y 10 OPERADORES ──────────────────────
  console.log('0. Preparando base de datos: 10 mesas y 10 operadores...')
  // Pausar cualquier lote activo existente para evitar conflicto de constraint única
  await pool.query(`UPDATE lotes_voucher SET estado = 'pausado' WHERE estado = 'activo'`)
  // Upsert del lote de prueba como activo.
  // NO tocamos ultimo_numero_llamado en el UPDATE para no violar el trigger anti-regresion.
  // Ponemos numero_hasta muy alto para que el test siempre tenga vouchers disponibles.
  await pool.query(`
    INSERT INTO lotes_voucher (id, numero_lote, numero_desde, numero_hasta, ultimo_numero_llamado, estado)
    VALUES (1, 1, 1, 99999, 0, 'activo')
    ON CONFLICT (id) DO UPDATE
      SET estado = 'activo',
          numero_hasta = 99999
  `)

  // Asegurar que existan 10 operadores (op1 .. op10)
  const passwordHash = await bcrypt.hash('Operador2026!', 10)
  for (let i = 1; i <= 10; i++) {
    await pool.query(`
      INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
      VALUES ($1, $2, 'operador', $3, true)
      ON CONFLICT (LOWER(username)) WHERE eliminado_en IS NULL DO UPDATE SET activo = true, password_hash = $2
    `, [`op${i}`, passwordHash, `Operador ${i}`])
  }

  // Liberar asignaciones previas
  await pool.query(`UPDATE mesas SET operador_id = NULL`)

  // Asegurar que existan 10 mesas (id 1..10)
  // Caso de prueba especial: Mesa 7 tendrá numero = 3 para verificar discrepancia id vs numero
  for (let i = 1; i <= 10; i++) {
    const numVisible = (i === 7) ? 77 : i // Mesa id 7 tendrá número 77 (diferente de id)
    await pool.query(`
      INSERT INTO mesas (id, numero, nombre, estado)
      VALUES ($1, $2, $3, 'activa')
      ON CONFLICT (id) DO UPDATE SET numero = $2, nombre = $3, estado = 'activa'
    `, [i, numVisible, `Ventanilla ${numVisible}`])
  }

  // Asignar operador i a mesa i
  for (let i = 1; i <= 10; i++) {
    const { rows: [u] } = await pool.query(`SELECT id FROM usuarios WHERE username = $1`, [`op${i}`])
    await pool.query(`UPDATE mesas SET operador_id = $1 WHERE id = $2`, [u.id, i])
  }

  // Obtener tokens JWT para los 10 operadores
  console.log('Autenticando los 10 operadores...')
  const tokens = {}
  for (let i = 1; i <= 10; i++) {
    const res = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `op${i}`, password: 'Operador2026!' })
    })
    const data = await res.json()
    tokens[i] = data.token
  }
  assert(Object.keys(tokens).length === 10, '10 operadores autenticados con JWT exitosamente')

  // Conectar 2 pantallas de TV a tv:global
  console.log('\nConectando TV 1 y TV 2 a tv:global...')
  const tv1Events = []
  const tv2Events = []

  const wsTv1 = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
  wsTv1.on('message', d => { try { tv1Events.push(JSON.parse(d.toString())) } catch(_) {} })

  const wsTv2 = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
  wsTv2.on('message', d => { try { tv2Events.push(JSON.parse(d.toString())) } catch(_) {} })

  await Promise.all([
    new Promise(r => wsTv1.on('open', r)),
    new Promise(r => wsTv2.on('open', r))
  ])
  await sleep(150)
  assert(wsTv1.readyState === WebSocket.OPEN && wsTv2.readyState === WebSocket.OPEN, 'TV 1 y TV 2 conectadas y sincronizadas')

  // Conectar WebSockets para las 10 mesas
  console.log('Conectando WebSockets para las 10 mesas...')
  const mesaSockets = {}
  const mesaEvents = {}

  for (let i = 1; i <= 10; i++) {
    mesaEvents[i] = []
    const ws = new WebSocket(`${BASE_WS}/ws?token=${tokens[i]}&canal=mesa:${i}&mesa_id=${i}`)
    ws.on('error', (err) => {
      console.error(`[WS MESA ${i}] Error de conexión: ${err.message}`)
    })
    ws.on('message', d => { try { mesaEvents[i].push(JSON.parse(d.toString())) } catch(_) {} })
    mesaSockets[i] = ws
  }

  await Promise.all(Object.values(mesaSockets).map(ws => new Promise(r => ws.on('open', r))))
  await sleep(200)
  assert(Object.values(mesaSockets).every(ws => ws.readyState === WebSocket.OPEN), '10 paneles de mesa conectados con canal segmentado mesa:X y lote:activo')

  // ─────────────────────────────────────────────────────────────────────────
  // PRUEBA 1: UN OPERADOR LLAMA UN TURNO
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- PRUEBA 1: Un operador llama un turno ---')
  const t1Inicio = Date.now()
  const rLlamar1 = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokens[1]}`,
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({ mesa_id: 1 })
  })
  const dLlamar1 = await rLlamar1.json()
  const turnoLlamado1 = dLlamar1.turno
  await sleep(100)

  // Verificar panel 1 y TV
  const tv1Llamado = tv1Events.find(e => e.tipo === 'nuevo_llamado' && e.payload?.numero === turnoLlamado1.numero)
  const panel1Llamado = mesaEvents[1].find(e => e.tipo === 'turno_llamado' && e.payload?.turno?.id === turnoLlamado1.id)

  assert(!!panel1Llamado, `Panel 1 recibió turno_llamado con Turno #${turnoLlamado1.numero}`)
  assert(!!tv1Llamado, `TV 1 recibió nuevo_llamado con Turno #${turnoLlamado1.numero}`)
  assert(tv1Llamado.payload.mesa_numero === turnoLlamado1.mesa_numero,
    `Panel y TV muestran la misma mesa (Mesa ${turnoLlamado1.mesa_numero}) y el mismo turno`)

  // ─────────────────────────────────────────────────────────────────────────
  // PRUEBA 2: TRES OPERADORES LLAMAN CASI A LA VEZ
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- PRUEBA 2: Tres operadores llaman casi a la vez (Mesa 1, 2 y 3) ---')
  // Esperar 1.6s para superar la ventana de protección de doble-clic (< 1.5s en fn_llamar_siguiente) de Mesa 1
  await sleep(1600)
  tv1Events.length = 0
  mesaEvents[1].length = 0
  mesaEvents[2].length = 0
  mesaEvents[3].length = 0

  const r3Llamadas = await Promise.all([
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokens[1]}`, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: 1 })
    }).then(r => r.json()),
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokens[2]}`, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: 2 })
    }).then(r => r.json()),
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokens[3]}`, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: 3 })
    }).then(r => r.json())
  ])

  await sleep(150)

  // Cada panel muestra solo el suyo
  const p1T = mesaEvents[1].filter(e => e.tipo === 'turno_llamado')
  const p2T = mesaEvents[2].filter(e => e.tipo === 'turno_llamado')
  const p3T = mesaEvents[3].filter(e => e.tipo === 'turno_llamado')

  assert(p1T.length === 1 && p1T[0].payload.turno.mesa_id === '1', 'Panel 1 recibió exclusivamente el turno de Mesa 1')
  assert(p2T.length === 1 && p2T[0].payload.turno.mesa_id === '2', 'Panel 2 recibió exclusivamente el turno de Mesa 2')
  assert(p3T.length === 1 && p3T[0].payload.turno.mesa_id === '3', 'Panel 3 recibió exclusivamente el turno de Mesa 3')

  // TV recibe los 3 llamados en orden de secuencia monotónica seq
  const tvNuevos = tv1Events.filter(e => e.tipo === 'nuevo_llamado')
  assert(tvNuevos.length === 3, 'TV recibió los 3 llamados emitidos en la ráfaga')
  const seqsTv = tvNuevos.map(e => e.seq)
  const seqsOrdenados = [...seqsTv].sort((a, b) => a - b)
  assert(JSON.stringify(seqsTv) === JSON.stringify(seqsOrdenados), 'Los 3 eventos en TV llegaron en orden monotónico de seq')

  // ─────────────────────────────────────────────────────────────────────────
  // PRUEBA 3: UN OPERADOR RE-LLAMA
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- PRUEBA 3: Un operador re-llama su turno en pantalla ---')
  tv1Events.length = 0
  const turnoEnAtencionMesa1 = r3Llamadas[0].turno

  const rRellamar = await fetch(`${BASE_HTTP}/turnos/${turnoEnAtencionMesa1.id}/rellamar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokens[1]}` },
    body: JSON.stringify({ mesa_id: 1 })
  })
  const dRellamar = await rRellamar.json()
  assert(rRellamar.status === 200, 'Re-llamar responde 200 OK')

  await sleep(150)
  const evRellamadoTv = tv1Events.find(e => e.tipo === 'turno_rellamado')
  assert(!!evRellamadoTv, 'TV recibió evento turno_rellamado')
  assert(evRellamadoTv.payload.numero === turnoEnAtencionMesa1.numero,
    `TV avisa exactamente el turno que el operador tiene en pantalla (#${turnoEnAtencionMesa1.numero})`)
  assert(evRellamadoTv.payload.mesa_numero === turnoEnAtencionMesa1.mesa_numero,
    `TV avisa la mesa correcta (Mesa ${turnoEnAtencionMesa1.mesa_numero})`)

  // ─────────────────────────────────────────────────────────────────────────
  // PRUEBA 4: CORTE DE CONEXIÓN DE TV Y RECUPERACIÓN AUTOMÁTICA
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- PRUEBA 4: Corte de conexión de TV y recuperación automática ---')
  // Desconectar TV 1
  wsTv1.close()
  await sleep(100)

  // Realizar 2 llamadas mientras TV 1 está desconectada
  const rLlamadaDesc1 = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokens[4]}`, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ mesa_id: 4 })
  }).then(r => r.json())

  const rLlamadaDesc2 = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokens[5]}`, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ mesa_id: 5 })
  }).then(r => r.json())

  // Reconectar TV 1
  const tv1ReconEvents = []
  const wsTv1Recon = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
  wsTv1Recon.on('message', d => { try { tv1ReconEvents.push(JSON.parse(d.toString())) } catch(_) {} })
  await new Promise(r => wsTv1Recon.on('open', r))
  await sleep(250)

  const snapRecon = tv1ReconEvents.find(e => e.tipo === 'snapshot')
  assert(!!snapRecon, 'TV 1 reconectada recibe snapshot del servidor')
  assert(snapRecon.payload.ultimo_llamado?.numero === rLlamadaDesc2.turno.numero,
    `Snapshot de TV 1 recupera el último turno emitido en la ausencia (#${rLlamadaDesc2.turno.numero})`)
  assert(snapRecon.payload.proximo_numero === rLlamadaDesc2.proximo_numero,
    `Snapshot de TV 1 recupera el próximo número correcto (${rLlamadaDesc2.proximo_numero})`)

  // ─────────────────────────────────────────────────────────────────────────
  // PRUEBA 5: MESA CUYO ID INTERNO NO COINCIDE CON SU NÚMERO (ID 7, NÚMERO 77)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- PRUEBA 5: Mesa con id interno != número público (Mesa id 7 con número visible 77) ---')
  tv1ReconEvents.length = 0
  mesaEvents[7].length = 0

  // 1. Verificar lo que devuelve el panel de esa mesa al cargar estado
  const rEstadoMesa7 = await fetch(`${BASE_HTTP}/turnos/estado?mesa_id=7`, {
    headers: { 'Authorization': `Bearer ${tokens[7]}` }
  })
  const dEstadoMesa7 = await rEstadoMesa7.json()
  assert(dEstadoMesa7.mesa.numero === 77, `GET /turnos/estado para mesa id 7 devuelve numero: 77 (no el id 7)`)

  // 2. Operador 7 llama un turno
  const rLlamarMesa7 = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokens[7]}`, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ mesa_id: 7 })
  })
  const dLlamarMesa7 = await rLlamarMesa7.json()
  await sleep(150)

  const evTvMesa7 = tv1ReconEvents.find(e => e.tipo === 'nuevo_llamado' && e.payload?.numero === dLlamarMesa7.turno.numero)
  assert(evTvMesa7.payload.mesa_numero === 77, `TV recibe y muestra "Mesa 77" (el número visible, no el id interno 7)`)
  assert(dLlamarMesa7.turno.mesa_numero === 77, `Respuesta del panel confirma mesa_numero: 77`)

  // ─────────────────────────────────────────────────────────────────────────
  // PRUEBA 6: CARGA Y STRESS (10 MESAS + 2 PANTALLAS DE TV)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- PRUEBA 6: Carga y Stress (10 Mesas concurrentes llamando a la vez + 2 TVs) ---')
  await sleep(2000)
  tv1ReconEvents.length = 0
  tv2Events.length = 0
  for (let i = 1; i <= 10; i++) mesaEvents[i].length = 0

  const TOTAL_LLAMADAS = 30 // 3 rondas simultáneas de las 10 mesas
  const latenciasLlamar = []
  const inicioStress = Date.now()

  console.log(`Ejecutando ${TOTAL_LLAMADAS} llamadas concurrentes distribuidas en las 10 mesas...`)

  // Ejecutar 3 tandas de 10 mesas en paralelo con 2s entre tandas de la misma mesa
  for (let tanda = 0; tanda < 3; tanda++) {
    const promesasTanda = []
    for (let mesaIdx = 1; mesaIdx <= 10; mesaIdx++) {
      const t0Req = Date.now()
      promesasTanda.push(
        fetch(`${BASE_HTTP}/turnos/llamar`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${tokens[mesaIdx]}`,
            'Idempotency-Key': crypto.randomUUID()
          },
          body: JSON.stringify({ mesa_id: mesaIdx })
        }).then(async r => {
          const lat = Date.now() - t0Req
          latenciasLlamar.push(lat)
          return r.json()
        })
      )
    }
    await Promise.all(promesasTanda)
    // Esperar 2s antes de que la misma mesa pueda llamar su siguiente turno
    if (tanda < 2) await sleep(2000)
  }

  const duracionTotalStress = Date.now() - inicioStress
  await sleep(300) // Esperar a que la cola WS termine de propagar todos los mensajes

  console.log(`Estrés finalizado en ${duracionTotalStress} ms.`)
  const latMax = Math.max(...latenciasLlamar)
  const latProm = Math.round(latenciasLlamar.reduce((a, b) => a + b, 0) / latenciasLlamar.length)

  assert(latMax < 1000, `Latencia máxima de llamada HTTP fue ${latMax} ms (< 1000 ms esperado)`)
  assert(latProm < 150, `Latencia promedio de llamada HTTP fue ${latProm} ms (< 150 ms)`)

  // Verificar entrega en las 2 pantallas de TV
  const tv1LlamadosTotal = tv1ReconEvents.filter(e => e.tipo === 'nuevo_llamado')
  const tv2LlamadosTotal = tv2Events.filter(e => e.tipo === 'nuevo_llamado')

  assert(tv1LlamadosTotal.length >= TOTAL_LLAMADAS,
    `TV 1 recibió todas las ${TOTAL_LLAMADAS} llamadas (${tv1LlamadosTotal.length} recibidas)`)
  assert(tv2LlamadosTotal.length >= TOTAL_LLAMADAS,
    `TV 2 recibió todas las ${TOTAL_LLAMADAS} llamadas (${tv2LlamadosTotal.length} recibidas)`)

  // Verificar que ambas TVs recibieron exactamente la misma secuencia de números
  const seqNumsTv1 = tv1LlamadosTotal.slice(-TOTAL_LLAMADAS).map(e => e.payload.numero)
  const seqNumsTv2 = tv2LlamadosTotal.slice(-TOTAL_LLAMADAS).map(e => e.payload.numero)
  assert(JSON.stringify(seqNumsTv1) === JSON.stringify(seqNumsTv2),
    'TV 1 y TV 2 muestran EXACTAMENTE la misma secuencia de llamados en idéntico orden')

  // Verificar que todos los números son correlativos y sin duplicados
  const setNumeros = new Set(seqNumsTv1)
  assert(setNumeros.size === TOTAL_LLAMADAS,
    `Cero duplicados en los ${TOTAL_LLAMADAS} llamados procesados concurrentemente`)

  // Verificar que todos los 10 paneles de mesa recibieron actualizaciones de próximo turno en caliente
  let panelesSincronizados = 0
  for (let i = 1; i <= 10; i++) {
    const proxUpdates = mesaEvents[i].filter(e => e.tipo === 'proximo_actualizado')
    if (proxUpdates.length > 0) panelesSincronizados++
  }
  assert(panelesSincronizados === 10,
    `Los 10 paneles de mesa recibieron en caliente los eventos proximo_actualizado vía canal lote:activo`)

  // Limpieza de sockets y conexiones
  wsTv1Recon.close()
  wsTv2.close()
  for (let i = 1; i <= 10; i++) {
    mesaSockets[i].close()
  }
  await pool.end()
  await redis.quit()

  console.log('\n======================================================================')
  console.log(`📊 RESULTADO DE LA REVISIÓN PANEL ↔ TV Y ESTRÉS: ${passed} PASSED / ${failed} FAILED`)
  console.log('======================================================================')

  if (failed > 0) process.exit(1)
}

run().catch(err => {
  console.error('❌ Error fatal en test_panel_tv_stress:', err)
  process.exit(1)
})
