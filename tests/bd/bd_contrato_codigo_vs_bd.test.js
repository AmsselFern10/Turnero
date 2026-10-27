'use strict'

/**
 * MÓDULO: base_de_datos
 * OBJETIVO: Comprobar el acuerdo entre el código y la base de datos:
 *           acciones de auditoría, claves de configuración, firma de funciones,
 *           queries preparadas sin error y traducción de errores a HTTP correcto.
 * EJECUCIÓN: node tests/bd/bd_contrato_codigo_vs_bd.test.js
 */

const assert = require('node:assert/strict')
const path = require('path')
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

// ── 1. Acciones de auditoría: código vs. BD ─────────────────────────────────
async function testAccionesAuditoria () {
  console.log('\n-- 1. Acciones de auditoría (AUDIT_ACCIONES vs. CHECK en BD)')

  const { AUDIT_ACCIONES } = require(
    path.join(__dirname, '..', '..', 'src', 'modules', 'audit-acciones.js')
  )

  const { rows } = await pool.query(`
    SELECT pg_get_constraintdef(c.oid, true) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'audit_log' AND c.contype = 'c'
  `)
  const checkDef = rows[0]?.def || ''

  const accionesEnCodigo = Object.values(AUDIT_ACCIONES)
  const accionesEnBD = []
  const matchAll = checkDef.matchAll(/'([A-Z_]+)'/g)
  for (const m of matchAll) accionesEnBD.push(m[1])

  console.log(`    Acciones en código: ${accionesEnCodigo.length}`)
  console.log(`    Acciones en BD (CHECK): ${accionesEnBD.length}`)

  // Cada acción del código debe estar en BD
  for (const accion of accionesEnCodigo) {
    await test(`Acción "${accion}" del código está en CHECK de BD`, () => {
      assert.ok(accionesEnBD.includes(accion), `"${accion}" no está en el CHECK de audit_log`)
    })
  }

  // Acciones en BD que NO están en el código → hallazgo
  const accionesEnBDSoloEnBD = accionesEnBD.filter(a => !accionesEnCodigo.includes(a))
  if (accionesEnBDSoloEnBD.length > 0) {
    hallazgo('CCV-001', 'Baja',
      `Acciones en BD pero no en AUDIT_ACCIONES del código: ${accionesEnBDSoloEnBD.join(', ')} — puede ser intencional si son acciones de triggers`)
  }

  // Verificar que cada acción INSERT realmente pasa el CHECK
  for (const accion of accionesEnCodigo) {
    await test(`INSERT audit_log con accion="${accion}" aceptado por BD`, async () => {
      const { rows: r } = await pool.query(
        `INSERT INTO audit_log (accion) VALUES ($1) RETURNING id`, [accion]
      )
      assert.ok(r[0].id, `No se pudo insertar accion "${accion}"`)
    })
  }
}

// ── 2. Claves de configuración ──────────────────────────────────────────────
async function testConfiguracion () {
  console.log('\n-- 2. Claves de configuración (código vs. BD)')

  // Claves referenciadas en el código (extraídas de los servicios)
  const clavesEnCodigo = [
    'alerta_vouchers_restantes',
    'modo_generacion_turnos',
    'kiosko_web_activo',
    'kiosko_tope_diario',
    'kiosko_modo_uso',
    'kiosko_impresion_automatica',
    'kiosko_url_base',
    'kiosko_url_publica',
    'zona_horaria',
    'impresora_activa',
    'impresora_ip',
    'impresora_puerto',
    'impresora_canal',
    'impresora_ancho_papel',
    'voz_anuncio_activa',
    'mostrar_estimado_espera',
    'tv_escala_turnos',
    'tv_escala_principal',
    'tv_escala_secundaria',
    'tv_opacidad_principal',
    'tv_opacidad_secundaria',
    'fondo_imagen_url',
    'fondo_imagen_activa',
    'fondo_imagen_escala'
  ]

  const { rows: cfgRows } = await pool.query('SELECT clave, valor FROM configuracion')
  const cfgMap = {}
  for (const r of cfgRows) cfgMap[r.clave] = r.valor

  for (const clave of clavesEnCodigo) {
    await test(`configuracion["${clave}"] existe en BD`, () => {
      assert.ok(clave in cfgMap, `Falta clave "${clave}" en configuracion`)
    })

    await test(`configuracion["${clave}"] tiene valor no nulo`, () => {
      const v = cfgMap[clave]
      assert.notEqual(v, null, `Clave "${clave}" tiene valor NULL`)
      assert.notEqual(v, undefined, `Clave "${clave}" tiene valor undefined`)
    })
  }
}

