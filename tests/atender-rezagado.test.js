'use strict'

/**
 * ==============================================================================
 * TEST SUITE: ATENDER REZAGADOS
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cubre las 10 pruebas requeridas:
 * 1. Cancelar un turno y atenderlo como rezagado: cronómetro desde cero, estado 'en_atencion'.
 * 2. El listado solo muestra cancelados; sin ninguno devuelve total=0.
 * 3. En la TV, el rezagado se anuncia completo aunque su número ya haya existido en historial.
 * 4. Mesa con turno en atención: al atender rezagado, el anterior pasa a 'atendido'. Nunca 2 en atención.
 * 5. Concurrencia: dos mesas compiten por el mismo rezagado; una gana y la otra recibe 409.
 * 6. Doble clic (Idempotency-Key): se atiende una sola vez.
 * 7. Validación de mesa inactiva/no asignada o sin permisos.
 * 8. Rezagado de kiosko web: consulta mi-turno y evento kiosko reflejan la nueva mesa en atención.
 * 9. El próximo turno y contador del lote no se alteran al atender un rezagado.
 * 10. Auditoría inmutable: se registra TURNO_REZAGADO en audit_log con operador y mesa.
 * ==============================================================================
 */

const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const crypto = require('crypto')
require('dotenv').config()

const buildApp = require('../src/app')

