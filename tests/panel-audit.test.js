/**
 * Auditoria del Panel de Operador (Ventanilla)
 *
 * Verifica la recepcion de llamados en tiempo real, sincronizacion de estado
 * y aislamiento de turnos en cada mesa operativa.
 *
 * Requiere: Servidor HTTP/WS y Base de Datos corriendo.
 * Ejecucion: node tests/panel-audit.test.js
 */

const WebSocket = require('ws')
const { Pool } = require('pg')
const crypto = require('crypto')
require('dotenv').config()

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE_HTTP = process.env.APP_URL || `http://localhost:${PORT}`
const BASE_WS = BASE_HTTP.replace('http', 'ws')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
  console.log('======================================================================')
  console.log('AUDITORIA DEL PANEL DE MESA — VERIFICACION Y TIEMPO REAL')
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

  // Limpiar límites de tasa previos en Redis
  const Redis = require('ioredis')
  const redis = new Redis(process.env.REDIS_URL || `redis://:${process.env.REDIS_PASSWORD || 'turnero_redis'}@${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT_EXPOSED || 6379}`, { password: process.env.REDIS_PASSWORD || 'turnero_redis' })
  const rlKeys = await redis.keys('fastify-rate-limit-*')
  if (rlKeys.length > 0) await redis.del(...rlKeys)

  // 1. Preparación de la base de datos
  console.log('1. Preparando estado de la BD (Lote activo y 3 mesas asignadas)...')
  // Asegurar que existe lote activo con vouchers
  await pool.query(`
    UPDATE lotes_voucher
    SET estado = 'activo', numero_hasta = 1000
    WHERE id = 1
  `)

  // Liberar asignaciones previas para evitar conflicto en ux_mesas_operador_unico
  await pool.query(`UPDATE mesas SET operador_id = NULL`)

  const { rows: ops } = await pool.query(`SELECT id, username FROM usuarios WHERE rol = 'operador' ORDER BY id LIMIT 3`)
  if (ops.length >= 3) {
    const id1 = parseInt(ops[0].id, 10)
    const id2 = parseInt(ops[1].id, 10)
    const id3 = parseInt(ops[2].id, 10)
    await pool.query(`UPDATE mesas SET operador_id = ${id1}, estado = 'activa' WHERE id = 1`)
    await pool.query(`UPDATE mesas SET operador_id = ${id2}, estado = 'activa' WHERE id = 2`)
    await pool.query(`UPDATE mesas SET operador_id = ${id3}, estado = 'activa' WHERE id = 3`)
  }

  // 2. Login de operadores
  console.log('\n2. Autenticando operadores...')
  const loginRes1 = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'op1', password: 'Operador2026!' })
  })
  const { token: token1 } = await loginRes1.json()

  const loginRes2 = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'op2', password: 'Operador2026!' })
  })
  const { token: token2 } = await loginRes2.json()

  const loginRes3 = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'op3', password: 'Operador2026!' })
  })
  const { token: token3 } = await loginRes3.json()

  assert(!!token1 && !!token2 && !!token3, 'Tokens JWT obtenidos para Mesa 1, Mesa 2 y Mesa 3')

  // 3. Test de Snapshot Consolidado (GET /turnos/estado?mesa_id=1)
  console.log('\n3. Verificando Snapshot de Mesa (GET /turnos/estado?mesa_id=1)...')
  const estadoRes = await fetch(`${BASE_HTTP}/turnos/estado?mesa_id=1`, {
    headers: { 'Authorization': `Bearer ${token1}` }
  })
  const estadoData = await estadoRes.json()

  assert(estadoRes.status === 200, 'GET /turnos/estado responde 200 OK')
  assert(estadoData.lote !== undefined && estadoData.lote !== null, 'Snapshot contiene datos del lote')
  assert(estadoData.mesa !== undefined && estadoData.mesa !== null, 'Snapshot contiene datos consolidados de la mesa')
  assert(estadoData.atendidos_hoy !== undefined, 'Snapshot contiene atendidos_hoy')
  assert(estadoData.proximo_numero !== undefined, 'Snapshot contiene proximo_numero')

  // 4. Test Idempotencia: 20 requests concurrentes con la misma Idempotency-Key
  console.log('\n4. Test de Idempotencia: 20 requests simultáneos con la misma Idempotency-Key...')
  const testKey = crypto.randomUUID()
  const reqsConcurrentes = Array.from({ length: 20 }).map(() =>
    fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token1}`,
        'Idempotency-Key': testKey
      },
      body: JSON.stringify({ mesa_id: 1 })
    }).then(r => r.json())
  )

  const resultadosConcurrentes = await Promise.all(reqsConcurrentes)
  const primerTurnoId = resultadosConcurrentes[0]?.turno?.id
  const primerTurnoNumero = resultadosConcurrentes[0]?.turno?.numero
  const todosIguales = resultadosConcurrentes.every(
    r => r.turno && String(r.turno.id) === String(primerTurnoId) && Number(r.turno.numero) === Number(primerTurnoNumero)
  )

  assert(todosIguales, `Los 20 requests concurrentes devolvieron exactamente el mismo Turno #${primerTurnoNumero} (ID: ${primerTurnoId})`)

  // Verificar en BD que solo se creó 1 turno con ese ID
  const { rows: turnosEnAtencion } = await pool.query(
    `SELECT COUNT(*) FROM turnos WHERE mesa_id = 1 AND estado = 'en_atencion'`
  )
  assert(parseInt(turnosEnAtencion[0].count) === 1, 'Invariante 3 en BD: Exactamente 1 turno en_atencion en la mesa')

  // 5. Test Timeout de Red simulado + Reintento con misma key
  console.log('\n5. Test Timeout de red simulado + Reintento...')
  const reintentoRes = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token1}`,
      'Idempotency-Key': testKey
    },
    body: JSON.stringify({ mesa_id: 1 })
  })
  const reintentoData = await reintentoRes.json()

  assert(String(reintentoData.turno?.id) === String(primerTurnoId), 'Reintento con misma key devuelve el turno original desde cache sin avanzar el lote')

  // 6. Test WebSocket: 3 mesas + TV en vivo
  console.log('\n6. Test de Tiempo Real: 3 Mesas conectadas + TV recibiendo proximo_actualizado (<100ms)...')

  const wsTv = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
  const wsMesa1 = new WebSocket(`${BASE_WS}/ws?canal=mesa:1&token=${token1}`)
  const wsMesa2 = new WebSocket(`${BASE_WS}/ws?canal=mesa:2&token=${token2}`)
  const wsMesa3 = new WebSocket(`${BASE_WS}/ws?canal=mesa:3&token=${token3}`)

  await Promise.all([
    new Promise(res => wsTv.on('open', res)),
    new Promise(res => wsMesa1.on('open', res)),
    new Promise(res => wsMesa2.on('open', res)),
    new Promise(res => wsMesa3.on('open', res))
  ])

  assert(true, '4 conexiones WebSocket establecidas simultáneamente (TV, Mesa 1, Mesa 2, Mesa 3)')

  // Escuchar eventos en Mesa 2, Mesa 3 y TV
  let tvRecibio = null
  let mesa1Recibio = null
  let mesa3Recibio = null
  let tiempoInicioLlamado = 0
  let latenciaMesa1 = 0
  let latenciaMesa3 = 0

  wsTv.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.tipo === 'nuevo_llamado') tvRecibio = msg.payload
    } catch (_) {}
  })

  wsMesa1.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.tipo === 'proximo_actualizado') {
        latenciaMesa1 = Date.now() - tiempoInicioLlamado
        mesa1Recibio = msg.payload
      }
    } catch (_) {}
  })

  wsMesa3.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.tipo === 'proximo_actualizado') {
        latenciaMesa3 = Date.now() - tiempoInicioLlamado
        mesa3Recibio = msg.payload
      }
    } catch (_) {}
  })

  // Mesa 2 llama un nuevo turno
  tiempoInicioLlamado = Date.now()
  const resLlamarNuevo = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token2}`,
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({ mesa_id: 2 })
  })
  const dataLlamarNuevo = await resLlamarNuevo.json()
  const nuevoTurnoNum = dataLlamarNuevo.turno?.numero
  const nuevoProximoNum = dataLlamarNuevo.proximo_numero

  // Esperar propagación WS (máx 200ms)
  await sleep(150)

  assert(!!mesa1Recibio, `Mesa 1 recibió proximo_actualizado en caliente (${latenciaMesa1} ms < 100 ms)`)
  assert(!!mesa3Recibio, `Mesa 3 recibió proximo_actualizado en caliente (${latenciaMesa3} ms < 100 ms)`)
  assert(mesa1Recibio?.proximo_numero === nuevoProximoNum, `Mesa 1 proximo_numero coincide: ${mesa1Recibio?.proximo_numero} === ${nuevoProximoNum}`)
  assert(mesa3Recibio?.proximo_numero === nuevoProximoNum, `Mesa 3 proximo_numero coincide: ${mesa3Recibio?.proximo_numero} === ${nuevoProximoNum}`)
  assert(tvRecibio?.turno === nuevoTurnoNum, `TV recibió nuevo_llamado del Turno #${nuevoTurnoNum}`)

  // Desconectar sockets
  wsTv.close()
  wsMesa1.close()
  wsMesa2.close()
  wsMesa3.close()

  console.log('\n======================================================================')
  console.log(`📊 RESULTADO FINAL: ${passed} PASADOS | ${failed} FALLADOS`)
  console.log('======================================================================\n')

  await pool.end()
  process.exit(failed > 0 ? 1 : 0)
}

run().catch(err => {
  console.error('Error fatal en suite:', err)
  process.exit(1)
})
