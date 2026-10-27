'use strict'

/**
 * MÓDULO: admin_gestion
 * OBJETIVO: Evaluar la eliminación e inactivación de lotes, mesas y usuarios.
 *   Verifica cómo reacciona el sistema cuando se deshabilita o elimina una
 *   mesa activa, un lote o un usuario: integridad de datos, sin excepciones
 *   no capturadas, vistas dependientes actualizadas vía WS y audit_log preservado.
 * EJECUCIÓN: node tests/admin_ciclo_vida_entidades.test.js
 */

const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const assert = require('node:assert/strict')
require('dotenv').config()

const buildApp = require('../src/app')

async function runAdminCicloVidaEntidades () {
  console.log('======================================================================')
  console.log(' MÓDULO: admin_gestion — admin_ciclo_vida_entidades')
  console.log(' Integridad de datos ante eliminación/inactivación de entidades')
  console.log('======================================================================\n')

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  })

  const app = await buildApp()
  const jwtSecret = process.env.JWT_SECRET || 'dev_secret_jwt_matriculas_2026'
  const passHash = await bcrypt.hash('CicloTest2026!', 10)

  // ── Limpieza inicial ────────────────────────────────────────────────────────
  await pool.query(`UPDATE configuracion SET valor = 'voucher_fisico' WHERE clave = 'modo_generacion_turnos'`)
  await pool.query(`UPDATE configuracion SET valor = 'false' WHERE clave = 'kiosko_web_activo'`)
  await pool.query(`DELETE FROM turnos WHERE numero BETWEEN 9700 AND 9800`)
  await pool.query(`DELETE FROM mesas WHERE numero IN (961, 962, 963)`)
  await pool.query(`DELETE FROM usuarios WHERE username IN ('adm_cv1', 'adm_cv2', 'op_cv1', 'op_cv2')`)
  await pool.query(`DELETE FROM lotes_voucher WHERE numero_lote IN (881, 882, 883, 884)`)

  // ── Usuarios de prueba ──────────────────────────────────────────────────────
  const [adm1Res, adm2Res, op1Res, op2Res] = await Promise.all([
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('adm_cv1', $1, 'admin', 'Admin CV Uno', true) RETURNING id`, [passHash]),
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('adm_cv2', $1, 'admin', 'Admin CV Dos', true) RETURNING id`, [passHash]),
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('op_cv1', $1, 'operador', 'Operador CV Uno', true) RETURNING id`, [passHash]),
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('op_cv2', $1, 'operador', 'Operador CV Dos', true) RETURNING id`, [passHash])
  ])
  const adm1Id = parseInt(adm1Res.rows[0].id, 10)
  const adm2Id = parseInt(adm2Res.rows[0].id, 10)
  const op1Id  = parseInt(op1Res.rows[0].id, 10)
  const op2Id  = parseInt(op2Res.rows[0].id, 10)

  const adm1Token = jwt.sign({ id: adm1Id, username: 'adm_cv1', rol: 'admin', nombre_completo: 'Admin CV Uno' }, jwtSecret)
  const adm2Token = jwt.sign({ id: adm2Id, username: 'adm_cv2', rol: 'admin', nombre_completo: 'Admin CV Dos' }, jwtSecret)
  const op1Token  = jwt.sign({ id: op1Id, username: 'op_cv1', rol: 'operador', nombre_completo: 'Operador CV Uno' }, jwtSecret)
  const op2Token  = jwt.sign({ id: op2Id, username: 'op_cv2', rol: 'operador', nombre_completo: 'Operador CV Dos' }, jwtSecret)

  // ── Interceptor de eventos WS ───────────────────────────────────────────────
  const wsEvents = []
  const originalBroadcast = app.broadcast
  app.broadcast = async (canal, tipo, payload) => {
    wsEvents.push({ canal, tipo, payload, ts: Date.now() })
    return originalBroadcast.call(app, canal, tipo, payload)
  }

  // Lote de trabajo (reutilizar activo o crear temporal)
  let loteTrabajoId
  const loteExistente = await pool.query(`SELECT id FROM lotes_voucher WHERE estado = 'activo' LIMIT 1`)
  if (loteExistente.rows.length === 0) {
    const tmp = await pool.query(`INSERT INTO lotes_voucher (numero_lote, numero_lote_nombre, numero_desde, numero_hasta, ultimo_numero_llamado, estado) VALUES (880, 'Lote 880', 9700, 9800, 9699, 'activo') RETURNING id`)
    loteTrabajoId = parseInt(tmp.rows[0].id, 10)
  } else {
    loteTrabajoId = parseInt(loteExistente.rows[0].id, 10)
  }

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // BLOQUE A: CICLO DE VIDA DE MESAS
    // ──────────────────────────────────────────────────────────────────────────

    // TEST 1: Crear mesa activa → aparece en /auth/mesas/disponibles; inactiva → no aparece
    console.log('[TEST 1] Mesa activa aparece en selección; inactiva no aparece...')
    const resMesa961 = await app.inject({
      method: 'POST', url: '/mesas',
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { numero: 961, nombre: 'Mesa Ciclo 961', estado: 'activa' }
    })
    assert.equal(resMesa961.statusCode, 201, 'Crear mesa activa debe devolver 201')
    const mesa961 = JSON.parse(resMesa961.body).mesa
    assert.equal(mesa961.estado, 'activa')

    const resDisp1 = await app.inject({
      method: 'GET', url: '/auth/mesas/disponibles',
      headers: { authorization: `Bearer ${op1Token}` }
    })
    assert.equal(resDisp1.statusCode, 200)
    const mesas1 = JSON.parse(resDisp1.body).mesas
    assert.ok(mesas1.some(m => m.numero === 961), 'Mesa 961 activa debe aparecer en /auth/mesas/disponibles')

    const resMesa962 = await app.inject({
      method: 'POST', url: '/mesas',
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { numero: 962, nombre: 'Mesa Ciclo 962', estado: 'inactiva' }
    })
    assert.equal(resMesa962.statusCode, 201)
    const mesa962 = JSON.parse(resMesa962.body).mesa

    const resDisp2 = await app.inject({
      method: 'GET', url: '/auth/mesas/disponibles',
      headers: { authorization: `Bearer ${op1Token}` }
    })
    const mesas2 = JSON.parse(resDisp2.body).mesas
    assert.ok(!mesas2.some(m => m.numero === 962), 'Mesa 962 inactiva NO debe aparecer en selección')
    console.log('   [OK] Mesa activa visible; inactiva oculta en selección.')

    // TEST 2: Inactivar mesa con turno en atención → turno cancelado, audit_log registrado
    console.log('[TEST 2] Inactivar mesa con turno activo → turno cancelado con motivo audit...')
    await pool.query(`UPDATE mesas SET operador_id = $1 WHERE id = $2`, [op1Id, mesa961.id])
    const turnoMesaRes = await pool.query(`
      INSERT INTO turnos (numero, mesa_id, operador_id, lote_id, estado, origen, llamado_en)
      VALUES (9701, $1, $2, $3, 'en_atencion', 'voucher_fisico', NOW()) RETURNING id
    `, [mesa961.id, op1Id, loteTrabajoId])
    const turnoMesaId = parseInt(turnoMesaRes.rows[0].id, 10)

    wsEvents.length = 0
    const resInact961 = await app.inject({
      method: 'PATCH', url: `/mesas/${mesa961.id}/estado`,
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { estado: 'inactiva' }
    })
    assert.equal(resInact961.statusCode, 200, 'Inactivar mesa debe responder 200')

    const turnoTrasInact = await pool.query(`SELECT estado, finalizado_en FROM turnos WHERE id = $1`, [turnoMesaId])
    assert.equal(turnoTrasInact.rows[0].estado, 'cancelado', 'El turno debe quedar cancelado al inactivar la mesa')
    assert.ok(turnoTrasInact.rows[0].finalizado_en, 'finalizado_en debe estar registrado')

    const auditTurno = await pool.query(`SELECT accion, metadata_json FROM audit_log WHERE turno_id = $1 ORDER BY id DESC LIMIT 1`, [turnoMesaId])
    assert.ok(auditTurno.rows.length > 0, 'Debe existir registro en audit_log para el turno cancelado')
    assert.equal(auditTurno.rows[0].accion, 'TURNO_CANCELADO', 'La acción en audit_log debe ser TURNO_CANCELADO')
    assert.match(auditTurno.rows[0].metadata_json?.motivo || '', /mesa_inactivada/i, 'El motivo en audit_log debe mencionar mesa_inactivada')

    await new Promise(r => setTimeout(r, 100))
    const eventoInact = wsEvents.find(e => e.canal === 'tv:global' || e.canal === 'admin:all')
    assert.ok(eventoInact, `Inactivar mesa debe emitir evento WS (eventos: ${wsEvents.map(e => `${e.canal}:${e.tipo}`).join(', ')})`)
    console.log('   [OK] Turno cancelado, audit_log registrado, WS emitido.')

    // TEST 3: Eliminar mesa con turno en atención → rechazado 409
    console.log('[TEST 3] Eliminar mesa con turno activo rechazado con 409...')
    await pool.query(`UPDATE mesas SET estado = 'activa', operador_id = $1 WHERE id = $2`, [op1Id, mesa961.id])
    const turnoBloqueoRes = await pool.query(`
      INSERT INTO turnos (numero, mesa_id, operador_id, lote_id, estado, origen, llamado_en)
      VALUES (9702, $1, $2, $3, 'en_atencion', 'voucher_fisico', NOW()) RETURNING id
    `, [mesa961.id, op1Id, loteTrabajoId])
    const turnoBloqueoId = parseInt(turnoBloqueoRes.rows[0].id, 10)

    const resDelMesaBloq = await app.inject({
      method: 'DELETE', url: `/mesas/${mesa961.id}`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resDelMesaBloq.statusCode, 409, 'Eliminar mesa con turno activo debe devolver 409')
    assert.match(JSON.parse(resDelMesaBloq.body).error, /en atenci[oó]n/i, 'Mensaje de error debe mencionar "en atención"')

    // Finalizar turno para poder continuar
    await pool.query(`UPDATE turnos SET estado = 'atendido', finalizado_en = NOW() WHERE id = $1`, [turnoBloqueoId])
    console.log('   [OK] 409 recibido correctamente. Mesa protegida mientras hay turno activo.')

    // TEST 4: Eliminar mesa libre → borrado lógico, número liberado
    console.log('[TEST 4] Eliminar mesa libre → borrado lógico, número liberado para reutilización...')
    await pool.query(`UPDATE mesas SET operador_id = NULL WHERE id = $1`, [mesa961.id])
    wsEvents.length = 0
    const resDelMesa961 = await app.inject({
      method: 'DELETE', url: `/mesas/${mesa961.id}`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resDelMesa961.statusCode, 200, 'Eliminar mesa libre debe devolver 200')

    const mesaEliminadaCheck = await pool.query(`SELECT estado, eliminado_en FROM mesas WHERE id = $1`, [mesa961.id])
    assert.equal(mesaEliminadaCheck.rows[0].estado, 'eliminada', 'Mesa debe quedar con estado "eliminada"')
    assert.ok(mesaEliminadaCheck.rows[0].eliminado_en, 'eliminado_en debe estar registrado')

    const eventoDelMesa = wsEvents.find(e => e.canal === 'admin:all')
    assert.ok(eventoDelMesa, 'Eliminar mesa debe emitir evento WS a admin:all')
    console.log('   [OK] Mesa eliminada lógicamente, datos históricos preservados.')

    // ──────────────────────────────────────────────────────────────────────────
    // BLOQUE B: CICLO DE VIDA DE USUARIOS
    // ──────────────────────────────────────────────────────────────────────────

    // TEST 5: Protección del último admin activo (vía API y trigger de BD)
    console.log('[TEST 5] Protección del último admin activo (API + trigger de BD)...')
    // Desactivar todos los demás admins existentes menos adm_cv1
    const { rows: otrosAdmins } = await pool.query(
      `SELECT id FROM usuarios WHERE rol = 'admin' AND activo = true AND eliminado_en IS NULL AND id != $1`, [adm1Id]
    )
    const otrosIds = otrosAdmins.map(r => r.id)
    if (otrosIds.length > 0) {
      await pool.query(`UPDATE usuarios SET activo = false WHERE id = ANY($1::int[])`, [otrosIds])
    }

    // Intentar desactivar al único admin por API
    const resDesactUnico = await app.inject({
      method: 'PATCH', url: `/admin/usuarios/${adm1Id}`,
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { activo: false }
    })
    assert.equal(resDesactUnico.statusCode, 400, 'Desactivar único admin debe devolver 400')
    assert.match(JSON.parse(resDesactUnico.body).error, /propia cuenta|único administrador/i)

    // Intentar eliminar al único admin por API
    const resDelUnico = await app.inject({
      method: 'DELETE', url: `/admin/usuarios/${adm1Id}`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resDelUnico.statusCode, 400, 'Eliminar único admin debe devolver 400')

    // Intentar directamente en BD — el trigger fn_proteger_ultimo_admin debe frenarlo
    let triggerActivado = false
    try {
      await pool.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [adm1Id])
    } catch (err) {
      triggerActivado = true
      assert.match(err.message, /único administrador activo|unico administrador/i, `El trigger debe mencionar "único administrador": ${err.message}`)
    }
    assert.ok(triggerActivado, 'El trigger fn_proteger_ultimo_admin debe rechazar el UPDATE directo en BD')

    // Restaurar otros admins
    if (otrosIds.length > 0) {
      await pool.query(`UPDATE usuarios SET activo = true WHERE id = ANY($1::int[])`, [otrosIds])
    }
    await pool.query(`UPDATE usuarios SET activo = true WHERE id = $1`, [adm2Id])
    console.log('   [OK] Último admin protegido por API y trigger de BD.')

    // TEST 6: Admin no puede cambiar su propio rol
    console.log('[TEST 6] Admin no puede cambiar su propio rol...')
    const resRolPropio = await app.inject({
      method: 'PATCH', url: `/admin/usuarios/${adm1Id}`,
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { rol: 'operador' }
    })
    assert.equal(resRolPropio.statusCode, 400, 'Cambio de rol propio debe devolver 400')
    assert.match(JSON.parse(resRolPropio.body).error, /propio rol|propia cuenta/i)
    console.log('   [OK] Cambio de rol propio rechazado correctamente.')

    // TEST 7: Desactivar operador con mesa asignada → mesa queda libre + WS notifica
    console.log('[TEST 7] Desactivar operador con mesa → mesa queda libre y WS notifica...')
    // Usar mesa962 (inactiva), activarla y asignar op1
    await pool.query(`UPDATE mesas SET estado = 'activa', operador_id = $1 WHERE id = $2`, [op1Id, mesa962.id])

    wsEvents.length = 0
    const resDesactOp1 = await app.inject({
      method: 'PATCH', url: `/admin/usuarios/${op1Id}`,
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { activo: false }
    })
    assert.equal(resDesactOp1.statusCode, 200, 'Desactivar operador debe devolver 200')

    const mesaTrasDesact = await pool.query(`SELECT estado, operador_id FROM mesas WHERE id = $1`, [mesa962.id])
    assert.equal(mesaTrasDesact.rows[0].operador_id, null, 'Mesa debe quedar sin operador asignado')
    assert.equal(mesaTrasDesact.rows[0].estado, 'activa', 'Mesa debe quedarse activa y disponible')

    await new Promise(r => setTimeout(r, 100))
    const eventoDesactOp = wsEvents.find(e => e.canal === 'tv:global' || e.canal === 'admin:all')
    assert.ok(eventoDesactOp, `Desactivar operador debe emitir evento WS (eventos: ${wsEvents.map(e => `${e.canal}:${e.tipo}`).join(', ')})`)
    console.log('   [OK] Mesa liberada y WS notificado al desactivar operador.')

    // TEST 8: Desactivar operador con turno en atención → turno cancelado, mesa liberada
    console.log('[TEST 8] Desactivar operador con turno activo → turno cancelado, mesa liberada...')
    await pool.query(`UPDATE usuarios SET activo = true WHERE id = $1`, [op1Id])
    await pool.query(`UPDATE mesas SET operador_id = $1, estado = 'activa' WHERE id = $2`, [op1Id, mesa962.id])
    const turnoOpRes = await pool.query(`
      INSERT INTO turnos (numero, mesa_id, operador_id, lote_id, estado, origen, llamado_en)
      VALUES (9703, $1, $2, $3, 'en_atencion', 'voucher_fisico', NOW()) RETURNING id
    `, [mesa962.id, op1Id, loteTrabajoId])
    const turnoOpId = parseInt(turnoOpRes.rows[0].id, 10)

    const resDesactOp1b = await app.inject({
      method: 'PATCH', url: `/admin/usuarios/${op1Id}`,
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { activo: false }
    })
    assert.equal(resDesactOp1b.statusCode, 200, 'Desactivar operador con turno activo debe devolver 200')

    const turnoTrasDesactOp = await pool.query(`SELECT estado FROM turnos WHERE id = $1`, [turnoOpId])
    assert.equal(turnoTrasDesactOp.rows[0].estado, 'cancelado', 'Turno debe cancelarse al desactivar el operador')

    const auditOp = await pool.query(`SELECT accion, metadata_json FROM audit_log WHERE turno_id = $1 ORDER BY id DESC LIMIT 1`, [turnoOpId])
    assert.ok(auditOp.rows.length > 0, 'Debe haber registro en audit_log para turno cancelado por desactivación')
    assert.equal(auditOp.rows[0].accion, 'TURNO_CANCELADO')
    assert.match(auditOp.rows[0].metadata_json?.motivo || '', /usuario_desactivado/i)
    console.log('   [OK] Turno cancelado con motivo usuario_desactivado y audit_log registrado.')

    // TEST 9: Degradar admin → pierde acceso al panel de admin inmediatamente
    console.log('[TEST 9] Degradar admin activo → acceso al panel de admin revocado en el mismo token...')
    // adm1 degrada a adm2
    const resDegradar = await app.inject({
      method: 'PATCH', url: `/admin/usuarios/${adm2Id}`,
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { rol: 'operador' }
    })
    assert.equal(resDegradar.statusCode, 200, 'Degradar admin a operador debe devolver 200')

    // adm2 intenta acceder al admin con su token anterior (rol aún firmado como admin)
    const resAdm2Admin = await app.inject({
      method: 'GET', url: '/admin/usuarios',
      headers: { authorization: `Bearer ${adm2Token}` }
    })
    assert.equal(resAdm2Admin.statusCode, 403, 'Admin degradado debe perder acceso inmediatamente (token antiguo rechazado)')

    // Restaurar rol de adm2
    await pool.query(`UPDATE usuarios SET rol = 'admin' WHERE id = $1`, [adm2Id])
    console.log('   [OK] Degradación de rol revoca acceso de inmediato.')

    // TEST 10: Eliminar usuario → audit_log preservado (integridad FK)
    console.log('[TEST 10] Eliminar usuario → entradas en audit_log conservadas por integridad FK...')
    await pool.query(`UPDATE usuarios SET activo = true WHERE id = $1`, [op1Id])
    await pool.query(`UPDATE mesas SET operador_id = NULL WHERE operador_id = $1`, [op1Id])

    // Verificar que hay audit_log de op1 (generado por tests anteriores)
    const auditAntes = await pool.query(`SELECT COUNT(*) AS total FROM audit_log WHERE operador_id = $1`, [op1Id])
    const totalAuditAntes = parseInt(auditAntes.rows[0].total, 10)

    const resDelOp1 = await app.inject({
      method: 'DELETE', url: `/admin/usuarios/${op1Id}`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resDelOp1.statusCode, 200, 'Eliminar operador debe devolver 200')

    // El usuario debe quedar marcado como eliminado (borrado lógico)
    const usuarioEliminado = await pool.query(`SELECT activo, eliminado_en FROM usuarios WHERE id = $1`, [op1Id])
    assert.ok(usuarioEliminado.rows[0].eliminado_en || !usuarioEliminado.rows[0].activo, 'Usuario debe quedar inactivo o con eliminado_en registrado')

    // Los registros de audit_log deben conservarse (no eliminados en cascada)
    const auditDespues = await pool.query(`SELECT COUNT(*) AS total FROM audit_log WHERE operador_id = $1`, [op1Id])
    const totalAuditDespues = parseInt(auditDespues.rows[0].total, 10)
    assert.equal(totalAuditDespues, totalAuditAntes, `Registros de audit_log deben conservarse tras eliminar usuario (antes: ${totalAuditAntes}, después: ${totalAuditDespues})`)
    console.log(`   [OK] ${totalAuditDespues} registros de audit_log conservados tras eliminar usuario.`)

    // TEST 11: Unicidad de username — inactivo conserva, eliminado libera
    console.log('[TEST 11] Unicidad de username: inactivo conserva, eliminado libera...')
    await pool.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [op2Id])

    // Intentar crear usuario con mismo username (inactivo): debe ser 409
    const resRepInactivo = await app.inject({
      method: 'POST', url: '/admin/usuarios',
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { username: 'OP_CV2', nombre_completo: 'Nuevo Op CV2', password: 'NuevoPwd2026!', rol: 'operador' }
    })
    assert.equal(resRepInactivo.statusCode, 409, 'Username de usuario inactivo debe estar reservado (409)')
    assert.match(JSON.parse(resRepInactivo.body).error, /ya existe/i)

    // Eliminar op2 lógicamente
    await app.inject({
      method: 'DELETE', url: `/admin/usuarios/${op2Id}`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })

    // Ahora debe permitirse crear con el username liberado
    const resLibUsername = await app.inject({
      method: 'POST', url: '/admin/usuarios',
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { username: 'op_cv2', nombre_completo: 'Nuevo Op CV Dos', password: 'NuevoPwd2026!', rol: 'operador' }
    })
    assert.equal(resLibUsername.statusCode, 201, 'Username liberado por eliminación debe poder reutilizarse (201)')
    console.log('   [OK] Username inactivo reservado; eliminado libera el nombre.')

    // ──────────────────────────────────────────────────────────────────────────
    // BLOQUE C: CICLO DE VIDA DE LOTES
    // ──────────────────────────────────────────────────────────────────────────

    // TEST 12: Crear lote → extender en caliente → pausar → reactivar → cerrar
    console.log('[TEST 12] Ciclo completo de lote: crear → extender → pausar → reactivar → cerrar...')
    // Desactivar el lote activo real para poder crear uno de prueba
    await pool.query(`UPDATE lotes_voucher SET estado = 'cerrado' WHERE estado = 'activo'`)
    const lote881Res = await pool.query(`
      INSERT INTO lotes_voucher (numero_lote, numero_desde, numero_hasta, ultimo_numero_llamado, estado)
      VALUES (881, 1, 20, 0, 'activo') RETURNING id
    `)
    const lote881Id = parseInt(lote881Res.rows[0].id, 10)

    // Extender
    wsEvents.length = 0
    const resExtender = await app.inject({
      method: 'PATCH', url: `/lotes/${lote881Id}/extender`,
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { nuevo_numero_hasta: 35 }
    })
    assert.equal(resExtender.statusCode, 200, 'Extender lote debe devolver 200')
    const { rows: [loteExt] } = await pool.query(`SELECT numero_hasta FROM lotes_voucher WHERE id = $1`, [lote881Id])
    assert.equal(parseInt(loteExt.numero_hasta, 10), 35, 'numero_hasta debe ser 35 tras extender')
    assert.ok(wsEvents.some(e => e.canal === 'admin:all' && e.tipo === 'lote_extendido'), 'Debe emitir lote_extendido a admin:all')

    // Pausar
    wsEvents.length = 0
    const resPausar = await app.inject({
      method: 'PATCH', url: `/lotes/${lote881Id}/pausar`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resPausar.statusCode, 200, 'Pausar lote debe devolver 200')
    const { rows: [lotePausado] } = await pool.query(`SELECT estado FROM lotes_voucher WHERE id = $1`, [lote881Id])
    assert.equal(lotePausado.estado, 'pausado', 'Estado del lote debe ser "pausado"')

    // Reactivar
    wsEvents.length = 0
    const resReactivar = await app.inject({
      method: 'PATCH', url: `/lotes/${lote881Id}/activar`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resReactivar.statusCode, 200, 'Reactivar lote pausado debe devolver 200')
    const { rows: [loteReact] } = await pool.query(`SELECT estado FROM lotes_voucher WHERE id = $1`, [lote881Id])
    assert.equal(loteReact.estado, 'activo', 'Estado del lote debe ser "activo" tras reactivar')

    // Cerrar
    const resCerrar = await app.inject({
      method: 'PATCH', url: `/lotes/${lote881Id}/cerrar`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resCerrar.statusCode, 200, 'Cerrar lote debe devolver 200')
    const { rows: [loteCerrado] } = await pool.query(`SELECT estado FROM lotes_voucher WHERE id = $1`, [lote881Id])
    assert.equal(loteCerrado.estado, 'cerrado', 'Estado del lote debe ser "cerrado"')
    console.log('   [OK] Ciclo completo de lote: activo → extendido → pausado → activo → cerrado.')

    // TEST 13: Lote cerrado no puede reactivarse y bloquea llamados
    console.log('[TEST 13] Lote cerrado rechaza reactivación y bloquea llamados...')
    const resReactivarCerrado = await app.inject({
      method: 'PATCH', url: `/lotes/${lote881Id}/activar`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resReactivarCerrado.statusCode, 400, 'Reactivar lote cerrado debe devolver 400')
    assert.match(JSON.parse(resReactivarCerrado.body).error, /no puede activarse/i)

    // Restaurar op1 para poder llamar
    await pool.query(`UPDATE usuarios SET activo = true, eliminado_en = NULL WHERE id = $1`, [op1Id])
    const mesaTmp = await pool.query(`INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES (963, 'Mesa Tmp 963', 'activa', $1) RETURNING id`, [op1Id])
    const mesaTmpId = parseInt(mesaTmp.rows[0].id, 10)

    const resLlamarCerrado = await app.inject({
      method: 'POST', url: '/turnos/llamar',
      headers: { authorization: `Bearer ${op1Token}` },
      payload: { mesa_id: mesaTmpId }
    })
    assert.equal(resLlamarCerrado.statusCode, 409, 'Llamar con lote cerrado debe devolver 409')
    console.log('   [OK] Lote cerrado no reactivable y bloquea llamados.')

    // TEST 14: Un solo lote activo a la vez — 409 al intentar activar un segundo
    console.log('[TEST 14] Un solo lote activo a la vez — segundo intento devuelve 409...')
    const lote882Res = await pool.query(`
      INSERT INTO lotes_voucher (numero_lote, numero_desde, numero_hasta, estado)
      VALUES (882, 1, 50, 'activo') RETURNING id
    `)
    const lote882Id = parseInt(lote882Res.rows[0].id, 10)
    const lote883Res = await pool.query(`
      INSERT INTO lotes_voucher (numero_lote, numero_desde, numero_hasta, estado)
      VALUES (883, 1, 50, 'preparado') RETURNING id
    `)
    const lote883Id = parseInt(lote883Res.rows[0].id, 10)

    const resConflicto = await app.inject({
      method: 'PATCH', url: `/lotes/${lote883Id}/activar`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resConflicto.statusCode, 409, 'Activar segundo lote debe devolver 409')
    assert.match(JSON.parse(resConflicto.body).error, /Ya hay un lote activo/i)
    console.log('   [OK] Segundo lote rechazado con 409.')

    // TEST 15: Eliminar lote — activo y usado rechazados; sin usar permitido
    console.log('[TEST 15] Eliminar lote: activo rechazado 409; sin usar permitido 200...')
    const resDelActivo = await app.inject({
      method: 'DELETE', url: `/lotes/${lote882Id}`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resDelActivo.statusCode, 409, 'Eliminar lote activo debe devolver 409')

    wsEvents.length = 0
    const resDelSinUsar = await app.inject({
      method: 'DELETE', url: `/lotes/${lote883Id}`,
      headers: { authorization: `Bearer ${adm1Token}` }
    })
    assert.equal(resDelSinUsar.statusCode, 200, 'Eliminar lote sin usar debe devolver 200')
    assert.ok(wsEvents.some(e => e.tipo === 'lote_eliminado'), 'Debe emitir lote_eliminado al eliminar lote sin usar')
    console.log('   [OK] Lote activo protegido; lote sin usar eliminado con evento WS.')

    // TEST 16: Extender lote agotado lo reactiva automáticamente
    console.log('[TEST 16] Extender lote agotado lo vuelve a estado activo...')
    await pool.query(`UPDATE lotes_voucher SET ultimo_numero_llamado = 50, estado = 'agotado' WHERE id = $1`, [lote882Id])
    const resExtAgotado = await app.inject({
      method: 'PATCH', url: `/lotes/${lote882Id}/extender`,
      headers: { authorization: `Bearer ${adm1Token}` },
      payload: { nuevo_numero_hasta: 75 }
    })
    assert.equal(resExtAgotado.statusCode, 200, 'Extender lote agotado debe devolver 200')
    const { rows: [loteReactivado] } = await pool.query(`SELECT estado FROM lotes_voucher WHERE id = $1`, [lote882Id])
    assert.equal(loteReactivado.estado, 'activo', 'Lote agotado extendido debe quedar en estado "activo"')
    console.log('   [OK] Lote agotado extendido y reactivado automáticamente.')

  } finally {
    // Restaurar broadcast y limpiar en orden seguro
    app.broadcast = originalBroadcast

    await pool.query(`UPDATE configuracion SET valor = 'voucher_fisico' WHERE clave = 'modo_generacion_turnos'`)
    await pool.query(`UPDATE configuracion SET valor = 'false' WHERE clave = 'kiosko_web_activo'`)

    // Finalizar turnos activos de prueba para evitar FK en limpieza
    await pool.query(`UPDATE turnos SET estado = 'cancelado', finalizado_en = NOW() WHERE mesa_id IN (SELECT id FROM mesas WHERE numero IN (961, 962, 963)) AND estado = 'en_atencion'`)
    await pool.query(`DELETE FROM turnos WHERE numero BETWEEN 9700 AND 9800`)
    await pool.query(`DELETE FROM mesas WHERE numero IN (961, 962, 963)`)
    await pool.query(`DELETE FROM usuarios WHERE username IN ('adm_cv1', 'adm_cv2', 'op_cv1', 'op_cv2')`)
    await pool.query(`DELETE FROM lotes_voucher WHERE numero_lote IN (881, 882, 883, 884)`)
    await pool.query(`DELETE FROM lotes_voucher WHERE numero_lote = 880`)

    // Restaurar el lote original si quedó cerrado por este test
    const loteActivoCheck = await pool.query(`SELECT COUNT(*) AS total FROM lotes_voucher WHERE estado = 'activo'`)
    if (parseInt(loteActivoCheck.rows[0].total, 10) === 0) {
      await pool.query(`UPDATE lotes_voucher SET estado = 'activo' WHERE id = (SELECT id FROM lotes_voucher ORDER BY id ASC LIMIT 1)`)
    }

    await pool.end()
    await app.close()
  }

  console.log('\n======================================================================')
  console.log(' ¡16 PRUEBAS DE admin_ciclo_vida_entidades COMPLETADAS CON ÉXITO!')
  console.log('======================================================================\n')
  process.exit(0)
}

runAdminCicloVidaEntidades().catch(err => {
  console.error('\n[ERROR] Fallo en admin_ciclo_vida_entidades:', err.message)
  console.error(err.stack)
  process.exit(1)
})

