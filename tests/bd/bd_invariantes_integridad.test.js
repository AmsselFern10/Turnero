'use strict'

/**
 * MÓDULO: base_de_datos
 * OBJETIVO: Atacar cada regla de negocio directamente en la base de datos,
 *           saltándose la aplicación, para comprobar que la BD la hace cumplir
 *           por sí sola. Verifica CHECKs, índices únicos parciales, triggers
 *           y valores límite hostiles.
 * EJECUCIÓN: node tests/bd/bd_invariantes_integridad.test.js
 */

const assert = require('node:assert/strict')
const {
  setupTestDb, teardownTestDb, getTestPool, BD_TEST_NAME, newTestClient
} = require('./helpers/db_test_setup')

let pool
let passed = 0
let failed = 0
const errores = []
const hallazgos = []

function ok (nombre) {
  process.stdout.write(`  [OK] ${nombre}\n`)
  passed++
}

function fail (nombre, detalle) {
  process.stderr.write(`  [FAIL] ${nombre}\n`)
  if (detalle) process.stderr.write(`        ${detalle}\n`)
  failed++
  errores.push({ nombre, detalle })
}

function hallazgo (id, severidad, descripcion) {
  hallazgos.push({ id, severidad, descripcion })
  process.stdout.write(`  [HALLAZGO-${id} | ${severidad}] ${descripcion}\n`)
}

async function test (nombre, fn) {
  try {
    await fn()
    ok(nombre)
  } catch (err) {
    fail(nombre, err.message)
  }
}

// Verifica que una operación LANZA error con código 23505 (unique violation) o similar
async function debeViolacion (fn, codigoEsperado = '23505') {
  let cliente
  try {
    cliente = await pool.connect()
    await cliente.query('BEGIN')
    await fn(cliente)
    await cliente.query('ROLLBACK')
    return { fallo: true, mensaje: 'No se lanzó excepción esperada', err: null }
  } catch (err) {
    if (cliente) await cliente.query('ROLLBACK').catch(() => {})
    if (err.code === codigoEsperado || err.code === '23514' || err.code === 'P0001') {
      return { fallo: false, err }
    }
    return { fallo: true, mensaje: `Código ${err.code} inesperado: ${err.message}`, err }
  } finally {
    if (cliente) cliente.release()
  }
}

// ── Preparar datos base mínimos ─────────────────────────────────────────────
let adminId, op1Id, op2Id, mesa1Id, mesa2Id, lote1Id