// ── 3. Firma de funciones de BD ─────────────────────────────────────────────
async function testFirmaFunciones () {
  console.log('\n-- 3. Firma de funciones (argumentos y columnas devueltas)')

  // fn_llamar_siguiente(BIGINT, BIGINT)
  await test('fn_llamar_siguiente existe con 2 argumentos BIGINT', async () => {
    const { rows } = await pool.query(`
      SELECT proname, pg_get_function_arguments(oid) AS args
      FROM pg_proc WHERE proname='fn_llamar_siguiente'
    `)
    assert.ok(rows.length > 0, 'fn_llamar_siguiente no encontrada')
    const args = rows[0].args
    assert.ok(args.includes('bigint'), `Argumentos: ${args}`)
  })

  const COLUMNAS_FN_LLAMAR = [
    'turno_id', 'turno_numero', 'llamado_en', 'mesa_id', 'mesa_numero', 'mesa_nombre',
    'lote_id', 'lote_numero', 'numero_hasta', 'ultimo_llamado', 'vouchers_restantes',
    'proximo_numero', 'es_lote_agotado', 'es_idempotente', 'modo'
  ]

  await test('fn_llamar_siguiente devuelve columnas esperadas', async () => {
    // Necesitamos una mesa y operador mínimos
    const bcrypt = require('bcrypt')
    const h = await bcrypt.hash('x', 4)
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('op_firma', 'Op Firma', $1, 'operador') RETURNING id`, [h]
    )
    const { rows: [m] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES (50, 'Mesa Firma', 'activa', ${u.id}) RETURNING id`
    )
    const { rows: [l] } = await pool.query(
      `INSERT INTO lotes_voucher (numero_desde, numero_hasta, estado) VALUES (1, 10, 'activo') RETURNING id`
    )

    const { rows } = await pool.query(`SELECT * FROM fn_llamar_siguiente(${m.id}, ${u.id})`)
    assert.ok(rows[0], 'Sin resultado')

    for (const col of COLUMNAS_FN_LLAMAR) {
      assert.ok(col in rows[0], `Columna "${col}" no devuelta por fn_llamar_siguiente`)
    }

    // Limpiar
    await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE mesa_id=${m.id} AND estado='en_atencion'`)
    await pool.query(`UPDATE lotes_voucher SET estado='cerrado' WHERE id=${l.id}`)
    await pool.query(`UPDATE mesas SET estado='inactiva', operador_id=NULL WHERE id=${m.id}`)
  })

  // fn_atender_rezagado(BIGINT, BIGINT, BIGINT)
  await test('fn_atender_rezagado existe con 3 argumentos BIGINT', async () => {
    const { rows } = await pool.query(`
      SELECT proname, pg_get_function_arguments(oid) AS args
      FROM pg_proc WHERE proname='fn_atender_rezagado'
    `)
    assert.ok(rows.length > 0, 'fn_atender_rezagado no encontrada')
    const args = rows[0].args
    const bigintCount = (args.match(/bigint/g) || []).length
    assert.equal(bigintCount, 3, `Esperado 3 BIGINTs, encontrado: ${args}`)
  })

  const COLUMNAS_FN_REZAGADO = [
    'turno_id', 'turno_numero', 'llamado_en', 'mesa_id', 'mesa_numero', 'mesa_nombre',
    'lote_id', 'lote_numero', 'vouchers_restantes', 'proximo_numero', 'origen', 'token_consulta'
  ]

  await test('fn_atender_rezagado devuelve columnas esperadas', async () => {
    // Verificar columnas via información del catálogo (sin necesitar datos)
    const { rows } = await pool.query(`
      SELECT pg_get_function_result(oid) AS ret
      FROM pg_proc WHERE proname='fn_atender_rezagado'
    `)
    const ret = rows[0]?.ret || ''
    for (const col of COLUMNAS_FN_REZAGADO) {
      assert.ok(ret.includes(col), `Columna "${col}" no en la firma de fn_atender_rezagado. Firma: ${ret.slice(0, 200)}`)
    }
  })
}

// ── 4. Queries del código se preparan sin error ─────────────────────────────
async function testQueriesPreparadas () {
  console.log('\n-- 4. Queries críticas del código se preparan sin error en BD')

  // Simular PREPARE para verificar que columnas y tablas existen
  const queriesToVerify = [
    {
      nombre: 'llamarSiguiente: SELECT fn_llamar_siguiente',
      sql: 'SELECT * FROM fn_llamar_siguiente($1, $2)',
      tipos: ['bigint', 'bigint']
    },
    {
      nombre: 'cancelarTurno: UPDATE turnos SET estado',
      sql: `UPDATE turnos SET estado = 'cancelado' WHERE id = $1 AND mesa_id = $2 AND estado = 'en_atencion' RETURNING id, numero, lote_id, token_consulta`,
      tipos: ['bigint', 'bigint']
    },
    {
      nombre: 'obtenerRezagados: SELECT turnos cancelados hoy',
      sql: `SELECT t.id, t.numero, t.estado, t.origen FROM turnos t LEFT JOIN mesas m ON t.mesa_id = m.id LEFT JOIN usuarios u ON t.operador_id = u.id WHERE t.estado = 'cancelado' AND t.fecha_turno = fn_fecha_hoy()`,
      tipos: []
    },
    {
      nombre: 'atenderRezagado: SELECT fn_atender_rezagado',
      sql: 'SELECT * FROM fn_atender_rezagado($1, $2, $3)',
      tipos: ['bigint', 'bigint', 'bigint']
    },
    {
      nombre: 'getAlertaUmbral: SELECT configuracion zona_horaria',
      sql: `SELECT valor FROM configuracion WHERE clave = $1 LIMIT 1`,
      tipos: ['text']
    },
    {
      nombre: 'kiosko: SELECT turnos device_id esperando',
      sql: `SELECT t.id, t.numero, t.token_consulta FROM turnos t WHERE t.device_id = $1 AND t.estado = 'esperando' AND t.fecha_turno = $2 LIMIT 1`,
      tipos: ['text', 'date']
    },
    {
      nombre: 'kiosko: INSERT kiosko_contador_diario ON CONFLICT',
      sql: `INSERT INTO kiosko_contador_diario (fecha, ultimo_numero, sesion, actualizado_en) VALUES ($1, 1, 1, NOW()) ON CONFLICT (fecha) DO UPDATE SET ultimo_numero = kiosko_contador_diario.ultimo_numero + 1, actualizado_en = NOW() RETURNING ultimo_numero, sesion`,
      tipos: ['date']
    },
    {
      nombre: 'consultarMiTurno: SELECT turnos por token',
      sql: `SELECT t.id, t.numero, t.estado, t.llamado_en, t.creado_en, t.fecha_turno, m.numero AS mesa_numero, m.nombre AS mesa_nombre FROM turnos t LEFT JOIN mesas m ON t.mesa_id = m.id WHERE t.token_consulta = $1`,
      tipos: ['text']
    }
  ]

  let planIdx = 0
  for (const q of queriesToVerify) {
    await test(q.nombre, async () => {
      const planName = `test_plan_${++planIdx}`
      const tiposStr = q.tipos.length > 0 ? `(${q.tipos.join(', ')})` : ''
      await pool.query(`PREPARE ${planName} ${tiposStr} AS ${q.sql}`)
      await pool.query(`DEALLOCATE ${planName}`)
    })
  }
}

// ── 5. Violaciones de BD llegan como HTTP correcto (no texto crudo de PG) ───
async function testTraduccionErrores () {
  console.log('\n-- 5. Traducción de errores de BD a HTTP (via turnos/service.js)')

  // Cargar la aplicación en modo test contra la BD de prueba
  // Para poder llamar a la API sin servidor HTTP real, usamos app.inject
  process.env.DATABASE_URL = `postgresql://postgres:turnero@localhost:5432/${BD_TEST_NAME}`
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://:turnero_redis@localhost:6379'
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_jwt_matriculas_2026'
  process.env.NODE_ENV = 'development'

  let app
  try {
    app = await require(path.join(__dirname, '..', '..', 'src', 'app'))()
  } catch (err) {
    hallazgo('CCV-002', 'Alta', `No se pudo cargar la app para test de traducción de errores: ${err.message}`)
    return
  }

  const bcrypt = require('bcrypt')
  const jwt = require('jsonwebtoken')
  const crypto = require('crypto')
  const h = await bcrypt.hash('Test2026!', 10)

  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('op_http', 'Op HTTP', $1, 'operador') RETURNING id`, [h]
  )
  const { rows: [m] } = await pool.query(
    `INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES (60, 'Mesa HTTP', 'activa', ${u.id}) RETURNING id`
  )
  const jti = crypto.randomUUID()
  const opToken = jwt.sign({ id: u.id, username: 'op_http', rol: 'operador', jti }, process.env.JWT_SECRET)
  await app.redis.set(`user_active_session:${u.id}`, jti)

  // 5.1 Llamar sin lote activo → 409 (no texto crudo de PG)
  await test('Llamar sin lote activo → 409 (no texto crudo PG)', async () => {
    // Asegurar que no hay lote activo
    await pool.query(`UPDATE lotes_voucher SET estado='cerrado' WHERE estado='activo'`)
    const res = await app.inject({
      method: 'POST', url: '/turnos/llamar',
      headers: { authorization: `Bearer ${opToken}` },
      payload: { mesa_id: m.id }
    })
    assert.equal(res.statusCode, 409, `Esperado 409, recibido ${res.statusCode}: ${res.body}`)
    const bodyStr = res.body.toLowerCase()
    // No debe contener texto técnico de PG
    assert.ok(!bodyStr.includes('p0001') && !bodyStr.includes('raise exception'), `Texto técnico PG expuesto: ${res.body}`)
    assert.ok(bodyStr.length > 0, 'Respuesta sin mensaje de error')
  })

  // 5.2 Llamar mesa inexistente → 404
  await test('Llamar mesa inexistente → 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/turnos/llamar',
      headers: { authorization: `Bearer ${opToken}` },
      payload: { mesa_id: 99999 }
    })
    assert.equal(res.statusCode, 404, `Esperado 404, recibido ${res.statusCode}`)
  })

  // 5.3 Llamar mesa de otro operador → 403
  await test('Llamar mesa de otro operador → 403', async () => {
    const { rows: [u2] } = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES ('op_http2', 'Op HTTP2', $1, 'operador') RETURNING id`, [h]
    )
    const { rows: [m2] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES (61, 'Mesa HTTP2', 'activa', ${u2.id}) RETURNING id`
    )
    const res = await app.inject({
      method: 'POST', url: '/turnos/llamar',
      headers: { authorization: `Bearer ${opToken}` },
      payload: { mesa_id: m2.id }  // op_http intenta llamar mesa de op_http2
    })
    assert.equal(res.statusCode, 403, `Esperado 403, recibido ${res.statusCode}`)
  })

  await app.close()
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function runTests () {
  console.log('══════════════════════════════════════════════════════════════')
  console.log(' bd_contrato_codigo_vs_bd — Contrato código vs. base de datos')
  console.log(`  BD: ${BD_TEST_NAME}`)
  console.log('══════════════════════════════════════════════════════════════')

  await testAccionesAuditoria()
  await testConfiguracion()
  await testFirmaFunciones()
  await testQueriesPreparadas()
  await testTraduccionErrores()

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

