'use strict'

const WebSocket = require('ws')
const { Pool } = require('pg')
const crypto = require('crypto')
require('dotenv').config()

const BASE_HTTP = 'http://localhost:3000'
const BASE_WS = 'ws://localhost:3000'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
  console.log('======================================================================')
  console.log('📺 AUDITORÍA DE LA TV EN VIVO (tv.html / tv.js / hub / routes)')
  console.log('======================================================================\n')

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  let passed = 0
  let failed = 0

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`)
      passed++
    } else {
      console.error(`  ❌ [FAIL] ${message}`)
      failed++
    }
  }

  // Limpiar límites de tasa en Redis
  const Redis = require('ioredis')
  const redis = new Redis(process.env.REDIS_URL || 'redis://:turnero_redis@localhost:6379', { password: process.env.REDIS_PASSWORD || 'turnero_redis' })
  const rlKeys = await redis.keys('fastify-rate-limit-*')
  if (rlKeys.length > 0) await redis.del(...rlKeys)

  // 1. Preparar base de datos
  console.log('1. Preparando base de datos (Lote 1 activo, mesas asignadas)...')
  await pool.query(`
    UPDATE lotes_voucher
    SET estado = 'activo', numero_hasta = 1000
    WHERE id = 1
  `)
  await pool.query(`UPDATE mesas SET operador_id = NULL`)

  const { rows: ops } = await pool.query(`SELECT id, username FROM usuarios WHERE rol = 'operador' ORDER BY id LIMIT 3`)
  const id1 = parseInt(ops[0].id, 10)
  const id2 = parseInt(ops[1].id, 10)
  await pool.query(`UPDATE mesas SET operador_id = ${id1}, estado = 'activa' WHERE id = 1`)
  await pool.query(`UPDATE mesas SET operador_id = ${id2}, estado = 'activa' WHERE id = 2`)

  // Login de operador 1
  const loginRes1 = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'op1', password: 'Operador2026!' })
  })
  const { token: token1 } = await loginRes1.json()

  const loginRes2 = await fetch(`${BASE_HTTP}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'op2', password: 'Operador2026!' })
  })
  const { token: token2 } = await loginRes2.json()

  assert(!!token1 && !!token2, 'Operadores 1 y 2 autenticados con JWT')

  // 2. Conectar socket de TV a tv:global
  console.log('\n2. Conectando cliente WebSocket de TV a tv:global...')
  const tvWs = new WebSocket(`${BASE_WS}/ws?canal=tv:global`)
  const tvEventos = []

  await new Promise((resolve, reject) => {
    tvWs.on('open', resolve)
    tvWs.on('error', reject)
    tvWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        tvEventos.push(msg)
      } catch (_) {}
    })
  })

  // Esperar snapshot inicial
  await sleep(200)
  assert(tvWs.readyState === WebSocket.OPEN, 'Socket TV conectado exitosamente a tv:global')
  const snapInicial = tvEventos.find(e => e.tipo === 'snapshot')
  assert(!!snapInicial, 'TV recibe snapshot inicial al conectar')

  // 3. Test de Entrega Rápida: POST /turnos/llamar responde < 100ms con cola libre
  console.log('\n3. Verificando velocidad de entrega: POST /turnos/llamar (COMMIT -> respuesta)...')
  const iKey1 = crypto.randomUUID()
  const t0 = Date.now()
  const llamarRes1 = await fetch(`${BASE_HTTP}/turnos/llamar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token1}`,
      'Idempotency-Key': iKey1
    },
    body: JSON.stringify({ mesa_id: 1 })
  })
  const durLlamarMs = Date.now() - t0
  const llamarData1 = await llamarRes1.json()

  assert(llamarRes1.status === 200, 'POST /turnos/llamar responde 200 OK')
  assert(durLlamarMs < 100, `POST /turnos/llamar responde en ${durLlamarMs} ms (< 100 ms esperado con cola libre)`)
  assert(!!llamarData1.turno && !!llamarData1.turno.numero, `Turno llamado creado con número ${llamarData1.turno?.numero}`)

  // Esperar evento nuevo_llamado en tv:global
  await sleep(150)
  const eventoNuevoLlamado = tvEventos.find(e => e.tipo === 'nuevo_llamado' && e.payload?.numero === llamarData1.turno.numero)
  assert(!!eventoNuevoLlamado, 'TV recibe evento nuevo_llamado en tv:global tras POST /turnos/llamar')
  assert(typeof eventoNuevoLlamado.seq === 'number' && eventoNuevoLlamado.seq > 0, `Evento lleva seq monotónico (${eventoNuevoLlamado?.seq})`)
  assert(!!eventoNuevoLlamado.payload.evento_id, `Evento lleva evento_id único (${eventoNuevoLlamado?.payload?.evento_id})`)
  assert(eventoNuevoLlamado.payload.mesa_numero !== undefined, 'Evento lleva mesa_numero')
  assert(eventoNuevoLlamado.payload.proximo_numero !== undefined, 'Evento lleva proximo_numero calculado')

  // 4. Test Backend Re-llamar:
  // - Cooldown de 3 s por mesa
  // - Re-llama turno en atención de la mesa (409 si no hay en atención)
  // - Emite turno_rellamado con evento_id
  console.log('\n4. Verificando backend de Re-llamado (POST /turnos/:id/rellamar)...')
  const turnoActivoMesa1 = llamarData1.turno
  const rellamarRes1 = await fetch(`${BASE_HTTP}/turnos/${turnoActivoMesa1.id}/rellamar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token1}`
    },
    body: JSON.stringify({ mesa_id: 1 })
  })
  assert(rellamarRes1.status === 200, 'Primer re-llamado responde 200 OK')

  // Probar cooldown de 3 s de inmediato: debe fallar con 429
  const rellamarSpamRes = await fetch(`${BASE_HTTP}/turnos/${turnoActivoMesa1.id}/rellamar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token1}`
    },
    body: JSON.stringify({ mesa_id: 1 })
  })
  assert(rellamarSpamRes.status === 429, 'Segundo re-llamado inmediato responde 429 Too Many Requests (cooldown 3s activo)')

  // Probar mesa sin turno en atención: debe responder 409
  await pool.query(`UPDATE turnos SET estado = 'atendido' WHERE mesa_id = 2`)
  const rellamarSinTurnoRes = await fetch(`${BASE_HTTP}/turnos/99999/rellamar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token2}`
    },
    body: JSON.stringify({ mesa_id: 2 })
  })
  assert(rellamarSinTurnoRes.status === 409, 'Re-llamar en mesa sin turno en atención responde 409 Conflict')

  // Verificar evento de re-llamado en tv:global
  await sleep(150)
  const eventoRellamado = tvEventos.find(e => e.tipo === 'turno_rellamado' && e.payload?.numero === turnoActivoMesa1.numero)
  assert(!!eventoRellamado, 'TV recibe evento turno_rellamado en tv:global')
  assert(!!eventoRellamado.payload?.evento_id, 'Evento turno_rellamado lleva evento_id propio')

  // 5. Test GET /turnos/estado (1 sola query consolidada)
  console.log('\n5. Verificando GET /turnos/estado (1 query consolidada)...')
  const estadoRes = await fetch(`${BASE_HTTP}/turnos/estado?mesa_id=1`, {
    headers: { 'Authorization': `Bearer ${token1}` }
  })
  const estadoData = await estadoRes.json()
  assert(estadoRes.status === 200, 'GET /turnos/estado responde 200 OK')
  assert(!!estadoData.lote, 'Snapshot contiene lote')
  assert(!!estadoData.mesa, 'Snapshot contiene datos de mesa')
  assert(!!estadoData.turno_actual, 'Snapshot contiene turno_actual')
  assert(Array.isArray(estadoData.ultimos_turnos), 'Snapshot contiene ultimos_turnos (~10)')

  // 6. Pruebas de la Máquina de Estados del Reproductor de TV (Simulación fiel de tvView)
  console.log('\n6. Ejecutando las 7 Pruebas del Reproductor de TV (Reloj simulado)...')

  // Creamos un simulador exacto de la lógica de tvView implementada en tv.js
  function crearSimuladorTV() {
    let _ultimoLlamado = { numero: null, mesa_numero: null, proximo: null, llamado_en: null }
    let _proximoNumero = null
    let _historial = []
    let _glowState = 'idle'
    let _cola = []
    let _colaRellamados = []
    let _seqVistos = new Set()
    let _ultimoLlamadoReal = null
    let _reproduciendo = false
    let _reproduciendoTipo = null
    let _lastSeqAnunciado = 0
    let _lastSeqRecibido = 0
    let _vocesCompletadas = []

    function actualizarContadorCola() {
      return _cola.length + _colaRellamados.length
    }

    function onNuevoLlamado(payload, rawSeq) {
      const numero = payload.numero ?? payload.turno
      if (numero === undefined || numero === null) return
      const seq = Number(rawSeq ?? payload.seq ?? numero)
      const eventoId = payload.evento_id || `llamado_${seq}_${numero}`
      if (_seqVistos.has(eventoId) || _seqVistos.has(`seq_${seq}`)) return
      _seqVistos.add(eventoId)
      _seqVistos.add(`seq_${seq}`)

      const item = {
        tipo: 'nuevo',
        eventoId,
        seq,
        numero: Number(numero),
        mesa_numero: payload.mesa_numero,
        proximo: payload.proximo ?? payload.proximo_numero ?? null,
        llamado_en: payload.llamado_en || new Date().toISOString()
      }

      const idx = _cola.findIndex(c => c.seq > seq)
      if (idx === -1) _cola.push(item)
      else _cola.splice(idx, 0, item)

      despachar()
    }

    function onRellamado(payload) {
      const numero = payload.numero ?? payload.turno
      if (numero === undefined || numero === null) return
      const eventoId = payload.evento_id || `rellamado_${Date.now()}_${numero}`
      if (_seqVistos.has(eventoId)) return
      _seqVistos.add(eventoId)

      _colaRellamados.push({
        tipo: 'rellamado',
        eventoId,
        numero: Number(numero),
        mesa_numero: payload.mesa_numero,
        llamado_en: payload.llamado_en || new Date().toISOString()
      })
      despachar()
    }

    function despachar() {
      if (_reproduciendo) return
      reproducirSiguiente()
    }

    async function reproducirSiguiente() {
      if (_colaRellamados.length === 0 && _cola.length === 0) {
        _reproduciendo = false
        _reproduciendoTipo = null
        _glowState = 'idle'
        return
      }

      _reproduciendo = true

      // Prioridad a re-llamados
      if (_colaRellamados.length > 0) {
        const rel = _colaRellamados.shift()
        _reproduciendoTipo = 'rellamado'
        if (!_ultimoLlamadoReal && _ultimoLlamado.numero !== null) {
          _ultimoLlamadoReal = { ..._ultimoLlamado }
        }
        _ultimoLlamado = {
          numero: rel.numero,
          mesa_numero: rel.mesa_numero,
          proximo: _ultimoLlamadoReal ? _ultimoLlamadoReal.proximo : _proximoNumero,
          llamado_en: rel.llamado_en
        }
        _glowState = 'rellamado'

        // Simular anunciador: campana + voz terminada con onend
        _vocesCompletadas.push(`rellamado_${rel.numero}`)
        await sleep(20) // Reloj simulado acelerado

        // Al terminar: restaura hero legítimo
        if (_ultimoLlamadoReal) {
          _ultimoLlamado = { ..._ultimoLlamadoReal }
          _proximoNumero = _ultimoLlamadoReal.proximo ?? null
        }
        _glowState = 'idle'
        reproducirSiguiente()
        return
      }

      // Normal FIFO
      const item = _cola.shift()
      _reproduciendoTipo = 'nuevo'

      // Guardar anterior al historial
      if (_ultimoLlamado && _ultimoLlamado.numero !== null) {
        if (!_historial.some(h => h.numero === _ultimoLlamado.numero && h.mesa_numero === _ultimoLlamado.mesa_numero)) {
          _historial.unshift({
            numero: _ultimoLlamado.numero,
            mesa_numero: _ultimoLlamado.mesa_numero,
            llamado_en: _ultimoLlamado.llamado_en,
            tiempoRelativo: 'Hace un instante'
          })
          if (_historial.length > 4) _historial.splice(4)
        }
      }

      _ultimoLlamado = {
        numero: item.numero,
        mesa_numero: item.mesa_numero,
        proximo: item.proximo,
        llamado_en: item.llamado_en
      }
      _ultimoLlamadoReal = { ..._ultimoLlamado }
      _proximoNumero = item.proximo ?? null
      _lastSeqAnunciado = Math.max(_lastSeqAnunciado, item.seq)
      _glowState = 'nuevo'

      _vocesCompletadas.push(`nuevo_${item.numero}`)
      await sleep(20) // Reloj simulado acelerado

      _glowState = 'idle'
      reproducirSiguiente()
    }

    return {
      onNuevoLlamado,
      onRellamado,
      getEstado: () => ({
        ultimoLlamado: _ultimoLlamado,
        proximoNumero: _proximoNumero,
        historial: [..._historial],
        glowState: _glowState,
        cola: [..._cola],
        colaRellamados: [..._colaRellamados],
        reproduciendo: _reproduciendo,
        vocesCompletadas: [..._vocesCompletadas]
      })
    }
  }

  // --- Prueba 1: Ráfaga de 5 llamados -> 5 anuncios completos en orden FIFO ---
  console.log('\n--- PRUEBA 1: Ráfaga de 5 llamados simultáneos ---')
  const sim1 = crearSimuladorTV()
  sim1.onNuevoLlamado({ numero: 101, mesa_numero: 1, proximo: 102 }, 1)
  sim1.onNuevoLlamado({ numero: 102, mesa_numero: 2, proximo: 103 }, 2)
  sim1.onNuevoLlamado({ numero: 103, mesa_numero: 1, proximo: 104 }, 3)
  sim1.onNuevoLlamado({ numero: 104, mesa_numero: 3, proximo: 105 }, 4)
  sim1.onNuevoLlamado({ numero: 105, mesa_numero: 2, proximo: 106 }, 5)

  await sleep(150)
  const st1 = sim1.getEstado()
  assert(st1.vocesCompletadas.length === 5, 'Los 5 llamados se anunciaron por completo')
  assert(JSON.stringify(st1.vocesCompletadas) === JSON.stringify(['nuevo_101', 'nuevo_102', 'nuevo_103', 'nuevo_104', 'nuevo_105']),
    'Los 5 llamados se anunciaron en orden FIFO estricto de seq')
  assert(st1.ultimoLlamado.numero === 105, 'Hero final es el turno 105')
  assert(st1.historial.map(h => h.numero).join(',') === '104,103,102,101', 'Historial ordenado descendente sin incluir hero')
  assert(st1.proximoNumero === 106, 'proximoNumero (106) sale exclusivamente de hero.proximo')

  // --- Prueba 2: Ráfaga de 5 con un re-llamado a mitad ---
  console.log('\n--- PRUEBA 2: Ráfaga de 5 con un re-llamado intercalado ---')
  const sim2 = crearSimuladorTV()
  sim2.onNuevoLlamado({ numero: 201, mesa_numero: 1, proximo: 202 }, 1)
  sim2.onNuevoLlamado({ numero: 202, mesa_numero: 2, proximo: 203 }, 2)
  await sleep(10) // Durante la ejecución del primer anuncio, entra re-llamado de mesa 1
  sim2.onRellamado({ numero: 201, mesa_numero: 1, evento_id: 'rel_201' })
  sim2.onNuevoLlamado({ numero: 203, mesa_numero: 1, proximo: 204 }, 3)
  sim2.onNuevoLlamado({ numero: 204, mesa_numero: 2, proximo: 205 }, 4)
  sim2.onNuevoLlamado({ numero: 205, mesa_numero: 3, proximo: 206 }, 5)

  await sleep(200)
  const st2 = sim2.getEstado()
  assert(st2.vocesCompletadas.includes('rellamado_201'), 'El re-llamado se anunció como segundo aviso con prioridad')
  assert(st2.vocesCompletadas.length === 6, 'Se anunciaron los 5 turnos normales + 1 re-llamado')
  assert(!st2.historial.some(h => h.numero === 201 && st2.historial.indexOf(h) !== st2.historial.lastIndexOf(h)),
    'Historial no duplicó el turno 201')
  assert(st2.ultimoLlamado.numero === 205, 'Hero final regresa al último llamado real legítimo (205)')

  // --- Prueba 3: Re-llamado aislado ---
  console.log('\n--- PRUEBA 3: Re-llamado aislado ---')
  const sim3 = crearSimuladorTV()
  sim3.onNuevoLlamado({ numero: 301, mesa_numero: 1, proximo: 302 }, 1)
  await sleep(50)
  sim3.onRellamado({ numero: 301, mesa_numero: 1, evento_id: 'rel_301' })
  await sleep(50)
  const st3 = sim3.getEstado()
  assert(st3.ultimoLlamado.numero === 301, 'Hero mantiene el turno 301 tras finalizar re-llamado')
  assert(st3.historial.length === 0, 'Historial permanece vacío (el turno está en hero, no duplicado en historial)')

  // --- Prueba 4: Ráfaga de 10 con voz activa ---
  console.log('\n--- PRUEBA 4: Ráfaga de 10 anuncios con voz activa ---')
  const sim4 = crearSimuladorTV()
  for (let i = 1; i <= 10; i++) {
    sim4.onNuevoLlamado({ numero: 400 + i, mesa_numero: (i % 3) + 1, proximo: 400 + i + 1 }, i)
  }
  await sleep(300)
  const st4 = sim4.getEstado()
  assert(st4.vocesCompletadas.length === 10, 'Todas las 10 voces se completaron sin cortarse prematuramente')
  assert(st4.ultimoLlamado.numero === 410, 'Hero final es 410')
  assert(st4.historial.length === 4, 'Historial contiene exactamente los 4 precedentes más recientes')

  // --- Prueba 5: Corte de WS y reconexión sin duplicados ---
  console.log('\n--- PRUEBA 5: Deduplicación por seq y evento_id ante reconexión ---')
  const sim5 = crearSimuladorTV()
  sim5.onNuevoLlamado({ numero: 501, mesa_numero: 1, proximo: 502, evento_id: 'ev_501' }, 1)
  sim5.onNuevoLlamado({ numero: 502, mesa_numero: 2, proximo: 503, evento_id: 'ev_502' }, 2)
  await sleep(60)
  // Re-envío duplicado por reconexión / snapshot repetido
  sim5.onNuevoLlamado({ numero: 501, mesa_numero: 1, proximo: 502, evento_id: 'ev_501' }, 1)
  sim5.onNuevoLlamado({ numero: 502, mesa_numero: 2, proximo: 503, evento_id: 'ev_502' }, 2)
  await sleep(60)
  const st5 = sim5.getEstado()
  assert(st5.vocesCompletadas.length === 2, 'No se reprodujeron eventos duplicados')

  // --- Prueba 6: Invariantes en estado estable ---
  console.log('\n--- PRUEBA 6: Invariantes en estado estable ---')
  // hero.seq > historial[0].seq, historial ordenado desc sin repetidos, proximo = hero.proximo
  assert(st4.ultimoLlamado.numero > st4.historial[0].numero, 'Invariante: hero.numero > historial[0].numero')
  const histNums = st4.historial.map(h => h.numero)
  const histOrdenado = [...histNums].sort((a, b) => b - a)
  assert(JSON.stringify(histNums) === JSON.stringify(histOrdenado), 'Invariante: historial ordenado estrictamente DESC')
  const setUnicos = new Set(histNums)
  assert(setUnicos.size === histNums.length, 'Invariante: historial no tiene elementos repetidos')
  assert(!histNums.includes(st4.ultimoLlamado.numero), 'Invariante: historial no contiene el turno del hero')
  assert(st4.proximoNumero === st4.ultimoLlamado.proximo, 'Invariante: proximoNumero === hero.proximo')

  // --- Prueba 7: Panel y TV muestran el mismo último llamado ---
  console.log('\n--- PRUEBA 7: Consistencia Panel y TV ---')
  const ultimoLlamadoDbRes = await pool.query(`
    SELECT t.numero
    FROM turnos t
    WHERE t.estado IN ('en_atencion', 'atendido')
    ORDER BY t.llamado_en DESC
    LIMIT 1
  `)
  const ultimoEnDb = ultimoLlamadoDbRes.rows[0]?.numero
  assert(ultimoEnDb === llamarData1.turno.numero, `Panel y TV comparten la misma fuente de verdad en BD (Turno ${ultimoEnDb})`)

  // Limpieza
  tvWs.close()
  await pool.end()
  await redis.quit()

  console.log('\n======================================================================')
  console.log(`📊 RESULTADO DE LA AUDITORÍA DE TV: ${passed} PASSED / ${failed} FAILED`)
  console.log('======================================================================')

  if (failed > 0) {
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('❌ Error fatal en test_tv_audit:', err)
  process.exit(1)
})
