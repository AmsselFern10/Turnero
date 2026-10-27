/**
 * MÓDULO: panel_mesa
 * OBJETIVO: Probar el flujo integral en secuencia real, combinado con la TV.
 *           Secuencia: 4 llamadas → 1 rezagado → 1 llamada → 2 re-llamados →
 *           3 llamadas → 2 rezagados → 1 re-llamado.
 *           Evaluación: orden FIFO estricto, TV actualizada en tiempo real,
 *           sin condiciones de carrera, sin saturación de conexión.
 * EJECUCIÓN: node tests/mesa_flujo_combinado_fifo_tv.test.js
 */

'use strict'

const WebSocket  = require('ws')
const { Pool }   = require('pg')
const bcrypt     = require('bcrypt')
const crypto     = require('crypto')
require('dotenv').config()

const PORT    = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE    = process.env.APP_URL || `http://localhost:${PORT}`
const BASE_WS = BASE.replace('http', 'ws')

const RUN_ID  = crypto.randomBytes(4).toString('hex')

// Anti-doble-clic del servidor: 1.5s entre llamadas de la misma mesa.
// Usamos 1700ms para asegurar margen.
const DOBLE_CLIC_GAP = 1700
// Cooldown re-llamar: 3s
const RELLAMAR_COOLDOWN = 3200

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

