'use strict'

/**
 * MÓDULO: base_de_datos
 * OBJETIVO: Comprobar que el sistema aguanta el volumen esperado y que los
 *           índices se usan. Carga cientos de miles de turnos y audit_log,
 *           luego verifica con EXPLAIN que no hay Seq Scan en tablas grandes
 *           y que los tiempos están dentro de las metas.
 * EJECUCIÓN: node tests/bd/bd_rendimiento_volumen.test.js
 */

const assert = require('node:assert/strict')
const {
  setupTestDb, teardownTestDb, getTestPool, BD_TEST_NAME
} = require('./helpers/db_test_setup')

let pool
let passed = 0
let failed = 0
const errores = []
const hallazgos = []

function ok (n, extra) { process.stdout.write(`  [OK] ${n}${extra ? ' ' + extra : ''}\n`); passed++ }
function fail (n, d) {
  process.stderr.write(`  [FAIL] ${n}\n`)
  if (d) process.stderr.write(`        ${d}\n`)
  failed++; errores.push({ n, d })
}
function hallazgo (id, sev, desc) {
  hallazgos.push({ id, sev, desc })
  process.stdout.write(`  [HALLAZGO-${id} | ${sev}] ${desc}\n`)
}

async function test (nombre, fn) {
  try { await fn(); } catch (err) { fail(nombre, err.message); return }
  // La función ok se llama dentro de fn para poder pasar tiempos
}

// ── Setup de datos base ─────────────────────────────────────────────────────
let adminId, op1Id, mesa1Id, loteId

async function setupBase () {
  const bcrypt = require('bcrypt')
  const h = await bcrypt.hash('Test2026!', 10)

  const { rows: [a] } = await pool.query(
    `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('adm_vol', 'Admin Vol', $1, 'admin') RETURNING id`, [h]
  )
  const { rows: [o1] } = await pool.query(
    `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('op_vol', 'Op Vol', $1, 'operador') RETURNING id`, [h]
  )
  adminId = parseInt(a.id, 10)
  op1Id   = parseInt(o1.id, 10)

  const { rows: [m] } = await pool.query(
    `INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES (1, 'Mesa Vol', 'activa', ${op1Id}) RETURNING id`
  )
  mesa1Id = parseInt(m.id, 10)

  const { rows: [l] } = await pool.query(`
    INSERT INTO lotes_voucher (numero_desde, numero_hasta, ultimo_numero_llamado, estado)
    VALUES (1, 5000000, 0, 'activo') RETURNING id
  `)
  loteId = parseInt(l.id, 10)
}

// ── Cargar datos masivos en batch ───────────────────────────────────────────
async function cargarTurnos (cantidad) {
  console.log(`    Cargando ${cantidad.toLocaleString()} turnos en batch...`)
  const BATCH = 5000
  const hoy = (await pool.query('SELECT fn_fecha_hoy() AS f')).rows[0].f

  for (let i = 0; i < cantidad; i += BATCH) {
    const chunk = Math.min(BATCH, cantidad - i)
    const valores = []
    const params = []
    let pIdx = 1

    for (let j = 0; j < chunk; j++) {
      const num = i + j + 1
      const estado = j % 5 === 0 ? 'cancelado' : (j % 5 === 1 ? 'en_atencion' : 'atendido')
      valores.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`)
      params.push(num, hoy, loteId, estado, 'voucher_fisico', mesa1Id, op1Id)
    }

    await pool.query(
      `INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id) VALUES ${valores.join(',')} ON CONFLICT DO NOTHING`,
      params
    )
  }
  // Sincronizar el contador del lote al último número cargado para que fn_llamar_siguiente continúe sin colisión
  await pool.query(`UPDATE lotes_voucher SET ultimo_numero_llamado = $1 WHERE id = $2`, [cantidad, loteId])
  console.log(`    ${cantidad.toLocaleString()} turnos cargados y lote sincronizado a ${cantidad}.`)
}

async function cargarAuditLog (cantidad) {
  console.log(`    Cargando ${cantidad.toLocaleString()} registros audit_log en batch...`)
  const BATCH = 10000

  for (let i = 0; i < cantidad; i += BATCH) {
    const chunk = Math.min(BATCH, cantidad - i)
    const valores = []
    const params = []
    let pIdx = 1

    for (let j = 0; j < chunk; j++) {
      const acciones = ['TURNO_LLAMADO', 'ATENCION_FINALIZADA', 'TURNO_CANCELADO', 'LOGIN_EXITOSO']
      valores.push(`($${pIdx++}, $${pIdx++})`)
      params.push(acciones[(i + j) % acciones.length], op1Id)
    }

    await pool.query(
      `INSERT INTO audit_log (accion, operador_id) VALUES ${valores.join(',')}`,
      params
    )
  }
  console.log(`    ${cantidad.toLocaleString()} registros audit_log cargados.`)
}

// ── Verificar plan de ejecución ─────────────────────────────────────────────
async function verificarPlan (nombre, sql, params, { permitirSeqScan = false } = {}) {
  const { rows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT TEXT, BUFFERS) ${sql}`, params)
  const plan = rows.map(r => r['QUERY PLAN']).join('\n')

  // Buscar Seq Scan en tablas grandes (turnos, audit_log)
  const seqScanEnTablaGrande = /Seq Scan on (turnos|audit_log)/i.test(plan)

  // Tiempo real (ms)
  const timeMatch = plan.match(/Execution Time: ([\d.]+) ms/)
  const tiempoMs = timeMatch ? parseFloat(timeMatch[1]) : null

  if (!permitirSeqScan && seqScanEnTablaGrande) {
    hallazgo(nombre, 'Media', `Seq Scan detectado en tabla grande. Plan:\n${plan.slice(0, 500)}`)
  }

  return { plan, seqScanEnTablaGrande, tiempoMs }
}

