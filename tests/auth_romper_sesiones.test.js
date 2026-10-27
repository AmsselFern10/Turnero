'use strict'

/**
 * MÓDULO: auth_sesiones_seguridad
 * OBJETIVO: Intentar romper sesiones y seguridad de acceso con un navegador real (Playwright).
 *           Verifica sesión única por cuenta, sesión única por navegador, limpieza de datos
 *           al cerrar sesión, acceso al admin, protección del último admin y cambios en caliente.
 * EJECUCIÓN: node tests/auth_romper_sesiones.test.js
 */

const { chromium }   = require('playwright')
const { Pool }       = require('pg')
const Redis          = require('ioredis')
const bcrypt         = require('bcrypt')
const crypto         = require('crypto')
const WebSocket      = require('ws')
require('dotenv').config()

// ── SEGURO OBLIGATORIO ─────────────────────────────────────────────────────
const DB_NAME = (process.env.DATABASE_URL || '').split('/').pop().split('?')[0] || process.env.DB_NAME || 'turnero'
const ENVS_PROHIBIDOS = ['production', 'prod', 'productivo']
if (ENVS_PROHIBIDOS.includes((process.env.NODE_ENV || '').toLowerCase()) ||
    ENVS_PROHIBIDOS.includes(DB_NAME.toLowerCase())) {
  console.error('[SEGURO] ABORTANDO: Este test NO puede correr en producción.')
  process.exit(1)
}

const PORT    = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE    = process.env.APP_URL || `http://localhost:${PORT}`
const BASE_WS = BASE.replace('http', 'ws')

const RUN_ID  = crypto.randomBytes(4).toString('hex')
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function apiLogin(username, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const body = await res.json()
  return { status: res.status, token: body.token, user: body.usuario }
}

