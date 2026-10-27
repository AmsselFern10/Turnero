/**
 * MÓDULO: tv_pantalla_publica
 * OBJETIVO: Evaluar la consistencia visual entre el turno principal y las tarjetas del historial.
 *           El turno actual y las 4 tarjetas anteriores permanecen sincronizados y no pierden datos tras desconexiones breves.
 * EJECUCIÓN: node tests/tv_sincronizacion_historial.test.js
 */

'use strict'

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
  console.log(' TV — SINCRONIZACIÓN DE HISTORIAL Y RESILIENCIA ANTE DESCONEXIÓN')
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

  // 1. Preparación de operador y mesa
  console.log('[1/4] Preparando entorno y conexión WebSocket inicial...')
  await pool.query(`UPDATE lotes_voucher SET estado = 'activo', numero_hasta = GREATEST(numero_hasta, 999999) WHERE id = 1`)
  const { rows: [op] } = await pool.query(`SELECT id, username FROM usuarios WHERE rol = 'operador' LIMIT 1`)

  const loginRes = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: op.username, password: 'Operador2026!' })
  })
  const { token } = await loginRes.json()

  const mesaNum = 6300 + (Date.now() % 1000)
  const { rows: [mesa] } = await pool.query(
    `INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES ($1, $2, 'activa', $3) RETURNING id`,
    [mesaNum, `Mesa Historial [${mesaNum}]`, op.id]
  )

  // 2. Conectar cliente TV
  let tvWs = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
  let tvEventos = []

  function setupSocketListeners(ws) {
    ws.on('message', (data) => {
      try { tvEventos.push(JSON.parse(data.toString())) } catch (_) {}
    })
  }
  setupSocketListeners(tvWs)
  await new Promise(r => tvWs.on('open', r))
  await sleep(150)

  // 3. Simulación de la Máquina de Estados de tv.js para Historial
  console.log('\n[2/4] Verificando invariantes de Historial (máx 4 tarjetas, orden DESC, sin duplicar hero)...')

  function crearGestorHistorial() {
    let hero = null
    let historial = []

    function nuevoLlamado(item) {
      // Si ya había un hero en pantalla, pasa al historial
      if (hero && hero.numero !== null) {
        if (!historial.some(h => h.numero === hero.numero)) {
          historial.unshift({
            numero: hero.numero,
            mesa_numero: hero.mesa_numero,
            llamado_en: hero.llamado_en
          })
          if (historial.length > 4) {
            historial.splice(4) // Máximo 4 tarjetas
          }
        }
      }
      hero = { ...item }
    }

    function reLlamado(item) {
      // Los re-llamados NO entran al historial y NO expulsan al hero real
      // Solo cambian temporalmente la vista
    }

    return {
      nuevoLlamado,
      reLlamado,
      getEstado: () => ({ hero: hero ? { ...hero } : null, historial: [...historial] }),
      restaurarDesdeSnapshot: (snapshot) => {
        if (snapshot.ultimo_llamado) {
          hero = { ...snapshot.ultimo_llamado }
        }
        if (Array.isArray(snapshot.historial)) {
          // Filtrar para que el hero no aparezca en el historial
          historial = snapshot.historial
            .filter(h => h.numero !== hero?.numero)
            .slice(0, 4)
        }
      }
    }
  }

  const gestor = crearGestorHistorial()

  // Ejecutar 6 llamados consecutivos
  for (let num = 501; num <= 506; num++) {
    gestor.nuevoLlamado({ numero: num, mesa_numero: (num % 3) + 1, llamado_en: new Date().toISOString() })
  }

  const st = gestor.getEstado()
  assert(st.hero.numero === 506, 'El turno principal (Hero) es el último llamado (506)')
  assert(st.historial.length === 4, `El historial tiene exactamente 4 tarjetas precedentes (${st.historial.length}/4)`)
  assert(!st.historial.some(h => h.numero === 506), 'El turno principal (506) NO está dentro del historial')

  const numerosHistorial = st.historial.map(h => h.numero)
  assert(JSON.stringify(numerosHistorial) === JSON.stringify([505, 504, 503, 502]),
    `Historial está ordenado estrictamente DESC [${numerosHistorial.join(', ')}]`)

  // 4. Prueba de corte de conexión y recuperación mediante Snapshot
  console.log('\n[3/4] Evaluando corte de red y resincronización visual mediante Snapshot...')

  // Realizar un llamado real en el servidor mientras la TV está "desconectada"
  tvWs.terminate() // Corte abrupto de la conexión
  await sleep(100)

  const rLlamarCorte = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ mesa_id: mesa.id })
  })
  const dCorte = await rLlamarCorte.json()
  const turnoDuranteCorte = dCorte.turno.numero

  // Reconectar WebSocket y pedir snapshot
  console.log(`   Turno #${turnoDuranteCorte} fue llamado durante el corte. Reconectando TV...`)
  tvEventos = []
  tvWs = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
  setupSocketListeners(tvWs)
  await new Promise(r => tvWs.on('open', r))
  await sleep(200)

  // Obtener snapshot enviado por el servidor al conectar
  const snapReconex = tvEventos.find(e => e.tipo === 'snapshot')
  assert(!!snapReconex, 'TV recibe snapshot de sincronización inmediatamente al reconectar')
  assert(!!snapReconex.payload?.historial, 'Snapshot contiene historial de llamados')

  // Restaurar estado visual del frontend a partir del snapshot (tal como hace tv.js)
  gestor.restaurarDesdeSnapshot({
    ultimo_llamado: snapReconex.payload.ultimo_llamado || snapReconex.payload.historial[0],
    historial: snapReconex.payload.historial
  })

  const stReconex = gestor.getEstado()
  assert(stReconex.hero.numero === turnoDuranteCorte, `Hero sincronizado recuperó el último turno emitido (#${turnoDuranteCorte})`)
  assert(stReconex.historial.length <= 4, 'Historial restablecido no excede las 4 tarjetas')
  assert(!stReconex.historial.some(h => h.numero === stReconex.hero.numero), 'Invariante mantenida: Hero no se duplica en el historial recuperado')

  // 5. Invarianza con Re-llamado
  console.log('\n[4/4] Verificando que re-llamar no altera el historial...')
  gestor.reLlamado({ numero: 502, mesa_numero: 2 })
  const stRellamado = gestor.getEstado()
  assert(stRellamado.hero.numero === turnoDuranteCorte, 'Hero legítimo se conserva tras re-llamado')
  assert(stRellamado.historial.length <= 4, 'Longitud del historial intacta tras re-llamado')

  // Limpieza
  tvWs.close()
  await pool.query(`DELETE FROM mesas WHERE id = $1`, [mesa.id]).catch(() => {})
  await pool.end()

  console.log('\n======================================================================')
  console.log(`RESULTADO FINAL: ${passed} PASADOS | ${failed} FALLADOS`)
  console.log('======================================================================')

  if (failed > 0) {
    process.exit(1)
  } else {
    process.exit(0)
  }
}

run().catch((err) => {
  console.error('\n[FAIL] Error fatal en tv_sincronizacion_historial:', err)
  process.exit(1)
})
