'use strict'

const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const assert = require('node:assert/strict')
require('dotenv').config()

const buildApp = require('../src/app')

async function runVerification() {
  console.log('======================================================================')
  console.log(' VERIFICACIÓN: MESAS, TURNOS HUÉRFANOS Y SALIDA DE OPERADOR')
  console.log('======================================================================\n')

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  })

  // Limpiar residuos previos si los hubiera (sin tocar audit_log que es inmutable)
  await pool.query(`DELETE FROM turnos WHERE numero >= 9100 AND numero <= 9200`)
  await pool.query(`DELETE FROM mesas WHERE numero IN (981, 982)`)
  await pool.query(`DELETE FROM usuarios WHERE username IN ('admin_test_m', 'op_test_m')`)

  const app = await buildApp()
  const passHash = await bcrypt.hash('Operador2026!', 10)
  const jwtSecret = process.env.JWT_SECRET || 'dev_secret_jwt_matriculas_2026'

  // Admin user
  const adminRes = await pool.query(`
    INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
    VALUES ('admin_test_m', $1, 'admin', 'Admin Test M', true)
    ON CONFLICT (LOWER(username)) WHERE eliminado_en IS NULL DO UPDATE SET activo = true
    RETURNING id
  `, [passHash])
  const adminId = adminRes.rows[0].id
  const adminToken = jwt.sign({ id: adminId, username: 'admin_test_m', rol: 'admin', nombre_completo: 'Admin Test M' }, jwtSecret)

  // Operador user
  const opRes = await pool.query(`
    INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
    VALUES ('op_test_m', $1, 'operador', 'Operador Test M', true)
    ON CONFLICT (LOWER(username)) WHERE eliminado_en IS NULL DO UPDATE SET activo = true
    RETURNING id
  `, [passHash])
  const opId = opRes.rows[0].id
  const opToken = jwt.sign({ id: opId, username: 'op_test_m', rol: 'operador', nombre_completo: 'Operador Test M' }, jwtSecret)

  // Mesa con operador
  const mesaRes = await pool.query(`
    INSERT INTO mesas (numero, nombre, estado, operador_id)
    VALUES (981, 'Mesa Test 981', 'activa', $1)
    RETURNING id
  `, [opId])
  const mesaId = mesaRes.rows[0].id

  // Obtener o crear lote activo
  let loteRes = await pool.query(`SELECT id FROM lotes_voucher WHERE estado = 'activo' LIMIT 1`)
  let loteId
  if (loteRes.rows.length === 0) {
    const nuevoLote = await pool.query(`
      INSERT INTO lotes_voucher (numero_lote, numero_desde, numero_hasta, ultimo_numero_llamado, estado)
      VALUES (999, 1, 100, 10, 'activo')
      RETURNING id
    `)
    loteId = nuevoLote.rows[0].id
  } else {
    loteId = loteRes.rows[0].id
  }

  // Mesa vacía
  const mesaVaciaRes = await pool.query(`
    INSERT INTO mesas (numero, nombre, estado, operador_id)
    VALUES (982, 'Mesa Test 982', 'activa', NULL)
    RETURNING id
  `)
  const mesaVaciaId = mesaVaciaRes.rows[0].id

  // Turno activo en mesa 981
  const turnoRes = await pool.query(`
    INSERT INTO turnos (numero, mesa_id, operador_id, lote_id, estado, origen, llamado_en)
    VALUES (9101, $1, $2, $3, 'en_atencion', 'voucher_fisico', NOW())
    RETURNING id
  `, [mesaId, opId, loteId])
  const turnoId = turnoRes.rows[0].id

  console.log('[TEST 1] Inactivar mesa desde admin debe cancelar el turno en atención automáticamente...')
  const resInact = await app.inject({
    method: 'PATCH',
    url: `/mesas/${mesaId}/estado`,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json'
    },
    payload: { estado: 'inactiva' }
  })
  assert.equal(resInact.statusCode, 200)
  const turnoCheck1 = await pool.query(`SELECT estado, finalizado_en FROM turnos WHERE id = $1`, [turnoId])
  assert.equal(turnoCheck1.rows[0].estado, 'cancelado')
  assert.ok(turnoCheck1.rows[0].finalizado_en)
  const auditCheck1 = await pool.query(`SELECT accion, metadata_json FROM audit_log WHERE turno_id = $1 ORDER BY id DESC LIMIT 1`, [turnoId])
  assert.equal(auditCheck1.rows[0].accion, 'TURNO_CANCELADO')
  assert.equal(auditCheck1.rows[0].metadata_json.motivo, 'mesa_inactivada_admin')
  console.log('   [OK] Turno cancelado correctamente con motivo mesa_inactivada_admin.')

  console.log('[TEST 2] Intentar eliminar mesa con operador activo y turno en atención debe rechazar con 409...')
  // Reasignar operador y crear turno activo
  await pool.query(`UPDATE mesas SET estado = 'activa', operador_id = $1 WHERE id = $2`, [opId, mesaId])
  const turnoActivoRes = await pool.query(`
    INSERT INTO turnos (numero, mesa_id, operador_id, lote_id, estado, origen, llamado_en)
    VALUES (9104, $1, $2, $3, 'en_atencion', 'voucher_fisico', NOW())
    RETURNING id
  `, [mesaId, opId, loteId])
  const turnoActivoId = turnoActivoRes.rows[0].id

  const resDelConOp = await app.inject({
    method: 'DELETE',
    url: `/mesas/${mesaId}`,
    headers: {
      authorization: `Bearer ${adminToken}`
    }
  })
  assert.equal(resDelConOp.statusCode, 409)
  const bodyDelConOp = JSON.parse(resDelConOp.body)
  assert.match(bodyDelConOp.error, /en atención activo/i)
  console.log('   [OK] 409 Conflict recibido porque el operador está actualmente atendiendo.')

  console.log('[TEST 3] Eliminar mesa sin operador (borrado lógico limpio) debe tener éxito y liberar el número...')
  // Quitar operador
  await pool.query(`UPDATE mesas SET operador_id = NULL WHERE id = $1`, [mesaId])
  const resDelLibre = await app.inject({
    method: 'DELETE',
    url: `/mesas/${mesaId}`,
    headers: {
      authorization: `Bearer ${adminToken}`
    }
  })
  assert.equal(resDelLibre.statusCode, 200)
  const mesaCheckElim = await pool.query(`SELECT estado, eliminado_en FROM mesas WHERE id = $1`, [mesaId])
  assert.equal(mesaCheckElim.rows[0].estado, 'eliminada')
  assert.ok(mesaCheckElim.rows[0].eliminado_en)
  console.log('   [OK] Mesa eliminada lógicamente (estado = eliminada), conservando datos para reportes y liberando el número.')

  console.log('[TEST 4] Liberar mesa desde /auth/liberar-mesa debe cancelar turno activo (nunca dejarlo como atendido)...')
  await pool.query(`UPDATE mesas SET estado = 'activa', operador_id = $1 WHERE id = $2`, [opId, mesaId])
  const turno2Res = await pool.query(`
    INSERT INTO turnos (numero, mesa_id, operador_id, lote_id, estado, origen, llamado_en)
    VALUES (9102, $1, $2, $3, 'en_atencion', 'voucher_fisico', NOW())
    RETURNING id
  `, [mesaId, opId, loteId])
  const turno2Id = turno2Res.rows[0].id

  const resLiberar = await app.inject({
    method: 'POST',
    url: '/auth/liberar-mesa',
    headers: {
      authorization: `Bearer ${opToken}`
    }
  })
  assert.equal(resLiberar.statusCode, 200)
  const turnoCheck2 = await pool.query(`SELECT estado FROM turnos WHERE id = $1`, [turno2Id])
  assert.equal(turnoCheck2.rows[0].estado, 'cancelado')
  const mesaCheck2 = await pool.query(`SELECT operador_id FROM mesas WHERE id = $1`, [mesaId])
  assert.equal(mesaCheck2.rows[0].operador_id, null)
  console.log('   [OK] Turno cancelado limpiamente y mesa desasignada.')

  console.log('[TEST 5] Inactivar usuario operador debe cancelar turno activo y liberar la mesa...')
  await pool.query(`UPDATE mesas SET estado = 'activa', operador_id = $1 WHERE id = $2`, [opId, mesaId])
  const turno3Res = await pool.query(`
    INSERT INTO turnos (numero, mesa_id, operador_id, lote_id, estado, origen, llamado_en)
    VALUES (9103, $1, $2, $3, 'en_atencion', 'voucher_fisico', NOW())
    RETURNING id
  `, [mesaId, opId, loteId])
  const turno3Id = turno3Res.rows[0].id

  const resInactUser = await app.inject({
    method: 'PATCH',
    url: `/admin/usuarios/${opId}`,
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json'
    },
    payload: { activo: false }
  })
  assert.equal(resInactUser.statusCode, 200)
  const turnoCheck3 = await pool.query(`SELECT estado FROM turnos WHERE id = $1`, [turno3Id])
  assert.equal(turnoCheck3.rows[0].estado, 'cancelado')
  const mesaCheck3 = await pool.query(`SELECT operador_id, estado FROM mesas WHERE id = $1`, [mesaId])
  assert.equal(mesaCheck3.rows[0].operador_id, null)
  assert.equal(mesaCheck3.rows[0].estado, 'inactiva')
  const auditCheck3 = await pool.query(`SELECT accion, metadata_json FROM audit_log WHERE turno_id = $1 ORDER BY id DESC LIMIT 1`, [turno3Id])
  assert.equal(auditCheck3.rows[0].accion, 'TURNO_CANCELADO')
  assert.equal(auditCheck3.rows[0].metadata_json.motivo, 'usuario_desactivado_por_admin')
  console.log('   [OK] Turno cancelado con motivo usuario_desactivado_por_admin y mesa liberada e inactivada.')

  // Limpieza
  console.log('\nLimpiando datos de prueba...')
  await pool.query(`DELETE FROM turnos WHERE id IN ($1, $2, $3)`, [turnoId, turno2Id, turno3Id])
  await pool.query(`DELETE FROM mesas WHERE id = $1`, [mesaId])
  await pool.query(`DELETE FROM usuarios WHERE id IN ($1, $2)`, [opId, adminId])
  await app.close()
  await pool.end()

  console.log('======================================================================')
  console.log(' ¡TODAS LAS PRUEBAS DE VERIFICACIÓN PASARON CON ÉXITO!')
  console.log('======================================================================')
}

runVerification().catch((err) => {
  console.error('Error durante la verificación:', err)
  process.exit(1)
})
