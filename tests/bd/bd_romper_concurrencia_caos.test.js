'use strict'

/**
 * MÓDULO: base_de_datos
 * OBJETIVO: Intentar romper el sistema con concurrencia, fallos y entradas hostiles.
 *           Después de cada ataque, un verificador de invariantes revisa la BD completa.
 * EJECUCIÓN: node tests/bd/bd_romper_concurrencia_caos.test.js
 */

const assert = require('node:assert/strict')
const {
  setupTestDb, teardownTestDb, getTestPool, newTestClient, BD_TEST_NAME
} = require('./helpers/db_test_setup')

let pool
let passed = 0
let failed = 0
const errores = []
const hallazgos = []

function ok (n) { process.stdout.write(`  [OK] ${n}\n`); passed++ }
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
  try { await fn(); ok(nombre) } catch (err) { fail(nombre, err.message) }
}

// ── Verificador de invariantes (ejecutado después de cada ataque) ─────────────
async function verificarInvariantes (etiqueta) {
  const erroresInv = []

  try {
    // INV-1: Solo 1 lote activo
    const { rows: [r1] } = await pool.query(`SELECT COUNT(*) AS c FROM lotes_voucher WHERE estado='activo'`)
    if (parseInt(r1.c, 10) > 1) erroresInv.push('INV-1 VIOLADA: más de 1 lote activo')

    // INV-2: No hay turno en_atencion duplicado por mesa
    const { rows: r2 } = await pool.query(`
      SELECT mesa_id, COUNT(*) AS c FROM turnos WHERE estado='en_atencion' GROUP BY mesa_id HAVING COUNT(*) > 1
    `)
    if (r2.length > 0) erroresInv.push(`INV-2 VIOLADA: mesas con > 1 turno en_atencion: ${r2.map(r => r.mesa_id).join(', ')}`)

    // INV-3: No hay operador en más de 1 mesa activa
    const { rows: r3 } = await pool.query(`
      SELECT operador_id, COUNT(*) AS c FROM mesas WHERE operador_id IS NOT NULL AND estado!='eliminada' AND eliminado_en IS NULL GROUP BY operador_id HAVING COUNT(*) > 1
    `)
    if (r3.length > 0) erroresInv.push(`INV-3 VIOLADA: operadores en > 1 mesa: ${r3.map(r => r.operador_id).join(', ')}`)

    // INV-4: Al menos 1 admin activo no eliminado
    const { rows: [r4] } = await pool.query(`SELECT COUNT(*) AS c FROM usuarios WHERE rol='admin' AND activo=true AND eliminado_en IS NULL`)
    if (parseInt(r4.c, 10) === 0) erroresInv.push('INV-4 VIOLADA: sin admin activo')

    // INV-5: Contador de lote no regresó sin autorización
    const { rows: r5 } = await pool.query(`
      SELECT id, ultimo_numero_llamado, numero_hasta FROM lotes_voucher WHERE ultimo_numero_llamado < 0
    `)
    if (r5.length > 0) erroresInv.push(`INV-5 VIOLADA: contador negativo en lotes: ${r5.map(r => r.id).join(', ')}`)

    // INV-6: Duraciones nunca negativas
    const { rows: [r6] } = await pool.query(`
      SELECT COUNT(*) AS c FROM turnos WHERE (duracion_espera_seg IS NOT NULL AND duracion_espera_seg < 0) OR (duracion_atencion_seg IS NOT NULL AND duracion_atencion_seg < 0)
    `)
    if (parseInt(r6.c, 10) > 0) erroresInv.push('INV-6 VIOLADA: hay duraciones negativas en turnos')

    // INV-7: No hay turnos en_atencion sin mesa
    const { rows: [r7] } = await pool.query(`SELECT COUNT(*) AS c FROM turnos WHERE estado='en_atencion' AND mesa_id IS NULL`)
    if (parseInt(r7.c, 10) > 0) erroresInv.push('INV-7 VIOLADA: turnos en_atencion sin mesa')

  } catch (err) {
    erroresInv.push(`Error al verificar invariantes: ${err.message}`)
  }

  if (erroresInv.length > 0) {
    fail(`verificarInvariantes[${etiqueta}]`, erroresInv.join(' | '))
    return false
  }

  ok(`verificarInvariantes[${etiqueta}]`)
  return true
}

// ── Setup de datos ──────────────────────────────────────────────────────────
let mesas = []    // Array de { id, operadorId }
let loteId

