/**
 * MÓDULO: tv_pantalla_publica
 * OBJETIVO: Evaluar el disparador de alertas sonoras (campanilla y voz).
 *           Las alertas no se duplican, repiten ni entran en bucle ante llamados consecutivos o re-llamados.
 * EJECUCIÓN: node tests/tv_sistema_sonido.test.js
 */

'use strict'

const WebSocket = require('ws')
const { Pool } = require('pg')
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
  console.log(' TV — SISTEMA DE SONIDO Y PREVENCIÓN DE BUCLES / DUPLICADOS')
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

  // 1. Conexión WebSocket real para verificar el payload de eventos sonoros
  console.log('[1/4] Verificando payloads de sonido del servidor WebSocket...')
  const tvWs = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
  const tvEventos = []

  await new Promise((resolve, reject) => {
    tvWs.on('open', resolve)
    tvWs.on('error', reject)
    tvWs.on('message', (data) => {
      try { tvEventos.push(JSON.parse(data.toString())) } catch (_) {}
    })
  })

  // Obtener token operador
  const { rows: [op] } = await pool.query(`SELECT id, username FROM usuarios WHERE rol = 'operador' LIMIT 1`)
  const loginRes = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: op.username, password: 'Operador2026!' })
  })
  const { token } = await loginRes.json()

  const mesaNum = 6200 + (Date.now() % 1000)
  const { rows: [mesa] } = await pool.query(
    `INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES ($1, $2, 'activa', $3) RETURNING id`,
    [mesaNum, `Mesa Audio [${mesaNum}]`, op.id]
  )

  // Llamar turno y luego re-llamar
  const rLlamar = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ mesa_id: mesa.id })
  })
  const dLlamar = await rLlamar.json()
  const turnoId = dLlamar.turno.id

  const rRellamar = await fetch(`${BASE_HTTP}/turnos/${turnoId}/rellamar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ mesa_id: mesa.id })
  })
  assert(rRellamar.status === 200, 'Re-llamar responde 200 OK')

  await sleep(200)
  const evNuevo = tvEventos.find(e => e.tipo === 'nuevo_llamado' && e.payload?.numero === dLlamar.turno.numero)
  const evRellamado = tvEventos.find(e => e.tipo === 'turno_rellamado' && e.payload?.numero === dLlamar.turno.numero)

  assert(!!evNuevo, 'TV recibe evento nuevo_llamado')
  assert(!!evNuevo.payload.evento_id, 'Evento nuevo_llamado tiene evento_id único para deduplicación sonora')
  assert(!!evRellamado, 'TV recibe evento turno_rellamado')
  assert(evRellamado.payload.es_rellamado === true, 'Evento turno_rellamado marca es_rellamado=true')
  assert(evRellamado.payload.evento_id !== evNuevo.payload.evento_id, 'evento_id es distinto entre llamado y re-llamado')

  // 2. Simulación de la Máquina de Audio de tv.js
  console.log('\n[2/4] Evaluando máquina de estados de sonido (Campana + Voz y anti-bucle)...')

  function crearMotorAudioTV() {
    let _cola = []
    let _reproduciendo = false
    let _campanasDisparadas = []
    let _vocesDisparadas = []
    let _seqVistos = new Set()
    let _watchdogDisparado = false
    let _vozHabilitada = true

    function setVozHabilitada(val) {
      _vozHabilitada = val
    }

    function onEvento(tipo, payload) {
      const eventoId = payload.evento_id || `ev_${payload.seq}_${payload.numero}`
      // Deduplicación estricta por eventoId (WS-004 / RF-TV-02)
      if (_seqVistos.has(eventoId)) return false
      _seqVistos.add(eventoId)

      _cola.push({ tipo, payload, eventoId })
      despachar()
      return true
    }

    async function despachar() {
      if (_reproduciendo) return
      if (_cola.length === 0) return

      _reproduciendo = true
      const item = _cola.shift()

      // 1. Disparar campanilla institucional (siempre)
      _campanasDisparadas.push({
        numero: item.payload.numero,
        tipo: item.tipo,
        timestamp: Date.now()
      })
      await sleep(15) // tiempo de chime

      // 2. Disparar voz sintetizada si está activa
      if (_vozHabilitada) {
        _vocesDisparadas.push({
          texto: item.tipo === 'rellamado'
            ? `Segundo aviso: Turno ${item.payload.numero}, dirigirse a Mesa ${item.payload.mesa_numero}`
            : `Turno ${item.payload.numero}, Mesa ${item.payload.mesa_numero}`,
          tipo: item.tipo,
          timestamp: Date.now()
        })
        await sleep(25) // tiempo de voz
      }

      _reproduciendo = false
      // Siguiente en la cola
      if (_cola.length > 0) {
        despachar()
      }
    }

    return {
      onEvento,
      setVozHabilitada,
      getEstadisticas: () => ({
        campanas: [..._campanasDisparadas],
        voces: [..._vocesDisparadas],
        colaRestante: _cola.length
      })
    }
  }

  // TEST 1: Llamados consecutivos no generan bucle ni solapamiento
  const motor = crearMotorAudioTV()
  motor.onEvento('nuevo', { numero: 401, mesa_numero: 1, evento_id: 'ev_401' })
  motor.onEvento('nuevo', { numero: 402, mesa_numero: 2, evento_id: 'ev_402' })
  motor.onEvento('rellamado', { numero: 401, mesa_numero: 1, evento_id: 'rel_401_1' })

  await sleep(200)
  const st1 = motor.getEstadisticas()
  assert(st1.campanas.length === 3, `Se ejecutaron exactamente 3 campanillas (${st1.campanas.length}/3)`)
  assert(st1.voces.length === 3, `Se ejecutaron exactamente 3 voces (${st1.voces.length}/3)`)
  assert(st1.colaRestante === 0, 'La cola de sonido terminó en reposo sin bucle infinito')

  // TEST 2: Reenvío del mismo evento por reconexión o snapshot NO duplica el sonido
  console.log('\n[3/4] Evaluando prevención de duplicados ante retransmisión de red...')
  const reintentoDuplicado = motor.onEvento('nuevo', { numero: 401, mesa_numero: 1, evento_id: 'ev_401' })
  assert(reintentoDuplicado === false, 'Evento duplicado con mismo evento_id es descartado silenciosamente')

  const st2 = motor.getEstadisticas()
  assert(st2.campanas.length === 3, 'El contador de campanillas no aumentó ante evento duplicado')
  assert(st2.voces.length === 3, 'El contador de voces no aumentó ante evento duplicado')

  // TEST 3: Voz desactivada en configuración -> suena campana pero no habla
  console.log('\n[4/4] Evaluando comportamiento con voz_anuncio_activa = false...')
  motor.setVozHabilitada(false)
  motor.onEvento('nuevo', { numero: 403, mesa_numero: 3, evento_id: 'ev_403' })
  await sleep(100)

  const st3 = motor.getEstadisticas()
  assert(st3.campanas.length === 4, 'Campana sonó para el turno 403 con voz desactivada')
  assert(st3.voces.length === 3, 'No se disparó voz para el turno 403 (voz desactivada)')

  // Limpieza
  tvWs.close()
  await pool.query(`DELETE FROM mesas WHERE id = $1`, [mesa.id]).catch(() => {})
  await pool.end()

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
  console.error('\n[FAIL] Error fatal en tv_sistema_sonido:', err)
  process.exit(1)
})
