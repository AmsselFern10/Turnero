/**
 * MÓDULO: panel_mesa
 * OBJETIVO: Simular 10 operadores ejecutando "Llamar siguiente" simultáneamente,
 *           en el mismo milisegundo. Verificar que ningún turno se entrega duplicado
 *           a dos operadores distintos y que la base de datos mantiene la consistencia,
 *           sin bloqueos ni errores.
 * EJECUCIÓN: node tests/mesa_concurrencia_race_condition.test.js
 */

'use strict'

const crypto = require('crypto')
require('dotenv').config()
const { Pool } = require('pg')
const bcrypt = require('bcrypt')

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE = process.env.APP_URL || `http://localhost:${PORT}`

// ── Prefijos únicos para aislar los datos de este test ───────────────────────
const RUN_ID     = crypto.randomBytes(4).toString('hex')
const USERNAME   = (i) => `op_race_${RUN_ID}_${i}`
const MESA_NUM   = (i) => 8000 + parseInt(RUN_ID, 16) % 100 * 10 + i
const N          = 10   // Número de operadores/mesas concurrentes
const LOTE_CAP   = 5000 // Vouchers extra a garantizar en el lote activo

async function test () {
  const connectionString = process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  const pool = new Pool({ connectionString })

  let opIds   = []
  let mesaIds = []
  let turnosIds = []

  console.log('======================================================================')
  console.log(' CONCURRENCIA ATÓMICA — 10 OPERADORES SIMULTÁNEOS (RACE CONDITION)')
  console.log('======================================================================\n')
  console.log(`[RUN ID: ${RUN_ID}]`)

  try {
    // ── PASO 1: Verificar lote activo con suficientes vouchers ────────────────
    console.log('\n[1/6] Verificando lote activo con vouchers suficientes...')
    const { rows: [lote] } = await pool.query(
      `SELECT id, ultimo_numero_llamado, numero_hasta
       FROM lotes_voucher WHERE estado = 'activo'
       ORDER BY id DESC LIMIT 1`
    )
    if (!lote) {
      throw new Error('No hay lote activo. Activa uno desde el panel admin antes de correr este test.')
    }
    // Ampliar el lote para garantizar N vouchers disponibles
    const nuevoHasta = (lote.ultimo_numero_llamado || 0) + LOTE_CAP
    await pool.query(
      `UPDATE lotes_voucher SET numero_hasta = GREATEST(numero_hasta, $1) WHERE id = $2`,
      [nuevoHasta, lote.id]
    )
    console.log(`   [OK] Lote activo id=${lote.id} — vouchers garantizados hasta ${nuevoHasta}`)

    // ── PASO 2: Crear 10 operadores de prueba ─────────────────────────────────
    console.log('\n[2/6] Creando 10 operadores de prueba temporales...')
    const passHash = await bcrypt.hash('RaceTest_2026!', 10)
    for (let i = 1; i <= N; i++) {
      const { rows: [u] } = await pool.query(
        `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
         VALUES ($1, $2, 'operador', $3, true)
         RETURNING id`,
        [USERNAME(i), passHash, `Race Operador ${i} [${RUN_ID}]`]
      )
      opIds.push(u.id)
    }
    console.log(`   [OK] ${N} operadores creados: ${opIds.map(id => id).join(', ')}`)

    // ── PASO 3: Crear 10 mesas y asignar un operador a cada una ──────────────
    console.log('\n[3/6] Creando 10 mesas y asignando operadores...')
    for (let i = 0; i < N; i++) {
      const num = MESA_NUM(i + 1)
      // Si el número ya existe como mesa eliminada o activa, lo reutilizamos
      const { rows: [m] } = await pool.query(
        `INSERT INTO mesas (numero, nombre, estado, operador_id)
         VALUES ($1, $2, 'activa', $3)
         ON CONFLICT (numero) WHERE estado != 'eliminada' AND eliminado_en IS NULL
         DO UPDATE SET estado = 'activa', operador_id = $3, nombre = $2
         RETURNING id`,
        [num, `Mesa Race ${num} [${RUN_ID}]`, opIds[i]]
      )
      mesaIds.push(m.id)
      console.log(`   Mesa #${num} (id=${m.id}) → ${USERNAME(i + 1)}`)
    }

    // ── PASO 4: Login de los 10 operadores ───────────────────────────────────
    console.log('\n[4/6] Autenticando 10 operadores simultáneamente...')
    const loginResults = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        fetch(`${BASE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: USERNAME(i + 1), password: 'RaceTest_2026!' })
        }).then(r => r.json()).then(data => ({ i, data }))
      )
    )

    const tokens = loginResults.map(({ data }) => data.token).filter(Boolean)
    if (tokens.length < N) {
      throw new Error(`Solo ${tokens.length}/${N} operadores pudieron autenticarse. Comprueba el servidor.`)
    }
    console.log(`   [OK] ${tokens.length}/${N} operadores autenticados`)

    // ── PASO 5: Disparar los N operadores EXACTAMENTE al mismo tiempo ─────────
    console.log(`\n[5/6] Disparando ${N} llamadas a /turnos/llamar SIMULTÁNEAMENTE...`)
    const t0 = Date.now()

    const resultados = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        fetch(`${BASE}/turnos/llamar`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${tokens[i]}`,
            'Idempotency-Key': crypto.randomUUID()
          },
          body: JSON.stringify({ mesa_id: mesaIds[i] })
        })
          .then(r => r.json())
          .then(data => ({ mesaIdx: i + 1, mesaId: mesaIds[i], data }))
      )
    )

    const dt = Date.now() - t0
    console.log(`   Todas las respuestas recibidas en ${dt} ms\n`)

    // ── PASO 6: Verificar resultados ──────────────────────────────────────────
    console.log('[6/6] Evaluando resultados...')
    let passed = 0
    let failed = 0

    const exitosos = resultados.filter(r => r.data.turno)
    const errores  = resultados.filter(r => !r.data.turno)

    for (const r of resultados) {
      if (r.data.turno) {
        console.log(`   Mesa ${r.mesaIdx}: turno=#${r.data.turno.numero}`)
        turnosIds.push(r.data.turno.id)
      } else {
        console.error(`   Mesa ${r.mesaIdx}: ERROR = ${JSON.stringify(r.data)}`)
      }
    }

    // Evaluación 1: Todos los operadores obtuvieron un turno
    const todosExitosos = exitosos.length === N
    if (todosExitosos) {
      console.log(`\n   [PASS] Todos los ${N} operadores obtuvieron un turno`)
      passed++
    } else {
      console.error(`\n   [FAIL] Solo ${exitosos.length}/${N} operadores obtuvieron turno. Errores: ${errores.length}`)
      failed++
    }

    // Evaluación 2: Ningún número duplicado
    const nums  = exitosos.map(r => r.data.turno.numero)
    const uniq  = new Set(nums)
    if (uniq.size === nums.length) {
      console.log(`   [PASS] Sin duplicados: ${nums.sort((a, b) => a - b).join(', ')}`)
      passed++
    } else {
      const dups = nums.filter((n, i) => nums.indexOf(n) !== i)
      console.error(`   [FAIL] DUPLICADOS DETECTADOS: ${dups.join(', ')} — violación de atomicidad`)
      failed++
    }

    // Evaluación 3: Los números son consecutivos (sin saltos)
    const sorted = nums.slice().sort((a, b) => a - b)
    const consecutivos = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1)
    if (consecutivos) {
      console.log(`   [PASS] Números consecutivos sin saltos`)
      passed++
    } else {
      console.error(`   [FAIL] Saltos en la secuencia: ${sorted.join(', ')}`)
      failed++
    }

    // Evaluación 4: Verificar en BD que cada mesa tiene exactamente 1 turno en_atencion
    let mesasConInvariante = 0
    for (const mesaId of mesaIds) {
      const { rows } = await pool.query(
        `SELECT COUNT(*) FROM turnos WHERE mesa_id = $1 AND estado = 'en_atencion'`,
        [mesaId]
      )
      if (parseInt(rows[0].count) <= 1) mesasConInvariante++
    }
    if (mesasConInvariante === N) {
      console.log(`   [PASS] Invariante BD: cada mesa tiene ≤ 1 turno en_atencion`)
      passed++
    } else {
      console.error(`   [FAIL] ${N - mesasConInvariante} mesas violaron el invariante (más de 1 turno en_atencion)`)
      failed++
    }

    // Evaluación 5: Tiempo total < 5 segundos (sin bloqueos)
    if (dt < 5000) {
      console.log(`   [PASS] Tiempo total ${dt}ms < 5000ms — sin deadlocks ni bloqueos prolongados`)
      passed++
    } else {
      console.error(`   [FAIL] Tiempo total ${dt}ms ≥ 5000ms — posible deadlock o contención excesiva`)
      failed++
    }

    console.log('\n======================================================================')
    console.log(`RESULTADO: ${passed} PASADOS | ${failed} FALLADOS`)
    console.log('======================================================================')

    if (failed > 0) process.exit(1)

  } finally {
    // ── LIMPIEZA: siempre, aunque haya errores ────────────────────────────────
    console.log('\nLimpiando datos de prueba...')
    if (turnosIds.length > 0) {
      await pool.query(`UPDATE turnos SET estado = 'atendido' WHERE id = ANY($1)`, [turnosIds])
    }
    if (mesaIds.length > 0) {
      await pool.query(`UPDATE mesas SET operador_id = NULL, estado = 'inactiva' WHERE id = ANY($1)`, [mesaIds])
      await pool.query(`DELETE FROM mesas WHERE id = ANY($1)`, [mesaIds])
    }
    if (opIds.length > 0) {
      await pool.query(`DELETE FROM usuarios WHERE id = ANY($1)`, [opIds])
    }
    await pool.end()
    console.log('   [OK] Datos de prueba eliminados.')
  }
}

test().catch(err => {
  console.error('\n[FAIL] Error fatal:', err.message || err)
  process.exit(1)
})
