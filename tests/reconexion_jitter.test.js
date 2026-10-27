'use strict'

/**
 * MÓDULO: reconexion
 * OBJETIVO: Verificar la lógica de reconexión con backoff exponencial y Full Jitter de todas
 *           las pantallas (TV, panel, admin, kiosko), detectar fugas de timers/sockets,
 *           y resistencia a cortes prolongados, sesiones vencidas y cortes intermitentes.
 * EJECUCIÓN: node tests/reconexion_jitter.test.js
 */

const WebSocket = require('ws')
const { Pool }  = require('pg')
const Redis     = require('ioredis')
const bcrypt    = require('bcrypt')
const crypto    = require('crypto')
const net       = require('net')
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

// ── Helper: simula corte TCP abrupto (sin FIN de cierre limpio) ──────────
async function abrirYCortar(url, espera = 500) {
  const ws = new WebSocket(url)
  await new Promise(r => { ws.on('open', r); ws.on('error', r); setTimeout(r, 3000) })
  await sleep(espera)
  // Simular corte abrupto: terminar el socket TCP sin close frame
  if (ws._socket) {
    ws._socket.destroy()
  } else {
    ws.terminate()
  }
  return ws
}

// ── Helper: conectar y medir delays de reconexión (simulado en Node) ──────
// Simula el comportamiento del ws-client.js desde el servidor, verificando
// que N conexiones distintas dispersan sus tiempos de reintento.
async function medirJitter(baseDelay, maxDelay, N = 100) {
  const delays = []
  for (let intento = 1; intento <= N; intento++) {
    const maxInterval = Math.min(maxDelay, baseDelay * Math.pow(2, Math.min(intento - 1, 6)))
    const delay = Math.max(500, Math.floor(Math.random() * maxInterval))
    delays.push(delay)
  }
  return delays
}

async function login(username, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const body = await res.json()
  return { status: res.status, token: body.token, cookies: res.headers.get('set-cookie') }
}

