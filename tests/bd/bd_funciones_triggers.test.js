'use strict'

/**
 * MÓDULO: base_de_datos
 * OBJETIVO: Evaluar el comportamiento de las funciones y triggers ejecutando
 *           cada rama posible. Verifica fn_llamar_siguiente (voucher y kiosko),
 *           fn_atender_rezagado, fn_calcular_duraciones_turno, fn_audit_turno,
 *           fn_fecha_hoy, y fn_proteger_ultimo_admin.
 * EJECUCIÓN: node tests/bd/bd_funciones_triggers.test.js
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

async function debeError (fn) {
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    await fn(client)
    await client.query('ROLLBACK')
    return { ok: false, err: null, msg: 'No se lanzó excepción' }
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    return { ok: true, err }
  } finally {
    if (client) client.release()
  }
}

// ── Setup de datos de prueba ────────────────────────────────────────────────
let adminId, op1Id, op2Id, mesa1Id, mesa2Id, lote1Id

async function setup () {
  const bcrypt = require('bcrypt')
  const h = await bcrypt.hash('Test2026!', 10)

  const [a, o1, o2] = await Promise.all([
    pool.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('a_trg', 'Admin Trg', $1, 'admin') RETURNING id`, [h]),
    pool.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('o1_trg', 'Op1 Trg', $1, 'operador') RETURNING id`, [h]),
    pool.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('o2_trg', 'Op2 Trg', $1, 'operador') RETURNING id`, [h])
  ])
  adminId = parseInt(a.rows[0].id, 10)
  op1Id   = parseInt(o1.rows[0].id, 10)
  op2Id   = parseInt(o2.rows[0].id, 10)

  const [m1, m2] = await Promise.all([
    pool.query(`INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES (1, 'Mesa 1', 'activa', ${op1Id}) RETURNING id`),
    pool.query(`INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES (2, 'Mesa 2', 'activa', ${op2Id}) RETURNING id`)
  ])
  mesa1Id = parseInt(m1.rows[0].id, 10)
  mesa2Id = parseInt(m2.rows[0].id, 10)

  const l = await pool.query(`
    INSERT INTO lotes_voucher (numero_desde, numero_hasta, ultimo_numero_llamado, estado)
    VALUES (1, 100, 0, 'activo') RETURNING id
  `)
  lote1Id = parseInt(l.rows[0].id, 10)
}

// ── Bloque A: fn_llamar_siguiente — modo voucher ────────────────────────────
async function testLlamarSiguiente () {
  console.log('\n-- A. fn_llamar_siguiente (modo voucher_fisico)')

  await test('Llamada normal: devuelve turno con número correcto', async () => {
    // Asegurar que no hay turnos activos previos
    await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
    const { rows } = await pool.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    assert.ok(rows[0], 'Sin resultado')
    assert.equal(rows[0].turno_numero, 1)
    assert.equal(rows[0].modo, 'voucher_fisico')
    assert.equal(rows[0].es_idempotente, false)
  })

  await test('Contador del lote avanzó a 1', async () => {
    const { rows } = await pool.query(`SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id=${lote1Id}`)
    assert.equal(rows[0].ultimo_numero_llamado, 1)
  })

  await test('Turno anterior marcado como atendido al llamar siguiente', async () => {
    // Simular que pasaron más de 1.5s para evitar idempotencia de doble clic
    await pool.query(`UPDATE turnos SET llamado_en = NOW() - interval '2 seconds' WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
    await pool.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    const { rows } = await pool.query(`SELECT COUNT(*) AS c FROM turnos WHERE mesa_id=${mesa1Id} AND estado='atendido'`)
    assert.ok(parseInt(rows[0].c, 10) >= 1)
  })

  await test('Doble clic rápido: devuelve mismo turno con es_idempotente=true', async () => {
    // Simular llamada fresca y segundo clic inmediato (<1.5s)
    await pool.query(`UPDATE turnos SET llamado_en = NOW() - interval '2 seconds' WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
    const r1 = await pool.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    const num = r1.rows[0].turno_numero
    // Llamada inmediata (<1.5s)
    const r2 = await pool.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    assert.equal(r2.rows[0].es_idempotente, true)
    assert.equal(r2.rows[0].turno_numero, num)
  })

  await test('Sin lote activo: error claro', async () => {
    // Limpiar turno activo para no caer en rama de idempotencia
    await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
    await pool.query(`UPDATE lotes_voucher SET estado='pausado' WHERE id=${lote1Id}`)
    const r = await debeError(async (c) => {
      await c.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    })
    assert.ok(r.ok, `Debería lanzar error. ${r.msg || ''}`)
    assert.ok(r.err.message.toLowerCase().includes('lote'), `Mensaje: ${r.err.message}`)
    await pool.query(`UPDATE lotes_voucher SET estado='activo' WHERE id=${lote1Id}`)
  })

  await test('Lote pausado: error claro', async () => {
    await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
    await pool.query(`UPDATE lotes_voucher SET estado='pausado' WHERE id=${lote1Id}`)
    const r = await debeError(async (c) => {
      await c.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    })
    assert.ok(r.ok, r.msg || '')
    await pool.query(`UPDATE lotes_voucher SET estado='activo' WHERE id=${lote1Id}`)
  })

  await test('Mesa pausada: error con mención del estado', async () => {
    await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
    await pool.query(`UPDATE mesas SET estado='pausada' WHERE id=${mesa1Id}`)
    const r = await debeError(async (c) => {
      await c.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    })
    assert.ok(r.ok, r.msg || '')
    assert.ok(r.err.message.includes('pausada') || r.err.message.includes('activas'), r.err.message)
    await pool.query(`UPDATE mesas SET estado='activa' WHERE id=${mesa1Id}`)
  })

  await test('Operador equivocado: error con mención de asignación', async () => {
    await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
    const r = await debeError(async (c) => {
      await c.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op2Id})`)
    })
    assert.ok(r.ok, r.msg || '')
    assert.ok(r.err.message.includes('asignada'), r.err.message)
  })

  await test('Último número del lote: marca lote agotado', async () => {
    await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
    // Crear un lote pequeño temporal para probar el agotamiento sin afectar lote1Id
    const { rows: [lTmp] } = await pool.query(`
      INSERT INTO lotes_voucher (numero_desde, numero_hasta, ultimo_numero_llamado, estado)
      VALUES (990, 991, 990, 'preparado') RETURNING id
    `)
    // Pausar lote1Id temporalmente y activar el lote de prueba
    await pool.query(`UPDATE lotes_voucher SET estado='pausado' WHERE id=${lote1Id}`)
    await pool.query(`UPDATE lotes_voucher SET estado='activo' WHERE id=${lTmp.id}`)

    // Llamar el último número (991)
    const { rows } = await pool.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    assert.equal(rows[0].es_lote_agotado, true)

    // El lote temporal debe quedar agotado
    const { rows: [lotePost] } = await pool.query(`SELECT estado FROM lotes_voucher WHERE id=${lTmp.id}`)
    assert.equal(lotePost.estado, 'agotado')

    // Reactivar lote1Id
    await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
    await pool.query(`UPDATE lotes_voucher SET estado='activo' WHERE id=${lote1Id}`)
  })
}

// ── Bloque B: fn_llamar_siguiente — modo kiosko ────────────────────────────
async function testLlamarSiguienteKiosko () {
  console.log('\n-- B. fn_llamar_siguiente (modo kiosko_web)')

  await pool.query(`UPDATE configuracion SET valor='kiosko_web' WHERE clave='modo_generacion_turnos'`)
  // Asegurar que la mesa no tiene turno en atención activo
  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)

  await test('Sin turnos en espera: error claro', async () => {
    const r = await debeError(async (c) => {
      await c.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    })
    assert.ok(r.ok, r.msg || '')
    assert.ok(r.err.message.toLowerCase().includes('espera') || r.err.message.toLowerCase().includes('turno'), r.err.message)
  })

  // Insertar turnos kiosko en espera
  const token1 = '0'.repeat(64)
  const token2 = '1'.repeat(64)
  await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, sesion, lote_id, estado, origen, token_consulta)
    VALUES (1, fn_fecha_hoy(), 1, NULL, 'esperando', 'kiosko_web', $1)
  `, [token1])
  await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, sesion, lote_id, estado, origen, token_consulta)
    VALUES (2, fn_fecha_hoy(), 1, NULL, 'esperando', 'kiosko_web', $1)
  `, [token2])

  await test('Llama turno kiosko FIFO (menor número primero)', async () => {
    const { rows } = await pool.query(`SELECT * FROM fn_llamar_siguiente(${mesa1Id}, ${op1Id})`)
    assert.equal(rows[0].turno_numero, 1)
    assert.equal(rows[0].modo, 'kiosko_web')
  })

  await test('Turno kiosko pasa a en_atencion con mesa y operador correctos', async () => {
    const { rows } = await pool.query(`SELECT estado, mesa_id, operador_id FROM turnos WHERE token_consulta=$1`, [token1])
    assert.equal(rows[0].estado, 'en_atencion')
    assert.equal(parseInt(rows[0].mesa_id, 10), mesa1Id)
    assert.equal(parseInt(rows[0].operador_id, 10), op1Id)
  })

  // Restaurar modo
  await pool.query(`UPDATE configuracion SET valor='voucher_fisico' WHERE clave='modo_generacion_turnos'`)
  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${mesa1Id} AND estado='en_atencion'`)
}

// ── Bloque C: fn_atender_rezagado ──────────────────────────────────────────
async function testAtenderRezagado () {
  console.log('\n-- C. fn_atender_rezagado')

  // Crear un turno cancelado (rezagado)
  const { rows: [tr] } = await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, llamado_en, finalizado_en)
    VALUES (800, fn_fecha_hoy(), ${lote1Id}, 'cancelado', 'voucher_fisico', NOW() - interval '5 min', NOW() - interval '1 min')
    RETURNING id
  `)
  const turnoRezId = parseInt(tr.id, 10)

  await test('Atender rezagado: devuelve turno con mesa y operador', async () => {
    const { rows } = await pool.query(`SELECT * FROM fn_atender_rezagado(${turnoRezId}, ${mesa1Id}, ${op1Id})`)
    assert.ok(rows[0], 'Sin resultado')
    assert.equal(rows[0].turno_numero, 800)
    assert.equal(parseInt(rows[0].mesa_id, 10), mesa1Id)
  })

  await test('Rezagado pasa a en_atencion con llamado_en actualizado', async () => {
    const { rows } = await pool.query(`SELECT estado, llamado_en FROM turnos WHERE id=${turnoRezId}`)
    assert.equal(rows[0].estado, 'en_atencion')
    assert.ok(rows[0].llamado_en, 'llamado_en debe estar definido')
  })

  await test('audit_log registra TURNO_REZAGADO', async () => {
    const { rows } = await pool.query(`SELECT accion FROM audit_log WHERE turno_id=${turnoRezId} AND accion='TURNO_REZAGADO'`)
    assert.ok(rows.length > 0, 'Falta entrada TURNO_REZAGADO en audit_log')
  })

  await test('Atender turno no cancelado (en_atencion): error claro', async () => {
    const r = await debeError(async (c) => {
      await c.query(`SELECT * FROM fn_atender_rezagado(${turnoRezId}, ${mesa1Id}, ${op1Id})`)
    })
    assert.ok(r.ok, r.msg || '')
    assert.ok(r.err.message.toLowerCase().includes('atendido') || r.err.message.toLowerCase().includes('disponible'), r.err.message)
  })

  // Turno de otro día
  const { rows: [otro] } = await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, finalizado_en)
    VALUES (801, '2020-01-01', ${lote1Id}, 'cancelado', 'voucher_fisico', NOW())
    RETURNING id
  `)
  const otroDiaId = parseInt(otro.id, 10)

  await test('Rezagado de otro día: rechazado por corresponder a jornada anterior', async () => {
    const r = await debeError(async (c) => {
      await c.query(`SELECT * FROM fn_atender_rezagado(${otroDiaId}, ${mesa2Id}, ${op2Id})`)
    })
    assert.ok(r.ok, 'Debería rechazar rezagado de otro día')
    assert.ok(r.err.message.includes('jornada anterior'), `Mensaje: ${r.err.message}`)
  })

  // Limpiar
  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id IN (${mesa1Id}, ${mesa2Id}) AND estado='en_atencion'`)
}

// ── Bloque D: Triggers de duraciones ──────────────────────────────────────
async function testDuraciones () {
  console.log('\n-- D. fn_calcular_duraciones_turno (triggers)')

  // esperando → en_atencion
  const token = '2'.repeat(64)
  const { rows: [tk] } = await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, token_consulta, creado_en)
    VALUES (900, fn_fecha_hoy(), NULL, 'esperando', 'kiosko_web', $1, NOW() - interval '30 seconds')
    RETURNING id
  `, [token])
  const tkId = parseInt(tk.id, 10)

  await pool.query(`UPDATE turnos SET estado='en_atencion', mesa_id=${mesa1Id}, operador_id=${op1Id} WHERE id=${tkId}`)

  await test('esperando→en_atencion: duracion_espera_seg calculada (>0)', async () => {
    const { rows } = await pool.query(`SELECT duracion_espera_seg, llamado_en FROM turnos WHERE id=${tkId}`)
    assert.ok(rows[0].duracion_espera_seg >= 30, `duracion_espera_seg=${rows[0].duracion_espera_seg} esperado >=30`)
    assert.ok(rows[0].llamado_en, 'llamado_en debe estar definido')
  })

  // en_atencion → atendido
  await pool.query(`UPDATE turnos SET estado='atendido' WHERE id=${tkId}`)

  await test('en_atencion→atendido: duracion_atencion_seg calculada (>=0)', async () => {
    const { rows } = await pool.query(`SELECT duracion_atencion_seg, finalizado_en FROM turnos WHERE id=${tkId}`)
    assert.ok(rows[0].duracion_atencion_seg >= 0, `duracion_atencion_seg=${rows[0].duracion_atencion_seg}`)
    assert.ok(rows[0].finalizado_en, 'finalizado_en debe estar definido')
  })

  // cancelado → en_atencion (rezagado): reset de duracion_atencion_seg
  const { rows: [tkR] } = await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, llamado_en, finalizado_en, duracion_atencion_seg)
    VALUES (901, fn_fecha_hoy(), ${lote1Id}, 'cancelado', 'voucher_fisico', NOW()-interval '10 min', NOW()-interval '5 min', 300)
    RETURNING id
  `)
  await pool.query(`UPDATE turnos SET estado='en_atencion', mesa_id=${mesa2Id}, operador_id=${op2Id} WHERE id=${tkR.id}`)

  await test('cancelado→en_atencion: duracion_atencion_seg=NULL (reset correcto)', async () => {
    const { rows } = await pool.query(`SELECT duracion_atencion_seg, finalizado_en, llamado_en FROM turnos WHERE id=${tkR.id}`)
    assert.equal(rows[0].duracion_atencion_seg, null, 'duracion_atencion_seg debe resetearse a NULL')
    assert.equal(rows[0].finalizado_en, null, 'finalizado_en debe resetearse a NULL')
    assert.ok(rows[0].llamado_en, 'llamado_en debe estar definido')
  })

  await test('Duraciones nunca negativas', async () => {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS c FROM turnos
      WHERE (duracion_espera_seg IS NOT NULL AND duracion_espera_seg < 0)
         OR (duracion_atencion_seg IS NOT NULL AND duracion_atencion_seg < 0)
    `)
    assert.equal(rows[0].c, '0', 'Hay duraciones negativas')
  })

  // Limpiar
  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id IN (${mesa1Id},${mesa2Id}) AND estado='en_atencion'`)
}

// ── Bloque E: fn_audit_turno ────────────────────────────────────────────────
async function testAuditTurno () {
  console.log('\n-- E. fn_audit_turno (trigger de auditoría)')

  // INSERT estado esperando → TURNO_GENERADO
  const tok = '3'.repeat(64)
  const { rows: [tkg] } = await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, token_consulta)
    VALUES (1000, fn_fecha_hoy(), NULL, 'esperando', 'kiosko_web', $1) RETURNING id
  `, [tok])

  await test('INSERT esperando → audit_log TURNO_GENERADO', async () => {
    const { rows } = await pool.query(`SELECT accion FROM audit_log WHERE turno_id=${tkg.id}`)
    assert.ok(rows.some(r => r.accion === 'TURNO_GENERADO'), 'Falta TURNO_GENERADO en audit_log')
  })

  // esperando → en_atencion → TURNO_LLAMADO
  await pool.query(`UPDATE turnos SET estado='en_atencion', mesa_id=${mesa1Id}, operador_id=${op1Id} WHERE id=${tkg.id}`)

  await test('esperando→en_atencion → audit_log TURNO_LLAMADO', async () => {
    const { rows } = await pool.query(`SELECT accion FROM audit_log WHERE turno_id=${tkg.id} AND accion='TURNO_LLAMADO'`)
    assert.ok(rows.length > 0, 'Falta TURNO_LLAMADO en audit_log')
  })

  // en_atencion → atendido → ATENCION_FINALIZADA
  await pool.query(`UPDATE turnos SET estado='atendido' WHERE id=${tkg.id}`)

  await test('en_atencion→atendido → audit_log ATENCION_FINALIZADA', async () => {
    const { rows } = await pool.query(`SELECT accion FROM audit_log WHERE turno_id=${tkg.id} AND accion='ATENCION_FINALIZADA'`)
    assert.ok(rows.length > 0, 'Falta ATENCION_FINALIZADA en audit_log')
  })

  // INSERT en_atencion (voucher directo) → TURNO_LLAMADO
  const { rows: [tkv] } = await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id, llamado_en)
    VALUES (1001, fn_fecha_hoy(), ${lote1Id}, 'en_atencion', 'voucher_fisico', ${mesa1Id}, ${op1Id}, NOW()) RETURNING id
  `)

  await test('INSERT en_atencion (voucher) → audit_log TURNO_LLAMADO', async () => {
    const { rows } = await pool.query(`SELECT accion FROM audit_log WHERE turno_id=${tkv.id} AND accion='TURNO_LLAMADO'`)
    assert.ok(rows.length > 0, 'Falta TURNO_LLAMADO para INSERT en_atencion voucher')
  })

  // en_atencion → cancelado → TURNO_CANCELADO
  await pool.query(`UPDATE turnos SET estado='cancelado' WHERE id=${tkv.id}`)

  await test('en_atencion→cancelado → audit_log TURNO_CANCELADO', async () => {
    const { rows } = await pool.query(`SELECT accion FROM audit_log WHERE turno_id=${tkv.id} AND accion='TURNO_CANCELADO'`)
    assert.ok(rows.length > 0, 'Falta TURNO_CANCELADO en audit_log')
  })

  await test('Cada transición genera exactamente 1 registro en audit_log', async () => {
    const { rows } = await pool.query(`SELECT accion, COUNT(*) AS c FROM audit_log WHERE turno_id=${tkg.id} GROUP BY accion`)
    rows.forEach(r => {
      assert.equal(r.c, '1', `Acción ${r.accion} apareció ${r.c} veces (esperado 1)`)
    })
  })
}

// ── Bloque F: fn_fecha_hoy ──────────────────────────────────────────────────
async function testFechaHoy () {
  console.log('\n-- F. fn_fecha_hoy')

  await test('fn_fecha_hoy retorna una fecha válida', async () => {
    const { rows } = await pool.query(`SELECT fn_fecha_hoy() AS f`)
    assert.ok(rows[0].f, 'fn_fecha_hoy devuelve null')
    const d = new Date(rows[0].f)
    assert.ok(!isNaN(d.getTime()), `Fecha inválida: ${rows[0].f}`)
  })

  await test('Zona horaria inválida: fn_fecha_hoy es resiliente y usa fallback Tegucigalpa', async () => {
    await pool.query(`UPDATE configuracion SET valor='Zona/Invalida' WHERE clave='zona_horaria'`)
    const { rows } = await pool.query(`SELECT fn_fecha_hoy() AS f`)
    assert.ok(rows[0].f, 'fn_fecha_hoy con zona inválida debería retornar fecha fallback, no null')
    hallazgo('FTR-002', 'Info', 'fn_fecha_hoy tiene cláusula WHEN OTHERS THEN fallback a America/Tegucigalpa (resiliencia por diseño, no lanza excepción)')
    await pool.query(`UPDATE configuracion SET valor='America/Tegucigalpa' WHERE clave='zona_horaria'`)
  })
}

// ── Bloque G: Atomicidad (todo o nada) ─────────────────────────────────────
async function testAtomicidad () {
  console.log('\n-- G. Atomicidad de funciones')

  const contadorAntes = await pool.query(`SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id=${lote1Id}`)
  const numAntes = contadorAntes.rows[0].ultimo_numero_llamado

  // Provocar fallo: llamar con mesa_id inexistente
  const r = await debeError(async (c) => {
    await c.query(`SELECT * FROM fn_llamar_siguiente(99999, ${op1Id})`)
  })
  assert.ok(r.ok, 'Debería fallar con mesa inexistente')

  await test('Si fn_llamar_siguiente falla, el contador de lote no avanza', async () => {
    const contadorDespues = await pool.query(`SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id=${lote1Id}`)
    assert.equal(contadorDespues.rows[0].ultimo_numero_llamado, numAntes, 'El contador avanzó pese al error')
  })

  await test('Si fn_llamar_siguiente falla, no quedan turnos huérfanos en en_atencion', async () => {
    const { rows } = await pool.query(`SELECT COUNT(*) AS c FROM turnos WHERE mesa_id=99999`)
    assert.equal(rows[0].c, '0')
  })
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function runTests () {
  console.log('══════════════════════════════════════════════════════════════')
  console.log(' bd_funciones_triggers — Funciones y triggers de BD')
  console.log(`  BD: ${BD_TEST_NAME}`)
  console.log('══════════════════════════════════════════════════════════════')

  await setup()
  await testLlamarSiguiente()
  await testLlamarSiguienteKiosko()
  await testAtenderRezagado()
  await testDuraciones()
  await testAuditTurno()
  await testFechaHoy()
  await testAtomicidad()

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

