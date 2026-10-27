/**
 * MÓDULO: index_autenticacion_seguridad
 * OBJETIVO: Controles de acceso inicial, autenticación, rate limiting y asignación atómica de mesas.
 *           Valida bloqueo a credenciales erróneas o usuarios inactivos con auditoría;
 *           garantiza que la grilla solo entregue mesas activas y sin operador;
 *           evalúa la prevención de condiciones de carrera con check-and-set atómico al seleccionar mesas;
 *           comprueba la integridad visual de iconos SVG, CSS y resolución de IP LAN en login.
 * EJECUCIÓN: node tests/auth_acceso_y_mesas.test.js
 */

'use strict'

const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
require('dotenv').config()

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE_HTTP = process.env.APP_URL || `http://localhost:${PORT}`

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
  console.log('======================================================================')
  console.log(' AUTH — ACCESO INICIAL, CREDENCIALES Y ASIGNACIÓN ATÓMICA DE MESAS')
  console.log('======================================================================\n')

  const connectionString = process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER || 'turnero_app'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  const pool = new Pool({ connectionString })
  let passed = 0
  let failed = 0

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`)
      passed++
    } else {
      console.error(`  [FAIL] ${message}`)
      failed++
    }
  }

  const RUN_ID = crypto.randomBytes(3).toString('hex')
  const opUsername = `op_auth_${RUN_ID}`
  const opInactivoUser = `op_inactivo_${RUN_ID}`
  const opPassword = 'Password2026!'
  const mesaNumA = 7100 + (parseInt(RUN_ID, 16) % 300)
  const mesaNumB = mesaNumA + 1

  let opId = null
  let opInactivoId = null
  let mesaIdA = null
  let mesaIdB = null

  try {
    // ── 1. Preparación de Usuarios y Mesas de Prueba ───────────────────────────
    console.log('[1/5] Preparando datos de prueba (usuarios y mesas aisladas)...')
    const passHash = await bcrypt.hash(opPassword, 10)

    // Operador activo
    const { rows: [u1] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, true) RETURNING id`,
      [opUsername, passHash, `Operador Auth [${RUN_ID}]`]
    )
    opId = u1.id

    // Operador inactivo
    const { rows: [u2] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, false) RETURNING id`,
      [opInactivoUser, passHash, `Operador Inactivo [${RUN_ID}]`]
    )
    opInactivoId = u2.id

    // Mesas de prueba: una activa sin operador, otra inactiva
    const { rows: [mA] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id)
       VALUES ($1, $2, 'activa', NULL) RETURNING id`,
      [mesaNumA, `Mesa Libre [${mesaNumA}]`]
    )
    mesaIdA = mA.id

    const { rows: [mB] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id)
       VALUES ($1, $2, 'inactiva', NULL) RETURNING id`,
      [mesaNumB, `Mesa Inactiva [${mesaNumB}]`]
    )
    mesaIdB = mB.id

    assert(opId && opInactivoId && mesaIdA && mesaIdB, 'Usuarios y mesas de prueba creados en PostgreSQL')

    // ── 2. Validación de Controles de Acceso y Rechazo de Credenciales ─────────
    console.log('\n[2/5] Evaluando rechazo seguro de credenciales y auditoría de accesos fallidos...')

    // A. Usuario inexistente
    const rInexistente = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `user_fantasma_${RUN_ID}`, password: 'CualquierPassword!' })
    })
    const dInexistente = await rInexistente.json()
    assert(rInexistente.status === 401, 'Usuario inexistente es rechazado con código HTTP 401')
    assert(/credenciales/i.test(JSON.stringify(dInexistente)),
      'Mensaje de error genérico para prevenir enumeración de usuarios')

    // B. Contraseña incorrecta
    const rPassErroneo = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opUsername, password: 'PasswordIncorrecta999!' })
    })
    assert(rPassErroneo.status === 401, 'Contraseña incorrecta es rechazada con código HTTP 401')

    // C. Verificar registro en audit_log
    const { rows: logsFallidos } = await pool.query(
      `SELECT accion, metadata_json FROM audit_log
       WHERE accion = 'LOGIN_FALLIDO'
       ORDER BY id DESC LIMIT 5`
    )
    const logMatch = logsFallidos.some(l => JSON.stringify(l.metadata_json).includes(opUsername))
    assert(logMatch, 'Intento de login fallido fue registrado en audit_log con su metadata')

    // D. Usuario inactivo
    const rInactivo = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opInactivoUser, password: opPassword })
    })
    assert(rInactivo.status === 401, 'Usuario con activo = false es bloqueado con HTTP 401')

    // ── 3. Login Exitoso y Entrega Segura de Tokens ────────────────────────────
    console.log('\n[3/5] Evaluando inicio de sesión exitoso y cookies de seguridad...')

    const rLoginOk = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opUsername, password: opPassword })
    })
    const dLoginOk = await rLoginOk.json()
    const setCookieHeader = rLoginOk.headers.get('set-cookie') || ''

    assert(rLoginOk.status === 200, 'Login exitoso responde con HTTP 200 OK')
    assert(typeof dLoginOk.token === 'string' && dLoginOk.token.length > 30, 'Devuelve token JWT firmado')
    assert(dLoginOk.usuario?.id === opId, 'Datos del usuario autenticado devueltos en la respuesta')
    assert(setCookieHeader.includes('refresh_token'), 'Cookie refresh_token presente en Set-Cookie')
    assert(setCookieHeader.toLowerCase().includes('httponly'), 'Cookies configuradas con HttpOnly para prevenir XSS')

    const opToken = dLoginOk.token

    // ── 4. Grilla de Mesas Disponibles y Asignación Atómica Concurrente ────────
    console.log('\n[4/5] Evaluando consulta de mesas y prevención de condiciones de carrera...')

    // Consulta de mesas disponibles
    const rMesas = await fetch(`${BASE_HTTP}/auth/mesas/disponibles`, {
      headers: { 'Authorization': `Bearer ${opToken}` }
    })
    const dMesas = await rMesas.json()
    assert(rMesas.status === 200, 'GET /auth/mesas/disponibles responde 200 OK')
    assert(Array.isArray(dMesas.mesas), 'Responde con lista de mesas en formato array')

    const tieneMesaA = dMesas.mesas.some(m => m.id === mesaIdA)
    const tieneMesaB = dMesas.mesas.some(m => m.id === mesaIdB)
    assert(tieneMesaA, 'Mesa activa y libre (Mesa A) aparece disponible en la grilla')
    assert(!tieneMesaB, 'Mesa inactiva (Mesa B) NO aparece en la lista de mesas disponibles')

    // Simulación de Asignación Concurrente: Crear un segundo operador para competir por Mesa A
    const { rows: [uCompetidor] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, true) RETURNING id`,
      [`op_comp_${RUN_ID}`, passHash, `Operador Competidor [${RUN_ID}]`]
    )
    const rLoginComp = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `op_comp_${RUN_ID}`, password: opPassword })
    })
    const { token: compToken } = await rLoginComp.json()

    // Ambos operadores intentan seleccionar mesa A simultáneamente en el mismo ms
    const [peticion1, peticion2] = await Promise.all([
      fetch(`${BASE_HTTP}/auth/seleccionar-mesa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opToken}` },
        body: JSON.stringify({ mesa_id: mesaIdA })
      }),
      fetch(`${BASE_HTTP}/auth/seleccionar-mesa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${compToken}` },
        body: JSON.stringify({ mesa_id: mesaIdA })
      })
    ])

    const status1 = peticion1.status
    const status2 = peticion2.status
    const unGanador = (status1 === 200 && status2 === 409) || (status1 === 409 && status2 === 200)

    assert(unGanador, `Check-and-set atómico: Solo un operador obtuvo la mesa (Respuestas: ${status1} y ${status2})`)

    // Verificar que la mesa ya no aparece disponible para terceros
    const rMesasDespues = await fetch(`${BASE_HTTP}/auth/mesas/disponibles`, {
      headers: { 'Authorization': `Bearer ${compToken}` }
    })
    const dMesasDespues = await rMesasDespues.json()
    const sigueEnGrilla = dMesasDespues.mesas.some(m => m.id === mesaIdA)
    assert(!sigueEnGrilla, 'Mesa seleccionada desaparece inmediatamente de la grilla de disponibles')

    // Liberar mesa
    const rLiberar = await fetch(`${BASE_HTTP}/auth/liberar-mesa`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${status1 === 200 ? opToken : compToken}` }
    })
    const dLiberar = await rLiberar.json()
    assert(rLiberar.status === 200 && dLiberar.liberada !== false, 'Operador puede liberar su mesa voluntariamente')

    // Limpieza de usuario competidor
    await pool.query(`DELETE FROM usuarios WHERE id = $1`, [uCompetidor.id]).catch(() => {})

    // ── 5. Integridad de Frontend (Iconos SVG, CSS e IP LAN) ───────────────────
    console.log('\n[5/5] Evaluando contrato de UI: Iconos vectoriales, CSS y LAN IP en frontend...')
    const indexHtmlPath = path.join(__dirname, '../src/public/index.html')
    const loginJsPath = path.join(__dirname, '../src/public/js/pages/login.js')
    const componentsCssPath = path.join(__dirname, '../src/public/css/components.css')
    const kioskoServicePath = path.join(__dirname, '../src/modules/kiosko/service.js')

    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8')
    const loginJs = fs.readFileSync(loginJsPath, 'utf8')
    const componentsCss = fs.readFileSync(componentsCssPath, 'utf8')
    const kioskoService = fs.readFileSync(kioskoServicePath, 'utf8')

    assert(loginJs.includes('mesaPreAsignada: null'), 'login.js declara mesaPreAsignada en estado Alpine')
    assert(loginJs.includes('esAsistido ? `${base}?modo=tablet` : base'), 'login.js anexa ?modo=tablet en modo asistido')
    assert(kioskoService.includes('url_base: urlBase'), 'kiosko service resuelve y retorna url_base para LAN')
    assert(!indexHtml.includes('m-3 8.25h3m-3 3.75h3m-6-3.75H6.375'), 'index.html no tiene trazos SVG rotos/duplicados')
    assert(indexHtml.includes('x-show="!showPassword"'), 'index.html conmuta visibilidad con iconos SVG limpios')
    assert(componentsCss.includes('.icon-box') && componentsCss.includes('.input-field:-webkit-autofill'),
      'components.css contiene utilidades de centrado e icon-box con soporte autofill')

  } finally {
    // ── Limpieza Segura ────────────────────────────────────────────────────────
    console.log('\nLimpiando datos de prueba...')
    if (mesaIdA) await pool.query(`DELETE FROM mesas WHERE id = $1`, [mesaIdA]).catch(() => {})
    if (mesaIdB) await pool.query(`DELETE FROM mesas WHERE id = $1`, [mesaIdB]).catch(() => {})
    if (opId) await pool.query(`DELETE FROM usuarios WHERE id = $1`, [opId]).catch(() => {})
    if (opInactivoId) await pool.query(`DELETE FROM usuarios WHERE id = $1`, [opInactivoId]).catch(() => {})
    await pool.end()
  }

  console.log('\n======================================================================')
  console.log(`RESULTADO FINAL: ${passed} PASADOS | ${failed} FALLADOS`)
  console.log('======================================================================')

  if (failed > 0) {
    process.exit(1)
  } else {
    process.exit(0)
  }
}

run().catch((err) => {
  console.error('\n[FAIL] Error fatal en auth_acceso_y_mesas:', err)
  process.exit(1)
})
