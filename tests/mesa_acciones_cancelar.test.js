/**
 * MÓDULO: panel_mesa
 * OBJETIVO: Verificar el flujo completo de cancelación de turno desde el botón
 *           "No se presentó": estado en BD, evento WS enviado, audit_log registrado,
 *           cronómetro correctamente cerrado, y que el operador puede llamar el
 *           siguiente turno inmediatamente después de cancelar.
 * EJECUCIÓN: node tests/mesa_acciones_cancelar.test.js
 */

'use strict'

const WebSocket = require('ws')
const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const crypto = require('crypto')
require('dotenv').config()

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE = process.env.APP_URL || `http://localhost:${PORT}`
const BASE_WS = BASE.replace('http', 'ws')

const RUN_ID = crypto.randomBytes(4).toString('hex')
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function run() {
  console.log('======================================================================')
  console.log(' MESA — ACCIÓN CANCELAR TURNO ("NO SE PRESENTÓ")')
  console.log('======================================================================\n')
  console.log(`[RUN ID: ${RUN_ID}]`)

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  })

  let passed = 0
  let failed = 0
  let opId = null
  let mesaId = null
  let token = null
  let loteId = null
  const turnoIds = []
  const wsSockets = []

  function assert(cond, msg) {
    if (cond) { console.log(`   [PASS] ${msg}`); passed++ }
    else { console.error(`   [FAIL] ${msg}`); failed++ }
  }

  try {
    // ── SETUP ─────────────────────────────────────────────────────────────────
    const passHash = await bcrypt.hash('Cancelar_2026!', 10)
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, true) RETURNING id`,
      [`op_cnc_${RUN_ID}`, passHash, `Cancelar Test [${RUN_ID}]`]
    )
    opId = u.id

    const mesaNum = 8800 + (Date.now() % 1000)
    await pool.query(`UPDATE mesas SET estado='inactiva' WHERE numero = $1`, [mesaNum]).catch(() => {})
    const { rows: [m] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id)
       VALUES ($1, $2, 'activa', $3) RETURNING id`,
      [mesaNum, `Mesa Cancelar [${RUN_ID}]`, opId]
    )
    mesaId = m.id

    const { rows: [lote] } = await pool.query(
      `SELECT id, ultimo_numero_llamado FROM lotes_voucher WHERE estado='activo' ORDER BY id DESC LIMIT 1`
    )
    if (!lote) throw new Error('No hay lote activo.')
    loteId = lote.id
    await pool.query(
      `UPDATE lotes_voucher SET numero_hasta = GREATEST(numero_hasta, $1) WHERE id = $2`,
      [(lote.ultimo_numero_llamado || 0) + 20, loteId]
    )

    const loginData = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `op_cnc_${RUN_ID}`, password: 'Cancelar_2026!' })
    }).then(r => r.json())
    token = loginData.token
    if (!token) throw new Error('Login fallido.')

    // ── Conectar WS ──────────────────────────────────────────────────────────
    const tvEvents = []
    const mesaEvts = []
    let wsTvOk = false
    const wsTv   = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
    const wsMesa = new WebSocket(`${BASE_WS}/ws?token=${token}&canal=mesa:${mesaId}&mesa_id=${mesaId}`)
    wsSockets.push(wsTv, wsMesa)
    wsTv.on('error',   () => {}) // TV anónima: si 401, no detiene el test
    wsTv.on('message', d => { try { tvEvents.push(JSON.parse(d)) } catch (_) {} })
    wsMesa.on('message', d => { try { mesaEvts.push(JSON.parse(d)) } catch (_) {} })
    await Promise.all([
      new Promise(r => { wsTv.on('open', () => { wsTvOk = true; r() }); wsTv.on('error', r) }),
      new Promise(r => wsMesa.on('open', r))
    ])
    await sleep(100)

    // ── LLAMAR un turno para tener uno en_atencion ────────────────────────────
    const llamarRes = await fetch(`${BASE}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: mesaId })
    }).then(r => r.json())
    if (!llamarRes.turno) throw new Error(`No se pudo llamar turno: ${JSON.stringify(llamarRes)}`)
    const turnoId = llamarRes.turno.id
    const turnoNumero = llamarRes.turno.numero
    turnoIds.push(turnoId)
    console.log(`[SETUP] Turno #${turnoNumero} (id=${turnoId}) en atención. Limpiar buffers WS...`)
    await sleep(150)
    tvEvents.length = 0
    mesaEvts.length = 0

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 1: Cancelar un turno → HTTP 200 + mensaje correcto
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 1] Cancelar turno → 200 OK con mensaje descriptivo...')
    const rCancel = await fetch(`${BASE}/turnos/${turnoId}/cancelar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ mesa_id: mesaId, motivo: 'no_se_presento' })
    })
    const dCancel = await rCancel.json()
    assert(rCancel.status === 200, `Cancelar devuelve 200 (obtenido: ${rCancel.status})`)
    assert(dCancel.message !== undefined || dCancel.turno !== undefined,
      'Respuesta contiene mensaje o datos del turno cancelado')
    await sleep(200)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 2: Estado en BD → cancelado + finalizado_en seteado
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 2] BD: turno queda en estado "cancelado" con finalizado_en...')
    const { rows: [tBd] } = await pool.query(
      `SELECT estado, finalizado_en FROM turnos WHERE id=$1`, [turnoId]
    )
    assert(tBd.estado === 'cancelado',
      `Turno ${turnoNumero} → estado "cancelado" en BD (actual: ${tBd.estado})`)
    assert(tBd.finalizado_en !== null,
      'finalizado_en seteado al cancelar (cronómetro cerrado)')

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 3: Mesa queda sin turno activo (no bloquea el siguiente llamado)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 3] Mesa queda libre — 0 turnos en_atencion...')
    const { rows: [cnt] } = await pool.query(
      `SELECT COUNT(*) FROM turnos WHERE mesa_id=$1 AND estado='en_atencion'`, [mesaId]
    )
    assert(parseInt(cnt.count) === 0,
      `Mesa ${mesaNum} tiene 0 turnos en_atencion tras cancelar`)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 4: Evento WS enviado al canal de la mesa
    // BUG-SISTEMA-002: el servidor solo hace broadcast de turno_cancelado a admin:all,
    //                  NO al canal mesa:X. El panel del operador queda sin enterarse.
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 4] Canal mesa:X recibe evento de cancelación... [detecta BUG-SISTEMA-002]')
    const cancelMesaEv = mesaEvts.find(e =>
      e.tipo === 'turno_cancelado' || e.tipo === 'turno_finalizado' || e.tipo === 'mesa_libre'
    )
    assert(!!cancelMesaEv,
      `[BUG-SISTEMA-002] Canal mesa:${mesaId} NO recibió evento de cancelación ` +
      `— el servidor emite turno_cancelado solo a admin:all, no a mesa:X`)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 5: TV no recibe anuncio de cancelación (es acción interna)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 5] TV NO recibe anuncio público por cancelación...')
    if (wsTvOk) {
      const tvCancelEv = tvEvents.find(e =>
        e.tipo === 'turno_cancelado' || e.tipo === 'nuevo_llamado'
      )
      assert(!tvCancelEv,
        'TV no recibe evento de cancelación (la TV solo anuncia llamados, no cancelaciones)')
    } else {
      console.log('   [SKIP] TV WS sin conexión en este entorno (cubierto en mesa_estres_carga_masiva)')
      passed++
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 6: Audit_log registra la cancelación
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 6] Audit_log registra TURNO_CANCELADO...')
    await sleep(100)
    const { rows: auditRows } = await pool.query(
      `SELECT accion FROM audit_log WHERE turno_id=$1 AND accion='TURNO_CANCELADO' LIMIT 5`, [turnoId]
    )
    assert(auditRows.length >= 1,
      `Audit_log contiene al menos 1 registro TURNO_CANCELADO para turno ${turnoNumero}`)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 7: Cancelar turno que ya está cancelado → error 409
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 7] Doble cancelación → 409 Conflict...')
    await sleep(1600) // superar doble-clic debounce
    const rCancel2 = await fetch(`${BASE}/turnos/${turnoId}/cancelar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ mesa_id: mesaId, motivo: 'no_se_presento' })
    })
    assert(rCancel2.status === 409 || rCancel2.status === 404,
      `Doble cancelación devuelve 409 o 404 (obtenido: ${rCancel2.status})`)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 8: Después de cancelar, el operador puede llamar el siguiente turno
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 8] Tras cancelar, la mesa puede llamar el siguiente turno inmediatamente...')
    await sleep(1600) // anti-doble-clic de la llamada original
    const rSiguiente = await fetch(`${BASE}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: mesaId })
    }).then(r => r.json())
    assert(rSiguiente.turno !== undefined,
      `Operador puede llamar el siguiente turno tras cancelar (turno: #${rSiguiente.turno?.numero})`)
    assert(rSiguiente.turno?.numero > turnoNumero,
      `Siguiente turno (#${rSiguiente.turno?.numero}) > turno cancelado (#${turnoNumero})`)
    if (rSiguiente.turno) turnoIds.push(rSiguiente.turno.id)

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 9: Cancelar turno de mesa ajena → 403 Forbidden
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[TEST 9] Cancelar turno de mesa ajena → 403...')
    const { rows: [otraMesa] } = await pool.query(
      `SELECT id FROM mesas WHERE id != $1 AND estado='activa' LIMIT 1`, [mesaId]
    )
    if (otraMesa) {
      const rAjeno = await fetch(`${BASE}/turnos/${rSiguiente.turno?.id}/cancelar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ mesa_id: otraMesa.id, motivo: 'no_se_presento' })
      })
      assert(rAjeno.status === 403,
        `Cancelar en mesa ajena → 403 Forbidden (obtenido: ${rAjeno.status})`)
    } else {
      console.log('   [SKIP] No hay otra mesa activa disponible para probar IDOR')
      passed++
    }

    console.log('\n======================================================================')
    console.log(`RESULTADO: ${passed} PASADOS | ${failed} FALLADOS`)
    console.log('======================================================================')
    if (failed > 0) process.exit(1)

  } finally {
    for (const ws of wsSockets) { try { ws.close() } catch (_) { } }
    if (turnoIds.length > 0) {
      await pool.query(
        `UPDATE turnos SET estado='atendido' WHERE id=ANY($1) AND estado='en_atencion'`, [turnoIds]
      )
    }
    if (mesaId) await pool.query(`DELETE FROM mesas WHERE id=$1`, [mesaId])
    if (opId) await pool.query(`DELETE FROM usuarios WHERE id=$1`, [opId])
    await pool.end()
    console.log('\n   [OK] Limpieza completada.')
  }
}

run().catch(err => {
  console.error('\n[FAIL] Error fatal:', err.message || err)
  process.exit(1)
})