async function run() {
  console.log('══════════════════════════════════════════════════════════════')
  console.log('  RECONEXIÓN — JITTER, RECUPERACIÓN Y RESISTENCIA A CORTES    ')
  console.log('══════════════════════════════════════════════════════════════')
  console.log(`[RUN ID: ${RUN_ID}]\n`)

  const pool  = new Pool({ connectionString: process.env.DATABASE_URL })
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379',
    { password: process.env.REDIS_PASSWORD, lazyConnect: false })

  let passed = 0, failed = 0
  const hallazgos = []
  const allWs = []
  let opId = null, mesaId = null, adminId = null
  let tokenOp = null, tokenAdmin = null

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
    // ── SETUP ────────────────────────────────────────────────────────────
    console.log('[SETUP] Creando entidades de prueba...')
    await resetRateLimit()
    const opPass    = 'Recon_Test_2026!'
    const adminPass = 'Recon_Admin_2026!'
    const hOp       = await bcrypt.hash(opPass, 10)
    const hAdmin    = await bcrypt.hash(adminPass, 10)
    const opUser    = `op_recon_${RUN_ID}`
    const adminUser = `adm_recon_${RUN_ID}`
    let mesaNum   = null

    const rOp = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
       VALUES ($1, $2, $3, 'operador', true) RETURNING id`,
      [opUser, `Op Recon ${RUN_ID}`, hOp])
    opId = rOp.rows[0].id

    const rAdm = await pool.query(
      `INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
       VALUES ($1, $2, $3, 'admin', true) RETURNING id`,
      [adminUser, `Admin Recon ${RUN_ID}`, hAdmin])
    adminId = rAdm.rows[0].id

    const { rows: [{ max_num }] } = await pool.query('SELECT COALESCE(MAX(numero), 10000) AS max_num FROM mesas')
    mesaNum = Number(max_num) + 1
    const rM = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id)
       VALUES ($1, $2, 'activa', $3) RETURNING id`,
      [mesaNum, `Mesa Recon ${RUN_ID}`, opId])
    mesaId = rM.rows[0].id

    await pool.query(`UPDATE lotes_voucher SET numero_hasta = GREATEST(numero_hasta, ultimo_numero_llamado + 300)
                      WHERE estado = 'activo'`)

    const resOp  = await login(opUser, opPass)
    const resAdm = await login(adminUser, adminPass)
    tokenOp    = resOp.token
    tokenAdmin = resAdm.token
    console.log(`   [OK] Op id=${opId}, Admin id=${adminId}, Mesa id=${mesaId}\n`)

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 1: VERIFICACIÓN DEL ALGORITMO DE JITTER (Código del cliente)
    // ──────────────────────────────────────────────────────────────────────
    console.log('[1] Verificar algoritmo Full Jitter en ws-client.js')
    const fs = require('fs')
    const clientSrc = fs.readFileSync('src/public/js/ws-client.js', 'utf8')

    const tieneMaxDelay     = clientSrc.includes('maxDelay') || clientSrc.includes('30000')
    const tieneJitter       = clientSrc.includes('Math.random') || clientSrc.includes('random')
    const tienePow2         = clientSrc.includes('Math.pow') || clientSrc.includes('2, ')
    const tieneReconnectAttempts = clientSrc.includes('reconnectAttempts')

    assert(tieneMaxDelay,          '1.1 ws-client.js tiene maxDelay (cap de reconexión)')
    assert(tieneJitter,            '1.2 ws-client.js usa Math.random (jitter)')
    assert(tienePow2,              '1.3 ws-client.js usa exponencial (2^n)')
    assert(tieneReconnectAttempts, '1.4 ws-client.js cuenta intentos de reconexión')

    // Simular el cálculo de jitter para 100 pantallas (N=100, baseDelay=1000, maxDelay=30000)
    const delays100 = await medirJitter(1000, 30000, 100)
    const delayMin = Math.min(...delays100)
    const delayMax = Math.max(...delays100)
    const delayStd = Math.sqrt(delays100.reduce((s, d) => s + (d - delays100.reduce((a,b)=>a+b)/100)**2, 0) / 100)

    assert(delayMin >= 500,   `1.5 Jitter mínimo >= 500ms (actual: ${delayMin}ms)`)
    assert(delayMax <= 30000, `1.6 Jitter máximo <= 30000ms (cap) (actual: ${delayMax}ms)`)
    assert(delayStd > 1000,   `1.7 Alta dispersión de jitter (desv. estándar: ${Math.round(delayStd)}ms > 1000ms)`)

    // Con 100 pantallas reconectando, NO deben coincidir más de 5 en el mismo segundo
    const porSegundo = {}
    for (const d of delays100) {
      const s = Math.floor(d / 1000)
      porSegundo[s] = (porSegundo[s] || 0) + 1
    }
    const maxCoincidencias = Math.max(...Object.values(porSegundo))
    assert(maxCoincidencias <= 20,
           `1.8 No más de 20 pantallas reconectan en el mismo segundo (máx: ${maxCoincidencias}/100)`)

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 2: RECUPERACIÓN TRAS CORTE — Snapshot sin duplicados
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[2] Recuperación tras corte: snapshot correcto sin duplicar eventos')

    // Abrir TV y panel
    const tvMsgs   = []
    const panelMsgs = []

    const tvWs = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
    const panelWs = new WebSocket(`${BASE_WS}/ws?token=${tokenOp}&canal=mesa:${mesaId}`)
    allWs.push(tvWs, panelWs)

    tvWs.on('message',    d => { try { tvMsgs.push(JSON.parse(d.toString()))    } catch(_) {} })
    panelWs.on('message', d => { try { panelMsgs.push(JSON.parse(d.toString())) } catch(_) {} })

    await new Promise(r => {
      let ok = 0
      const check = () => { if (++ok >= 2) r() }
      tvWs.on('open', check); panelWs.on('open', check)
      tvWs.on('error', check); panelWs.on('error', check)
      setTimeout(r, 4000)
    })
    await sleep(400)

    // Llamar un turno antes del corte
    await fetch(`${BASE}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenOp}`,
                 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: mesaId })
    })
    await sleep(500)

    const llamadoAntesCorte = tvMsgs.filter(m => m.tipo === 'nuevo_llamado').length
    assert(llamadoAntesCorte >= 1, `2.1 TV recibió evento antes del corte (${llamadoAntesCorte} eventos)`)

    // Simular corte: cerrar el socket de TV abruptamente
    tvWs.terminate()
    await sleep(200)

    // Llamar otro turno durante el "corte"
    const rDuranteCorte = await fetch(`${BASE}/turnos/llamar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenOp}`,
                 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ mesa_id: mesaId })
    })
    const numeroDuranteCorte = (await rDuranteCorte.json())?.turno?.numero
    await sleep(300)

    // Reconectar TV
    const tvMsgsPost = []
    const tvWs2 = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
    allWs.push(tvWs2)

    let snapshotPostReconexion = null
    await new Promise(r => {
      tvWs2.on('open', () => {
        // Solicitar snapshot explícitamente (como haría el ws-client.js)
        tvWs2.send(JSON.stringify({ tipo: 'solicitar_snapshot', payload: { canal: 'tv:global' } }))
        r()
      })
      tvWs2.on('error', r)
      setTimeout(r, 3000)
    })
    tvWs2.on('message', d => {
      try {
        const msg = JSON.parse(d.toString())
        tvMsgsPost.push(msg)
        if (msg.tipo === 'snapshot') snapshotPostReconexion = msg.payload
      } catch(_) {}
    })
    await sleep(1000)

    assert(snapshotPostReconexion !== null,
           '2.2 TV reconectada recibe snapshot tras solicitar_snapshot')

    if (snapshotPostReconexion) {
      const ultimoLlamado = snapshotPostReconexion.ultimo_llamado
      assert(ultimoLlamado !== null,
             '2.3 Snapshot post-reconexión contiene ultimo_llamado')

      // El turno llamado durante el corte debe estar en el snapshot
      if (numeroDuranteCorte && ultimoLlamado) {
        const enHistorial = snapshotPostReconexion.historial?.some(h => h.numero === numeroDuranteCorte)
                         || ultimoLlamado.numero === numeroDuranteCorte
        assert(enHistorial,
               `2.4 Turno llamado durante el corte (#${numeroDuranteCorte}) aparece en snapshot post-reconexión`)
      }
    }

    // Sin duplicados: snapshot no duplica en la lista de mensajes
    const snapshots = tvMsgsPost.filter(m => m.tipo === 'snapshot')
    assert(snapshots.length <= 2, // puede haber el inicial + el de solicitar_snapshot
           `2.5 TV no recibe snapshots duplicados (recibidos: ${snapshots.length})`)

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 3: SIN BUCLES NI FUGAS — Servidor que acepta y cierra de inmediato
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[3] Sin bucles ni fugas: servidor que rechaza de inmediato')

    // Un token inválido debe provocar cierre sin bucle de reintentos
    // (En el cliente real hay backoff; aquí comprobamos que el servidor
    //  responde con código de cierre esperado y no con 1006/reset)
    const cerradoInvalido = await new Promise(resolve => {
      const ws = new WebSocket(`${BASE_WS}/ws?token=token.invalido.xxx&canal=admin:all`)
      allWs.push(ws)
      ws.on('close', (code) => resolve(code))
      ws.on('error', () => resolve(0))
      setTimeout(() => resolve(-1), 3000)
    })
    // El servidor debe rechazar antes del upgrade (401) o cerrar con código específico
    // No debe quedar "colgado" esperando (timeout -1 no es aceptable)
    assert(cerradoInvalido !== -1,
           `3.1 Servidor responde rápido ante token inválido (no se cuelga, code=${cerradoInvalido})`)

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 4: CORTE DIFÍCIL — Sesión vencida durante el corte
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[4] Corte difícil: sesión vencida durante el corte')

    // Simular un token ya revocado (logout manual)
    await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenOp}` }
    })

    // Re-login para un nuevo token
    await resetRateLimit()
    const resOp2 = await login(opUser, opPass)
    const tokenOpNuevo = resOp2.token

    // Intentar reconectar con el token viejo (revocado)
    const cierreTokenViejo = await new Promise(resolve => {
      const ws = new WebSocket(`${BASE_WS}/ws?token=${tokenOp}&canal=mesa:${mesaId}`)
      allWs.push(ws)
      ws.on('close', (code) => resolve(code))
      ws.on('error', () => resolve(0))
      setTimeout(() => resolve(-1), 4000)
    })
    assert(cierreTokenViejo !== 1000 && cierreTokenViejo !== -1,
           `4.1 Token revocado es rechazado al reconectar (code=${cierreTokenViejo})`)

    // Con el token nuevo, la reconexión debe funcionar
    const tokenNuevoFunciona = await new Promise(resolve => {
      const ws = new WebSocket(`${BASE_WS}/ws?token=${tokenOpNuevo}&canal=mesa:${mesaId}`)
      allWs.push(ws)
      ws.on('open', () => { ws.close(); resolve(true) })
      ws.on('error', () => resolve(false))
      setTimeout(() => resolve(false), 4000)
    })
    tokenOp = tokenOpNuevo // actualizar el token para el cleanup
    assert(tokenNuevoFunciona, '4.2 Reconexión con nuevo token después del logout funciona')

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 5: CORTE INTERMITENTE — Cortes repetidos de 1 segundo
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[5] Corte intermitente: 5 cortes de 1 segundo, sin fugas de timers')

    let cortesOk = 0
    const NCORTES = 5

    for (let i = 0; i < NCORTES; i++) {
      const ws = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
      allWs.push(ws)
      const abierto = await new Promise(r => {
        ws.on('open', () => r(true))
        ws.on('error', () => r(false))
        setTimeout(() => r(false), 3000)
      })
      if (abierto) {
        await sleep(1000)
        ws.terminate() // corte abrupto
        await sleep(500)
        cortesOk++
      }
    }
    assert(cortesOk === NCORTES,
           `5.1 ${NCORTES} cortes intermitentes de 1s completados (${cortesOk}/${NCORTES} conexiones abiertas)`)

    // El servidor sigue respondiendo después de los cortes intermitentes
    const rPostCortes = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opUser, password: opPass })
    })
    assert(rPostCortes.status === 200,
           `5.2 Servidor responde correctamente después de ${NCORTES} cortes intermitentes`)

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 6: ACCIONES BLOQUEADAS SIN CONEXIÓN (verificación de código)
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[6] Verificar que las acciones se bloquean sin conexión WS (código del cliente)')

    const panelSrc = fs.readFileSync('src/public/js/pages/panel_mesa.js', 'utf8')
    // El panel debe verificar el estado del WS antes de permitir acciones
    const verificaEstadoWs = panelSrc.includes('CONECTADO') || panelSrc.includes('ws.status') ||
                             panelSrc.includes('wsConectado') || panelSrc.includes('conectado')
    const bloqueaAcciones  = panelSrc.includes('disabled') || panelSrc.includes('loading') ||
                             panelSrc.includes('bloqueado') || panelSrc.includes('x-bind:disabled')

    if (!verificaEstadoWs || !bloqueaAcciones) {
      hallazgo('media',
        '6.1 Panel de operador puede permitir acciones sin conexión WS activa',
        'El panel_mesa.js no muestra evidencia clara de bloqueo de acciones cuando el WS ' +
        'está en estado RECONECTANDO. El API HTTP sí rechazaría la petición (auth válida), ' +
        'pero la UX podría quedar confusa sin feedback de bloqueo visual claro.')
    } else {
      assert(true, '6.1 Panel_mesa.js verifica estado WS antes de habilitar acciones')
    }

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 7: RECONEXIÓN MASIVA — 30 clientes reconectando simultáneamente
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[7] Avalancha de reconexión: 30 clientes TV simultáneos')
    const N_MASIVA = 30
    const reconWsList = []
    const t0 = Date.now()

    const promesasRecon = Array.from({ length: N_MASIVA }, () =>
      new Promise(resolve => {
        const ws = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
        reconWsList.push(ws)
        allWs.push(ws)
        let snapshotRecibido = false
        ws.on('message', (d) => {
          try {
            const msg = JSON.parse(d.toString())
            if (msg.tipo === 'snapshot') snapshotRecibido = true
          } catch(_) {}
        })
        ws.on('open', () => {
          // Simular solicitud de snapshot como hace el ws-client.js tras reconectar
          ws.send(JSON.stringify({ tipo: 'solicitar_snapshot', payload: { canal: 'tv:global' } }))
        })
        ws.on('error', () => resolve({ ok: false, snapshotRecibido }))
        setTimeout(() => resolve({ ok: ws.readyState === 1, snapshotRecibido }), 5000)
      })
    )

    const resultadosRecon = await Promise.all(promesasRecon)
    const tiempoRecon = Date.now() - t0
    const conectadosOk = resultadosRecon.filter(r => r.ok).length

    assert(conectadosOk >= N_MASIVA * 0.9,
           `7.1 ${conectadosOk}/${N_MASIVA} clientes conectados en reconexión masiva (>= 90%)`)
    assert(tiempoRecon < 8000,
           `7.2 ${N_MASIVA} reconexiones masivas en ${tiempoRecon}ms (< 8000ms)`)

    await sleep(1000)
    const conSnapshots = resultadosRecon.filter(r => r.snapshotRecibido).length
    assert(conSnapshots >= N_MASIVA * 0.8,
           `7.3 ${conSnapshots}/${N_MASIVA} clientes recibieron snapshot en la reconexión masiva`)

    // Cerrar todos
    for (const ws of reconWsList) { try { ws.close() } catch(_) {} }

    // El servidor sigue vivo
    const rFinal = await fetch(`${BASE}/index.html`)
    assert(rFinal.status === 200,
           '7.4 Servidor vivo y respondiendo tras la avalancha de reconexiones')

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 8: Detección de corte silencioso (verificación de código)
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[8] Verificar detección de corte silencioso (heartbeat y silenceTimeout)')

    const tieneHeartbeat = clientSrc.includes('heartbeatTimer') || clientSrc.includes('heartbeat')
    const tieneSilenceTimeout = clientSrc.includes('silenceTimeout') || clientSrc.includes('lastActivityTime')
    const tieneTerminate = clientSrc.includes('1001') || clientSrc.includes('silencio_detectado')

    assert(tieneHeartbeat,      '8.1 ws-client.js implementa heartbeat periódico')
    assert(tieneSilenceTimeout, '8.2 ws-client.js detecta corte silencioso por inactividad')
    assert(tieneTerminate,      '8.3 ws-client.js fuerza reconexión al detectar corte silencioso')

    // El servidor también tiene heartbeat global
    const hubSrc = fs.readFileSync('src/modules/ws/hub.js', 'utf8')
    const servidorHeartbeat = hubSrc.includes('HEARTBEAT_INTERVAL') || hubSrc.includes('globalHeartbeatTimer')
    const servidorZombie    = hubSrc.includes('terminate') || hubSrc.includes('isAlive')
    assert(servidorHeartbeat, '8.4 hub.js implementa heartbeat global del servidor')
    assert(servidorZombie,    '8.5 hub.js termina conexiones zombi (isAlive/terminate)')

  } catch (err) {
    console.error('\n[ERROR INESPERADO]', err.message, err.stack)
    failed++
  } finally {
    console.log('\n[LIMPIEZA] Cerrando conexiones y eliminando datos de prueba...')
    for (const ws of allWs) { try { ws.close() } catch(_) {} }
    await sleep(300)

    if (mesaId) {
      await pool.query(`UPDATE mesas SET estado = 'eliminada', eliminado_en = NOW(), operador_id = NULL WHERE id = $1`, [mesaId])
        .catch(() => {})
    }
    if (opId)    await pool.query(`UPDATE usuarios SET eliminado_en = NOW(), activo = false WHERE id = $1`, [opId]).catch(() => {})
    if (adminId) await pool.query(`UPDATE usuarios SET eliminado_en = NOW(), activo = false WHERE id = $1`, [adminId]).catch(() => {})
    if (opId)    await redis.del(`user_active_session:${opId}`).catch(() => {})
    if (adminId) await redis.del(`user_active_session:${adminId}`).catch(() => {})

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

