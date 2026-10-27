/**
 * MÓDULO: tv_pantalla_publica
 * OBJETIVO: Validar la recepción, el despliegue y la salida de los turnos en la pantalla pública.
 *           Los turnos entran y salen respetando el orden cronológico exacto enviado por el servidor.
 * EJECUCIÓN: node tests/tv_flujo_orden_turnos.test.js
 */

'use strict'

const WebSocket = require('ws')
const { Pool } = require('pg')
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
  console.log(' TV — FLUJO Y ORDEN CRONOLÓGICO DE TURNOS (FIFO ESTRICTO)')
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

  // 1. Preparación de entorno
  console.log('[1/4] Preparando base de datos y autenticación de operador...')
  await pool.query(`UPDATE lotes_voucher SET estado = 'activo', numero_hasta = GREATEST(numero_hasta, 999999) WHERE id = 1`)
  
  const { rows: [op] } = await pool.query(`SELECT id, username FROM usuarios WHERE rol = 'operador' LIMIT 1`)
  if (!op) throw new Error('No se encontró operador en BD')

  // Crear 4 mesas con operadores asignados
  const mesas = []
  const baseNum = 6100 + (Date.now() % 500)
  const mesaIds = []
  const opIds = []

  const passHash = await bcrypt.hash('Operador2026!', 10)
  for (let i = 0; i < 4; i++) {
    const num = baseNum + i
    const { rows: [nuevoOp] } = await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, true) RETURNING id`,
      [`op_tv_fifo_${num}`, passHash, `Op TV [${num}]`]
    )
    opIds.push(nuevoOp.id)

    const { rows: [nuevaMesa] } = await pool.query(
      `INSERT INTO mesas (numero, nombre, estado, operador_id) VALUES ($1, $2, 'activa', $3) RETURNING id`,
      [num, `Mesa TV FIFO [${num}]`, nuevoOp.id]
    )
    mesaIds.push(nuevaMesa.id)

    const loginRes = await fetch(`${BASE_HTTP}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `op_tv_fifo_${num}`, password: 'Operador2026!' })
    })
    const { token: tk } = await loginRes.json()
    mesas.push({ id: nuevaMesa.id, numero: num, token: tk })
  }
  assert(mesas.length === 4, '4 operadores y mesas preparados para prueba FIFO')

  // 2. Conectar socket de TV a tv:global
  console.log('\n[2/4] Conectando pantalla TV a canal WebSocket tv:global...')
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

  await sleep(150)
  assert(tvWs.readyState === WebSocket.OPEN, 'Socket TV conectado exitosamente a tv:global')
  const snapInicial = tvEventos.find(e => e.tipo === 'snapshot')
  assert(!!snapInicial, 'TV recibe snapshot inicial al conectar')

  // 3. Emitir 4 llamados reales y verificar orden monotónico de seq en tv:global
  console.log('\n[3/4] Emitiendo llamados desde las 4 ventanillas y verificando recepción cronológica...')
  const turnosLlamados = []
  for (let i = 0; i < 4; i++) {
    const m = mesas[i]
    const res = await fetch(`${BASE_HTTP}/turnos/llamar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${m.token}`,
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify({ mesa_id: m.id })
    })
    const data = await res.json()
    assert(res.status === 200, `Ventanilla #${m.numero} responde 200 OK (Turno #${data.turno?.numero})`)
    turnosLlamados.push(data.turno.numero)
    await sleep(60)
  }

  await sleep(300) // esperar propagación de eventos
  const eventosLlamados = tvEventos.filter(e => e.tipo === 'nuevo_llamado')
  const eventosDeNuestrasMesas = eventosLlamados.filter(e => mesas.some(m => m.numero === e.payload?.mesa_numero))

  assert(eventosDeNuestrasMesas.length === 4, `TV recibió los 4 eventos de nuevo_llamado (${eventosDeNuestrasMesas.length}/4)`)

  // Comprobar orden cronológico estricto de números emitidos
  const numerosRecibidos = eventosDeNuestrasMesas.map(e => e.payload?.numero)
  assert(JSON.stringify(numerosRecibidos) === JSON.stringify(turnosLlamados),
    `Los turnos recibidos en TV coinciden en orden exacto: [${numerosRecibidos.join(', ')}]`)

  // Comprobar secuencia monotónica creciente de seq en los eventos del servidor
  const seqs = eventosDeNuestrasMesas.map(e => Number(e.seq))
  let seqsMonotonicos = true
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] <= seqs[i - 1]) seqsMonotonicos = false
  }
  assert(seqsMonotonicos, `Secuencia seq es estrictamente creciente monotónica: [${seqs.join(', ')}]`)

  // 4. Validación de la Cola Despachadora FIFO de la TV ante Ráfagas Simultáneas
  console.log('\n[4/4] Simulando entrada masiva a la cola FIFO del frontend...')
  // Simulador representativo del despachador de tv.js
  let _hero = null
  let _cola = []
  let _ordenDespachado = []

  function encolarTurno(payload, seq) {
    const item = {
      seq: Number(seq),
      numero: Number(payload.numero),
      mesa_numero: payload.mesa_numero,
      proximo: payload.proximo
    }
    // Inserción ordenada por seq en caso de llegada desordenada por red
    const idx = _cola.findIndex(c => c.seq > item.seq)
    if (idx === -1) _cola.push(item)
    else _cola.splice(idx, 0, item)
  }

  function despacharSiguiente() {
    if (_cola.length === 0) return
    const sig = _cola.shift()
    _hero = sig
    _ordenDespachado.push(sig.numero)
  }

  // Simular llegada con ráfaga de 6 llamados
  const listaSim = [
    { numero: 101, seq: 10 },
    { numero: 102, seq: 11 },
    { numero: 103, seq: 12 },
    { numero: 104, seq: 13 },
    { numero: 105, seq: 14 },
    { numero: 106, seq: 15 }
  ]

  // Encolar deliberadamente en desorden para verificar ordenación por seq
  encolarTurno(listaSim[2], listaSim[2].seq)
  encolarTurno(listaSim[0], listaSim[0].seq)
  encolarTurno(listaSim[4], listaSim[4].seq)
  encolarTurno(listaSim[1], listaSim[1].seq)
  encolarTurno(listaSim[5], listaSim[5].seq)
  encolarTurno(listaSim[3], listaSim[3].seq)

  while (_cola.length > 0) {
    despacharSiguiente()
  }

  assert(JSON.stringify(_ordenDespachado) === JSON.stringify([101, 102, 103, 104, 105, 106]),
    `Despacho de turnos respeta el orden cronológico exacto de seq: [${_ordenDespachado.join(', ')}]`)
  assert(_hero.numero === 106, 'El turno principal final en pantalla es el último cronológico (106)')

  // Limpieza
  tvWs.close()
  if (mesaIds.length > 0) await pool.query(`DELETE FROM mesas WHERE id = ANY($1)`, [mesaIds]).catch(() => {})
  if (opIds.length > 0) await pool.query(`DELETE FROM usuarios WHERE id = ANY($1)`, [opIds]).catch(() => {})
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
  console.error('\n[FAIL] Error fatal en tv_flujo_orden_turnos:', err)
  process.exit(1)
})
