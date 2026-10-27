/**
 * MÓDULO: index_autenticacion_seguridad
 * OBJETIVO: Roles RBAC, control de sesiones únicas, logout y reactividad en tiempo real.
 *           Se deniega el acceso a /admin y /admin.html a usuarios sin rol admin;
 *           si el mismo usuario inicia sesión en un segundo dispositivo, la sesión previa se cierra
 *           automáticamente (cierre WS 4401 y token invalidado en Redis con código sesion_reemplazada);
 *           el logout atómico revoca tokens en blacklist y cierra conexiones activas;
 *           cambios de contraseña en caliente revocan sesiones previas inmediatamente;
 *           la asignación de mesa en vivo por admin notifica por WebSocket al operador para auto-redirección.
 * EJECUCIÓN: node tests/auth_seguridad_rbac_sesiones.test.js
 */

'use strict'

const WebSocket = require('ws')
const { Pool } = require('pg')
const Redis = require('ioredis')
const bcrypt = require('bcrypt')
const crypto = require('crypto')
require('dotenv').config()

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE_HTTP = process.env.APP_URL || `http://localhost:${PORT}`
const BASE_WS = BASE_HTTP.replace('http', 'ws')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
  console.log('======================================================================')
  console.log(' AUTH — ROLES RBAC, SESIÓN ÚNICA, LOGOUT Y REACTIVIDAD EN VIVO')
  console.log('======================================================================\n')

  const connectionString = process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER || 'turnero_app'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  const pool = new Pool({ connectionString })
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

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
  const opUsername = `op_rbac_${RUN_ID}`
  const opPassword = 'PasswordOperador2026!'
  const adminUsername = `admin_rbac_${RUN_ID}`
  const adminPassword = 'AdminPassword2026!'
  const mesaNum = 7300 + (parseInt(RUN_ID, 16) % 300)

  let opId = null
  let adminId = null
  let mesaId = null
  let adminToken = null
  const socketsACerrar = []

  try {
    // ── 1. Preparación de Usuarios y Obtención de Credenciales de Admin ─────────
    console.log('[1/5] Preparando usuario operador, usuario admin y mesa aislada...')
    const passHash = await bcrypt.hash(opPassword, 10)
    const adminPassHash = await bcrypt.hash(adminPassword, 10)

    // Crear operador de prueba
    const { rows: [uOp] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, true) RETURNING id`,
      [opUsername, passHash, `Operador RBAC [${RUN_ID}]`]
    )
    opId = uOp.id

    // Crear admin de prueba dedicado
    const { rows: [uAdmin] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'admin', $3, true) RETURNING id`,
      [adminUsername, adminPassHash, `Admin RBAC [${RUN_ID}]`]
    )
    adminId = uAdmin.id

    // Crear mesa de prueba
    const { rows: [mesaRow] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id)
       VALUES ($1, $2, 'activa', NULL) RETURNING id`,
      [mesaNum, `Mesa RBAC [${mesaNum}]`]
    )
    mesaId = mesaRow.id

    // Login del admin para obtener token
    const rAdminLogin = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: adminUsername, password: adminPassword })
    })
    const dAdmin = await rAdminLogin.json()
    adminToken = dAdmin.token

    assert(opId && adminId && mesaId && adminToken, 'Operador, Administrador y Mesa preparados correctamente')

    // ── 2. Validación Estricta de RBAC (Control de Acceso por Roles) ───────────
    console.log('\n[2/5] Evaluando permisos y denegación de rutas /admin a roles no autorizados...')

    // A. Petición anónima a /admin/kpis
    const rAnonimo = await fetch(`${BASE_HTTP}/admin/kpis`)
    assert(rAnonimo.status === 401, 'Petición anónima a /admin/kpis es rechazada con HTTP 401')

    // B. Login como operador
    const rOpLogin = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opUsername, password: opPassword })
    })
    const dOpLogin = await rOpLogin.json()
    const opToken = dOpLogin.token
    assert(rOpLogin.status === 200 && opToken, 'Login de operador exitoso')

    // C. Operador intentando acceder a la pantalla y rutas administrativas
    const [rAdminHtml, rAdminRuta, rKpis, rConfigAdmin] = await Promise.all([
      fetch(`${BASE_HTTP}/admin.html`, { headers: { 'Authorization': `Bearer ${opToken}` } }),
      fetch(`${BASE_HTTP}/admin`, { headers: { 'Authorization': `Bearer ${opToken}` } }),
      fetch(`${BASE_HTTP}/admin/kpis`, { headers: { 'Authorization': `Bearer ${opToken}` } }),
      fetch(`${BASE_HTTP}/admin/configuracion`, { headers: { 'Authorization': `Bearer ${opToken}` } })
    ])

    assert(rAdminHtml.status === 403, 'Operador rechazado en /admin.html con HTTP 403 Forbidden')
    assert(rAdminRuta.status === 403, 'Operador rechazado en /admin con HTTP 403 Forbidden')
    assert(rKpis.status === 403, 'Operador rechazado en /admin/kpis con HTTP 403 Forbidden')
    assert(rConfigAdmin.status === 403, 'Operador rechazado en /admin/configuracion con HTTP 403 Forbidden')

    // D. Admin accede legítimamente a la pantalla y endpoints
    const [rAdminHtmlOk, rAdminKpisOk] = await Promise.all([
      fetch(`${BASE_HTTP}/admin.html`, { headers: { 'Authorization': `Bearer ${adminToken}` } }),
      fetch(`${BASE_HTTP}/admin/kpis`, { headers: { 'Authorization': `Bearer ${adminToken}` } })
    ])
    assert(rAdminHtmlOk.status === 200, 'Usuario con rol admin accede a /admin.html con HTTP 200 OK')
    assert(rAdminKpisOk.status === 200, 'Usuario con rol admin accede a /admin/kpis con HTTP 200 OK')

    // ── 3. Revocación Inmediata por Cambio de Contraseña en Caliente ───────────
    console.log('\n[3/5] Evaluando revocación inmediata por cambio de contraseña en caliente...')
    const iatOperador = Math.floor(Date.now() / 1000)
    await redis.set(`pwd_changed:${opId}`, iatOperador + 10) // Marca de tiempo posterior a emisión

    const rTokenAntiguo = await fetch(`${BASE_HTTP}/auth/me`, {
      headers: { 'Authorization': `Bearer ${opToken}` }
    })
    const dTokenAntiguo = await rTokenAntiguo.json()
    assert(rTokenAntiguo.status === 401, 'Token emitido antes de modificar contraseña es revocado con HTTP 401')
    assert(dTokenAntiguo.codigo === 'password_cambiada', 'Servidor reporta código password_cambiada')

    // Limpiar flag en Redis para continuar pruebas de sesión con nuevo token
    await redis.del(`pwd_changed:${opId}`)

    // ── 4. Sesión Única por Cuenta y Expulsión Inmediata (Doble Sesión) ────────
    console.log('\n[4/5] Evaluando sesión única por cuenta y expulsión del dispositivo anterior...')

    // Re-login para obtener Token Fresco de Dispositivo 1
    const rReLogin1 = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opUsername, password: opPassword })
    })
    const { token: tokenDispositivo1 } = await rReLogin1.json()

    // Dispositivo 1: Selecciona mesa y conecta WebSocket
    await fetch(`${BASE_HTTP}/auth/seleccionar-mesa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenDispositivo1}` },
      body: JSON.stringify({ mesa_id: mesaId })
    })

    let ws1Cerrado = false
    let ws1CloseCode = null
    let ws1CloseReason = ''

    const ws1 = new WebSocket(`${BASE_WS}/ws?token=${tokenDispositivo1}&canal=mesa:${mesaId}&mesa_id=${mesaId}`)
    socketsACerrar.push(ws1)

    await new Promise((resolve, reject) => {
      ws1.on('open', resolve)
      ws1.on('error', reject)
    })
    ws1.on('close', (code, reason) => {
      ws1Cerrado = true
      ws1CloseCode = code
      ws1CloseReason = reason.toString()
    })

    assert(ws1.readyState === WebSocket.OPEN, 'Dispositivo 1 conectado a WebSocket de ventanilla')

    // Dispositivo 2: Inicia sesión con la MISMA cuenta del operador
    console.log('   Iniciando sesión en Dispositivo 2 con la misma cuenta...')
    const rLogin2 = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opUsername, password: opPassword })
    })
    const dLogin2 = await rLogin2.json()
    const tokenDispositivo2 = dLogin2.token

    assert(rLogin2.status === 200, 'Dispositivo 2 obtiene nuevo token JWT exitosamente')
    assert(tokenDispositivo2 !== tokenDispositivo1, 'Nuevo token tiene identificador JTI independiente')

    // Esperar propagación de desconexión forzosa en WebSocket Hub
    await sleep(250)

    assert(ws1Cerrado, 'WebSocket del Dispositivo 1 fue expulsado automáticamente por el servidor')
    assert(ws1CloseCode === 4401, `Código de expulsión del servidor es 4401 (${ws1CloseCode})`)
    assert(ws1CloseReason.includes('otro dispositivo'), 'Motivo de expulsión indica sesión abierta en otro dispositivo')

    // Dispositivo 1 intenta hacer una petición HTTP protegida con su token viejo
    const rIntentoDispositivo1 = await fetch(`${BASE_HTTP}/auth/me`, {
      headers: { 'Authorization': `Bearer ${tokenDispositivo1}` }
    })
    const dIntento1 = await rIntentoDispositivo1.json()
    assert(rIntentoDispositivo1.status === 401, 'Petición HTTP del Dispositivo 1 con token previo es rechazada con 401')
    assert(dIntento1.codigo === 'sesion_reemplazada', 'Servidor reporta código semántico sesion_reemplazada')

    // Dispositivo 2 opera legítimamente
    const rMeDispositivo2 = await fetch(`${BASE_HTTP}/auth/me`, {
      headers: { 'Authorization': `Bearer ${tokenDispositivo2}` }
    })
    assert(rMeDispositivo2.status === 200, 'Dispositivo 2 puede operar normalmente sin interrupción')

    // Logout en Dispositivo 2
    const rLogout = await fetch(`${BASE_HTTP}/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenDispositivo2}` }
    })
    assert(rLogout.status === 200, 'POST /auth/logout responde 200 OK')

    const rPostLogout = await fetch(`${BASE_HTTP}/auth/me`, {
      headers: { 'Authorization': `Bearer ${tokenDispositivo2}` }
    })
    assert(rPostLogout.status === 401, 'Token utilizado en logout es rechazado inmediatamente con 401 (Blacklist Redis)')

    // ── 5. Reasignación Forzada de Mesa en Vivo por Admin y Notificación WS ────
    console.log('\n[5/5] Evaluando notificación WebSocket de asignación en vivo por admin...')

    // Nuevo login para tener sesión limpia
    const rLogin3 = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opUsername, password: opPassword })
    })
    const { token: opToken3 } = await rLogin3.json()

    // Conectar socket a tv:global simulando index.html en grilla de mesas
    const wsGrilla = new WebSocket(`${BASE_WS}/ws?token=${opToken3}&canal=tv:global`)
    socketsACerrar.push(wsGrilla)

    let eventoAsignadoRecibido = null

    await new Promise((resolve, reject) => {
      wsGrilla.on('open', resolve)
      wsGrilla.on('error', reject)
    })
    wsGrilla.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.tipo === 'operador_asignado_por_admin') {
          eventoAsignadoRecibido = msg.payload
        }
      } catch (_) {}
    })

    // Asegurar que la mesa está libre antes de la asignación del admin
    await pool.query(`UPDATE mesas SET operador_id = NULL, estado = 'activa' WHERE id = $1`, [mesaId])

    // Admin asigna la mesa al operador
    const rAsignar = await fetch(`${BASE_HTTP}/mesas/${mesaId}/asignar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ operador_id: opId })
    })
    assert(rAsignar.status === 200, 'Admin asigna mesa al operador vía PATCH /mesas/:id/asignar')

    await sleep(250)
    assert(eventoAsignadoRecibido !== null, 'WebSocket recibió evento operador_asignado_por_admin en tiempo real')
    assert(Number(eventoAsignadoRecibido?.operador_id) === Number(opId),
      'Evento recibido contiene el operador_id correspondiente para auto-redirección')

  } finally {
    // ── Limpieza Segura ────────────────────────────────────────────────────────
    console.log('\nLimpiando conexiones y datos de prueba...')
    for (const ws of socketsACerrar) {
      try { ws.close() } catch (_) {}
    }
    if (mesaId) await pool.query(`DELETE FROM mesas WHERE id = $1`, [mesaId]).catch(() => {})
    if (opId) await pool.query(`DELETE FROM usuarios WHERE id = $1`, [opId]).catch(() => {})
    if (adminId) await pool.query(`DELETE FROM usuarios WHERE id = $1`, [adminId]).catch(() => {})
    await redis.quit().catch(() => {})
    await pool.end().catch(() => {})
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
  console.error('\n[FAIL] Error fatal en auth_seguridad_rbac_sesiones:', err)
  process.exit(1)
})