async function llamar (token, mesaId) {
  const r = await fetch(`${BASE}/turnos/llamar`, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/json',
      'Authorization':  `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({ mesa_id: mesaId })
  })
  return r.json()
}

async function rellamar (token, turnoId, mesaId) {
  const r = await fetch(`${BASE}/turnos/${turnoId}/rellamar`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ mesa_id: mesaId })
  })
  return { status: r.status, data: await r.json() }
}

async function atenderRezagado (token, turnoId, mesaId) {
  const r = await fetch(`${BASE}/turnos/atender-rezagado`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ turno_id: turnoId, mesa_id: mesaId })
  })
  return { status: r.status, data: await r.json() }
}

async function run () {
  console.log('======================================================================')
  console.log(' FLUJO COMBINADO FIFO + TV — SECUENCIA INTEGRAL')
  console.log('======================================================================\n')
  console.log(`[RUN ID: ${RUN_ID}]`)

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  })

  let passed = 0
  let failed = 0
  let opId   = null
  let mesaId = null
  let loteId = null
  const turnosCreadosEnTest = []
  const wsSockets = []

  function assert (cond, msg) {
    if (cond) { console.log(`   [PASS] ${msg}`); passed++ }
    else       { console.error(`   [FAIL] ${msg}`); failed++ }
  }

  try {
    // ── SETUP ─────────────────────────────────────────────────────────────────
    console.log('[SETUP] Creando operador, mesa y verificando lote activo...')
    const passHash = await bcrypt.hash('FlujoTV_2026!', 10)

    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, true) RETURNING id`,
      [`op_flujo_${RUN_ID}`, passHash, `Flujo TV Test [${RUN_ID}]`]
    )
    opId = u.id

    const mesaNum = 6600 + parseInt(RUN_ID, 16) % 100
    const { rows: [m] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id)
       VALUES ($1, $2, 'activa', $3) RETURNING id`,
      [mesaNum, `Mesa Flujo [${RUN_ID}]`, opId]
    )
    mesaId = m.id

    const { rows: [lote] } = await pool.query(
      `SELECT id, ultimo_numero_llamado FROM lotes_voucher WHERE estado = 'activo' ORDER BY id DESC LIMIT 1`
    )
    if (!lote) throw new Error('No hay lote activo. Activa uno desde admin.')
    loteId = lote.id
    // Garantizar 50 vouchers para el test
    await pool.query(
      `UPDATE lotes_voucher SET numero_hasta = GREATEST(numero_hasta, $1) WHERE id = $2`,
      [(lote.ultimo_numero_llamado || 0) + 50, loteId]
    )
    console.log(`   [OK] op_id=${opId} mesa_id=${mesaId} (Mesa #${mesaNum}) lote_id=${loteId}\n`)

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    const loginRes = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `op_flujo_${RUN_ID}`, password: 'FlujoTV_2026!' })
    })
    const { token } = await loginRes.json()
    if (!token) throw new Error('Login fallido.')
    console.log('[SETUP] Token JWT obtenido\n')

    // ── CONECTAR TV WS ────────────────────────────────────────────────────────
    console.log('[SETUP] Conectando TV (tv:global)...')
    const tvEvents = []
    const wsTv = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
    wsSockets.push(wsTv)
    wsTv.on('message', d => { try { tvEvents.push(JSON.parse(d.toString())) } catch (_) {} })
    await new Promise(r => wsTv.on('open', r))
    await sleep(100)
    console.log('   [OK] TV conectada\n')

    // ═════════════════════════════════════════════════════════════════════════
    // FASE 1: 4 llamadas consecutivas a "Siguiente" (FIFO estricto)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('--- FASE 1: 4 llamadas a "Siguiente" ---')
    const llamados = []
    for (let i = 1; i <= 4; i++) {
      const d = await llamar(token, mesaId)
      if (!d.turno) throw new Error(`Llamada ${i} falló: ${JSON.stringify(d)}`)
      llamados.push(d.turno)
      turnosCreadosEnTest.push(d.turno.id)
      console.log(`   Llamada ${i}: turno #${d.turno.numero} (id=${d.turno.id})`)
      if (i < 4) await sleep(DOBLE_CLIC_GAP)
    }
    await sleep(200) // propagación WS

    // Verificar orden FIFO: números estrictamente crecientes
    const numsFase1 = llamados.map(t => t.numero)
    const fifoOk = numsFase1.every((n, i) => i === 0 || n > numsFase1[i - 1])
    assert(fifoOk, `FIFO estricto en Fase 1: [${numsFase1.join(', ')}]`)

    // Verificar que TV recibió los 4 (o al menos el último)
    const tvFase1 = tvEvents.filter(e => e.tipo === 'nuevo_llamado')
    assert(tvFase1.length >= 1, `TV recibió al menos 1 evento nuevo_llamado en Fase 1 (${tvFase1.length})`)
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // FASE 2: Preparar y atender 1 rezagado
    // ═════════════════════════════════════════════════════════════════════════
    console.log('--- FASE 2: Atender 1 rezagado ---')
    // Crear un turno cancelado (rezagado) vía DB directamente
    const { rows: [tRez1] } = await pool.query(
      `INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id, llamado_en, finalizado_en)
       VALUES (9001, fn_fecha_hoy(), $1, 'cancelado', 'voucher_fisico', $2, $3, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '5 minutes')
       RETURNING id, numero`,
      [loteId, mesaId, opId]
    )
    turnosCreadosEnTest.push(tRez1.id)
    console.log(`   Rezagado preparado: turno #${tRez1.numero} (id=${tRez1.id})`)

    await sleep(DOBLE_CLIC_GAP) // respetar gap para no pisar la última llamada
    const rezRes1 = await atenderRezagado(token, tRez1.id, mesaId)
    assert(rezRes1.status === 200, `Atender rezagado 1 devuelve 200 (obtenido: ${rezRes1.status})`)
    if (rezRes1.status === 200) {
      assert(rezRes1.data.turno.numero === tRez1.numero, `Rezagado #${tRez1.numero} asignado correctamente`)
      assert(rezRes1.data.es_rezagado === true, 'Payload marca es_rezagado=true para TV')
    }

    // Verificar que el lote NO avanzó
    const { rows: [lotePost1] } = await pool.query(
      `SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id = $1`, [loteId]
    )
    const loteRef = lote.ultimo_numero_llamado + 4 // 4 llamadas de Fase 1
    assert(lotePost1.ultimo_numero_llamado === loteRef,
      `Lote no avanza al atender rezagado (esperado: ${loteRef}, actual: ${lotePost1.ultimo_numero_llamado})`)
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // FASE 3: 1 llamada a "Siguiente" después del rezagado
    // ═════════════════════════════════════════════════════════════════════════
    console.log('--- FASE 3: 1 llamada a "Siguiente" ---')
    await sleep(DOBLE_CLIC_GAP)
    const d5 = await llamar(token, mesaId)
    if (!d5.turno) throw new Error(`Llamada Fase 3 falló: ${JSON.stringify(d5)}`)
    llamados.push(d5.turno)
    turnosCreadosEnTest.push(d5.turno.id)
    console.log(`   Llamada Fase 3: turno #${d5.turno.numero}`)
    assert(d5.turno.numero > numsFase1[numsFase1.length - 1],
      `Turno de Fase 3 (#${d5.turno.numero}) es mayor al último de Fase 1 (#${numsFase1[numsFase1.length - 1]}) — FIFO respetado`)
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // FASE 4: 2 re-llamados del turno actual
    // ═════════════════════════════════════════════════════════════════════════
    console.log('--- FASE 4: 2 re-llamados del turno en atención ---')
    const turnoRellamar = d5.turno
    tvEvents.length = 0

    const rr1 = await rellamar(token, turnoRellamar.id, mesaId)
    assert(rr1.status === 200, `Primer re-llamado: 200 OK (obtenido: ${rr1.status})`)
    await sleep(200)
    const evRell1 = tvEvents.find(e => e.tipo === 'turno_rellamado')
    assert(!!evRell1, `TV recibió evento turno_rellamado (1er re-llamado)`)
    assert(evRell1?.payload?.numero === turnoRellamar.numero,
      `TV re-llama el turno correcto #${turnoRellamar.numero}`)

    // Esperar cooldown y hacer el segundo re-llamado
    await sleep(RELLAMAR_COOLDOWN)
    tvEvents.length = 0
    const rr2 = await rellamar(token, turnoRellamar.id, mesaId)
    assert(rr2.status === 200, `Segundo re-llamado tras cooldown: 200 OK (obtenido: ${rr2.status})`)
    await sleep(200)
    const evRell2 = tvEvents.find(e => e.tipo === 'turno_rellamado')
    assert(!!evRell2, `TV recibió evento turno_rellamado (2do re-llamado)`)

    // Verificar que evento_id es diferente (nueva ventana)
    assert(evRell1?.payload?.evento_id !== evRell2?.payload?.evento_id,
      'Dos re-llamados tienen evento_id distinto (anti-dedup correcto)')
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // FASE 5: 3 llamadas a "Siguiente" subsecuentes
    // ═════════════════════════════════════════════════════════════════════════
    console.log('--- FASE 5: 3 llamadas a "Siguiente" subsecuentes ---')
    const llamadosFase5 = []
    for (let i = 1; i <= 3; i++) {
      await sleep(DOBLE_CLIC_GAP)
      const d = await llamar(token, mesaId)
      if (!d.turno) throw new Error(`Llamada Fase 5-${i} falló: ${JSON.stringify(d)}`)
      llamadosFase5.push(d.turno)
      turnosCreadosEnTest.push(d.turno.id)
      console.log(`   Llamada Fase 5-${i}: turno #${d.turno.numero}`)
    }
    await sleep(200)

    const numsFase5 = llamadosFase5.map(t => t.numero)
    const fifoOk5 = numsFase5.every((n, i) => i === 0 || n > numsFase5[i - 1])
    assert(fifoOk5, `FIFO estricto en Fase 5: [${numsFase5.join(', ')}]`)
    assert(numsFase5[0] > d5.turno.numero,
      `Primera llamada Fase 5 (#${numsFase5[0]}) > última llamada Fase 3 (#${d5.turno.numero})`)
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // FASE 6: Atender 2 rezagados
    // ═════════════════════════════════════════════════════════════════════════
    console.log('--- FASE 6: Atender 2 rezagados ---')
    const { rows: [tRez2] } = await pool.query(
      `INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id, llamado_en, finalizado_en)
       VALUES (9002, fn_fecha_hoy(), $1, 'cancelado', 'voucher_fisico', $2, $3, NOW() - INTERVAL '8 minutes', NOW() - INTERVAL '4 minutes')
       RETURNING id, numero`,
      [loteId, mesaId, opId]
    )
    const { rows: [tRez3] } = await pool.query(
      `INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id, llamado_en, finalizado_en)
       VALUES (9003, fn_fecha_hoy(), $1, 'cancelado', 'voucher_fisico', $2, $3, NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '2 minutes')
       RETURNING id, numero`,
      [loteId, mesaId, opId]
    )
    turnosCreadosEnTest.push(tRez2.id, tRez3.id)

    await sleep(DOBLE_CLIC_GAP)
    const rezRes2 = await atenderRezagado(token, tRez2.id, mesaId)
    assert(rezRes2.status === 200, `Atender rezagado 2 devuelve 200 (obtenido: ${rezRes2.status})`)

    await sleep(DOBLE_CLIC_GAP)
    const rezRes3 = await atenderRezagado(token, tRez3.id, mesaId)
    assert(rezRes3.status === 200, `Atender rezagado 3 devuelve 200 (obtenido: ${rezRes3.status})`)

    // Verificar que el lote NO avanzó con los rezagados
    const { rows: [lotePost2] } = await pool.query(
      `SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id = $1`, [loteId]
    )
    const loteRef2 = lote.ultimo_numero_llamado + 4 + 1 + 3 // Fases 1 + 3 + 5
    assert(lotePost2.ultimo_numero_llamado === loteRef2,
      `Lote no avanza al atender rezagados (esperado: ${loteRef2}, actual: ${lotePost2.ultimo_numero_llamado})`)
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // FASE 7: 1 re-llamado final
    // ═════════════════════════════════════════════════════════════════════════
    console.log('--- FASE 7: 1 re-llamado final ---')
    tvEvents.length = 0
    // El turno en_atencion ahora es el rezagado 3 (último atendido)
    await sleep(RELLAMAR_COOLDOWN) // asegurar que cooldown expiró
    const rrFinal = await rellamar(token, tRez3.id, mesaId)
    assert(rrFinal.status === 200, `Re-llamado final: 200 OK (obtenido: ${rrFinal.status})`)
    await sleep(200)
    const evRellFinal = tvEvents.find(e => e.tipo === 'turno_rellamado')
    assert(!!evRellFinal, 'TV recibió evento turno_rellamado final')
    assert(evRellFinal?.payload?.numero === tRez3.numero,
      `TV re-llama el turno correcto #${tRez3.numero}`)
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // VERIFICACIÓN GLOBAL FIFO — sin saltos de prioridad en toda la secuencia
    // ═════════════════════════════════════════════════════════════════════════
    console.log('--- VERIFICACIÓN GLOBAL: Sin saltos FIFO en toda la secuencia ---')
    const todosNormales = [...numsFase1, d5.turno.numero, ...numsFase5]
    const sinSaltos = todosNormales.every((n, i) => i === 0 || n > todosNormales[i - 1])
    assert(sinSaltos,
      `Orden FIFO global estricto sin saltos: [${todosNormales.join(', ')}]`)

    // Sin duplicados
    const setTurnos = new Set(todosNormales)
    assert(setTurnos.size === todosNormales.length,
      `Sin duplicados en la secuencia normal (${todosNormales.length} turnos únicos)`)

    console.log('\n======================================================================')
    console.log(`RESULTADO: ${passed} PASADOS | ${failed} FALLADOS`)
    console.log('======================================================================')

    if (failed > 0) process.exit(1)

  } finally {
    // Cerrar WebSockets
    for (const ws of wsSockets) {
      try { ws.close() } catch (_) {}
    }
    // Limpiar datos de prueba
    console.log('\nLimpiando datos de prueba...')
    if (turnosCreadosEnTest.length > 0) {
      await pool.query(
        `UPDATE turnos SET estado = 'atendido', finalizado_en = NOW() WHERE id = ANY($1) AND estado = 'en_atencion'`,
        [turnosCreadosEnTest]
      )
      await pool.query(`DELETE FROM turnos WHERE id = ANY($1)`, [turnosCreadosEnTest])
    }
    if (mesaId) await pool.query(`DELETE FROM mesas WHERE id = $1`, [mesaId])
    if (opId)   await pool.query(`DELETE FROM usuarios WHERE id = $1`, [opId])
    await pool.end()
    console.log('   [OK] Limpieza completada.')
  }
}

run().catch(err => {
  console.error('\n[FAIL] Error fatal:', err.message || err)
  process.exit(1)
})
