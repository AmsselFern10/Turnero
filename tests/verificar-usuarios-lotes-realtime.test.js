'use strict'

const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const assert = require('node:assert/strict')
require('dotenv').config()

const buildApp = require('../src/app')

async function runUsuariosLotesTests() {
  console.log('======================================================================')
  console.log(' TEST PASO 3: GESTIÓN DE USUARIOS Y LOTES MULTI-SESIÓN EN TIEMPO REAL')
  console.log('======================================================================\n')

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  })

  const app = await buildApp()
  const jwtSecret = process.env.JWT_SECRET || 'dev_secret_jwt_matriculas_2026'
  const passHash = await bcrypt.hash('Test2026!', 10)

  // Limpieza inicial
  await pool.query(`DELETE FROM turnos WHERE lote_id IN (SELECT id FROM lotes_voucher WHERE numero_lote IN (881, 882, 883, 884)) OR (numero >= 9600 AND numero <= 9700)`)
  await pool.query(`DELETE FROM mesas WHERE numero IN (961, 962, 963)`)
  await pool.query(`DELETE FROM usuarios WHERE username IN ('adm_test1', 'adm_test2', 'op_test1', 'op_test2')`)
  await pool.query(`DELETE FROM lotes_voucher WHERE numero_lote IN (881, 882, 883, 884)`)

  // 1. Usuarios de prueba
  const [admin1Res, admin2Res, op1Res, op2Res] = await Promise.all([
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('adm_test1', $1, 'admin', 'Admin Uno', true) RETURNING id`, [passHash]),
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('adm_test2', $1, 'admin', 'Admin Dos', true) RETURNING id`, [passHash]),
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('op_test1', $1, 'operador', 'Operador Uno', true) RETURNING id`, [passHash]),
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('op_test2', $1, 'operador', 'Operador Dos', true) RETURNING id`, [passHash])
  ])

  const admin1Id = parseInt(admin1Res.rows[0].id, 10)
  const admin2Id = parseInt(admin2Res.rows[0].id, 10)
  const op1Id = parseInt(op1Res.rows[0].id, 10)
  const op2Id = parseInt(op2Res.rows[0].id, 10)

  const admin1Token = jwt.sign({ id: admin1Id, username: 'adm_test1', rol: 'admin', nombre_completo: 'Admin Uno' }, jwtSecret)
  const admin2Token = jwt.sign({ id: admin2Id, username: 'adm_test2', rol: 'admin', nombre_completo: 'Admin Dos' }, jwtSecret)
  const op1Token = jwt.sign({ id: op1Id, username: 'op_test1', rol: 'operador', nombre_completo: 'Operador Uno' }, jwtSecret)
  const op2Token = jwt.sign({ id: op2Id, username: 'op_test2', rol: 'operador', nombre_completo: 'Operador Dos' }, jwtSecret)

  // Capturador de eventos WebSocket
  const wsEvents = []
  const originalBroadcast = app.broadcast
  app.broadcast = async (canal, tipo, payload) => {
    wsEvents.push({ canal, tipo, payload, ts: Date.now() })
    return originalBroadcast.call(app, canal, tipo, payload)
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Dejar sin admins por cualquier vía (debe ser rechazado en BD y API)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 1] Protección estricta del último administrador activo...')
    // Encontrar cualquier otro admin activo en la BD para aislar a admin1 como único
    const { rows: otrosAdminsExistentes } = await pool.query(
      `SELECT id FROM usuarios WHERE rol = 'admin' AND activo = true AND eliminado_en IS NULL AND id != $1`,
      [admin1Id]
    )
    const otrosAdminIds = otrosAdminsExistentes.map(r => r.id)
    if (otrosAdminIds.length > 0) {
      await pool.query(`UPDATE usuarios SET activo = false WHERE id = ANY($1::int[])`, [otrosAdminIds])
    }

    // Intentar desactivar al único admin restante (admin1) vía PATCH
    const resDesactUnico = await app.inject({
      method: 'PATCH',
      url: `/admin/usuarios/${admin1Id}`,
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { activo: false }
    })
    assert.equal(resDesactUnico.statusCode, 400)
    assert.match(JSON.parse(resDesactUnico.body).error, /No puede desactivar su propia cuenta|único administrador/i)

    // Intentar eliminar al único admin vía DELETE
    const resDelUnico = await app.inject({
      method: 'DELETE',
      url: `/admin/usuarios/${admin1Id}`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resDelUnico.statusCode, 400)

    // Intentar directamente en BD mediante SQL (el trigger debe frenarlo con error P0001)
    let triggerFreno = false
    try {
      await pool.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [admin1Id])
    } catch (err) {
      triggerFreno = true
      assert.match(err.message, /No se puede eliminar, desactivar ni degradar al unico administrador activo/i)
    }
    assert.ok(triggerFreno, 'El trigger fn_proteger_ultimo_admin debe rechazar la desactivación en base de datos')
    console.log('   [OK] Último administrador protegido en API y Base de Datos ante cualquier vía.')

    // Restaurar los otros administradores existentes y admin2
    if (otrosAdminIds.length > 0) {
      await pool.query(`UPDATE usuarios SET activo = true WHERE id = ANY($1::int[])`, [otrosAdminIds])
    }
    await pool.query(`UPDATE usuarios SET eliminado_en = NULL, activo = true, rol = 'admin' WHERE id = $1`, [admin2Id])

    // -------------------------------------------------------------------------
    // TEST 2: Admin se edita a sí mismo (nombre, password ok; cambiar rol rechazado)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 2] Admin se edita a sí mismo (rol inmutable para sí mismo)...')
    // Intentar cambiar su propio rol a operador
    const resCambioRolPropio = await app.inject({
      method: 'PATCH',
      url: `/admin/usuarios/${admin1Id}`,
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { rol: 'operador' }
    })
    assert.equal(resCambioRolPropio.statusCode, 400)
    assert.match(JSON.parse(resCambioRolPropio.body).error, /No puede modificar ni revocar su propio rol/i)

    // Editar su propio nombre y password
    wsEvents.length = 0
    const resEditPropio = await app.inject({
      method: 'PATCH',
      url: `/admin/usuarios/${admin1Id}`,
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { nombre_completo: 'Admin Uno Renombrado' }
    })
    assert.equal(resEditPropio.statusCode, 200)
    assert.equal(JSON.parse(resEditPropio.body).usuario.nombre_completo, 'Admin Uno Renombrado')
    assert.ok(wsEvents.some(e => e.tipo === 'usuario_actualizado'), 'Debe emitir usuario_actualizado')
    console.log('   [OK] Cambio de rol propio rechazado; edición de datos propios permitida con difusión en vivo.')

    // -------------------------------------------------------------------------
    // TEST 3: Desactivar y eliminar usuario con mesa asignada y conectado
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 3] Desactivar usuario con mesa asignada: mesa queda libre y activa...')
    // Crear mesa 961 y asignarle op1
    const mesa961Res = await pool.query(`INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES (961, 'Mesa 961', 'activa', $1) RETURNING id`, [op1Id])
    const mesa961Id = mesa961Res.rows[0].id

    wsEvents.length = 0
    // Desactivar a op1
    const resDesactOp = await app.inject({
      method: 'PATCH',
      url: `/admin/usuarios/${op1Id}`,
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { activo: false }
    })
    assert.equal(resDesactOp.statusCode, 200)

    // Verificar que la mesa quedó libre y activa
    const { rows: [mesaTrasDesact] } = await pool.query(`SELECT estado, operador_id FROM mesas WHERE id = $1`, [mesa961Id])
    assert.equal(mesaTrasDesact.operador_id, null, 'Mesa debe quedar sin operador')
    assert.equal(mesaTrasDesact.estado, 'activa', 'Mesa debe quedar activa y disponible para otros operadores')

    // Verificar avisos WS
    assert.ok(wsEvents.some(e => e.canal === 'tv:global' && e.tipo === 'mesas_disponibles_actualizadas' && e.payload.accion === 'liberada'), 'Mesa liberada debe anunciarse en selección de mesa')
    assert.ok(wsEvents.some(e => e.canal === 'tv:global' && e.tipo === 'operador_desasignado_por_admin'), 'Operador desasignado debe ser expulsado')
    console.log('   [OK] Al desactivar usuario, la mesa queda libre y activa disponible para otros operadores.')

    // Reactivar op1 y reasignarle mesa 961
    await pool.query(`UPDATE usuarios SET activo = true WHERE id = $1`, [op1Id])
    await pool.query(`UPDATE mesas SET operador_id = $1 WHERE id = $2`, [op1Id, mesa961Id])

    // -------------------------------------------------------------------------
    // TEST 4: Cambiar rol de usuario conectado (degradar admin pierde acceso)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 4] Cambio de rol en vivo y pérdida de acceso de admin degradado...')
    wsEvents.length = 0
    // Admin 1 degrada a Admin 2 a operador
    const resDegradar = await app.inject({
      method: 'PATCH',
      url: `/admin/usuarios/${admin2Id}`,
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { rol: 'operador' }
    })
    assert.equal(resDegradar.statusCode, 200)

    // Admin 2 intenta llamar a un endpoint protegido de admin con su token anterior: debe ser 403
    const resAdmin2Acceso = await app.inject({
      method: 'GET',
      url: '/admin/usuarios',
      headers: { authorization: `Bearer ${admin2Token}` }
    })
    assert.equal(resAdmin2Acceso.statusCode, 403, 'Admin degradado debe perder inmediatamente acceso al admin')
    console.log('   [OK] Degradación de rol revoca acceso al panel de administración de inmediato.')

    // Restaurar rol admin para Admin 2
    await pool.query(`UPDATE usuarios SET rol = 'admin' WHERE id = $1`, [admin2Id])

    // -------------------------------------------------------------------------
    // TEST 5: Nombre de usuario único (inactivo conserva, eliminado libera)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 5] Unicidad de username: inactivo conserva, eliminado libera...')
    // op2 está activo. Desactivarlo (inactivo)
    await pool.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [op2Id])

    // Intentar crear un usuario con el mismo username que el inactivo (op_test2): debe ser 409
    const resRepInactivo = await app.inject({
      method: 'POST',
      url: '/admin/usuarios',
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { username: 'OP_TEST2', nombre_completo: 'Otro Operador', password: 'password123', rol: 'operador' }
    })
    assert.equal(resRepInactivo.statusCode, 409)
    assert.match(JSON.parse(resRepInactivo.body).error, /ya existe/i)

    // Eliminar lógicamente a op2
    await app.inject({
      method: 'DELETE',
      url: `/admin/usuarios/${op2Id}`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })

    // Ahora intentar crear con el username liberado 'op_test2': debe permitirse (201)
    const resLibUsername = await app.inject({
      method: 'POST',
      url: '/admin/usuarios',
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { username: 'op_test2', nombre_completo: 'Nuevo Op Dos', password: 'password123', rol: 'operador' }
    })
    assert.equal(resLibUsername.statusCode, 201)
    const nuevoOp2Id = JSON.parse(resLibUsername.body).usuario.id
    console.log('   [OK] Usuario inactivo conserva su username; usuario eliminado libera el username para reutilización.')

    // -------------------------------------------------------------------------
    // TEST 6: Extender lote activo y agotado: broadcast a paneles, TV y admin
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 6] Extender lote activo y agotado con difusiones completas...')
    // Desactivar cualquier lote activo previo
    await pool.query(`UPDATE lotes_voucher SET estado = 'cerrado' WHERE estado = 'activo'`)

    // Crear Lote 881 (1 a 10)
    const lote881Res = await pool.query(`
      INSERT INTO lotes_voucher (numero_lote, numero_desde, numero_hasta, ultimo_numero_llamado, estado)
      VALUES (881, 1, 10, 0, 'activo') RETURNING id
    `)
    const lote881Id = lote881Res.rows[0].id

    wsEvents.length = 0
    const resExtender = await app.inject({
      method: 'PATCH',
      url: `/lotes/${lote881Id}/extender`,
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { nuevo_numero_hasta: 25 }
    })
    assert.equal(resExtender.statusCode, 200)

    // Verificar difusiones
    assert.ok(wsEvents.some(e => e.canal === 'admin:all' && e.tipo === 'lote_extendido'), 'Debe emitir lote_extendido a admin:all')
    assert.ok(wsEvents.some(e => e.canal === 'lote:activo' && e.tipo === 'proximo_actualizado' && e.payload.vouchers_restantes === 25), 'Debe emitir proximo_actualizado a lote:activo')
    assert.ok(wsEvents.some(e => e.canal === 'tv:global' && e.tipo === 'lote_extendido'), 'Debe emitir lote_extendido a tv:global')

    // Ahora simular lote agotado (ultimo_numero_llamado = 25, estado = 'agotado')
    await pool.query(`UPDATE lotes_voucher SET ultimo_numero_llamado = 25, estado = 'agotado' WHERE id = $1`, [lote881Id])
    const resExtAgotado = await app.inject({
      method: 'PATCH',
      url: `/lotes/${lote881Id}/extender`,
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { nuevo_numero_hasta: 40 }
    })
    assert.equal(resExtAgotado.statusCode, 200)
    const { rows: [lotePostExt] } = await pool.query(`SELECT estado FROM lotes_voucher WHERE id = $1`, [lote881Id])
    assert.equal(lotePostExt.estado, 'activo', 'Lote agotado que se extiende debe volver a estado activo')
    console.log('   [OK] Extender lote activo y agotado actualiza en vivo y reactiva el lote agotado.')

    // -------------------------------------------------------------------------
    // TEST 7: Pausar lote: bloquea llamados; reactivar: reanuda sin error
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 7] Pausar lote bloquea llamadas; reactivar reanuda en vivo...')
    // Pausar Lote 881
    wsEvents.length = 0
    const resPausar = await app.inject({
      method: 'PATCH',
      url: `/lotes/${lote881Id}/pausar`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resPausar.statusCode, 200)
    assert.ok(wsEvents.some(e => e.canal === 'lote:activo' && e.tipo === 'lote_pausado'), 'Debe emitir lote_pausado a lote:activo')

    // Operador intenta llamar turno mientras está pausado: debe ser rechazado 409
    const resLlamarPausado = await app.inject({
      method: 'POST',
      url: '/turnos/llamar',
      headers: { authorization: `Bearer ${op1Token}` },
      payload: { mesa_id: parseInt(mesa961Id, 10) }
    })
    assert.equal(resLlamarPausado.statusCode, 409)
    const errLlamarPausado = JSON.parse(resLlamarPausado.body)
    assert.match(errLlamarPausado.message || errLlamarPausado.error, /No hay un lote activo|activar un lote/i)

    // Reactivar Lote 881
    wsEvents.length = 0
    const resReactivar = await app.inject({
      method: 'PATCH',
      url: `/lotes/${lote881Id}/activar`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resReactivar.statusCode, 200)
    assert.ok(wsEvents.some(e => e.canal === 'lote:activo' && e.tipo === 'proximo_actualizado'), 'Debe emitir proximo_actualizado para desbloquear paneles')

    // Ahora llamar debe funcionar sin error y continuar donde quedó (26)
    const resLlamarReactivado = await app.inject({
      method: 'POST',
      url: '/turnos/llamar',
      headers: { authorization: `Bearer ${op1Token}` },
      payload: { mesa_id: parseInt(mesa961Id, 10) }
    })
    assert.equal(resLlamarReactivado.statusCode, 200)
    assert.equal(JSON.parse(resLlamarReactivado.body).turno.numero, 26)
    console.log('   [OK] Lote pausado bloquea llamadas; reactivado continúa sin error en el número correspondiente.')

    // -------------------------------------------------------------------------
    // TEST 8: Cerrar lote es definitivo y bloquea llamados futuros
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 8] Cerrar lote definitivo y rechazo de llamadas posteriores...')
    const resCerrar = await app.inject({
      method: 'PATCH',
      url: `/lotes/${lote881Id}/cerrar`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resCerrar.statusCode, 200)

    // Intentar reactivar un lote cerrado: debe rechazarse con 400
    const resReactivarCerrado = await app.inject({
      method: 'PATCH',
      url: `/lotes/${lote881Id}/activar`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resReactivarCerrado.statusCode, 400)
    assert.match(JSON.parse(resReactivarCerrado.body).error, /no puede activarse desde su estado actual/i)

    // Finalizar turno previo en atención para evitar bloqueo de idempotencia <1.5s
    await pool.query(`UPDATE turnos SET estado = 'atendido', finalizado_en = NOW() WHERE mesa_id = $1`, [mesa961Id])

    // Llamar turno con lote cerrado: debe rechazarse 409
    const resLlamarCerrado = await app.inject({
      method: 'POST',
      url: '/turnos/llamar',
      headers: { authorization: `Bearer ${op1Token}` },
      payload: { mesa_id: parseInt(mesa961Id, 10) }
    })
    assert.equal(resLlamarCerrado.statusCode, 409)
    console.log('   [OK] Lote cerrado no puede reactivarse y llamadas son rechazadas.')

    // -------------------------------------------------------------------------
    // TEST 9: Un solo lote activo a la vez (transiciones y rechazo 409)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 9] Regla estricta de un solo lote activo a la vez...')
    const n882Res = await pool.query(`INSERT INTO lotes_voucher (numero_lote, numero_desde, numero_hasta, estado) VALUES (882, 1, 50, 'activo') RETURNING id`)
    const n883Res = await pool.query(`INSERT INTO lotes_voucher (numero_lote, numero_desde, numero_hasta, estado) VALUES (883, 1, 50, 'preparado') RETURNING id`)
    const l882Id = n882Res.rows[0].id
    const l883Id = n883Res.rows[0].id

    // Intentar activar 883 mientras 882 está activo: debe ser 409
    const resConflictoActivos = await app.inject({
      method: 'PATCH',
      url: `/lotes/${l883Id}/activar`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resConflictoActivos.statusCode, 409)
    assert.match(JSON.parse(resConflictoActivos.body).error, /Ya hay un lote activo \(Lote 882\)/i)
    console.log('   [OK] Activar segundo lote rechazado con 409 indicando el lote activo actual.')

    // -------------------------------------------------------------------------
    // TEST 10: Eliminar lote: solo no usado y no activo
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 10] Eliminar lote: activo y usado rechazados; solo sin usar permitido...')
    // 1. Intentar eliminar Lote 882 (activo): debe fallar 409
    const resDelActivo = await app.inject({
      method: 'DELETE',
      url: `/lotes/${l882Id}`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resDelActivo.statusCode, 409)
    assert.match(JSON.parse(resDelActivo.body).error, /está activo actualmente en sala/i)

    // 2. Intentar eliminar Lote 881 (usado, cerrado): debe fallar 409
    const resDelUsado = await app.inject({
      method: 'DELETE',
      url: `/lotes/${lote881Id}`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resDelUsado.statusCode, 409)
    assert.match(JSON.parse(resDelUsado.body).error, /ya ha sido utilizado/i)

    // 3. Eliminar Lote 883 (preparado, nunca usado): debe tener éxito (200)
    wsEvents.length = 0
    const resDelSinUsar = await app.inject({
      method: 'DELETE',
      url: `/lotes/${l883Id}`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resDelSinUsar.statusCode, 200)
    assert.ok(wsEvents.some(e => e.tipo === 'lote_eliminado'), 'Debe emitir lote_eliminado')

    // Comprobar que liberó su numero_lote 883 (crear otro con número 883)
    const resReusarNumLote = await pool.query(`
      INSERT INTO lotes_voucher (numero_lote, numero_desde, numero_hasta, estado)
      VALUES (883, 1, 50, 'preparado') RETURNING id
    `)
    assert.ok(resReusarNumLote.rows[0].id, 'El número del lote eliminado debe quedar libre para reutilizarse')
    console.log('   [OK] Solo lotes sin usar y no activos pueden eliminarse; el número queda libre para reutilizarse.')

    // -------------------------------------------------------------------------
    // TEST 11: Modo Kiosko independiente de los lotes
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 11] Modo kiosko independiente de los lotes...')
    // Activar modo kiosko_web en configuracion
    await pool.query(`UPDATE configuracion SET valor = 'true' WHERE clave = 'kiosko_web_activo'`)
    await pool.query(`UPDATE configuracion SET valor = 'kiosko_web' WHERE clave = 'modo_generacion_turnos'`)

    // Generar turno de kiosko
    const resKioskoTurno = await app.inject({
      method: 'POST',
      url: '/kiosko/turnos'
    })
    assert.equal(resKioskoTurno.statusCode, 201)
    const tKiosko = JSON.parse(resKioskoTurno.body).turno

    // Pausar todos los lotes de vouchers físicos
    await pool.query(`UPDATE lotes_voucher SET estado = 'pausado' WHERE estado = 'activo'`)

    // El operador llama siguiente en modo kiosko: debe tomar el turno de kiosko a pesar de no haber lote físico activo
    const resLlamarKiosko = await app.inject({
      method: 'POST',
      url: '/turnos/llamar',
      headers: { authorization: `Bearer ${op1Token}` },
      payload: { mesa_id: parseInt(mesa961Id, 10) }
    })
    assert.equal(resLlamarKiosko.statusCode, 200)
    assert.equal(JSON.parse(resLlamarKiosko.body).turno.origen, 'kiosko_web')
    console.log('   [OK] Modo kiosko opera con numeración propia independiente del estado de los lotes físicos.')

    // Restaurar modo voucher_fisico
    await pool.query(`UPDATE configuracion SET valor = 'voucher_fisico' WHERE clave = 'modo_generacion_turnos'`)

  } finally {
    // Restaurar broadcast original y limpiar datos de prueba
    app.broadcast = originalBroadcast
    await pool.query(`UPDATE configuracion SET valor = 'voucher_fisico' WHERE clave = 'modo_generacion_turnos'`)
    await pool.query(`DELETE FROM turnos WHERE lote_id IN (SELECT id FROM lotes_voucher WHERE numero_lote IN (881, 882, 883, 884)) OR (numero >= 9600 AND numero <= 9700)`)
    await pool.query(`DELETE FROM mesas WHERE numero IN (961, 962, 963)`)
    await pool.query(`DELETE FROM usuarios WHERE username IN ('adm_test1', 'adm_test2', 'op_test1', 'op_test2')`)
    await pool.query(`DELETE FROM lotes_voucher WHERE numero_lote IN (881, 882, 883, 884)`)
    await pool.end()
  }

  console.log('\n======================================================================')
  console.log(' ¡TODAS LAS COMPROBACIONES DE PASO 3 COMPLETADAS CON ÉXITO!')
  console.log('======================================================================\n')
}

runUsuariosLotesTests().catch(err => {
  console.error('\n❌ ERROR EN PRUEBAS:', err)
  process.exit(1)
})
