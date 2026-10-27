/**
 * MÓDULO: kiosko_autonomo
 * OBJETIVO: Ciclo de emisión de turnos en autoservicio y tablet:
 *           Generación atómica con correlativo diario, idempotencia mediante Idempotency-Key,
 *           restricción de 1 ticket por smartphone versus emisión continua en modo tablet,
 *           bloqueo por kiosko desactivado (403) y por tope diario alcanzado (409).
 * EJECUCIÓN: node tests/kiosko_emision_turnos.test.js
 */

'use strict'

const { Pool } = require('pg')
const crypto = require('crypto')
require('dotenv').config()

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE_HTTP = process.env.APP_URL || `http://localhost:${PORT}`

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
  console.log('======================================================================')
  console.log(' KIOSKO — GENERACIÓN ATÓMICA, IDEMPOTENCIA Y MODOS DE EMISIÓN')
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

  // Guardar estado original de configuración
  const { rows: configOrig } = await pool.query(
    `SELECT clave, valor FROM configuracion
     WHERE clave IN ('kiosko_web_activo', 'modo_generacion_turnos', 'kiosko_tope_diario', 'kiosko_modo_uso')`
  )
  const origMap = {}
  for (const c of configOrig) origMap[c.clave] = c.valor

  try {
    // ── 1. Preparación de Entorno ──────────────────────────────────────────────
    console.log('[1/5] Habilitando Kiosko Web en base de datos para pruebas...')
    await pool.query(
      `UPDATE configuracion SET valor = 'true' WHERE clave = 'kiosko_web_activo'`
    )
    await pool.query(
      `UPDATE configuracion SET valor = 'kiosko_web' WHERE clave = 'modo_generacion_turnos'`
    )
    await pool.query(
      `UPDATE configuracion SET valor = 'asistido' WHERE clave = 'kiosko_modo_uso'`
    )
    await pool.query(
      `UPDATE configuracion SET valor = '0' WHERE clave = 'kiosko_tope_diario'`
    )

    // Consulta de estado público
    const rEstado = await fetch(`${BASE_HTTP}/kiosko/estado`)
    const dEstado = await rEstado.json()
    assert(rEstado.status === 200, 'GET /kiosko/estado responde 200 OK')
    assert(dEstado.activo === true, 'Kiosko reporta estado activo = true')
    assert(dEstado.modo === 'kiosko_web', 'Modo operativo reporta kiosko_web')

    // ── 2. Generación Atómica y Correlatividad Diaria (Modo Asistido) ──────────
    console.log('\n[2/5] Evaluando generación de turno e idempotencia en modo Asistido (Tablet)...')
    const idemKey = crypto.randomUUID()
    const devId1 = 'device_' + crypto.randomBytes(4).toString('hex')

    const rGen1 = await fetch(`${BASE_HTTP}/kiosko/generar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
        'X-Device-Id': devId1
      },
      body: JSON.stringify({ modo: 'tablet' })
    })
    const dGen1 = await rGen1.json()

    assert(rGen1.status === 201, 'POST /kiosko/generar en tablet responde 201 Created')
    assert(typeof dGen1.numero === 'number' && dGen1.numero > 0, `Turno generado exitosamente (#${dGen1.numero})`)
    assert(typeof dGen1.token === 'string' && dGen1.token.length === 64, 'Token de seguimiento seguro de 64 caracteres generado')
    assert(typeof dGen1.posicion_en_cola === 'number', 'Posición en cola calculada correctamente')

    // Reintento con la misma Idempotency-Key (debe devolver el mismo ticket sin re-numerar)
    const rGen1Reintento = await fetch(`${BASE_HTTP}/kiosko/generar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
        'X-Device-Id': devId1
      },
      body: JSON.stringify({ modo: 'tablet' })
    })
    const dGen1Reintento = await rGen1Reintento.json()

    assert(rGen1Reintento.status === 201, 'Reintento con misma Idempotency-Key responde 201')
    assert(dGen1Reintento.numero === dGen1.numero, `Idempotencia respetada: devuelve el mismo turno #${dGen1.numero}`)
    assert(dGen1Reintento.token === dGen1.token, 'Idempotencia respetada: devuelve el mismo token')

    // En modo asistido, un celular móvil DEBE ser rechazado
    const rMobEnAsistido = await fetch(`${BASE_HTTP}/kiosko/generar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const dMobEnAsistido = await rMobEnAsistido.json()
    assert(rMobEnAsistido.status === 403, 'En modo asistido, emisión desde celular es rechazada con HTTP 403')
    assert(dMobEnAsistido.codigo === 'modo_asistido_activo' || dMobEnAsistido.error?.codigo === 'modo_asistido_activo',
      'Código de error reporta modo_asistido_activo')

    // ── 3. Exclusión Mutua en Modo Estudiante y Restricción 1 Ticket ───────────
    console.log('\n[3/5] Evaluando exclusión mutua en modo Estudiante (Tablet bloqueada, Móvil habilitado)...')
    await pool.query(`UPDATE configuracion SET valor = 'estudiante' WHERE clave = 'kiosko_modo_uso'`)

    // En modo estudiante, una tablet DEBE ser rechazada
    const rTabEnEstudiante = await fetch(`${BASE_HTTP}/kiosko/generar?modo=tablet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modo: 'tablet' })
    })
    const dTabEnEstudiante = await rTabEnEstudiante.json()
    assert(rTabEnEstudiante.status === 403, 'En modo estudiante, emisión desde tablet es rechazada con HTTP 403')
    assert(dTabEnEstudiante.codigo === 'modo_estudiante_activo' || dTabEnEstudiante.error?.codigo === 'modo_estudiante_activo',
      'Código de error reporta modo_estudiante_activo')

    const devIdSmartphone = 'celular_' + crypto.randomBytes(4).toString('hex')

    // Smartphone solicita primer ticket (sin modo tablet)
    const rSmart1 = await fetch(`${BASE_HTTP}/kiosko/generar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': devIdSmartphone
      },
      body: JSON.stringify({})
    })
    const dSmart1 = await rSmart1.json()
    assert(rSmart1.status === 201, 'Smartphone genera su primer turno en modo estudiante')

    // Mismo smartphone solicita otro turno mientras tiene uno en espera
    const rSmart2 = await fetch(`${BASE_HTTP}/kiosko/generar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': devIdSmartphone
      },
      body: JSON.stringify({})
    })
    const dSmart2 = await rSmart2.json()

    assert(dSmart2.numero === dSmart1.numero,
      `Restricción móvil: Smartphone con turno en espera recupera su ticket activo (#${dSmart1.numero}) sin crear duplicado`)

    // ── 4. Bloqueo por Kiosko Desactivado ──────────────────────────────────────
    console.log('\n[4/5] Evaluando rechazo cuando el kiosko está desactivado...')
    await pool.query(`UPDATE configuracion SET valor = 'false' WHERE clave = 'kiosko_web_activo'`)

    const rDesactivado = await fetch(`${BASE_HTTP}/kiosko/generar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modo: 'tablet' })
    })
    const dDesactivado = await rDesactivado.json()

    assert(rDesactivado.status === 403, 'Generación rechazada con HTTP 403 Forbidden cuando kiosko_web_activo = false')
    assert(dDesactivado.codigo === 'kiosko_desactivado' || dDesactivado.error?.codigo === 'kiosko_desactivado',
      'Código de error reporta kiosko_desactivado')

    // ── 5. Bloqueo por Tope Diario Alcanzado ───────────────────────────────────
    console.log('\n[5/5] Evaluando bloqueo cuando se alcanza el tope diario de turnos...')
    await pool.query(`UPDATE configuracion SET valor = 'true' WHERE clave = 'kiosko_web_activo'`)
    await pool.query(`UPDATE configuracion SET valor = 'asistido' WHERE clave = 'kiosko_modo_uso'`)

    // Averiguar el último número del contador diario de kiosko
    const { rows: [contadorHoy] } = await pool.query(
      `SELECT ultimo_numero FROM kiosko_contador_diario WHERE fecha = fn_fecha_hoy()`
    )
    const ultimoNum = contadorHoy?.ultimo_numero || 1

    // Establecer tope diario igual al último número emitido (para que el siguiente supere el tope)
    await pool.query(`UPDATE configuracion SET valor = $1 WHERE clave = 'kiosko_tope_diario'`, [String(ultimoNum)])

    const rTope = await fetch(`${BASE_HTTP}/kiosko/generar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modo: 'tablet' })
    })
    const dTope = await rTope.json()

    assert(rTope.status === 409, 'Generación rechazada con HTTP 409 Conflict al alcanzar el tope diario')
    assert(dTope.codigo === 'tope_diario_alcanzado' || dTope.error?.codigo === 'tope_diario_alcanzado',
      'Código de error reporta tope_diario_alcanzado')

  } finally {
    // ── Restaurar Configuración Original ───────────────────────────────────────
    console.log('\nRestaurando configuración original...')
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
  console.error('\n[FAIL] Error fatal en kiosko_emision_turnos:', err)
  process.exit(1)
})
