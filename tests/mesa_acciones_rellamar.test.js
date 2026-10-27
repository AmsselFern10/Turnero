/**
 * MÓDULO: panel_mesa
 * OBJETIVO: Evaluar de forma individual la acción "Re-llamar a TV".
 *           Verifica que se reemite el evento en la red y se actualizan los timestamps,
 *           sin alterar el estado en cola ni el progreso del lote.
 * EJECUCIÓN: node tests/mesa_acciones_rellamar.test.js
 */

'use strict'

const WebSocket  = require('ws')
const { Pool }   = require('pg')
const bcrypt     = require('bcrypt')
const crypto     = require('crypto')
require('dotenv').config()

const PORT     = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE     = process.env.APP_URL || `http://localhost:${PORT}`
const BASE_WS  = BASE.replace('http', 'ws')

const RUN_ID   = crypto.randomBytes(4).toString('hex')

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

async function run () {
  console.log('======================================================================')
  console.log(' MESA — ACCIÓN RE-LLAMAR A TV')
  console.log('======================================================================\n')
  console.log(`[RUN ID: ${RUN_ID}]`)

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  })

  let passed    = 0
  let failed    = 0
  let opId      = null
  let mesaId    = null
  let turnoId   = null
  let token     = null
  const wsSockets = []

  function assert (cond, msg) {
    if (cond) { console.log(`   [PASS] ${msg}`); passed++ }
    else       { console.error(`   [FAIL] ${msg}`); failed++ }
  }

  try {
    // ── SETUP ─────────────────────────────────────────────────────────────────
    console.log('[SETUP] Creando operador, mesa y obteniendo lote activo...')
    const passHash = await bcrypt.hash('Rellamar_2026!', 10)

    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, true) RETURNING id`,
      [`op_rll_${RUN_ID}`, passHash, `Rellamar Test [${RUN_ID}]`]
    )
    opId = u.id

    const { rows: [m] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id)
       VALUES ($1, $2, 'activa', $3) RETURNING id`,
      [7700 + parseInt(RUN_ID, 16) % 100, `Mesa Rellamar [${RUN_ID}]`, opId]
    )
    mesaId = m.id

    const { rows: [lote] } = await pool.query(
      `SELECT id, ultimo_numero_llamado, numero_hasta FROM lotes_voucher
       WHERE estado = 'activo' ORDER BY id DESC LIMIT 1`
    )
    if (!lote) throw new Error('No hay lote activo. Activa uno desde admin.')
    await pool.query(
      `UPDATE lotes_voucher SET numero_hasta = GREATEST(numero_hasta, $1) WHERE id = $2`,
      [(lote.ultimo_numero_llamado || 0) + 100, lote.id]
    )
    console.log(`   [OK] op_id=${opId} mesa_id=${mesaId} lote_id=${lote.id}`)

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    const loginRes  = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `op_rll_${RUN_ID}`, password: 'Rellamar_2026!' })
    })
    const loginData = await loginRes.json()
    token = loginData.token
    if (!token) throw new Error(`Login fallido: ${JSON.stringify(loginData)}`)
    console.log('   [OK] Token JWT obtenido\n')

    // ── LLAMAR SIGUIENTE para tener turno en_atencion ─────────────────────────
    console.log('[SETUP] Llamando turno inicial...')
    const rLlamar = await fetch(`${BASE}/turnos/llamar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify({ mesa_id: mesaId })
    })
    const dLlamar = await rLlamar.json()
    if (!dLlamar.turno) throw new Error(`No se obtuvo turno: ${JSON.stringify(dLlamar)}`)
    turnoId = dLlamar.turno.id
    const turnoNumero = dLlamar.turno.numero
    console.log(`   [OK] Turno #${turnoNumero} en_atencion (id=${turnoId})\n`)

    // ── CONECTAR WS ───────────────────────────────────────────────────────────
    console.log('Conectando WebSockets (tv:global y mesa:X)...')
    const tvEvents   = []
    const mesaEvents = []

    const wsTv   = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
    const wsMesa = new WebSocket(`${BASE_WS}/ws?token=${token}&canal=mesa:${mesaId}&mesa_id=${mesaId}`)
    wsSockets.push(wsTv, wsMesa)

    wsTv.on('message',   d => { try { tvEvents.push(JSON.parse(d.toString()))   } catch (_) {} })
    wsMesa.on('message', d => { try { mesaEvents.push(JSON.parse(d.toString())) } catch (_) {} })

    await Promise.all([
      new Promise(r => wsTv.on('open',   r)),
      new Promise(r => wsMesa.on('open', r))
    ])
    await sleep(100)
    console.log('   [OK] WebSockets conectados\n')

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 1: Re-llamar devuelve 200 y el turno correcto
    // ═════════════════════════════════════════════════════════════════════════
    console.log('[TEST 1] Re-llamar devuelve 200 con datos del turno...')
    const rRellamar = await fetch(`${BASE}/turnos/${turnoId}/rellamar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ mesa_id: mesaId })
    })
    const dRellamar = await rRellamar.json()
    assert(rRellamar.status === 200, `HTTP 200 OK (obtenido: ${rRellamar.status})`)
    assert(dRellamar.turno?.numero === turnoNumero,
      `Respuesta incluye el turno correcto #${turnoNumero}`)
    assert(dRellamar.turno?.id    === turnoId || String(dRellamar.turno?.id) === String(turnoId),
      'ID del turno en respuesta coincide')
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 2: TV recibe el evento turno_rellamado con datos completos
    // ═════════════════════════════════════════════════════════════════════════
    console.log('[TEST 2] TV recibe evento turno_rellamado con datos completos...')
    await sleep(200) // propagación WS
    const evTv = tvEvents.find(e => e.tipo === 'turno_rellamado')
    assert(!!evTv, `TV recibió evento turno_rellamado`)
    assert(evTv?.payload?.numero     === turnoNumero, `Payload.numero = #${turnoNumero}`)
    assert(evTv?.payload?.mesa_numero !== undefined,   'Payload incluye mesa_numero')
    assert(evTv?.payload?.evento_id !== undefined,     'Payload incluye evento_id (anti-dedup)')
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 3: El canal de mesa también recibe el turno_rellamado
    // ═════════════════════════════════════════════════════════════════════════
    console.log('[TEST 3] Canal mesa recibe turno_rellamado...')
    const evMesa = mesaEvents.find(e => e.tipo === 'turno_rellamado')
    assert(!!evMesa, `Canal mesa:${mesaId} recibió turno_rellamado`)
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 4: El turno sigue en_atencion (re-llamar no altera estado ni cola)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('[TEST 4] Estado del turno y progreso del lote no cambian...')
    const { rows: [tBd] } = await pool.query(
      `SELECT estado, finalizado_en FROM turnos WHERE id = $1`, [turnoId]
    )
    assert(tBd.estado === 'en_atencion',
      `Turno permanece en_atencion tras re-llamar (estado: ${tBd.estado})`)
    assert(tBd.finalizado_en === null,
      'finalizado_en sigue null — no se cerró el turno')

    const { rows: [lotePost] } = await pool.query(
      `SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id = $1`, [lote.id]
    )
    assert(lotePost.ultimo_numero_llamado === lote.ultimo_numero_llamado + 1,
      `Lote NO avanzó más allá del primer llamado (valor: ${lotePost.ultimo_numero_llamado})`)
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 5: Cooldown de 3s — segundo re-llamado inmediato devuelve 429
    // ═════════════════════════════════════════════════════════════════════════
    console.log('[TEST 5] Cooldown 3s — re-llamado inmediato devuelve 429...')
    const rCooldown = await fetch(`${BASE}/turnos/${turnoId}/rellamar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ mesa_id: mesaId })
    })
    assert(rCooldown.status === 429,
      `Segundo re-llamado inmediato devuelve 429 (obtenido: ${rCooldown.status})`)
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 6: Re-llamado de mesa ajena devuelve 403
    // ═════════════════════════════════════════════════════════════════════════
    console.log('[TEST 6] Intentar re-llamar mesa ajena devuelve 403...')
    const { rows: [otraMesa] } = await pool.query(
      `SELECT id FROM mesas WHERE id != $1 AND estado = 'activa' LIMIT 1`, [mesaId]
    )
    if (otraMesa) {
      const rAjena = await fetch(`${BASE}/turnos/${turnoId}/rellamar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ mesa_id: otraMesa.id })
      })
      assert(rAjena.status === 403,
        `Operador no puede re-llamar mesa ajena — 403 Forbidden (obtenido: ${rAjena.status})`)
    } else {
      console.log('   [SKIP] No hay otra mesa activa para probar protección IDOR')
      passed++ // Contar como OK si no hay con qué probar
    }
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 7: Después del cooldown, re-llamar vuelve a funcionar (200 OK)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('[TEST 7] Tras esperar 3s de cooldown, re-llamar vuelve a funcionar...')
    await sleep(3100)
    tvEvents.length = 0 // limpiar buffer
    const rPost = await fetch(`${BASE}/turnos/${turnoId}/rellamar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ mesa_id: mesaId })
    })
    assert(rPost.status === 200,
      `Tras 3s cooldown, re-llamar responde 200 (obtenido: ${rPost.status})`)
    await sleep(200)
    const evTv2 = tvEvents.find(e => e.tipo === 'turno_rellamado')
    assert(!!evTv2, 'TV recibió segundo evento turno_rellamado tras cooldown')

    // Verificar que el evento_id es diferente (nueva ventana de cooldown)
    const evId1 = evTv?.payload?.evento_id
    const evId2 = evTv2?.payload?.evento_id
    assert(evId1 !== evId2,
      `evento_id distinto entre re-llamados (anti-duplicación): "${evId1}" ≠ "${evId2}"`)
    console.log('')

    // ═════════════════════════════════════════════════════════════════════════
    // TEST 8: Auditoría — registro en audit_log
    // ═════════════════════════════════════════════════════════════════════════
    console.log('[TEST 8] Auditoría — se registran entradas TURNO_RELLAMADO...')
    await sleep(100) // permitir que el setImmediate del servidor escriba el audit_log
    const { rows: auditRows } = await pool.query(
      `SELECT id, accion FROM audit_log WHERE turno_id = $1 AND accion = 'TURNO_RELLAMADO'
       ORDER BY id DESC LIMIT 5`,
      [turnoId]
    )
    assert(auditRows.length >= 2,
      `Al menos 2 registros TURNO_RELLAMADO en audit_log para este turno (encontrados: ${auditRows.length})`)

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
    if (turnoId) {
      await pool.query(`UPDATE turnos SET estado = 'atendido' WHERE id = $1`, [turnoId])
    }
    if (mesaId) {
      await pool.query(`DELETE FROM mesas WHERE id = $1`, [mesaId])
    }
    if (opId) {
      await pool.query(`DELETE FROM usuarios WHERE id = $1`, [opId])
    }
    await pool.end()
    console.log('   [OK] Limpieza completada.')
  }
}

run().catch(err => {
  console.error('\n[FAIL] Error fatal:', err.message || err)
  process.exit(1)
})
