'use strict'

const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const assert = require('node:assert/strict')
require('dotenv').config()

const buildApp = require('../src/app')

async function runMonitoreoMesasTests() {
  console.log('======================================================================')
  console.log(' TEST PASO 3: MONITOREO EN VIVO Y GESTIÓN DE MESAS MULTI-SESIÓN')
  console.log('======================================================================\n')

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  })

  const app = await buildApp()
  const jwtSecret = process.env.JWT_SECRET || 'dev_secret_jwt_matriculas_2026'
  const passHash = await bcrypt.hash('Test2026!', 10)

  // Limpieza inicial
  await pool.query(`DELETE FROM turnos WHERE numero >= 9500 AND numero <= 9600`)
  await pool.query(`DELETE FROM mesas WHERE numero IN (951, 952, 953, 954, 955)`)
  await pool.query(`DELETE FROM usuarios WHERE username IN ('admin_m1', 'admin_m2', 'op_m1', 'op_m2')`)

  // 1. Usuarios: 2 Admins y 2 Operadores
  const [admin1Res, admin2Res, op1Res, op2Res] = await Promise.all([
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('admin_m1', $1, 'admin', 'Admin Uno', true) RETURNING id`, [passHash]),
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('admin_m2', $1, 'admin', 'Admin Dos', true) RETURNING id`, [passHash]),
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('op_m1', $1, 'operador', 'Operador Uno', true) RETURNING id`, [passHash]),
    pool.query(`INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo) VALUES ('op_m2', $1, 'operador', 'Operador Dos', true) RETURNING id`, [passHash])
  ])

  const admin1Id = parseInt(admin1Res.rows[0].id, 10)
  const admin2Id = parseInt(admin2Res.rows[0].id, 10)
  const op1Id = parseInt(op1Res.rows[0].id, 10)
  const op2Id = parseInt(op2Res.rows[0].id, 10)

  const admin1Token = jwt.sign({ id: admin1Id, username: 'admin_m1', rol: 'admin', nombre_completo: 'Admin Uno' }, jwtSecret)
  const admin2Token = jwt.sign({ id: admin2Id, username: 'admin_m2', rol: 'admin', nombre_completo: 'Admin Dos' }, jwtSecret)
  const op1Token = jwt.sign({ id: op1Id, username: 'op_m1', rol: 'operador', nombre_completo: 'Operador Uno' }, jwtSecret)
  const op2Token = jwt.sign({ id: op2Id, username: 'op_m2', rol: 'operador', nombre_completo: 'Operador Dos' }, jwtSecret)

  // Capturador de eventos WebSocket
  const wsEvents = []
  const originalBroadcast = app.broadcast
  app.broadcast = async (canal, tipo, payload) => {
    wsEvents.push({ canal, tipo, payload, ts: Date.now() })
    return originalBroadcast.call(app, canal, tipo, payload)
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 2: Crear mesa activa (aparece en disponibles) vs inactiva (no aparece)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 2] Crear mesa activa vs inactiva...')
    wsEvents.length = 0

    const resMesaActiva = await app.inject({
      method: 'POST',
      url: '/mesas',
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { numero: 951, nombre: 'Mesa Activa 951', estado: 'activa' }
    })
    assert.equal(resMesaActiva.statusCode, 201)
    const m951 = JSON.parse(resMesaActiva.body).mesa
    assert.equal(m951.estado, 'activa')

    // Verificar avisos WS emitidos
    assert.ok(wsEvents.some(e => e.canal === 'admin:all' && e.tipo === 'mesa_actualizada'), 'Debe emitir mesa_actualizada a admin:all')
    assert.ok(wsEvents.some(e => e.canal === 'tv:global' && e.tipo === 'mesas_disponibles_actualizadas' && e.payload.accion === 'liberada'), 'Debe emitir a tv:global para selección de mesa')

    // Verificar que aparece en /auth/mesas/disponibles
    const resDisp1 = await app.inject({
      method: 'GET',
      url: '/auth/mesas/disponibles',
      headers: { authorization: `Bearer ${op1Token}` }
    })
    const mesasDisp1 = JSON.parse(resDisp1.body).mesas
    assert.ok(mesasDisp1.some(m => m.numero === 951), 'Mesa 951 activa debe estar disponible en login')

    // Crear mesa inactiva
    wsEvents.length = 0
    const resMesaInact = await app.inject({
      method: 'POST',
      url: '/mesas',
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { numero: 952, nombre: 'Mesa Inactiva 952', estado: 'inactiva' }
    })
    assert.equal(resMesaInact.statusCode, 201)
    const m952 = JSON.parse(resMesaInact.body).mesa
    assert.equal(m952.estado, 'inactiva')

    // Mesa inactiva NO debe emitir a tv:global para selección
    assert.ok(!wsEvents.some(e => e.canal === 'tv:global' && e.tipo === 'mesas_disponibles_actualizadas'), 'Mesa inactiva no debe anunciarse en selección')
    const resDisp2 = await app.inject({
      method: 'GET',
      url: '/auth/mesas/disponibles',
      headers: { authorization: `Bearer ${op1Token}` }
    })
    const mesasDisp2 = JSON.parse(resDisp2.body).mesas
    assert.ok(!mesasDisp2.some(m => m.numero === 952), 'Mesa inactiva NO debe aparecer en selección')
    console.log('   [OK] Mesa activa aparece disponible de inmediato; inactiva no.')

    // -------------------------------------------------------------------------
    // TEST 3: Editar mesa (se refleja en todas partes: admin, operador, login)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 3] Editar mesa (número y nombre en vivo)...')
    wsEvents.length = 0
    const resEdit = await app.inject({
      method: 'PATCH',
      url: `/mesas/${m951.id}`,
      headers: { authorization: `Bearer ${admin2Token}` },
      payload: { nombre: 'Mesa 951 Renombrada' }
    })
    assert.equal(resEdit.statusCode, 200)

    // Verificar difusiones: admin:all, mesa:id, tv:global
    assert.ok(wsEvents.some(e => e.canal === 'admin:all' && e.tipo === 'mesa_actualizada'), 'Debe emitir a admin:all')
    assert.ok(wsEvents.some(e => e.canal === `mesa:${m951.id}` && e.tipo === 'mesa_actualizada'), 'Debe emitir al canal de la mesa')
    assert.ok(wsEvents.some(e => e.canal === 'tv:global' && e.tipo === 'mesas_disponibles_actualizadas'), 'Debe emitir a tv:global para grilla login')
    console.log('   [OK] Edición de mesa emitida a admin, consola de operador y grilla login.')

    // -------------------------------------------------------------------------
    // TEST 4: Inactivar y eliminar mesa libre mientras otro mira selección
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 4] Inactivar y eliminar mesa libre...')
    wsEvents.length = 0
    const resInactMesa = await app.inject({
      method: 'PATCH',
      url: `/mesas/${m951.id}/estado`,
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { estado: 'inactiva' }
    })
    assert.equal(resInactMesa.statusCode, 200)
    await new Promise(r => setTimeout(r, 100))
    assert.ok(wsEvents.some(e => e.canal === 'tv:global' && e.tipo === 'mesas_disponibles_actualizadas' && (e.payload.accion === 'inactivada' || e.payload.accion === 'tomada')), 'Debe avisar a tv:global para retirar mesa de grilla')

    wsEvents.length = 0
    const resDelMesa = await app.inject({
      method: 'DELETE',
      url: `/mesas/${m952.id}`,
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resDelMesa.statusCode, 200)
    await new Promise(r => setTimeout(r, 100))
    assert.ok(wsEvents.some(e => e.canal === 'admin:all' && e.tipo === 'mesa_actualizada'), 'Debe avisar a admin:all de eliminación')
    console.log('   [OK] Inactivar y eliminar mesa libre emiten eventos inmediatos de retiro.')

    // -------------------------------------------------------------------------
    // TEST 5: Un operador en una sola mesa, una mesa con un solo operador (concurrencia)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 5] Asignación única y rechazo ante dos asignaciones simultáneas...')
    // Reactivar 951 y crear 953
    await pool.query(`UPDATE mesas SET estado = 'activa' WHERE id = $1`, [m951.id])
    const m953Res = await pool.query(`INSERT INTO mesas (numero, nombre, estado) VALUES (953, 'Mesa 953', 'activa') RETURNING id`)
    const m953Id = m953Res.rows[0].id

    // Asignar op1 a mesa 951
    const resAsig1 = await app.inject({
      method: 'PATCH',
      url: `/mesas/${m951.id}/asignar`,
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { operador_id: op1Id }
    })
    assert.equal(resAsig1.statusCode, 200)

    // Intentar asignar op1 a mesa 953 (debe rechazarse con 409 y decir cuál mesa tiene)
    const resAsigDupl = await app.inject({
      method: 'PATCH',
      url: `/mesas/${m953Id}/asignar`,
      headers: { authorization: `Bearer ${admin2Token}` },
      payload: { operador_id: op1Id }
    })
    assert.equal(resAsigDupl.statusCode, 409)
    const errDupl = JSON.parse(resAsigDupl.body).error
    assert.match(errDupl, /Mesa 951/i, 'El mensaje de error debe indicar claramente qué mesa tiene asignada')
    console.log('   [OK] Operador en dos mesas rechazado indicando la mesa asignada.')

    // -------------------------------------------------------------------------
    // TEST 6: Cambiar de operador (A quitado, B puesto con A conectado)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 6] Cambiar de operador: A va al inicio con aviso, B asignado...')
    wsEvents.length = 0
    const resCambioOp = await app.inject({
      method: 'PATCH',
      url: `/mesas/${m951.id}/asignar`,
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { operador_id: op2Id }
    })
    assert.equal(resCambioOp.statusCode, 200)

    // Operador A (op1) debe recibir aviso de desasignación
    const eventoDesasig = wsEvents.find(e => e.canal === 'tv:global' && e.tipo === 'operador_desasignado_por_admin' && e.payload.operador_id === op1Id)
    assert.ok(eventoDesasig, 'Operador anterior debe recibir operador_desasignado_por_admin')
    const eventoMesaInact = wsEvents.find(e => e.canal === `mesa:${m951.id}` && e.tipo === 'mesa_inactivada' && e.payload.motivo === 'operador_reasignado_por_admin')
    assert.ok(eventoMesaInact, 'Consola del operador anterior debe recibir mesa_inactivada con motivo de reasignación')

    // Operador B (op2) debe recibir aviso de asignación
    const eventoAsigB = wsEvents.find(e => e.canal === 'tv:global' && e.tipo === 'operador_asignado_por_admin' && e.payload.operador_id === op2Id)
    assert.ok(eventoAsigB, 'Nuevo operador debe recibir operador_asignado_por_admin')
    console.log('   [OK] Operador anterior notificado para volver al login; nuevo operador redirigido a mesa.')

    // -------------------------------------------------------------------------
    // TEST 7: Unicidad de número de mesa (inactiva conserva, eliminada libera)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 7] Unicidad de número: inactiva conserva, eliminada libera...')
    // Inactivar mesa 953
    await pool.query(`UPDATE mesas SET estado = 'inactiva' WHERE id = $1`, [m953Id])

    // Intentar crear mesa con número 953 (inactiva pero existente): debe fallar 409
    const resNumRepetido = await app.inject({
      method: 'POST',
      url: '/mesas',
      headers: { authorization: `Bearer ${admin1Token}` },
      payload: { numero: 953, nombre: 'Mesa Repetida' }
    })
    assert.equal(resNumRepetido.statusCode, 409)
    assert.match(JSON.parse(resNumRepetido.body).error, /ya está asignado/i)

    // Eliminar lógicamente mesa 953
    await pool.query(`UPDATE mesas SET estado = 'eliminada', eliminado_en = NOW() WHERE id = $1`, [m953Id])

    // Ahora crear con número 953: debe tener éxito porque la eliminada liberó el número
    const resNumLiberado = await app.inject({
      method: 'POST',
      url: '/mesas',
      headers: { authorization: `Bearer ${admin2Token}` },
      payload: { numero: 953, nombre: 'Mesa Reutilizada 953', estado: 'activa' }
    })
    assert.equal(resNumLiberado.statusCode, 201)
    console.log('   [OK] Mesa inactiva conserva su número; mesa eliminada libera el número para reutilización.')

    // -------------------------------------------------------------------------
    // TEST 8: Monitoreo en vivo ante acciones (llamar, re-llamar, cancelar, etc.)
    // -------------------------------------------------------------------------
    console.log('[COMPROBACIÓN 8] Monitoreo en vivo ante re-llamado y coincidencia de cifras...')
    // Crear lote para llamados
    let loteId
    const loteExistente = await pool.query(`SELECT id FROM lotes_voucher WHERE estado = 'activo' LIMIT 1`)
    if (loteExistente.rows.length === 0) {
      const nLote = await pool.query(`INSERT INTO lotes_voucher (numero_lote, numero_desde, numero_hasta, ultimo_numero_llamado, estado) VALUES (995, 1, 500, 10, 'activo') RETURNING id`)
      loteId = nLote.rows[0].id
    } else {
      loteId = loteExistente.rows[0].id
    }

    // Crear turno en atención en mesa 951 (con op2)
    const turnoRes = await pool.query(`
      INSERT INTO turnos (numero, mesa_id, operador_id, lote_id, estado, origen, llamado_en)
      VALUES (9555, $1, $2, $3, 'en_atencion', 'voucher_fisico', NOW())
      RETURNING id
    `, [m951.id, op2Id, loteId])
    const turnoId = turnoRes.rows[0].id

    // Re-llamar turno
    wsEvents.length = 0
    const resRellamar = await app.inject({
      method: 'POST',
      url: `/turnos/${turnoId}/rellamar`,
      headers: { authorization: `Bearer ${op2Token}` },
      payload: { mesa_id: parseInt(m951.id, 10) }
    })
    assert.equal(resRellamar.statusCode, 200)

    // Esperar eventos post-commit
    await new Promise(r => setTimeout(r, 100))
    assert.ok(wsEvents.some(e => e.canal === 'admin:all' && (e.tipo === 'turno_rellamado' || e.tipo === 'kpi_update')), 'Re-llamado debe notificar a admin:all de inmediato')

    // Verificar cifras de /admin/kpis
    const resKpis = await app.inject({
      method: 'GET',
      url: '/admin/kpis',
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    assert.equal(resKpis.statusCode, 200)
    const kpisData = JSON.parse(resKpis.body)
    assert.ok(kpisData.en_atencion_ahora >= 1, 'Debe registrar turno en atención real')
    assert.ok(kpisData.mesas_activas >= 1, 'Mesas activas con operador debe coincidir con base de datos')

    // Comparar con /admin/reportes/datos
    const resReportes = await app.inject({
      method: 'GET',
      url: '/admin/reportes/datos',
      headers: { authorization: `Bearer ${admin1Token}` }
    })
    const repData = JSON.parse(resReportes.body)
    assert.equal(kpisData.mesas_activas, repData.kpis.mesas_activas, 'Cifra de mesas_activas debe coincidir exactamente entre Monitoreo y Reportes')
    console.log('   [OK] Re-llamado llega a admin:all en vivo y cifras coinciden con la BD y Reportes.')

  } finally {
    // Restaurar broadcast original y limpiar datos de prueba
    app.broadcast = originalBroadcast
    await pool.query(`DELETE FROM turnos WHERE numero >= 9500 AND numero <= 9600`)
    await pool.query(`DELETE FROM mesas WHERE numero IN (951, 952, 953, 954, 955)`)
    await pool.query(`DELETE FROM usuarios WHERE username IN ('admin_m1', 'admin_m2', 'op_m1', 'op_m2')`)
    await pool.end()
  }

  console.log('\n======================================================================')
  console.log(' ¡TODAS LAS PRUEBAS DE PASO 3 COMPLETADAS CON ÉXITO!')
  console.log('======================================================================\n')
}

runMonitoreoMesasTests().catch(err => {
  console.error('\n❌ ERROR EN PRUEBAS:', err)
  process.exit(1)
})
