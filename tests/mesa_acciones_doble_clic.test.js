/**
 * MÓDULO: panel_mesa
 * OBJETIVO: Verificar la protección anti-doble-clic del servidor (~1.5s).
 *           Dos llamadas rápidas consecutivas en la misma mesa deben resultar
 *           en exactamente 1 turno (idempotencia temporal), no en 2.
 *           Después del gap, la segunda llamada sí avanza el lote.
 * EJECUCIÓN: node tests/mesa_acciones_doble_clic.test.js
 */

'use strict'

const { Pool }  = require('pg')
const bcrypt    = require('bcrypt')
const crypto    = require('crypto')
require('dotenv').config()

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE = process.env.APP_URL || `http://localhost:${PORT}`

const RUN_ID = crypto.randomBytes(4).toString('hex')
function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

async function run () {
  console.log('======================================================================')
  console.log(' MESA — PROTECCIÓN ANTI-DOBLE-CLIC (DEBOUNCE SERVIDOR ~1.5s)')
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
  const turnoIds = []

  function assert (cond, msg) {
    if (cond) { console.log(`   [PASS] ${msg}`); passed++ }
    else       { console.error(`   [FAIL] ${msg}`); failed++ }
  }

  try {
    // ── SETUP ─────────────────────────────────────────────────────────────────
    const passHash = await bcrypt.hash('DblClic_2026!', 10)
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, true) RETURNING id`,
      [`op_dc_${RUN_ID}`, passHash, `DblClic Test [${RUN_ID}]`]
    )
    opId = u.id

    const mesaNum = 5500 + parseInt(RUN_ID, 16) % 100
    const { rows: [m] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id)
       VALUES ($1, $2, 'activa', $3) RETURNING id`,
      [mesaNum, `Mesa DblClic [${RUN_ID}]`, opId]
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

    const { token } = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `op_dc_${RUN_ID}`, password: 'DblClic_2026!' })
    }).then(r => r.json())
    if (!token) throw new Error('Login fallido.')

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 1: Dos clics en < 100ms → 1 solo turno (coalescing)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 1] 2 clics en < 100ms → exactamente 1 turno (coalescing por Idempotency-Key)...')
    const ikey1 = crypto.randomUUID()
    const [r1a, r1b] = await Promise.all([
      fetch(`${BASE}/turnos/llamar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': ikey1 },
        body: JSON.stringify({ mesa_id: mesaId })
      }).then(r => r.json()),
      fetch(`${BASE}/turnos/llamar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': ikey1 },
        body: JSON.stringify({ mesa_id: mesaId })
      }).then(r => r.json())
    ])

    assert(r1a.turno && r1b.turno, 'Ambas respuestas tienen turno')
    assert(r1a.turno.id === r1b.turno.id, `Ambos clics → mismo turno ID (${r1a.turno?.id})`)
    assert(r1a.turno.numero === r1b.turno.numero, `Mismo número de turno (${r1a.turno?.numero})`)
    if (r1a.turno) turnoIds.push(r1a.turno.id)

    const { rows: enAtencion1 } = await pool.query(
      `SELECT COUNT(*) FROM turnos WHERE mesa_id=$1 AND estado='en_atencion'`, [mesaId]
    )
    assert(parseInt(enAtencion1[0].count) === 1, 'BD: exactamente 1 turno en_atencion tras doble clic')

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 2: Dos clics con distintas Idempotency-Key en < 50ms → server debounce
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 2] 2 clics con keys distintas en < 50ms → coalescing por mesa...')
    const loteAntes = (await pool.query(
      `SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id=$1`, [lote.id]
    )).rows[0].ultimo_numero_llamado

    const [r2a, r2b] = await Promise.all([
      fetch(`${BASE}/turnos/llamar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ mesa_id: mesaId })
      }).then(r => r.json()),
      fetch(`${BASE}/turnos/llamar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ mesa_id: mesaId })
      }).then(r => r.json())
    ])

    const loteDespues = (await pool.query(
      `SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id=$1`, [lote.id]
    )).rows[0].ultimo_numero_llamado

    // Con distintas keys pero misma mesa en vuelo simultáneo,
    // el coalescing por mesa garantiza que avanzan a lo sumo 1
    const avance = loteDespues - loteAntes
    assert(avance <= 1, `Lote avanzó como máximo 1 tras doble clic con keys distintas (avanzó: ${avance})`)

    if (r2a.turno) turnoIds.push(r2a.turno.id)
    if (r2b.turno && r2b.turno.id !== r2a.turno?.id) turnoIds.push(r2b.turno.id)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 3: Reintento legítimo tras timeout con la misma key → misma respuesta
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 3] Reintento con misma Idempotency-Key → mismo turno desde caché...')
    await sleep(300) // simular delay de red
    const ikey3 = crypto.randomUUID()
    const r3a = await fetch(`${BASE}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': ikey3 },
      body: JSON.stringify({ mesa_id: mesaId })
    }).then(r => r.json())
    if (r3a.turno) turnoIds.push(r3a.turno.id)

    await sleep(100)
    const r3b = await fetch(`${BASE}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': ikey3 },
      body: JSON.stringify({ mesa_id: mesaId })
    }).then(r => r.json())

    assert(r3b.turno?.id === r3a.turno?.id, `Reintento devuelve mismo turno (id=${r3a.turno?.id})`)
    assert(r3b.es_idempotente === true, 'Respuesta de reintento marca es_idempotente=true')

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 4: Tras >1.5s, la misma mesa puede llamar un nuevo turno
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 4] Tras 1.6s, la misma mesa llama un nuevo turno (avance real)...')
    await sleep(1600)
    const loteRef = (await pool.query(
      `SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id=$1`, [lote.id]
    )).rows[0].ultimo_numero_llamado

    const r4 = await fetch(`${BASE}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: mesaId })
    }).then(r => r.json())

    const loteRef2 = (await pool.query(
      `SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id=$1`, [lote.id]
    )).rows[0].ultimo_numero_llamado

    assert(r4.turno !== undefined, 'Mesa llama turno exitosamente tras gap de 1.6s')
    assert(loteRef2 > loteRef, `Lote avanzó realmente (${loteRef} → ${loteRef2})`)
    assert(r4.es_idempotente !== true, 'Respuesta NO marca es_idempotente en llamada legítima nueva')
    if (r4.turno) turnoIds.push(r4.turno.id)

    console.log('\n======================================================================')
    console.log(`RESULTADO: ${passed} PASADOS | ${failed} FALLADOS`)
    console.log('======================================================================')
    if (failed > 0) process.exit(1)

  } finally {
    if (turnoIds.length > 0) {
      await pool.query(`UPDATE turnos SET estado='atendido' WHERE id=ANY($1) AND estado='en_atencion'`, [turnoIds])
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