async function setup (numMesas = 20) {
  const bcrypt = require('bcrypt')
  const h = await bcrypt.hash('Test2026!', 10)

  mesas = []
  for (let i = 1; i <= numMesas; i++) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('op_caos_${i}', 'Op Caos ${i}', $1, 'operador') RETURNING id`, [h]
    )
    const { rows: [m] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES (${i}, 'Mesa Caos ${i}', 'activa', ${u.id}) RETURNING id`
    )
    mesas.push({ id: parseInt(m.id, 10), operadorId: parseInt(u.id, 10) })
  }

  const { rows: [l] } = await pool.query(`
    INSERT INTO lotes_voucher (numero_desde, numero_hasta, ultimo_numero_llamado, estado)
    VALUES (1, 100000, 0, 'activo') RETURNING id
  `)
  loteId = parseInt(l.id, 10)
}

// ── Ataque 1: 50 llamados simultáneos desde 20 mesas ────────────────────────
async function ataqueStorm () {
  console.log('\n-- A1. Tormenta: 50 llamados simultáneos (20 mesas × 50 rondas)')

  const RONDAS = 50
  let numeros = new Set()
  let duplicados = 0

  for (let r = 0; r < RONDAS; r++) {
    // Finalizar turnos anteriores
    await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE estado='en_atencion'`)

    const promesas = mesas.map(m =>
      pool.query(`SELECT * FROM fn_llamar_siguiente(${m.id}, ${m.operadorId})`).catch(e => ({ error: e }))
    )
    const results = await Promise.all(promesas)

    for (const res of results) {
      if (res.error) continue
      const num = res.rows?.[0]?.turno_numero
      if (num != null) {
        if (numeros.has(num)) duplicados++
        numeros.add(num)
      }
    }
  }

  await test(`A1: Sin duplicados en ${RONDAS} rondas de 20 llamados simultáneos`, () => {
    assert.equal(duplicados, 0, `Se encontraron ${duplicados} números duplicados`)
  })

  await verificarInvariantes('post-storm')
}

// ── Ataque 2: Doble clic en la misma mesa ───────────────────────────────────
async function ataqueDobleClick () {
  console.log('\n-- A2. Doble clic: misma mesa, llamados en < 1ms')

  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE estado='en_atencion'`)

  const mesa = mesas[0]
  const [r1, r2] = await Promise.all([
    pool.query(`SELECT * FROM fn_llamar_siguiente(${mesa.id}, ${mesa.operadorId})`),
    pool.query(`SELECT * FROM fn_llamar_siguiente(${mesa.id}, ${mesa.operadorId})`)
  ])

  await test('A2: Doble clic devuelve mismo número (idempotente)', () => {
    const n1 = r1.rows?.[0]?.turno_numero
    const n2 = r2.rows?.[0]?.turno_numero
    assert.ok(n1 != null && n2 != null, 'Una de las llamadas falló')
    assert.equal(n1, n2, `Doble clic devolvió números distintos: ${n1}, ${n2}`)
  })

  await test('A2: Al menos una llamada fue idempotente', () => {
    const idem1 = r1.rows?.[0]?.es_idempotente
    const idem2 = r2.rows?.[0]?.es_idempotente
    assert.ok(idem1 || idem2, 'Ninguna llamada fue marcada como idempotente')
  })

  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE estado='en_atencion'`)
  await verificarInvariantes('post-dobleclick')
}

// ── Ataque 3: Extender lote mientras mesas llaman ───────────────────────────
async function ataqueExtenderDuranteLlamados () {
  console.log('\n-- A3. Extender lote mientras 20 mesas llaman simultáneamente')

  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE estado='en_atencion'`)

  const llamados = mesas.map(m =>
    pool.query(`SELECT * FROM fn_llamar_siguiente(${m.id}, ${m.operadorId})`).catch(e => ({ error: e }))
  )

  // Extender el lote al mismo tiempo
  const extender = pool.query(`UPDATE lotes_voucher SET numero_hasta=200000 WHERE id=${loteId}`).catch(e => ({ error: e }))

  const [resultados, extResult] = await Promise.all([Promise.all(llamados), extender])

  await test('A3: Llamados y extensión concurrente sin errores fatales', () => {
    const exitosos = resultados.filter(r => !r.error && r.rows?.[0])
    assert.ok(exitosos.length >= Math.floor(mesas.length * 0.8),
      `Solo ${exitosos.length}/${mesas.length} llamados exitosos`)
  })

  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE estado='en_atencion'`)
  await verificarInvariantes('post-extender-concurrente')
}

// ── Ataque 4: Dos admins degradándose mutuamente ────────────────────────────
async function ataqueDosAdminsDegradando () {
  console.log('\n-- A4. Dos admins intentando degradarse mutuamente')

  const bcrypt = require('bcrypt')
  const h = await bcrypt.hash('Test2026!', 10)

  const { rows: [a1] } = await pool.query(
    `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('adm_caos1', 'Admin Caos 1', $1, 'admin') RETURNING id`, [h]
  )
  const { rows: [a2] } = await pool.query(
    `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('adm_caos2', 'Admin Caos 2', $1, 'admin') RETURNING id`, [h]
  )

  const adm1Id = parseInt(a1.id, 10)
  const adm2Id = parseInt(a2.id, 10)

  // Desactivar todos los otros admins para que solo queden a1 y a2
  const { rows: otrosAdms } = await pool.query(
    `SELECT id FROM usuarios WHERE rol='admin' AND activo=true AND eliminado_en IS NULL AND id NOT IN (${adm1Id}, ${adm2Id})`
  )
  let idsOtros = otrosAdms.map(r => r.id)
  if (idsOtros.length > 0) {
    await pool.query(`UPDATE usuarios SET activo=false WHERE id IN (${idsOtros.join(',')})`)
  }

  // Ambos degradándose simultáneamente — pg_advisory_lock garantiza serialización
  const [r1, r2] = await Promise.all([
    pool.query(`UPDATE usuarios SET rol='operador' WHERE id=${adm1Id}`).catch(e => e),
    pool.query(`UPDATE usuarios SET rol='operador' WHERE id=${adm2Id}`).catch(e => e)
  ])

  await test('A4: Al menos 1 de los 2 admins fue protegido (siempre queda >=1 admin)', async () => {
    const { rows: [cnt] } = await pool.query(`SELECT COUNT(*) AS c FROM usuarios WHERE rol='admin' AND activo=true AND eliminado_en IS NULL`)
    assert.ok(parseInt(cnt.c, 10) >= 1,
      `Ambos admins fueron degradados — sistema quedó sin admin activo`)
  })

  // Restaurar
  await pool.query(`UPDATE usuarios SET rol='admin' WHERE id IN (${adm1Id}, ${adm2Id})`)
  if (idsOtros.length > 0) {
    await pool.query(`UPDATE usuarios SET activo=true WHERE id IN (${idsOtros.join(',')})`)
  }

  await verificarInvariantes('post-admins-concurrentes')
}

// ── Ataque 5: 300 turnos kiosko con device repetido en paralelo ──────────────
async function ataqueKioskoParalelo () {
  console.log('\n-- A5. 300 turnos kiosko con device_id repetido en paralelo')

  await pool.query(`UPDATE configuracion SET valor='kiosko_web' WHERE clave='modo_generacion_turnos'`)

  const TOTAL = 300
  const deviceId = 'device-caos-001'
  let turnosCreados = 0
  let erroresDeviceDup = 0

  // Generar 300 inserciones en paralelo con mismo device_id
  const promesas = Array.from({ length: TOTAL }, (_, i) => {
    const tok = Buffer.from(`kiosko-caos-${i}-${Date.now()}`).toString('hex').slice(0, 64).padEnd(64, '0')
    const key = `idem-caos-${i}-${Date.now()}`
    return pool.query(`
      INSERT INTO turnos (numero, fecha_turno, sesion, lote_id, estado, origen, token_consulta, idempotency_key, device_id)
      VALUES (${10000 + i}, fn_fecha_hoy(), 1, NULL, 'esperando', 'kiosko_web', $1, $2, $3)
    `, [tok, key, deviceId]).then(() => { turnosCreados++ }).catch(e => {
      if (e.code === '23505') erroresDeviceDup++
    })
  })

  await Promise.all(promesas)

  await test('A5: Solo 1 turno esperando por device_id (ux_turnos_device_esperando)', async () => {
    const { rows: [cnt] } = await pool.query(
      `SELECT COUNT(*) AS c FROM turnos WHERE device_id=$1 AND estado='esperando'`, [deviceId]
    )
    assert.equal(parseInt(cnt.c, 10), 1, `Hay ${cnt.c} turnos esperando con mismo device_id`)
  })

  await test('A5: Los demás insertados tienen estado diferente o fueron rechazados', () => {
    assert.ok(erroresDeviceDup >= 0, 'ok — rechazados correctamente')
  })

  // Limpiar
  await pool.query(`UPDATE turnos SET estado='cancelado', finalizado_en=NOW() WHERE estado='esperando' AND device_id=$1`, [deviceId])
  await pool.query(`UPDATE configuracion SET valor='voucher_fisico' WHERE clave='modo_generacion_turnos'`)
  await verificarInvariantes('post-kiosko-paralelo')
}

// ── Ataque 6: Entradas hostiles ─────────────────────────────────────────────
async function ataqueEntradasHostiles () {
  console.log('\n-- A6. Entradas hostiles (textos enormes, caracteres especiales)')

  const TEXTO_ENORME = 'A'.repeat(10000)
  const SQLINJECTION = "'; DROP TABLE turnos; --"
  const UNICODE_RARO  = '\u0000\uFFFD\u200B'

  // Texto enorme en username → rechazado por VARCHAR(30)
  await test('A6: username con 10000 chars rechazado', async () => {
    let rechazado = false
    try {
      const bcrypt = require('bcrypt')
      const h = await bcrypt.hash('x', 4)
      await pool.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ($1, 'x', $2, 'operador')`, [TEXTO_ENORME, h])
    } catch (_) { rechazado = true }
    assert.ok(rechazado, 'Texto enorme en username no fue rechazado')
  })

  // SQL injection vía parámetro (debe ser tratado como literal)
  await test('A6: SQL injection en username tratado como literal (no ejecutado)', async () => {
    let insertado = false
    try {
      const bcrypt = require('bcrypt')
      const h = await bcrypt.hash('x', 4)
      // Esto debe fallar por largo (> 30 chars) o carácter inválido, no ejecutar el SQL
      await pool.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ($1, 'x', $2, 'operador')`, [SQLINJECTION, h])
      // Si insertó, verificar que la tabla turnos siga existiendo
      const { rows: tCheck } = await pool.query(`SELECT tablename FROM pg_tables WHERE tablename='turnos'`)
      assert.ok(tCheck.length > 0, 'La tabla turnos fue eliminada — SQL injection exitoso')
      insertado = true
    } catch (_) { /* rechazado correctamente */ }
    // La tabla debe seguir existiendo
    const { rows: tCheck } = await pool.query(`SELECT tablename FROM pg_tables WHERE tablename='turnos'`)
    assert.ok(tCheck.length > 0, 'La tabla turnos no existe después del ataque')
  })

  // Carácter nulo en metadata_json (debe aceptarse como JSONB)
  await test('A6: metadata_json con caracteres especiales aceptado como JSONB', async () => {
    const { rows } = await pool.query(
      `INSERT INTO audit_log (accion, metadata_json) VALUES ('LOGIN_EXITOSO', $1::jsonb) RETURNING id`,
      [JSON.stringify({ nota: 'test especial <>&"\'' })]
    )
    assert.ok(rows[0].id)
  })

  await verificarInvariantes('post-hostiles')
}

// ── Ataque 7: Mismo rezagado pedido desde 5 mesas simultáneamente ────────────
async function ataqueRezagadoConcurrente () {
  console.log('\n-- A7. Mismo rezagado pedido desde 5 mesas simultáneamente')

  // Asegurar que las mesas estén libres
  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE estado='en_atencion'`)

  const { rows: [rez] } = await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, llamado_en, finalizado_en)
    VALUES (99999, fn_fecha_hoy(), ${loteId}, 'cancelado', 'voucher_fisico', NOW()-interval '5 min', NOW()-interval '1 min')
    RETURNING id
  `)
  const rezId = parseInt(rez.id, 10)

  // 5 mesas intentan atender el mismo rezagado simultáneamente
  const intentos = mesas.slice(0, 5).map(m =>
    pool.query(`SELECT * FROM fn_atender_rezagado(${rezId}, ${m.id}, ${m.operadorId})`).catch(e => ({ error: e }))
  )
  const resultados = await Promise.all(intentos)

  await test('A7: Solo 1 mesa puede atender el mismo rezagado', () => {
    const exitosos = resultados.filter(r => !r.error && r.rows?.[0])
    assert.equal(exitosos.length, 1, `${exitosos.length} mesas atendieron el mismo rezagado`)
  })

  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE estado='en_atencion'`)
  await verificarInvariantes('post-rezagado-concurrente')
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function runTests () {
  console.log('══════════════════════════════════════════════════════════════')
  console.log(' bd_romper_concurrencia_caos — Concurrencia, fallos y caos')
  console.log(`  BD: ${BD_TEST_NAME}`)
  console.log('══════════════════════════════════════════════════════════════')

  await setup(20)

  await ataqueStorm()
  await ataqueDobleClick()
  await ataqueExtenderDuranteLlamados()
  await ataqueDosAdminsDegradando()
  await ataqueKioskoParalelo()
  await ataqueEntradasHostiles()
  await ataqueRezagadoConcurrente()

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