async function prepararDatos () {
  const bcrypt = require('bcrypt')
  const hash = await bcrypt.hash('Test2026!', 10)

  const [a, o1, o2] = await Promise.all([
    pool.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('adm_inv', 'Admin Inv', $1, 'admin') RETURNING id`, [hash]),
    pool.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('op_inv1', 'Operador Inv1', $1, 'operador') RETURNING id`, [hash]),
    pool.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('op_inv2', 'Operador Inv2', $1, 'operador') RETURNING id`, [hash])
  ])
  adminId = parseInt(a.rows[0].id, 10)
  op1Id   = parseInt(o1.rows[0].id, 10)
  op2Id   = parseInt(o2.rows[0].id, 10)

  const [m1, m2] = await Promise.all([
    pool.query(`INSERT INTO mesas (numero, nombre, estado) VALUES (1, 'Mesa 1', 'activa') RETURNING id`),
    pool.query(`INSERT INTO mesas (numero, nombre, estado) VALUES (2, 'Mesa 2', 'activa') RETURNING id`)
  ])
  mesa1Id = parseInt(m1.rows[0].id, 10)
  mesa2Id = parseInt(m2.rows[0].id, 10)

  const l = await pool.query(`
    INSERT INTO lotes_voucher (numero_desde, numero_hasta, ultimo_numero_llamado, estado)
    VALUES (1, 500, 0, 'activo') RETURNING id
  `)
  lote1Id = parseInt(l.rows[0].id, 10)
}

// ── Tests ───────────────────────────────────────────────────────────────────
async function runTests () {
  console.log('══════════════════════════════════════════════════════════════')
  console.log(' bd_invariantes_integridad — Invariantes de integridad en BD')
  console.log(`  BD: ${BD_TEST_NAME}`)
  console.log('══════════════════════════════════════════════════════════════\n')

  await prepararDatos()

  // ── Bloque 1: Roles y estados válidos ──────────────────────────────────
  console.log('-- 1. Roles y estados válidos')

  await test('Rol inválido rechazado (CHECK ck_usuarios_rol)', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('bad_rol', 'x', 'h', 'supervisor')`)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Estado de turno inválido rechazado', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id) VALUES (9001, fn_fecha_hoy(), ${lote1Id}, 'pendiente', 'voucher_fisico', ${mesa1Id})`)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Estado de mesa inválido rechazado', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO mesas (numero, nombre, estado) VALUES (9001, 'x', 'disponible')`)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Estado de lote inválido rechazado', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO lotes_voucher (numero_desde, numero_hasta, estado) VALUES (1, 100, 'corriendo')`)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Acción de audit_log inválida rechazada', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO audit_log (accion) VALUES ('ACCION_INVENTADA')`)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  // ── Bloque 2: Un solo lote activo ───────────────────────────────────────
  console.log('\n-- 2. Un solo lote activo (ux_lotes_un_lote_activo)')

  await test('Segundo lote activo rechazado', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO lotes_voucher (numero_desde, numero_hasta, estado) VALUES (501, 1000, 'activo')`)
    })
    assert.ok(!r.fallo, r.mensaje)
  })

  // ── Bloque 3: 1 turno en_atencion por mesa ────────────────────────────
  console.log('\n-- 3. Un turno en_atencion por mesa (ux_turnos_mesa_activa)')

  // Insertar un turno en_atencion
  const { rows: [t1] } = await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id)
    VALUES (9001, fn_fecha_hoy(), ${lote1Id}, 'en_atencion', 'voucher_fisico', ${mesa1Id}, ${op1Id})
    RETURNING id
  `)

  await test('Segundo turno en_atencion en la misma mesa rechazado', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`
        INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id)
        VALUES (9002, fn_fecha_hoy(), ${lote1Id}, 'en_atencion', 'voucher_fisico', ${mesa1Id}, ${op1Id})
      `)
    })
    assert.ok(!r.fallo, r.mensaje)
  })

  // Limpiar turno de prueba
  await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE id=${t1.id}`)

  // ── Bloque 4: Operador único por mesa ─────────────────────────────────
  console.log('\n-- 4. Operador único en mesa activa (ux_mesas_operador_unico)')

  await pool.query(`UPDATE mesas SET operador_id=${op1Id} WHERE id=${mesa1Id}`)

  await test('Mismo operador en dos mesas activas rechazado', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`UPDATE mesas SET operador_id=${op1Id} WHERE id=${mesa2Id}`)
    })
    assert.ok(!r.fallo, r.mensaje)
  })

  await pool.query(`UPDATE mesas SET operador_id=NULL WHERE id=${mesa1Id}`)

  // ── Bloque 5: Restricciones de lote ───────────────────────────────────
  console.log('\n-- 5. Restricciones de rango de lote')

  await test('numero_hasta < numero_desde rechazado (ck_lote_rango)', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO lotes_voucher (numero_desde, numero_hasta, estado) VALUES (100, 50, 'preparado')`)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('numero_desde=0 rechazado (ck_lote_rango: numero_desde>=1)', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO lotes_voucher (numero_desde, numero_hasta, estado) VALUES (0, 100, 'preparado')`)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('ultimo_numero_llamado > numero_hasta rechazado (ck_lote_progreso)', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO lotes_voucher (numero_desde, numero_hasta, ultimo_numero_llamado, estado) VALUES (1, 100, 150, 'preparado')`)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('ultimo_numero_llamado negativo rechazado (ck_lote_progreso)', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO lotes_voucher (numero_desde, numero_hasta, ultimo_numero_llamado, estado) VALUES (1, 100, -1, 'preparado')`)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  // ── Bloque 6: No regresión del contador de lote ────────────────────────
  console.log('\n-- 6. No regresión del lote (trg_lotes_no_regresion)')

  await pool.query(`UPDATE lotes_voucher SET ultimo_numero_llamado=10 WHERE id=${lote1Id}`)

  await test('Retroceso de contador rechazado sin GUC', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`UPDATE lotes_voucher SET ultimo_numero_llamado=5 WHERE id=${lote1Id}`)
    }, 'P0001')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Retroceso permitido con SET LOCAL app.permitir_retroceso_lote=on', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL "app.permitir_retroceso_lote" = 'on'`)
      await client.query(`UPDATE lotes_voucher SET ultimo_numero_llamado=5 WHERE id=${lote1Id}`)
      await client.query('ROLLBACK')
      ok('Retroceso con GUC aceptado')
      passed++
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      fail('Retroceso con GUC', err.message)
    } finally {
      client.release()
    }
    // Restaurar
    await pool.query(`UPDATE lotes_voucher SET ultimo_numero_llamado=10 WHERE id=${lote1Id}`)
  })

  // ── Bloque 7: Turno kiosko: atributos obligatorios ─────────────────────
  console.log('\n-- 7. Atributos obligatorios por origen de turno')

  await test('voucher_fisico sin lote_id rechazado (ck_turnos_origen_atributos)', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`
        INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id)
        VALUES (9100, fn_fecha_hoy(), NULL, 'en_atencion', 'voucher_fisico', ${mesa1Id})
      `)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('kiosko_web sin token_consulta rechazado (ck_turnos_origen_atributos)', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`
        INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, token_consulta)
        VALUES (9100, fn_fecha_hoy(), NULL, 'esperando', 'kiosko_web', NULL)
      `)
    }, '23514')
    assert.ok(!r.fallo, r.mensaje)
  })

  // ── Bloque 8: Unicidad de username ─────────────────────────────────────
  console.log('\n-- 8. Username único (ux_usuarios_username_activos)')

  await test('Username duplicado rechazado (mismo usuario activo)', async () => {
    const r = await debeViolacion(async (c) => {
      const bcrypt = require('bcrypt')
      const h = await bcrypt.hash('x', 4)
      await c.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('op_inv1', 'Dup', $1, 'operador')`, [h])
    })
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Username duplicado ignorando mayúsculas rechazado', async () => {
    const r = await debeViolacion(async (c) => {
      const bcrypt = require('bcrypt')
      const h = await bcrypt.hash('x', 4)
      await c.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('OP_INV1', 'Dup Upper', $1, 'operador')`, [h])
    })
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Username liberado por borrado lógico puede reutilizarse', async () => {
    await pool.query(`UPDATE usuarios SET eliminado_en=NOW() WHERE id=${op2Id}`)
    const bcrypt = require('bcrypt')
    const h = await bcrypt.hash('x', 4)
    // Debe poder insertar con mismo nombre ahora
    const { rows } = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('op_inv2', 'Nuevo op_inv2', $1, 'operador') RETURNING id`, [h]
    )
    assert.ok(rows[0].id, 'No se pudo reutilizar username liberado')
    // Limpiar
    await pool.query(`DELETE FROM usuarios WHERE id=${rows[0].id}`)
    await pool.query(`UPDATE usuarios SET eliminado_en=NULL WHERE id=${op2Id}`)
  })

  // ── Bloque 9: Número de mesa único ─────────────────────────────────────
  console.log('\n-- 9. Número de mesa único (ux_mesas_numero_activas)')

  await test('Número de mesa duplicado rechazado', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO mesas (numero, nombre, estado) VALUES (1, 'Dup Mesa 1', 'activa')`)
    })
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Número de mesa liberado al eliminar permite reutilización', async () => {
    await pool.query(`INSERT INTO mesas (numero, nombre, estado, eliminado_en) VALUES (1, 'Eliminada', 'eliminada', NOW())`)
    // La misma mesa1Id tiene numero=1; otra eliminada puede también tener numero=1 — esto es válido
    const { rows: dups } = await pool.query(`SELECT COUNT(*) AS c FROM mesas WHERE numero=1 AND (estado='eliminada' OR eliminado_en IS NOT NULL)`)
    // No lanzó excepción = correcto (eliminadas no participan en el índice único)
    ok('Mesa eliminada no bloquea nuevo número')
    passed++
  })

  // ── Bloque 10: Protección del último admin ─────────────────────────────
  console.log('\n-- 10. Protección del último admin activo (fn_proteger_ultimo_admin)')

  // Dejar solo admin_test y adm_inv activos, desactivar los demás
  const { rows: otrosAdmins } = await pool.query(
    `SELECT id FROM usuarios WHERE rol='admin' AND activo=true AND eliminado_en IS NULL AND id NOT IN (${adminId})`
  )
  if (otrosAdmins.length > 0) {
    const ids = otrosAdmins.map(r => r.id).join(',')
    await pool.query(`UPDATE usuarios SET activo=false WHERE id IN (${ids})`)
  }

  await test('Desactivar único admin rechazado por trigger', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`UPDATE usuarios SET activo=false WHERE id=${adminId}`)
    }, 'P0001')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Borrado lógico del único admin rechazado por trigger', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`UPDATE usuarios SET eliminado_en=NOW() WHERE id=${adminId}`)
    }, 'P0001')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Degradar rol del único admin rechazado por trigger', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`UPDATE usuarios SET rol='operador' WHERE id=${adminId}`)
    }, 'P0001')
    assert.ok(!r.fallo, r.mensaje)
  })

  // Restaurar admins desactivados
  if (otrosAdmins.length > 0) {
    const ids = otrosAdmins.map(r => r.id).join(',')
    await pool.query(`UPDATE usuarios SET activo=true WHERE id IN (${ids})`)
  }

  // ── Bloque 11: audit_log inmutable ─────────────────────────────────────
  console.log('\n-- 11. audit_log inmutable (trg_audit_log_inmutable)')

  const { rows: [auditRow] } = await pool.query(
    `INSERT INTO audit_log (accion, operador_id) VALUES ('LOGIN_EXITOSO', ${adminId}) RETURNING id`
  )

  await test('UPDATE en audit_log rechazado', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`UPDATE audit_log SET accion='LOGOUT' WHERE id=${auditRow.id}`)
    }, 'P0001')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('DELETE en audit_log rechazado', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`DELETE FROM audit_log WHERE id=${auditRow.id}`)
    }, 'P0001')
    assert.ok(!r.fallo, r.mensaje)
  })

  // ── Bloque 12: Idempotencia (kiosko) ────────────────────────────────────
  console.log('\n-- 12. Idempotencia (ux_turnos_idempotency_key, ux_turnos_device_esperando)')

  const tokenUnico = 'a'.repeat(64)
  await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, token_consulta, idempotency_key)
    VALUES (9200, fn_fecha_hoy(), NULL, 'esperando', 'kiosko_web', '${tokenUnico}', 'idem-key-001')
  `)

  await test('idempotency_key duplicada rechazada', async () => {
    const r = await debeViolacion(async (c) => {
      const tok2 = 'b'.repeat(64)
      await c.query(`
        INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, token_consulta, idempotency_key)
        VALUES (9201, fn_fecha_hoy(), NULL, 'esperando', 'kiosko_web', '${tok2}', 'idem-key-001')
      `)
    })
    assert.ok(!r.fallo, r.mensaje)
  })

  const deviceId = 'device-test-001'
  const tok3 = 'c'.repeat(64)
  await pool.query(`
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, token_consulta, device_id)
    VALUES (9202, fn_fecha_hoy(), NULL, 'esperando', 'kiosko_web', '${tok3}', '${deviceId}')
  `)

  await test('Segundo turno esperando del mismo device rechazado (ux_turnos_device_esperando)', async () => {
    const r = await debeViolacion(async (c) => {
      const tok4 = 'd'.repeat(64)
      await c.query(`
        INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, token_consulta, device_id)
        VALUES (9203, fn_fecha_hoy(), NULL, 'esperando', 'kiosko_web', '${tok4}', '${deviceId}')
      `)
    })
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Mismo device puede tener turnos en estados distintos de esperando', async () => {
    const tok5 = 'e'.repeat(64)
    await pool.query(`
      INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, token_consulta, device_id)
      VALUES (9204, fn_fecha_hoy(), NULL, 'atendido', 'kiosko_web', '${tok5}', '${deviceId}')
    `)
    ok('Device puede tener turno atendido y esperando simultáneamente si el esperando es distinto')
    passed++
  })

  // ── Bloque 13: Valores límite y hostiles ───────────────────────────────
  console.log('\n-- 13. Valores límite y hostiles')

  await test('username NULL rechazado (NOT NULL)', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES (NULL, 'x', 'h', 'operador')`)
    }, '23502')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('valor NULL en configuracion rechazado (NOT NULL)', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`INSERT INTO configuracion (clave, valor) VALUES ('clave_test_null', NULL)`)
    }, '23502')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('numero_lote extremo (999999999) aceptado — no hay CHECK de máximo', async () => {
    const { rows } = await pool.query(`
      INSERT INTO lotes_voucher (numero_desde, numero_hasta, estado)
      VALUES (1, 999999999, 'preparado') RETURNING id
    `)
    assert.ok(rows[0].id, 'Debería insertar número grande')
  })

  await test('username de 30 chars exactamente aceptado', async () => {
    const bcrypt = require('bcrypt')
    const h = await bcrypt.hash('x', 4)
    const u30 = 'a'.repeat(30)
    const { rows } = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ($1, 'x', $2, 'operador') RETURNING id`,
      [u30, h]
    )
    assert.ok(rows[0].id)
  })

  await test('username de 31 chars rechazado (VARCHAR(30))', async () => {
    const r = await debeViolacion(async (c) => {
      const bcrypt = require('bcrypt')
      const h = await bcrypt.hash('x', 4)
      const u31 = 'a'.repeat(31)
      await c.query(`INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ($1, 'x', $2, 'operador')`, [u31, h])
    }, '22001')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('token_consulta de 65 chars rechazado (VARCHAR(64))', async () => {
    const r = await debeViolacion(async (c) => {
      const token65 = 'f'.repeat(65)
      await c.query(`
        INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, token_consulta)
        VALUES (9300, fn_fecha_hoy(), NULL, 'esperando', 'kiosko_web', $1)
      `, [token65])
    }, '22001')
    assert.ok(!r.fallo, r.mensaje)
  })

  await test('Fecha imposible en fecha_turno rechazada', async () => {
    const r = await debeViolacion(async (c) => {
      await c.query(`
        INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id)
        VALUES (9999, '2026-13-99', ${lote1Id}, 'en_atencion', 'voucher_fisico', ${mesa1Id})
      `)
    }, '22008')
    assert.ok(!r.fallo, r.mensaje)
  })

  // ── Bloque 14: Sin registros huérfanos (FKs) ───────────────────────────
  console.log('\n-- 14. Integridad referencial (FK)')

  await test('FK configuracion.actualizado_por → usuarios: SET NULL al eliminar usuario', async () => {
    const bcrypt = require('bcrypt')
    const h = await bcrypt.hash('x', 4)
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('tmp_fk_user', 'x', $1, 'operador') RETURNING id`, [h]
    )
    await pool.query(`UPDATE configuracion SET actualizado_por=${u.id} WHERE clave='zona_horaria'`)
    // Eliminar el usuario (borrado físico — para la BD no hay ON DELETE CASCADE en usuarios)
    // FK en configuracion es ON DELETE SET NULL
    await pool.query(`DELETE FROM usuarios WHERE id=${u.id}`)
    const { rows: [cfg] } = await pool.query(`SELECT actualizado_por FROM configuracion WHERE clave='zona_horaria'`)
    assert.equal(cfg.actualizado_por, null, 'actualizado_por debe quedar NULL al eliminar usuario referenciado')
  })

  // ── Resumen ─────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(` RESULTADO: ${passed} OK  |  ${failed} FALLIDOS`)

  if (hallazgos.length > 0) {
    console.log('\n HALLAZGOS:')
    hallazgos.forEach(h => console.log(`  - [${h.id}] (${h.severidad}) ${h.descripcion}`))
  }

  if (errores.length > 0) {
    console.error('\n ERRORES:')
    errores.forEach(e => console.error(`  - ${e.nombre}: ${e.detalle}`))
  }

  console.log('══════════════════════════════════════════════════════════════\n')
  if (failed > 0) process.exit(1)
}

// ── Main ─────────────────────────────────────────────────────────────────────
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

