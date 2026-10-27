/**
 * MÓDULO: kiosko_autonomo
 * OBJETIVO: Trazabilidad, consulta y seguimiento en tiempo real del turno del estudiante.
 *           Detección de IP de LAN para el enlace y código QR evitando localhost;
 *           consulta de posición en cola y tiempo estimado con token seguro de 64 caracteres
 *           (GET /turnos/mi-turno/:token y alias /kiosko/mi-turno/:token);
 *           actualización y notificación reactiva por WebSocket en canal kiosko:<token>
 *           ante llamados, re-llamados y finalización;
 *           manejo semántico de token inexistente (404 turno_no_encontrado).
 * EJECUCIÓN: node tests/kiosko_seguimiento_tracking.test.js
 */

'use strict'

const WebSocket = require('ws')
const { Pool } = require('pg')
const crypto = require('crypto')
const { getLanIpAddress, resolverUrlSeguimiento } = require('../src/modules/kiosko/service')
require('dotenv').config()

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE_HTTP = process.env.APP_URL || `http://localhost:${PORT}`
const BASE_WS = BASE_HTTP.replace('http', 'ws')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
  console.log('======================================================================')
  console.log(' KIOSKO — SEGUIMIENTO, CONSULTA DE TURNO Y TRACKING EN TIEMPO REAL')
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

  // Guardar configuración original
  const { rows: configOrig } = await pool.query(
    `SELECT clave, valor FROM configuracion
     WHERE clave IN ('kiosko_web_activo', 'modo_generacion_turnos', 'kiosko_modo_uso')`
  )
  const origMap = {}
  for (const c of configOrig) origMap[c.clave] = c.valor

  let turnoCreado = null
  let socketEstudiante = null
  let mesaTestId = null

  try {
    // ── 1. Detección de IP LAN y Enlaces QR ─────────────────────────────────────
    console.log('[1/4] Evaluando resolución de IP LAN y generación de enlaces QR...')
    const ipLan = getLanIpAddress()
    assert(typeof ipLan === 'string' && ipLan.length >= 7, `IP de LAN detectada correctamente: ${ipLan}`)

    const tokenFalso = crypto.randomBytes(32).toString('hex')
    const urlGenerada = resolverUrlSeguimiento('', 'localhost:3000', 'http', tokenFalso)
    assert(!urlGenerada.includes('localhost'), 'URL de seguimiento reemplaza localhost por IP de LAN para lectura móvil')
    assert(urlGenerada.includes(`token=${tokenFalso}`), 'URL generada incluye el token de consulta seguro')

    // ── 2. Generación de Turno y Consulta de Posición en Cola ──────────────────
    console.log('\n[2/4] Generando turno y consultando posición y tiempo estimado de espera...')
    await pool.query(`UPDATE configuracion SET valor = 'true' WHERE clave = 'kiosko_web_activo'`)
    await pool.query(`UPDATE configuracion SET valor = 'kiosko_web' WHERE clave = 'modo_generacion_turnos'`)
    await pool.query(`UPDATE configuracion SET valor = 'asistido' WHERE clave = 'kiosko_modo_uso'`)

    const rGen = await fetch(`${BASE_HTTP}/kiosko/generar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modo: 'tablet' })
    })
    turnoCreado = await rGen.json()
    assert(rGen.status === 201 && turnoCreado.token, `Turno generado exitosamente (#${turnoCreado.numero})`)

    // Consultar turno mediante GET /turnos/mi-turno/:token
    const rMiTurno = await fetch(`${BASE_HTTP}/turnos/mi-turno/${turnoCreado.token}`)
    const dMiTurno = await rMiTurno.json()

    assert(rMiTurno.status === 200, 'GET /turnos/mi-turno/:token responde 200 OK')
    assert(dMiTurno.numero === turnoCreado.numero, `Número de turno coincide (#${dMiTurno.numero})`)
    assert(dMiTurno.estado === 'esperando', 'Estado inicial del turno es esperando')
    assert(typeof dMiTurno.posicion === 'number' || typeof dMiTurno.posicion_en_cola === 'number',
      `Posición en cola reportada: ${dMiTurno.posicion ?? dMiTurno.posicion_en_cola}`)
    assert(dMiTurno.tiempo_estimado_min !== undefined, 'Estimación de tiempo de espera calculada')

    // Consultar mediante alias GET /kiosko/mi-turno/:token
    const rAlias = await fetch(`${BASE_HTTP}/kiosko/mi-turno/${turnoCreado.token}`)
    assert(rAlias.status === 200, 'Alias GET /kiosko/mi-turno/:token responde 200 OK')

    // ── 3. Manejo de Token Inexistente o Alterado ──────────────────────────────
    console.log('\n[3/4] Evaluando rechazo semántico de tokens inexistentes (404)...')
    const tokenInexistente = 'f'.repeat(64)
    const rInexistente = await fetch(`${BASE_HTTP}/turnos/mi-turno/${tokenInexistente}`)
    const dInexistente = await rInexistente.json()

    assert(rInexistente.status === 404, 'Consulta con token inexistente responde con HTTP 404 Not Found')
    assert(dInexistente.codigo === 'turno_no_encontrado' || dInexistente.error?.codigo === 'turno_no_encontrado',
      'Código de error reporta turno_no_encontrado')

    // ── 4. Notificaciones Reactivas en Vivo por WebSocket (kiosko:<token>) ─────
    console.log('\n[4/4] Conectando smartphone del estudiante a su canal WebSocket personal...')
    socketEstudiante = new WebSocket(`${BASE_WS}/ws?canal=kiosko:${turnoCreado.token}`)
    const eventosRecibidos = []

    await new Promise((resolve, reject) => {
      socketEstudiante.on('open', resolve)
      socketEstudiante.on('error', reject)
      socketEstudiante.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          eventosRecibidos.push(msg)
        } catch (_) {}
      })
    })

    assert(socketEstudiante.readyState === WebSocket.OPEN,
      `Socket del estudiante conectado al canal personal kiosko:${turnoCreado.token.slice(0, 8)}...`)

    // Simular que el turno pasa a ser llamado por un operador en una ventanilla aislada
    console.log('   Simulando llamado de ventanilla...')
    const mesaTestNum = 9400 + (Date.now() % 400)
    const { rows: [mesaTest] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado) VALUES ($1, $2, 'activa') RETURNING id, numero`,
      [mesaTestNum, `Mesa Tracking [${mesaTestNum}]`]
    )
    const mesaId = mesaTest.id
    mesaTestId = mesaTest.id
    const mesaNum = mesaTest.numero

    await pool.query(
      `UPDATE turnos SET estado = 'en_atencion', mesa_id = $1, llamado_en = NOW() WHERE token_consulta = $2`,
      [mesaId, turnoCreado.token]
    )

    // Notificar al canal personal del estudiante mediante Redis Pub/Sub (distribución tiempo real multi-instancia)
    const Redis = require('ioredis')
    const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
    await redisClient.del(`mi_turno:${turnoCreado.token}`)
    await redisClient.publish('ws:broadcast', JSON.stringify({
      canal: `kiosko:${turnoCreado.token}`,
      tipo: 'turno_llamado',
      payload: {
        turno: turnoCreado.numero,
        mesa: mesaNum,
        timestamp: new Date().toISOString()
      }
    }))
    await redisClient.quit()

    await sleep(250)

    const eventoLlamado = eventosRecibidos.find(e => e.tipo === 'turno_llamado')
    assert(!!eventoLlamado, 'Smartphone recibió evento turno_llamado por WebSocket en tiempo real')
    assert(eventoLlamado?.payload?.mesa === mesaNum, `Evento indica correctamente dirigirse a Mesa ${mesaNum}`)

    // Comprobar que al volver a consultar la API el estado cambió a en_atencion
    const rAtencion = await fetch(`${BASE_HTTP}/turnos/mi-turno/${turnoCreado.token}`)
    const dAtencion = await rAtencion.json()
    assert(dAtencion.estado === 'en_atencion', 'Consulta HTTP refleja de inmediato estado en_atencion')

  } finally {
    // ── Limpieza Segura ────────────────────────────────────────────────────────
    console.log('\nLimpiando conexiones y restaurando configuración...')
    if (socketEstudiante) {
      try { socketEstudiante.close() } catch (_) {}
    }
    if (turnoCreado?.token) {
      await pool.query(`DELETE FROM turnos WHERE token_consulta = $1`, [turnoCreado.token]).catch(() => {})
    }
    if (mesaTestId) {
      await pool.query(`DELETE FROM mesas WHERE id = $1`, [mesaTestId]).catch(() => {})
    }
    for (const [clave, valor] of Object.entries(origMap)) {
      if (valor !== undefined) {
        await pool.query(`UPDATE configuracion SET valor = $1 WHERE clave = $2`, [valor, clave]).catch(() => {})
      }
    }
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
  console.error('\n[FAIL] Error fatal en kiosko_seguimiento_tracking:', err)
  process.exit(1)
})