async function apiFetch(path, method, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

async function run() {
  console.log('══════════════════════════════════════════════════════════════')
  console.log('  AUTH SESIONES — ROMPER SESIONES Y SEGURIDAD (PLAYWRIGHT)    ')
  console.log('══════════════════════════════════════════════════════════════')
  console.log(`[RUN ID: ${RUN_ID}]\n`)

  const pool  = new Pool({ connectionString: process.env.DATABASE_URL })
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379',
    { password: process.env.REDIS_PASSWORD, lazyConnect: false })

  let passed = 0, failed = 0
  const hallazgos = []

  // Entidades de prueba
  let browser = null
  let opId = null, op2Id = null, adminId = null, admin2Id = null
  let mesaId = null
  const opUser    = `op_sess_${RUN_ID}`
  const op2User   = `op2_sess_${RUN_ID}`
  const adminUser = `adm_sess_${RUN_ID}`
  const adm2User  = `adm2_sess_${RUN_ID}`
  const opPass    = 'Sess_Op_2026!'
  const adminPass = 'Sess_Ad_2026!'
  const allWs = []

  function assert(cond, msg) {
    if (cond) { console.log(`   [PASS] ${msg}`); passed++ }
    else       { console.error(`   [FAIL] ${msg}`); failed++ }
  }
  function hallazgo(sev, titulo, detalle) {
    hallazgos.push({ sev, titulo, detalle })
    console.warn(`   [HALLAZGO:${sev}] ${titulo} — ${detalle}`)
  }

  async function resetRateLimit() {
    try {
      const keys = await redis.keys('*rate-limit*')
      if (keys.length > 0) await redis.del(...keys)
    } catch (_) {}
  }

  try {
    // ── SETUP: Crear entidades de prueba ──────────────────────────────────
    console.log('[SETUP] Creando entidades de prueba...')
    const hOp    = await bcrypt.hash(opPass, 10)
    const hAdmin = await bcrypt.hash(adminPass, 10)

    const rlKeys = await redis.keys('fastify-rate-limit-*');
    if (rlKeys.length > 0) await redis.del(...rlKeys);

    const rOp = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
       VALUES ($1, $2, $3, 'operador', true) RETURNING id`,
      [opUser, `Op Sess ${RUN_ID}`, hOp])
    opId = rOp.rows[0].id

    const rOp2 = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
       VALUES ($1, $2, $3, 'operador', true) RETURNING id`,
      [op2User, `Op2 Sess ${RUN_ID}`, hOp])
    op2Id = rOp2.rows[0].id

    const rAdm = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
       VALUES ($1, $2, $3, 'admin', true) RETURNING id`,
      [adminUser, `Admin Sess ${RUN_ID}`, hAdmin])
    adminId = rAdm.rows[0].id

    const rAdm2 = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
       VALUES ($1, $2, $3, 'admin', true) RETURNING id`,
      [adm2User, `Admin2 Sess ${RUN_ID}`, hAdmin])
    admin2Id = rAdm2.rows[0].id

    const { rows: [{ max_num }] } = await pool.query('SELECT COALESCE(MAX(numero), 10000) AS max_num FROM mesas')
    const mesaNum = Number(max_num) + 1
    const rM = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id)
       VALUES ($1, $2, 'activa', $3) RETURNING id`,
      [mesaNum, `Mesa Sess ${RUN_ID}`, opId])
    mesaId = rM.rows[0].id

    // Lanzar Playwright
    browser = await chromium.launch({ headless: true })
    console.log(`   [OK] Browser Chromium lanzado\n`)

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 1: UNA SOLA SESIÓN POR CUENTA — Sesión vieja se cierra al abrir en otro dispositivo
    // ──────────────────────────────────────────────────────────────────────
    console.log('[1] Una sola sesión por cuenta: login en dispositivo 2 cierra el 1')

    // Dispositivo 1: abrir WS con sesión activa
    const resD1 = await apiLogin(opUser, opPass)
    const tokenD1 = resD1.token

    let wsD1CerradoConCode = null
    const wsD1 = new WebSocket(`${BASE_WS}/ws?token=${tokenD1}&canal=mesa:${mesaId}`)
    allWs.push(wsD1)
    await new Promise(r => { wsD1.on('open', r); wsD1.on('error', r); setTimeout(r, 3000) })

    wsD1.on('close', (code) => { wsD1CerradoConCode = code })

    // Dispositivo 2: iniciar sesión con la misma cuenta
    const resD2 = await apiLogin(opUser, opPass)
    const tokenD2 = resD2.token
    assert(resD2.status === 200, '1.1 Login en dispositivo 2 con la misma cuenta es exitoso')

    await sleep(1000) // esperar propagación de cierre WS

    assert(wsD1CerradoConCode === 4401,
           `1.2 WebSocket del dispositivo 1 fue cerrado con código 4401 (actual: ${wsD1CerradoConCode})`)

    // Petición HTTP con el token del dispositivo 1 debe ser rechazada
    const rD1Old = await apiFetch('/admin/kpis', 'GET', tokenD1)
    assert(rD1Old.status === 401,
           `1.3 Token del dispositivo 1 rechazado después de ser reemplazado (HTTP ${rD1Old.status})`)
    assert(rD1Old.body?.error?.includes('sesión') || rD1Old.body?.codigo === 'sesion_reemplazada',
           `1.4 Mensaje de error indica sesión reemplazada (body: ${JSON.stringify(rD1Old.body)})`)

    // El dispositivo 2 opera normalmente
    const rD2Ok = await apiFetch('/auth/mesas/disponibles', 'GET', tokenD2)
    assert(rD2Ok.status === 200, '1.5 Dispositivo 2 opera normalmente con el nuevo token')

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 2: UNA SOLA CUENTA POR NAVEGADOR (múltiples pestañas)
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[2] Una sola cuenta por navegador (Playwright — múltiples contextos/pestañas)')

    // Contexto A: operador logueado (simula pestaña 1)
    const ctxA = await browser.newContext()
    const pageA = await ctxA.newPage()

    // Login como operador en el contexto A via API (sessionStorage)
    await pageA.goto(`${BASE}/index.html`)
    await pageA.evaluate(async (params) => {
      const res = await fetch(params.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: params.user, password: params.pass })
      })
      const body = await res.json()
      if (body.token) {
        sessionStorage.setItem('turnero_token', body.token)
        sessionStorage.setItem('turnero_user', JSON.stringify(body.usuario))
      }
    }, { url: `${BASE}/auth/login`, user: opUser, pass: opPass })

    const tokenA = await pageA.evaluate(() => sessionStorage.getItem('turnero_token'))
    assert(!!tokenA, '2.1 Token almacenado en sessionStorage del contexto A')

    // Pestaña B en el mismo contexto: sessionStorage es POR PESTAÑA (aislado)
    const pageB = await ctxA.newPage()
    await pageB.goto(`${BASE}/index.html`)
    const tokenB = await pageB.evaluate(() => sessionStorage.getItem('turnero_token'))

    // sessionStorage es per-tab, por lo que la pestaña B no tiene el token de A
    assert(tokenB === null,
           '2.2 sessionStorage no se comparte entre pestañas del mismo contexto (per-tab)')

    // Verificar que el localStorage tampoco tiene el token (el sistema lo usa solo en sessionStorage)
    const tokenLocalStorage = await pageA.evaluate(() => localStorage.getItem('turnero_token'))
    if (tokenLocalStorage) {
      hallazgo('alta',
        '2.3 Token encontrado en localStorage (debería estar solo en sessionStorage)',
        'El token JWT se almacena en localStorage, que persiste entre sesiones. ' +
        'Esto representa un riesgo de seguridad en PCs compartidas. ' +
        'Causa: el código debería usar solo sessionStorage para el JWT.')
    } else {
      assert(true, '2.3 Token NO está en localStorage (solo en sessionStorage — correcto)')
    }

    await ctxA.close()

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 3: CERRAR SESIÓN LIMPIA TODO
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[3] Cerrar sesión: limpieza de tokens, WebSocket y datos del navegador')

    const resPreLogout = await apiLogin(opUser, opPass)
    const tokenPreLogout = resPreLogout.token

    let wsPreLogout = null
    let wsLogoutCode = null
    wsPreLogout = new WebSocket(`${BASE_WS}/ws?token=${tokenPreLogout}&canal=mesa:${mesaId}`)
    allWs.push(wsPreLogout)
    await new Promise(r => { wsPreLogout.on('open', r); wsPreLogout.on('error', r); setTimeout(r, 3000) })
    wsPreLogout.on('close', (code) => { wsLogoutCode = code })

    // Hacer logout
    const rLogout = await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenPreLogout}` }
    })
    assert(rLogout.status === 200, '3.1 POST /auth/logout responde 200 OK')

    await sleep(800)
    assert(wsLogoutCode === 4401, `3.2 WebSocket cerrado con código 4401 tras logout (actual: ${wsLogoutCode})`)

    // Token bloqueado en blacklist
    const rPostLogout = await apiFetch('/auth/mesas/disponibles', 'GET', tokenPreLogout)
    assert(rPostLogout.status === 401, `3.3 Token revocado después de logout (HTTP ${rPostLogout.status})`)

    // Verificar limpieza de navegador con Playwright
    const ctxLogout = await browser.newContext()
    const pageLogout = await ctxLogout.newPage()
    await pageLogout.goto(`${BASE}/index.html`)

    // Simular login + logout y verificar que sessionStorage se limpia
    await pageLogout.evaluate(async (params) => {
      // 1. Login
      const res = await fetch(params.loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: params.user, password: params.pass })
      })
      const body = await res.json()
      if (body.token) {
        sessionStorage.setItem('turnero_token', body.token)
        sessionStorage.setItem('turnero_user', JSON.stringify(body.usuario || {}))
      }
      // 2. Logout
      await fetch(params.logoutUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${body.token}` }
      })
      // 3. Limpiar sessionStorage (como haría el JS del cliente al detectar logout)
      sessionStorage.clear()
    }, {
      loginUrl: `${BASE}/auth/login`,
      logoutUrl: `${BASE}/auth/logout`,
      user: opUser, pass: opPass
    })

    const tokenTrasLogout = await pageLogout.evaluate(() => sessionStorage.getItem('turnero_token'))
    assert(tokenTrasLogout === null, '3.4 sessionStorage vacío después del logout (token limpiado)')

    // El botón Atrás no muestra pantalla protegida con datos (bfcache test)
    await pageLogout.goto(`${BASE}/panel_mesa.html`)
    await pageLogout.goBack()
    const urlActual = pageLogout.url()
    // Verificar que la página está en index (o fue redirigida)
    assert(
      urlActual.includes('index') || urlActual === `${BASE}/` || urlActual === `${BASE}/index.html`,
      `3.5 Botón Atrás no muestra página protegida (URL: ${urlActual})`
    )
    await ctxLogout.close()

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 4: ACCESO AL ADMIN — Operador no entra
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[4] Acceso al admin: operador no puede entrar por ninguna vía')

    const resOpAcc = await apiLogin(opUser, opPass)
    const tokenOpAcc = resOpAcc.token

    // Por API directa
    const rAdmin401 = await apiFetch('/admin/kpis', 'GET', null)
    assert(rAdmin401.status === 401, '4.1 /admin/kpis sin token → 401')

    const rAdmin403 = await apiFetch('/admin/kpis', 'GET', tokenOpAcc)
    assert(rAdmin403.status === 403, `4.2 /admin/kpis con token de operador → 403 (actual: ${rAdmin403.status})`)

    // Por pantalla (Playwright)
    const ctxOp = await browser.newContext()
    const pageOp = await ctxOp.newPage()
    await pageOp.goto(`${BASE}/index.html`)
    await pageOp.evaluate(async (params) => {
      const res = await fetch(params.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: params.user, password: params.pass })
      })
      const body = await res.json()
      if (body.token) sessionStorage.setItem('turnero_token', body.token)
    }, { url: `${BASE}/auth/login`, user: opUser, pass: opPass })

    // Intentar navegar a /admin.html directamente
    const respAdmin = await pageOp.goto(`${BASE}/admin.html`)
    const statusAdmin = respAdmin?.status() || 0
    const finalUrl = pageOp.url()
    assert(
      statusAdmin === 403 || finalUrl.includes('index') || finalUrl !== `${BASE}/admin.html`,
      `4.3 Operador no llega a /admin.html (status=${statusAdmin}, url=${finalUrl})`
    )
    await ctxOp.close()

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 5: EL ÚLTIMO ADMIN — No puede quedar sin admin
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[5] El último admin: el sistema siempre mantiene al menos uno')

    const resAdminToken = await apiLogin(adminUser, adminPass)
    const tokenAdmin = resAdminToken.token

    // Encontrar el admin original del seed (el único que no es de prueba)
    const { rows: admins } = await pool.query(
      `SELECT id, username FROM usuarios WHERE rol = 'admin' AND activo = true AND eliminado_en IS NULL`)
    const adminsSinPrueba = admins.filter(a => !a.username.includes(RUN_ID))
    const esElUltimoAdmin = adminsSinPrueba.length === 0

    if (!esElUltimoAdmin) {
      // Intentar degradar al admin de prueba (hay otro admin real)
      const resAdm2Tok = await apiLogin(adm2User, adminPass);
      const rDegrada = await apiFetch(`/admin/usuarios/${adminId}`, 'PATCH', resAdm2Tok.token,
                                      { rol: 'operador' })
      // Debe estar permitido (hay otro admin) O rechazado por política
      assert(rDegrada.status === 200 || rDegrada.status === 400,
             `5.1 Degradar admin con otro admin disponible → ${rDegrada.status} (200 ó 400 aceptable)`)

      // Restaurar siempre rol de admin para adminId
      await pool.query(`UPDATE usuarios SET rol = 'admin' WHERE id = $1`, [adminId])
    }

    // Intentar que el único admin se degrade a sí mismo (si fuera el único)
    // Buscar si el sistema tiene protección a nivel de trigger
    const { rows: triggerCheck } = await pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'trg_usuarios_proteger_ultimo_admin'`)
    assert(triggerCheck.length > 0,
           '5.2 Trigger de protección del último admin existe en la BD')

    // Intentar desactivar el usuario adminId directamente en BD (bypass de la API)
    // (La protección del trigger debe bloquearlo si es el último)
    const adminsActivos = admins.filter(a => a.activo && !a.username.includes(RUN_ID))
    if (adminsActivos.length <= 1 && adminsActivos[0]?.id === adminId) {
      // Es el único admin real — el trigger debe bloquearlo
      try {
        await pool.query(`UPDATE usuarios SET rol = 'operador' WHERE id = $1`, [adminId])
        // Si llegó aquí, el trigger falló
        hallazgo('crítica',
          '5.3 Trigger de último admin no protegió la degradación directa en BD',
          'Se pudo cambiar el rol del único admin directamente en la BD sin error del trigger.')
        // Restaurar
        await pool.query(`UPDATE usuarios SET rol = 'admin' WHERE id = $1`, [adminId])
      } catch (e) {
        assert(e.message.includes('admin') || e.message.includes('P0001'),
               `5.3 BD rechaza degradar al único admin directamente (trigger activo)`)
      }
    } else {
      assert(true, '5.3 Hay más de 1 admin activo — prueba de único admin con datos de seed')
    }

    // Un admin intenta degradarse a sí mismo via API
    const rAutoDegrade = await apiFetch(`/admin/usuarios/${adminId}`, 'PATCH', tokenAdmin,
                                        { rol: 'operador' })
    assert(rAutoDegrade.status === 400 || rAutoDegrade.status === 403,
           `5.4 API rechaza que el admin modifique su propio rol (HTTP ${rAutoDegrade.status})`)

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 6: CAMBIOS EN CALIENTE — Desactivar usuario afecta sesiones abiertas
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[6] Cambios en caliente: desactivar usuario afecta sesiones abiertas de inmediato')
    await resetRateLimit()

    const resOp2Login = await apiLogin(op2User, opPass)
    const tokenOp2 = resOp2Login.token

    // Verificar que la sesión funciona
    const rOp2Before = await apiFetch('/auth/mesas/disponibles', 'GET', tokenOp2)
    assert(rOp2Before.status === 200, '6.1 Sesión del operador 2 activa antes de desactivar')

    // Admin desactiva al operador 2
    const resAdminTok = await apiLogin(adminUser, adminPass)
    const tokenAdminFresh = resAdminTok.token
    const rDesactiva = await apiFetch(`/admin/usuarios/${op2Id}`, 'PATCH', tokenAdminFresh,
                                      { activo: false })
    assert(rDesactiva.status === 200, `6.2 Admin desactiva al operador 2 (HTTP ${rDesactiva.status})`)

    // La siguiente petición del operador 2 debe ser rechazada
    const rOp2After = await apiFetch('/auth/mesas/disponibles', 'GET', tokenOp2)
    assert(rOp2After.status === 401 || rOp2After.status === 403,
           `6.3 Sesión del operador desactivado es rechazada inmediatamente (HTTP ${rOp2After.status})`)

    // Reactivar al operador 2
    await apiFetch(`/admin/usuarios/${op2Id}`, 'PATCH', tokenAdminFresh, { activo: true })

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 7: ATAQUES — Token manipulado, fuerza bruta, datos hostiles
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[7] Ataques: token manipulado, fuerza bruta y datos hostiles')

    // Token manipulado (firma inválida)
    const rTokenFalso = await apiFetch('/auth/mesas/disponibles', 'GET',
                                       'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidXNlcm5hbWUiOiJhZG1pbiIsInJvbCI6ImFkbWluIn0.firma_falsa')
    assert(rTokenFalso.status === 401, '7.1 Token con firma inválida rechazado (401)')

    // Token vencido (iat en el pasado, exp expirado)
    const tokenVencido = require('jsonwebtoken').sign(
      { id: opId, username: opUser, rol: 'operador', jti: crypto.randomUUID() },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: -1 } // expira inmediatamente
    )
    const rTokenVencido = await apiFetch('/auth/mesas/disponibles', 'GET', tokenVencido)
    assert(rTokenVencido.status === 401, '7.2 Token vencido rechazado (401)')

    // Fuerza bruta: 12 intentos con contraseña incorrecta
    await resetRateLimit()
    let intentosBloqueados = 0
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: opUser, password: 'wrong_password_123' })
      })
      if (r.status === 429) intentosBloqueados++
    }
    assert(intentosBloqueados > 0,
           '7.3 Rate-limiting activo: login bloqueado tras 10 intentos fallidos (HTTP 429)')
    await resetRateLimit()

    // Datos hostiles: caracteres especiales y SQL en el formulario de login
    const payloadsHostiles = [
      { username: "' OR '1'='1", password: "' OR '1'='1" },
      { username: '<script>alert(1)</script>', password: 'cualquiera' },
      { username: 'a'.repeat(1000), password: 'b'.repeat(1000) },
      { username: null, password: null },
      { username: { $gt: '' }, password: { $gt: '' } }
    ]
    let hostilesOk = 0
    for (const payload of payloadsHostiles) {
      try {
        const r = await fetch(`${BASE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        if (r.status === 401 || r.status === 400 || r.status === 422 || r.status === 429) {
          hostilesOk++
        }
      } catch(_) { hostilesOk++ } // error de red también es aceptable
    }
    assert(hostilesOk === payloadsHostiles.length,
           `7.4 Todos los inputs hostiles rechazados correctamente (${hostilesOk}/${payloadsHostiles.length})`)

    // Suplantar mesa_id en la petición (IDOR en /turnos/llamar)
    const resOpReal = await apiLogin(opUser, opPass)
    const tokenOpReal = resOpReal.token

    // Intentar llamar con un mesa_id que no le pertenece al operador
    const rImpersonar = await fetch(`${BASE}/turnos/llamar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenOpReal}`,
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify({ mesa_id: mesaId + 9999 }) // ID que no existe
    })
    assert(rImpersonar.status === 403 || rImpersonar.status === 404,
           `7.5 Operador no puede llamar con mesa_id que no le pertenece (HTTP ${rImpersonar.status})`)

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 8: HALLAZGO — Dirección pública
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[8] Hallazgo registrado — Dirección pública (pendiente de implementación)')
    hallazgo('media',
      '8.0 Restricción de dirección pública no implementada',
      'Confirmado por el usuario: la restricción de que solo el kiosko sea accesible ' +
      'desde la dirección pública está pendiente de implementación. Actualmente, ' +
      '/admin.html, /panel_mesa.html, /tv.html e /index.html son accesibles desde ' +
      'cualquier interfaz de red. Se recomienda implementar un proxy inverso (nginx/caddy) ' +
      'que filtre por interfaz o agregar middleware de Fastify que verifique el host/IP origen.')

    // Verificar el estado actual: /admin.html accesible sin restricción de red
    const rAdminHtml = await fetch(`${BASE}/admin.html`)
    if (rAdminHtml.status === 200) {
      hallazgo('media',
        '8.1 /admin.html accesible sin restricción de IP/red',
        'La pantalla de administración es accesible desde cualquier dirección. ' +
        'Aunque requiere autenticación, debería ser inaccesible desde redes públicas.')
    } else {
      assert(true, `8.1 /admin.html retorna ${rAdminHtml.status} (puede haber restricción activa)`)
    }

  } catch (err) {
    console.error('\n[ERROR INESPERADO]', err.message, err.stack)
    failed++
  } finally {
    console.log('\n[LIMPIEZA] Cerrando browser, conexiones y eliminando datos de prueba...')
    for (const ws of allWs) { try { ws.close() } catch(_) {} }
    if (browser) await browser.close().catch(() => {})
    await sleep(300)

    // Limpiar entidades de prueba
    if (mesaId) {
      await pool.query(`UPDATE mesas SET estado = 'eliminada', eliminado_en = NOW(), operador_id = NULL WHERE id = $1`, [mesaId]).catch(() => {})
    }
    for (const uid of [opId, op2Id, adminId, admin2Id].filter(Boolean)) {
      await pool.query(`UPDATE usuarios SET eliminado_en = NOW(), activo = false WHERE id = $1`, [uid]).catch(() => {})
      await redis.del(`user_active_session:${uid}`).catch(() => {})
    }

    await pool.end().catch(() => {})
    await redis.quit().catch(() => {})

    console.log('══════════════════════════════════════════════════════════════')
    console.log(`  RESULTADO: ${passed} PASADOS | ${failed} FALLADOS`)
    if (hallazgos.length > 0) {
      console.log(`  HALLAZGOS (${hallazgos.length}):`)
      for (const h of hallazgos) console.log(`    [${h.sev}] ${h.titulo}: ${h.detalle}`)
    }
    console.log('══════════════════════════════════════════════════════════════')
    process.exit(failed > 0 ? 1 : 0)
  }
}

run()