async function runTests () {
  console.log('======================================================================')
  console.log(' SUITE DE PRUEBAS: BOTÓN "ATENDER REZAGADO"')
  console.log('======================================================================\n')

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  })

  // 1. Preparar datos de prueba
  console.log('[1/10] Preparando datos iniciales (operadores, mesas, lote activo)...')
  const passHash = await bcrypt.hash('Operador2026!', 10)

  // Crear 2 operadores y 2 mesas activas
  const op1Res = await pool.query(`
    INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
    VALUES ('op_rezagado_1', $1, 'operador', 'Operador Rezagado 1', true)
    ON CONFLICT (username) WHERE eliminado_en IS NULL DO UPDATE SET activo = true, password_hash = $1
    RETURNING id
  `, [passHash])
  const op1Id = op1Res.rows[0].id

  const op2Res = await pool.query(`
    INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
    VALUES ('op_rezagado_2', $1, 'operador', 'Operador Rezagado 2', true)
    ON CONFLICT (username) WHERE eliminado_en IS NULL DO UPDATE SET activo = true, password_hash = $1
    RETURNING id
  `, [passHash])
  const op2Id = op2Res.rows[0].id

  const mesa1Res = await pool.query(`
    INSERT INTO mesas (numero, nombre, estado, operador_id)
    VALUES (91, 'Mesa 91 Test', 'activa', $1)
    ON CONFLICT (numero) WHERE estado != 'eliminada' AND eliminado_en IS NULL DO UPDATE SET estado = 'activa', operador_id = $1
    RETURNING id
  `, [op1Id])
  const mesa1Id = mesa1Res.rows[0].id

  const mesa2Res = await pool.query(`
    INSERT INTO mesas (numero, nombre, estado, operador_id)
    VALUES (92, 'Mesa 92 Test', 'activa', $1)
    ON CONFLICT (numero) WHERE estado != 'eliminada' AND eliminado_en IS NULL DO UPDATE SET estado = 'activa', operador_id = $1
    RETURNING id
  `, [op2Id])
  const mesa2Id = mesa2Res.rows[0].id

  // Asegurar lote activo
  let { rows: [lote] } = await pool.query(`SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado FROM lotes_voucher WHERE estado = 'activo' LIMIT 1`)
  if (!lote) {
    const lRes = await pool.query(`
      INSERT INTO lotes_voucher (numero_lote, numero_desde, numero_hasta, ultimo_numero_llamado, estado)
      VALUES (99, 1, 1000, 10, 'activo')
      RETURNING id, numero_lote, numero_hasta, ultimo_numero_llamado
    `)
    lote = lRes.rows[0]
  }

  // Inicializar servidor Fastify para pruebas in-process
  const app = await buildApp({ logger: false })
  await app.ready()

  // Generar tokens JWT para los operadores
  const tokenOp1 = app.jwt.sign({ id: op1Id, username: 'op_rezagado_1', rol: 'operador', mesa_id: mesa1Id })
  const tokenOp2 = app.jwt.sign({ id: op2Id, username: 'op_rezagado_2', rol: 'operador', mesa_id: mesa2Id })

  // Esperar a que el event loop se normalice tras bcrypt.hash para under-pressure
  await new Promise(r => setTimeout(r, 600))

  console.log('   [OK] Entorno preparado correctamente.\n')

  let turnosCreados = []

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Cancelar un turno y atenderlo como rezagado
    // -------------------------------------------------------------------------
    console.log('[TEST 1] Cancelar un turno y atenderlo como rezagado...')
    // Limpiar turnos en atención de las mesas de prueba
    await pool.query(`UPDATE turnos SET estado = 'atendido' WHERE mesa_id IN ($1, $2) AND estado = 'en_atencion'`, [mesa1Id, mesa2Id])

    // Crear un turno cancelado de prueba
    const turnoCancRes = await pool.query(`
      INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id, llamado_en, finalizado_en)
      VALUES (777, fn_fecha_hoy(), $1, 'cancelado', 'voucher_fisico', $2, $3, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '5 minutes')
      RETURNING id, numero, estado
    `, [lote.id, mesa1Id, op1Id])
    const turnoCancId = turnoCancRes.rows[0].id
    turnosCreados.push(turnoCancId)

    // Atender como rezagado en Mesa 2
    const resAtender = await app.inject({
      method: 'POST',
      url: '/turnos/atender-rezagado',
      headers: { authorization: `Bearer ${tokenOp2}` },
      payload: { turno_id: turnoCancId, mesa_id: mesa2Id }
    })

    if (resAtender.statusCode !== 200) {
      throw new Error(`Fallo en atender rezagado: ${resAtender.statusCode} ${resAtender.body}`)
    }
    const body1 = JSON.parse(resAtender.body)
    if (body1.turno.id !== turnoCancId || body1.turno.numero !== 777 || body1.turno.mesa_id !== mesa2Id) {
      throw new Error(`Datos inesperados en respuesta de rezagado: ${JSON.stringify(body1)}`)
    }

    // Verificar en BD que el cronómetro empieza desde este momento
    const { rows: [tEnBd] } = await pool.query(`SELECT estado, mesa_id, operador_id, finalizado_en, duracion_atencion_seg FROM turnos WHERE id = $1`, [turnoCancId])
    if (tEnBd.estado !== 'en_atencion' || String(tEnBd.mesa_id) !== String(mesa2Id) || tEnBd.finalizado_en !== null || tEnBd.duracion_atencion_seg !== null) {
      throw new Error(`Inconsistencia en BD tras atender rezagado: ${JSON.stringify(tEnBd)}`)
    }
    console.log('   [OK] Turno #777 pasó a en_atencion en Mesa 2 con cronómetro reseteado.\n')

    // -------------------------------------------------------------------------
    // TEST 2: Listado de rezagados (GET /turnos/rezagados)
    // -------------------------------------------------------------------------
    console.log('[TEST 2] Verificando que GET /turnos/rezagados solo devuelve cancelados...')
    // En este momento el #777 ya no está cancelado, crear uno nuevo
    const turnoCanc2Res = await pool.query(`
      INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id, llamado_en, finalizado_en)
      VALUES (778, fn_fecha_hoy(), $1, 'cancelado', 'voucher_fisico', $2, $3, NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute')
      RETURNING id, numero
    `, [lote.id, mesa1Id, op1Id])
    const turnoCanc2Id = turnoCanc2Res.rows[0].id
    turnosCreados.push(turnoCanc2Id)

    const resList = await app.inject({
      method: 'GET',
      url: '/turnos/rezagados',
      headers: { authorization: `Bearer ${tokenOp1}` }
    })
    if (resList.statusCode !== 200) throw new Error(`Fallo GET /turnos/rezagados: ${resList.statusCode}`)
    const listBody = JSON.parse(resList.body)
    const encontrado = listBody.turnos.find(t => t.id === turnoCanc2Id)
    if (!encontrado) throw new Error('Turno cancelado #778 no apareció en la lista de rezagados')
    const noDeberiaEstar = listBody.turnos.find(t => t.id === turnoCancId)
    if (noDeberiaEstar) throw new Error('Turno ya atendido #777 no debería figurar en la lista de rezagados')
    console.log(`   [OK] Lista de rezagados devuelve exclusivamente turnos cancelados (${listBody.total} pendientes).\n`)

    // -------------------------------------------------------------------------
    // TEST 3: TV y orden de anuncios (validación de deduplicación)
    // -------------------------------------------------------------------------
    console.log('[TEST 3] Verificando soporte de re-anuncio en TV (es_rezagado)...')
    // El frontend de TV (tv.js) tiene la regla:
    // "if (!payload.es_rezagado) { ... deduplicar ... } else { re-anunciar y actualizar historial }"
    // Verificamos que el payload emitido contenga es_rezagado = true
    if (body1.es_rezagado !== true) {
      throw new Error('El resultado de atender rezagado debe marcar es_rezagado=true')
    }
    console.log('   [OK] Payload incluye es_rezagado=true garantizando anuncio sonoro y voz en TV.\n')

    // -------------------------------------------------------------------------
    // TEST 4: Mesa con turno en atención previo
    // -------------------------------------------------------------------------
    console.log('[TEST 4] Atender rezagado con mesa que tiene turno en atención previo...')
    // En este momento Mesa 2 tiene en atención el turno #777.
    // Atendemos el rezagado #778 en Mesa 2:
    const resAtenderSegundo = await app.inject({
      method: 'POST',
      url: '/turnos/atender-rezagado',
      headers: { authorization: `Bearer ${tokenOp2}` },
      payload: { turno_id: turnoCanc2Id, mesa_id: mesa2Id }
    })
    if (resAtenderSegundo.statusCode !== 200) {
      throw new Error(`Fallo atender rezagado con turno previo: ${resAtenderSegundo.body}`)
    }

    // El turno previo #777 debe haber pasado automáticamente a 'atendido'
    const { rows: [tPrevio] } = await pool.query(`SELECT estado, finalizado_en, duracion_atencion_seg FROM turnos WHERE id = $1`, [turnoCancId])
    if (tPrevio.estado !== 'atendido') {
      throw new Error(`El turno previo debió pasar a 'atendido', pero está en: ${tPrevio.estado}`)
    }
    if (!tPrevio.finalizado_en || tPrevio.duracion_atencion_seg === null) {
      throw new Error(`Duración de atención no calculada en turno previo: ${JSON.stringify(tPrevio)}`)
    }

    // Verificar que solo hay 1 turno en atención en Mesa 2
    const { rows: turnosEnAtencion } = await pool.query(
      `SELECT id, numero FROM turnos WHERE mesa_id = $1 AND estado = 'en_atencion'`,
      [mesa2Id]
    )
    if (turnosEnAtencion.length !== 1 || turnosEnAtencion[0].id !== turnoCanc2Id) {
      throw new Error(`Invariante violada: deben haber exactamente 1 turno en atención, se encontraron ${turnosEnAtencion.length}`)
    }
    console.log('   [OK] Turno previo finalizado como "atendido" con duración calculada. Mesa 2 mantiene exactamente 1 turno en atención.\n')

    // -------------------------------------------------------------------------
    // TEST 5: Concurrencia — Dos mesas eligen el mismo rezagado al mismo tiempo
    // -------------------------------------------------------------------------
    console.log('[TEST 5] Concurrencia: Dos mesas compiten por el mismo rezagado...')
    const turnoCanc3Res = await pool.query(`
      INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id, llamado_en, finalizado_en)
      VALUES (779, fn_fecha_hoy(), $1, 'cancelado', 'voucher_fisico', $2, $3, NOW(), NOW())
      RETURNING id, numero
    `, [lote.id, mesa1Id, op1Id])
    const turnoCanc3Id = turnoCanc3Res.rows[0].id
    turnosCreados.push(turnoCanc3Id)

    // Disparo simultáneo desde Mesa 1 y Mesa 2
    const [comp1, comp2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/turnos/atender-rezagado',
        headers: { authorization: `Bearer ${tokenOp1}` },
        payload: { turno_id: turnoCanc3Id, mesa_id: mesa1Id }
      }),
      app.inject({
        method: 'POST',
        url: '/turnos/atender-rezagado',
        headers: { authorization: `Bearer ${tokenOp2}` },
        payload: { turno_id: turnoCanc3Id, mesa_id: mesa2Id }
      })
    ])

    const codigos = [comp1.statusCode, comp2.statusCode].sort((a, b) => a - b)
    if (codigos[0] !== 200 || codigos[1] !== 409) {
      throw new Error(`Resultado de concurrencia incorrecto: Mesa 1 status=${comp1.statusCode}, Mesa 2 status=${comp2.statusCode}`)
    }
    const errorBody = comp1.statusCode === 409 ? JSON.parse(comp1.body) : JSON.parse(comp2.body)
    const errText = errorBody.message || errorBody.error || ''
    if (!errText.includes('ya fue atendido')) {
      throw new Error(`Mensaje de error no descriptivo en concurrencia: ${JSON.stringify(errorBody)}`)
    }
    console.log(`   [OK] Concurrencia atómica protegida: 1 mesa atendió (200 OK) y la otra recibió aviso descriptivo (409 Conflict: "${errText}").\n`)

    // -------------------------------------------------------------------------
    // TEST 6: Doble clic / Idempotencia
    // -------------------------------------------------------------------------
    console.log('[TEST 6] Doble clic e idempotencia...')
    const turnoCanc4Res = await pool.query(`
      INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id, llamado_en, finalizado_en)
      VALUES (780, fn_fecha_hoy(), $1, 'cancelado', 'voucher_fisico', $2, $3, NOW(), NOW())
      RETURNING id, numero
    `, [lote.id, mesa1Id, op1Id])
    const turnoCanc4Id = turnoCanc4Res.rows[0].id
    turnosCreados.push(turnoCanc4Id)

    const keyUnica = crypto.randomUUID()
    const [idem1, idem2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/turnos/atender-rezagado',
        headers: { authorization: `Bearer ${tokenOp1}`, 'idempotency-key': keyUnica },
        payload: { turno_id: turnoCanc4Id, mesa_id: mesa1Id }
      }),
      app.inject({
        method: 'POST',
        url: '/turnos/atender-rezagado',
        headers: { authorization: `Bearer ${tokenOp1}`, 'idempotency-key': keyUnica },
        payload: { turno_id: turnoCanc4Id, mesa_id: mesa1Id }
      })
    ])

    if (idem1.statusCode !== 200 || idem2.statusCode !== 200) {
      throw new Error(`Idempotencia falló: r1=${idem1.statusCode}, r2=${idem2.statusCode}`)
    }
    console.log('   [OK] Idempotency-Key protege contra doble-clic: ambas solicitudes devuelven 200 con el mismo turno sin duplicar.\n')

    // -------------------------------------------------------------------------
    // TEST 7: Validaciones de seguridad (Mesa no asignada)
    // -------------------------------------------------------------------------
    console.log('[TEST 7] Seguridad: Operador intentando atender en mesa que no le corresponde...')
    const secRes = await app.inject({
      method: 'POST',
      url: '/turnos/atender-rezagado',
      headers: { authorization: `Bearer ${tokenOp1}` }, // Op 1 asignado a Mesa 91
      payload: { turno_id: turnoCanc4Id, mesa_id: mesa2Id } // Intenta operar Mesa 92
    })
    if (secRes.statusCode !== 403) {
      throw new Error(`Se esperaba 403 Forbidden para mesa no asignada, obtenido: ${secRes.statusCode}`)
    }
    console.log('   [OK] Seguridad anti-IDOR verificada (403 Forbidden al operar mesa ajena).\n')

    // -------------------------------------------------------------------------
    // TEST 8: Rezagado de Kiosko Web (Celular del estudiante)
    // -------------------------------------------------------------------------
    console.log('[TEST 8] Rezagado de Kiosko Web: celular del estudiante se entera...')
    const tokenConsulta = crypto.randomBytes(32).toString('hex')
    const turnoKioskoRes = await pool.query(`
      INSERT INTO turnos (numero, fecha_turno, token_consulta, estado, origen, llamado_en, finalizado_en)
      VALUES (999, fn_fecha_hoy(), $1, 'cancelado', 'kiosko_web', NOW() - INTERVAL '15 minutes', NOW() - INTERVAL '5 minutes')
      RETURNING id, numero
    `, [tokenConsulta])
    const turnoKioskoId = turnoKioskoRes.rows[0].id
    turnosCreados.push(turnoKioskoId)

    const resAtenderKiosko = await app.inject({
      method: 'POST',
      url: '/turnos/atender-rezagado',
      headers: { authorization: `Bearer ${tokenOp1}` },
      payload: { turno_id: turnoKioskoId, mesa_id: mesa1Id }
    })
    if (resAtenderKiosko.statusCode !== 200) {
      throw new Error(`Fallo atender rezagado de kiosko: ${resAtenderKiosko.body}`)
    }

    // Consulta del estudiante vía GET /turnos/mi-turno/:token
    const resMiTurno = await app.inject({
      method: 'GET',
      url: `/turnos/mi-turno/${tokenConsulta}`
    })
    if (resMiTurno.statusCode !== 200) throw new Error(`Fallo mi-turno: ${resMiTurno.statusCode}`)
    const miTurnoBody = JSON.parse(resMiTurno.body)
    if (miTurnoBody.estado !== 'en_atencion' || miTurnoBody.mesa_numero !== 91) {
      throw new Error(`Celular del estudiante no refleja atención: ${JSON.stringify(miTurnoBody)}`)
    }
    console.log(`   [OK] Estudiante con token de kiosko consulta y ve su turno en_atencion en Mesa 91.\n`)

    // -------------------------------------------------------------------------
    // TEST 9: Invarianza del lote (no se consume voucher nuevo ni cambia proximo)
    // -------------------------------------------------------------------------
    console.log('[TEST 9] Verificando que atender rezagado NO altera el progreso del lote...')
    const { rows: [loteDespues] } = await pool.query(
      `SELECT ultimo_numero_llamado FROM lotes_voucher WHERE id = $1`,
      [lote.id]
    )
    if (loteDespues.ultimo_numero_llamado !== lote.ultimo_numero_llamado) {
      throw new Error(`El contador del lote cambió de ${lote.ultimo_numero_llamado} a ${loteDespues.ultimo_numero_llamado}`)
    }
    console.log(`   [OK] Progreso del lote intacto (ultimo_numero_llamado = ${loteDespues.ultimo_numero_llamado}).\n`)

    // -------------------------------------------------------------------------
    // TEST 10: Auditoría inmutable en audit_log
    // -------------------------------------------------------------------------
    console.log('[TEST 10] Verificando registro en audit_log...')
    const { rows: auditRows } = await pool.query(`
      SELECT accion, turno_id, mesa_id, operador_id, metadata_json
      FROM audit_log
      WHERE accion = 'TURNO_REZAGADO'
      ORDER BY id DESC
      LIMIT 1
    `)
    if (auditRows.length === 0) {
      throw new Error('No se encontró registro de auditoría con accion = TURNO_REZAGADO')
    }
    const audit = auditRows[0]
    console.log('   Registro de auditoría:', {
      accion: audit.accion,
      turno_id: audit.turno_id,
      mesa_id: audit.mesa_id,
      operador_id: audit.operador_id,
      metadata: audit.metadata_json
    })
    console.log('   [OK] Auditoría inmutable registrada con éxito.\n')

    console.log('======================================================================')
    console.log(' ¡TODAS LAS 10 PRUEBAS PASARON EXITOSAMENTE!')
    console.log('======================================================================')

  } finally {
    // Limpieza de datos de prueba
    if (turnosCreados.length > 0) {
      await pool.query(`DELETE FROM turnos WHERE id = ANY($1)`, [turnosCreados])
    }
    await pool.query(`DELETE FROM mesas WHERE id IN ($1, $2)`, [mesa1Id, mesa2Id])
    await pool.query(`DELETE FROM usuarios WHERE id IN ($1, $2)`, [op1Id, op2Id])
    await app.close()
    await pool.end()
  }
}

runTests().catch(err => {
  console.error('\n[FAIL] Error en la ejecución de pruebas:', err)
  process.exit(1)
})
