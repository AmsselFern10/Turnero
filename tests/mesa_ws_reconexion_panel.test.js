/**
 * MÓDULO: panel_mesa
 * OBJETIVO: Verificar que la reconexión del panel de operador tras corte de red
 *           restaura estado correcto (turno en atención, proximo_numero, atendidos_hoy)
 *           y que el panel sigue recibiendo eventos en tiempo real tras reconectar.
 * EJECUCIÓN: node tests/mesa_ws_reconexion_panel.test.js
 */

'use strict'

const WebSocket = require('ws')
const { Pool }  = require('pg')
const bcrypt    = require('bcrypt')
const crypto    = require('crypto')
require('dotenv').config()

const PORT    = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE    = process.env.APP_URL || `http://localhost:${PORT}`
const BASE_WS = BASE.replace('http', 'ws')

const RUN_ID = crypto.randomBytes(4).toString('hex')
function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

async function llamar (token, mesaId) {
  return fetch(`${BASE}/turnos/llamar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({ mesa_id: mesaId })
  }).then(r => r.json())
}

async function run () {
  console.log('======================================================================')
  console.log(' MESA — RECONEXIÓN WS DEL PANEL (SNAPSHOT DE RECUPERACIÓN)')
  console.log('======================================================================\n')
  console.log(`[RUN ID: ${RUN_ID}]`)

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}` +
      `@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  })

  let passed = 0
  let failed = 0
  let opId   = null
  let mesaId = null
  let token  = null
  const turnoIds  = []
  const wsList    = []

  function assert (cond, msg) {
    if (cond) { console.log(`   [PASS] ${msg}`); passed++ }
    else       { console.error(`   [FAIL] ${msg}`); failed++ }
  }

  try {
    // ── SETUP ────────────────────────────────────────────────────────────────
    const passHash = await bcrypt.hash('WsRecon_2026!', 10)
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, true) RETURNING id`,
      [`op_wsr_${RUN_ID}`, passHash, `WS Recon [${RUN_ID}]`]
    )
    opId = u.id

    const mesaNum = 3300 + parseInt(RUN_ID, 16) % 100
    const { rows: [m] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id)
       VALUES ($1, $2, 'activa', $3) RETURNING id`,
      [mesaNum, `WsRecon [${RUN_ID}]`, opId]
    )
    mesaId = m.id

    const { rows: [lote] } = await pool.query(
      `SELECT id, ultimo_numero_llamado FROM lotes_voucher WHERE estado='activo' ORDER BY id DESC LIMIT 1`
    )
    if (!lote) throw new Error('No hay lote activo.')
    await pool.query(
      `UPDATE lotes_voucher SET numero_hasta = GREATEST(numero_hasta, $1) WHERE id = $2`,
      [(lote.ultimo_numero_llamado || 0) + 20, lote.id]
    )

    const ld = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `op_wsr_${RUN_ID}`, password: 'WsRecon_2026!' })
    }).then(r => r.json())
    token = ld.token
    if (!token) throw new Error('Login fallido.')

    // ── SETUP: 2 llamadas → 1 atendido + 1 en_atencion ─────────────────────
    console.log('[SETUP] Creando 2 llamadas (1 atendido + 1 en atención)...')
    const t1 = await llamar(token, mesaId)
    if (t1.turno) turnoIds.push(t1.turno.id)
    await sleep(1700)
    const t2 = await llamar(token, mesaId)
    if (t2.turno) turnoIds.push(t2.turno.id)
    console.log(`   [OK] Turno #${t1.turno?.numero} atendido, #${t2.turno?.numero} en atención`)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 1: GET /turnos/estado devuelve snapshot correcto (estado actual)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 1] GET /turnos/estado devuelve snapshot con turno en atención...')
    const snap1 = await fetch(`${BASE}/turnos/estado?mesa_id=${mesaId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json())

    assert(snap1.turno_actual !== undefined || snap1.mesa !== undefined,
      'GET /turnos/estado responde con estructura válida (turno_actual o mesa)')
    assert(
      snap1.turno_actual?.id === t2.turno?.id || snap1.turno_actual?.numero === t2.turno?.numero,
      `Snapshot refleja turno en atención correcto (#${t2.turno?.numero})`
    )
    assert(snap1.proximo_numero !== undefined,
      'Snapshot incluye proximo_numero')

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 2: Panel WS inicial recibe turno_llamado en tiempo real
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 2] Panel WS recibe turno_llamado en tiempo real...')
    const panelEvts = []
    const ws1 = new WebSocket(`${BASE_WS}/ws?token=${token}&canal=mesa:${mesaId}&mesa_id=${mesaId}`)
    wsList.push(ws1)
    ws1.on('message', d => { try { panelEvts.push(JSON.parse(d)) } catch (_) {} })
    await new Promise(r => ws1.on('open', r))
    await sleep(300)
    panelEvts.length = 0  // descartar snapshot inicial y eventos buffereados

    // Llamar un turno mientras el panel está conectado
    await sleep(1700)
    const t3 = await llamar(token, mesaId)
    if (t3.turno) turnoIds.push(t3.turno.id)
    await sleep(250)

    const evRT = panelEvts.find(e => e.tipo === 'turno_llamado')
    assert(!!evRT, `Panel WS recibe turno_llamado en tiempo real (turno #${t3.turno?.numero})`)
    assert(Number(evRT?.payload?.turno?.numero) === t3.turno?.numero,
      `Número de turno en evento coincide (#${t3.turno?.numero})`)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 3: Corte abrupto + reconexión → snapshot HTTP correcto
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 3] Corte de red y reconexión → snapshot restaura estado...')
    ws1.terminate()
    await sleep(300)

    // Mientras el panel estaba desconectado, el operador llamó otro turno
    await sleep(1700)
    const t4 = await llamar(token, mesaId)
    if (t4.turno) turnoIds.push(t4.turno.id)
    console.log(`   [OK] Turno #${t4.turno?.numero} llamado durante el corte`)

    const snap2 = await fetch(`${BASE}/turnos/estado?mesa_id=${mesaId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json())

    assert(
      snap2.turno_actual?.id === t4.turno?.id || snap2.turno_actual?.numero === t4.turno?.numero,
      `Snapshot post-reconexión refleja turno actual correcto (#${t4.turno?.numero})`
    )
    assert(Number(snap2.atendidos_hoy) >= 2,
      `atendidos_hoy es >= 2 después de 3 llamadas (actual: ${snap2.atendidos_hoy})`)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 4: Tras reconectar, el panel sigue recibiendo eventos en tiempo real
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 4] Panel reconectado sigue recibiendo eventos en tiempo real...')
    const panelEvts2 = []
    const ws2 = new WebSocket(`${BASE_WS}/ws?token=${token}&canal=mesa:${mesaId}&mesa_id=${mesaId}`)
    wsList.push(ws2)
    ws2.on('message', d => { try { panelEvts2.push(JSON.parse(d)) } catch (_) {} })
    await new Promise(r => ws2.on('open', r))
    await sleep(300)
    panelEvts2.length = 0  // descartar snapshot del servidor al reconectar

    await sleep(1700)
    const t5 = await llamar(token, mesaId)
    if (t5.turno) turnoIds.push(t5.turno.id)
    await sleep(250)

    const evRT2 = panelEvts2.find(e => e.tipo === 'turno_llamado')
    assert(!!evRT2, `Panel reconectado recibe turno_llamado (#${t5.turno?.numero})`)
    assert(Number(evRT2?.payload?.turno?.numero) === t5.turno?.numero,
      `Número correcto tras reconexión (#${t5.turno?.numero})`)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 5: Panel reconectado no recibe eventos de mesas ajenas
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 5] Panel reconectado NO recibe eventos de mesas ajenas...')
    const evAjeno = panelEvts2.find(e =>
      e.tipo === 'turno_llamado' && Number(e.payload?.turno?.mesa_id) !== Number(mesaId)
    )
    if (evAjeno) {
      console.log(`   [DEBUG] Evento ajeno detectado: tipo=${evAjeno.tipo}, ` +
        `turno.mesa_id=${evAjeno.payload?.turno?.mesa_id} (esperado mesaId=${mesaId})`)
      console.log(`   [DEBUG] Payload completo:`, JSON.stringify(evAjeno.payload?.turno))
    }
    // BUG-SISTEMA-003 (posible): si el canal mesa:X recibe eventos de otras mesas bajo carga
    // este assert lo detecta. Si el sistema es correcto, debería ser null.
    assert(!evAjeno,
      `Panel solo recibe eventos de mesa:${mesaId}, sin contaminación de otras mesas`)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 6: proximo_numero en snapshot final es coherente
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 6] Snapshot final tiene proximo_numero > último turno llamado...')
    const snapFinal = await fetch(`${BASE}/turnos/estado?mesa_id=${mesaId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json())

    assert(snapFinal.proximo_numero > t5.turno?.numero,
      `proximo_numero (${snapFinal.proximo_numero}) > turno actual (#${t5.turno?.numero})`)

    console.log('\n======================================================================')
    console.log(`RESULTADO: ${passed} PASADOS | ${failed} FALLADOS`)
    console.log('======================================================================')
    if (failed > 0) process.exit(1)

  } finally {
    for (const ws of wsList) { try { ws.terminate() } catch (_) {} }
    if (turnoIds.length > 0) {
      await pool.query(
        `UPDATE turnos SET estado='atendido' WHERE id=ANY($1) AND estado='en_atencion'`,
        [turnoIds]
      )
    }
    if (mesaId) await pool.query(`DELETE FROM mesas WHERE id=$1`, [mesaId])
    if (opId)   await pool.query(`DELETE FROM usuarios WHERE id=$1`, [opId])
    await pool.end()
    console.log('\n   [OK] Limpieza completada.')
  }
}

run().catch(err => {
  console.error('\n[FAIL] Error fatal:', err.message || err)
  process.exit(1)
})