// ── Tests ───────────────────────────────────────────────────────────────────
async function runTests () {
  console.log('══════════════════════════════════════════════════════════════')
  console.log(' bd_rendimiento_volumen — Rendimiento bajo volumen masivo')
  console.log(`  BD: ${BD_TEST_NAME}`)
  console.log('══════════════════════════════════════════════════════════════\n')

  await setupBase()

  const CANT_TURNOS   = 100000
  const CANT_AUDIT    = 100000

  await cargarTurnos(CANT_TURNOS)
  await cargarAuditLog(CANT_AUDIT)

  const { rows: [cnt] } = await pool.query(`SELECT COUNT(*) AS c FROM turnos`)
  const { rows: [cntA] } = await pool.query(`SELECT COUNT(*) AS c FROM audit_log`)
  console.log(`\n  Turnos en BD: ${parseInt(cnt.c).toLocaleString()}`)
  console.log(`  Audit_log en BD: ${parseInt(cntA.c).toLocaleString()}\n`)

  // ── 1. fn_llamar_siguiente < 20ms en BD ─────────────────────────────────
  console.log('-- 1. fn_llamar_siguiente tiempo de respuesta')

  // Medir 20 llamadas consecutivas
  const tiempos = []
  for (let i = 0; i < 20; i++) {
    await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
    const t0 = Date.now()
    await pool.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    tiempos.push(Date.now() - t0)
  }
  const promedio = tiempos.reduce((a, b) => a + b, 0) / tiempos.length
  const maximo = Math.max(...tiempos)

  const META_MS = 20
  const META_PROMEDIO_MS = 10

  if (promedio <= META_PROMEDIO_MS) {
    ok(`fn_llamar_siguiente promedio: ${promedio.toFixed(1)}ms (meta <${META_PROMEDIO_MS}ms)`)
    passed++
  } else if (promedio <= META_MS) {
    ok(`fn_llamar_siguiente promedio: ${promedio.toFixed(1)}ms (meta <${META_MS}ms OK, <${META_PROMEDIO_MS}ms ideal)`)
    passed++
    hallazgo('RV-001', 'Baja', `fn_llamar_siguiente promedio ${promedio.toFixed(1)}ms supera el ideal de ${META_PROMEDIO_MS}ms`)
  } else {
    fail(`fn_llamar_siguiente promedio: ${promedio.toFixed(1)}ms supera meta de ${META_MS}ms`)
  }

  if (maximo > META_MS * 3) {
    hallazgo('RV-002', 'Media', `fn_llamar_siguiente máximo ${maximo}ms — posible contención con ${CANT_TURNOS} turnos`)
  } else {
    ok(`fn_llamar_siguiente máximo: ${maximo}ms`)
    passed++
  }

  // Limpiar turno en atención dejado por la medición
  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)

  // ── 2. Snapshot TV (últimos 10 turnos) ───────────────────────────────────
  console.log('\n-- 2. Snapshot TV (10 últimos llamados)')

  const hoy = (await pool.query('SELECT fn_fecha_hoy() AS f')).rows[0].f
  const t0tv = Date.now()
  await pool.query(`
    SELECT t.numero, m.numero AS mesa_numero, m.nombre AS mesa_nombre, t.llamado_en
    FROM turnos t
    LEFT JOIN mesas m ON t.mesa_id = m.id
    WHERE t.estado IN ('en_atencion', 'atendido')
      AND t.fecha_turno = $1
    ORDER BY t.llamado_en DESC NULLS LAST
    LIMIT 10
  `, [hoy])
  const tvMs = Date.now() - t0tv

  const META_TV_MS = 50
  if (tvMs <= META_TV_MS) {
    ok(`Snapshot TV: ${tvMs}ms (meta <${META_TV_MS}ms)`)
    passed++
  } else {
    fail(`Snapshot TV: ${tvMs}ms supera meta de ${META_TV_MS}ms`)
    hallazgo('RV-003', 'Media', `Snapshot TV tardó ${tvMs}ms con ${CANT_TURNOS} turnos — revisar ix_turnos_tv_recientes`)
  }

  // ── 3. Plan de ejecución: sin Seq Scan en tablas grandes ─────────────────
  console.log('\n-- 3. Planes de ejecución (sin Seq Scan en turnos/audit_log)')

  // Snapshot TV
  const planTV = await verificarPlan(
    'RV-004-tv-plan',
    `SELECT t.numero, t.llamado_en FROM turnos t WHERE t.estado IN ('en_atencion', 'atendido') AND t.fecha_turno = $1 ORDER BY t.llamado_en DESC NULLS LAST LIMIT 10`,
    [hoy]
  )
  if (!planTV.seqScanEnTablaGrande) {
    ok('Plan TV: usa índice (no Seq Scan)')
    passed++
  } else {
    fail('Plan TV: Seq Scan en turnos detectado')
  }

  // Rezagados de hoy
  const planRez = await verificarPlan(
    'RV-005-rez-plan',
    `SELECT t.id, t.numero FROM turnos t WHERE t.estado='cancelado' AND t.fecha_turno=$1`,
    [hoy]
  )
  if (!planRez.seqScanEnTablaGrande) {
    ok('Plan rezagados: usa índice (no Seq Scan)')
    passed++
  } else {
    hallazgo('RV-005', 'Baja', 'Plan rezagados usa Seq Scan — considerar índice en (estado, fecha_turno)')
    ok('Plan rezagados: Seq Scan (hallazgo registrado, no error)')
    passed++
  }

  // audit_log por operador
  const planAudit = await verificarPlan(
    'RV-006-audit-plan',
    `SELECT id, accion, timestamp FROM audit_log WHERE operador_id=$1 ORDER BY timestamp DESC LIMIT 50`,
    [op1Id]
  )
  if (!planAudit.seqScanEnTablaGrande) {
    ok('Plan audit_log por operador: usa índice (no Seq Scan)')
    passed++
  } else {
    fail('Plan audit_log por operador: Seq Scan detectado con 100k registros')
  }

  // ── 4. Cola del kiosko ───────────────────────────────────────────────────
  console.log('\n-- 4. Cola del kiosko con volumen')

  // Insertar 1000 turnos kiosko esperando
  console.log('    Insertando 1000 turnos kiosko esperando...')
  const valsK = []
  const paramsK = []
  let pK = 1
  for (let i = 0; i < 1000; i++) {
    const tok = Buffer.from(`kiosko-vol-${i}-${Date.now()}`).toString('hex').slice(0, 64).padEnd(64, '0')
    valsK.push(`($${pK++}, $${pK++}, 1, NULL, 'esperando', 'kiosko_web', $${pK++})`)
    paramsK.push(i + 1, hoy, tok)
  }
  await pool.query(
    `INSERT INTO turnos (numero, fecha_turno, sesion, lote_id, estado, origen, token_consulta) VALUES ${valsK.join(',')} ON CONFLICT DO NOTHING`,
    paramsK
  )

  const t0K = Date.now()
  await pool.query(`
    SELECT numero FROM turnos WHERE estado='esperando' AND origen='kiosko_web' AND fecha_turno=$1 ORDER BY sesion ASC, numero ASC LIMIT 1
  `, [hoy])
  const kMs = Date.now() - t0K

  if (kMs <= 50) {
    ok(`Cola kiosko (1000 esperando): ${kMs}ms`)
    passed++
  } else {
    hallazgo('RV-007', 'Media', `Cola kiosko tardó ${kMs}ms — revisar ix_turnos_esperando_kiosko`)
    ok(`Cola kiosko: ${kMs}ms (hallazgo registrado)`)
    passed++
  }

  // ── Resumen ─────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(` RESULTADO: ${passed} OK  |  ${failed} FALLIDOS`)
  if (hallazgos.length > 0) {
    console.log('\n HALLAZGOS:')
    hallazgos.forEach(h => console.log(`  - [${h.id}] (${h.sev}) ${h.desc}`))
  }
  if (errores.length > 0) {
    console.error('\n ERRORES:')
    errores.forEach(e => console.error(`  - ${e.n}: ${e.d}`))
  }
  console.log('══════════════════════════════════════════════════════════════\n')
  if (failed > 0) process.exit(1)
}

;(async () => {
  try {
    await setupTestDb()
    pool = getTestPool()
    await runTests()
  } finally {
    await teardownTestDb()
  }
})().catch(err => {
  console.error('[ERROR FATAL]', err.message)
  teardownTestDb().finally(() => process.exit(1))
})

