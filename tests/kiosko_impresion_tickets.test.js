/**
 * MÓDULO: kiosko_autonomo
 * OBJETIVO: Sistema de impresión térmica de vouchers ESC/POS en red LAN y reactividad:
 *           Validación de configuración de hardware (impresora_activa, impresora_ip, impresora_puerto, ancho 58/80mm);
 *           construcción de secuencias binarias ESC/POS (init, formato de ticket, corte de papel);
 *           endpoint de impresión directa POST /kiosko/imprimir con manejo de errores (409 y 503);
 *           simulación de recepción de socket TCP en puerto LAN (200 OK);
 *           resiliencia de auto-impresión (falla de impresora no aborta la creación del turno);
 *           contrato de interfaz en kiosko.html y admin.html (ocultamiento reactivo por WebSocket).
 * EJECUCIÓN: node tests/kiosko_impresion_tickets.test.js
 */

'use strict'

const net = require('net')
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')
const { construirVoucher, sanitizarTextoTicket } = require('../src/modules/kiosko/printer')
require('dotenv').config()

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE_HTTP = process.env.APP_URL || `http://localhost:${PORT}`

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function run() {
  console.log('======================================================================')
  console.log(' KIOSKO — IMPRESIÓN TÉRMICA ESC/POS, HARDWARE Y REACTIVIDAD')
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

  // Guardar configuración original de hardware
  const { rows: configOrig } = await pool.query(
    `SELECT clave, valor FROM configuracion
     WHERE clave IN ('impresora_activa', 'impresora_ip', 'impresora_puerto', 'impresora_canal', 'impresora_ancho_papel', 'kiosko_impresion_automatica', 'kiosko_web_activo')`
  )
  const origMap = {}
  for (const c of configOrig) origMap[c.clave] = c.valor

  try {
    // ── 1. Construcción de Secuencias Binarias ESC/POS ──────────────────────────
    console.log('[1/5] Evaluando construcción binaria de comandos ESC/POS...')
    const ticketEjemplo = {
      numero: 42,
      formato: '#042',
      modulo: 'Módulo de Matrículas',
      tracking_url: 'http://192.168.0.12:3000/turnos/mi-turno/abc123token',
      fecha: '27/10/2026',
      hora: '09:30'
    }

    const buffer58 = construirVoucher(ticketEjemplo, 58)
    assert(Buffer.isBuffer(buffer58), 'construirVoucher retorna un Buffer binario')
    // Comprobar bytes iniciales: ESC @ (0x1B, 0x40)
    assert(buffer58[0] === 0x1B && buffer58[1] === 0x40, 'Buffer inicia con comando ESC @ de inicialización de impresora')
    // Comprobar presencia del número formateado en el buffer
    assert(buffer58.includes(Buffer.from('#042')), 'Buffer contiene el texto del número de turno #042')
    // Comprobar comando de corte de papel (GS V)
    const tieneCorte = buffer58.includes(Buffer.from([0x1D, 0x56]))
    assert(tieneCorte, 'Buffer contiene comando de corte de papel ESC/POS (GS V)')

    // Soporte para 80mm
    const buffer80 = construirVoucher(ticketEjemplo, 80)
    assert(buffer80.length > buffer58.length, 'Comprobante de 80mm adapta el ancho con separadores extendidos')

    // Sanitización de caracteres especiales tipográficos
    const sanitizado = sanitizarTextoTicket('\u2022 Turno \u2014 VIP')
    assert(!sanitizado.includes('\u2022') && !sanitizado.includes('\u2014') && sanitizado.includes('-'),
      'sanitizarTextoTicket reemplaza viñetas y guiones largos por guiones estándar')

    // ── 2. Endpoint POST /kiosko/imprimir — Validaciones de Hardware Inactivo ───
    console.log('\n[2/5] Evaluando rechazo cuando la impresora no está configurada o inactiva...')

    // A. Impresora inactiva
    await pool.query(`UPDATE configuracion SET valor = 'false' WHERE clave = 'impresora_activa'`)
    const rInactiva = await fetch(`${BASE_HTTP}/kiosko/imprimir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero: 42 })
    })
    const dInactiva = await rInactiva.json()
    assert(rInactiva.status === 409, 'Rechazo con HTTP 409 cuando impresora_activa = false')
    assert(dInactiva.codigo === 'IMPRESORA_INACTIVA', 'Código de error reporta IMPRESORA_INACTIVA')

    // B. Impresora activa pero sin IP configurada
    await pool.query(`UPDATE configuracion SET valor = 'true' WHERE clave = 'impresora_activa'`)
    await pool.query(`UPDATE configuracion SET valor = '' WHERE clave = 'impresora_ip'`)
    const rSinIp = await fetch(`${BASE_HTTP}/kiosko/imprimir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero: 42 })
    })
    const dSinIp = await rSinIp.json()
    assert(rSinIp.status === 409, 'Rechazo con HTTP 409 cuando no hay IP configurada')
    assert(dSinIp.codigo === 'IP_NO_CONFIGURADA', 'Código de error reporta IP_NO_CONFIGURADA')

    // ── 3. Simulación de Impresora Térmica en Red LAN (TCP Socket 200 OK) ──────
    console.log('\n[3/5] Simulando impresora física en red local y verificando envío de bytes...')
    const puertoSim = 9876
    let bytesRecibidos = Buffer.alloc(0)

    const tcpServer = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        bytesRecibidos = Buffer.concat([bytesRecibidos, chunk])
      })
      // Simular impresora térmica que cierra el socket tras recibir el ticket
      socket.on('end', () => {})
    })

    await new Promise((resolve) => tcpServer.listen(puertoSim, '127.0.0.1', resolve))

    try {
      await pool.query(`UPDATE configuracion SET valor = '127.0.0.1' WHERE clave = 'impresora_ip'`)
      await pool.query(`UPDATE configuracion SET valor = $1 WHERE clave = 'impresora_puerto'`, [String(puertoSim)])

      const rImprimirOk = await fetch(`${BASE_HTTP}/kiosko/imprimir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numero: 88, formato: '#088', modulo: 'Ventanilla 1' })
      })
      const dImprimirOk = await rImprimirOk.json()

      assert(rImprimirOk.status === 200, 'POST /kiosko/imprimir responde 200 OK al conectar con impresora LAN')
      assert(dImprimirOk.ok === true, 'Respuesta indica ok: true')
      assert(bytesRecibidos.length > 0, `Servidor de impresora recibió ${bytesRecibidos.length} bytes ESC/POS en red`)
      assert(bytesRecibidos.includes(Buffer.from('#088')), 'Bytes recibidos por la impresora contienen el número del turno')

    } finally {
      await new Promise((resolve) => tcpServer.close(resolve))
    }

    // ── 4. Resiliencia de Auto-impresión ante Falla de Conexión (503) ──────────
    console.log('\n[4/5] Evaluando resiliencia cuando la impresora está apagada o inalcanzable...')
    // Configurar puerto inalcanzable
    await pool.query(`UPDATE configuracion SET valor = '127.0.0.1' WHERE clave = 'impresora_ip'`)
    await pool.query(`UPDATE configuracion SET valor = '19999' WHERE clave = 'impresora_puerto'`)

    const rErrorConexion = await fetch(`${BASE_HTTP}/kiosko/imprimir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numero: 99 })
    })
    const dErrorConexion = await rErrorConexion.json()
    assert(rErrorConexion.status === 503, 'POST /kiosko/imprimir responde 503 ante impresora apagada')
    assert(dErrorConexion.codigo === 'ECONNREFUSED' || dErrorConexion.codigo === 'TIMEOUT',
      `Reporta código de fallo de red: ${dErrorConexion.codigo}`)

    // Generar turno en tablet con auto-impresión habilitada: debe crear el turno sin romperse
    await pool.query(`UPDATE configuracion SET valor = 'true' WHERE clave = 'kiosko_web_activo'`)
    await pool.query(`UPDATE configuracion SET valor = 'kiosko_web' WHERE clave = 'modo_generacion_turnos'`)
    await pool.query(`UPDATE configuracion SET valor = 'asistido' WHERE clave = 'kiosko_modo_uso'`)
    await pool.query(`UPDATE configuracion SET valor = 'true' WHERE clave = 'kiosko_impresion_automatica'`)
    await pool.query(`UPDATE configuracion SET valor = 'true' WHERE clave = 'impresora_activa'`)
    await pool.query(`UPDATE configuracion SET valor = 'directa' WHERE clave = 'impresora_canal'`)
    await pool.query(`UPDATE configuracion SET valor = '127.0.0.1' WHERE clave = 'impresora_ip'`)
    await pool.query(`UPDATE configuracion SET valor = '19999' WHERE clave = 'impresora_puerto'`)

    const rGenAuto = await fetch(`${BASE_HTTP}/kiosko/generar?modo=tablet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const dGenAuto = await rGenAuto.json()

    assert(rGenAuto.status === 201, 'Turno se crea exitosamente (201) aún si la impresora térmica falla')
    assert(typeof dGenAuto.numero === 'number', 'Número de turno generado preservado intacto')
    assert(dGenAuto.impresion?.ok === false, 'Objeto impresion reporta el fallo de hardware sin bloquear el servicio')

    // ── 5. Contrato de Interfaz de Impresión en HTML y JS ──────────────────────
    console.log('\n[5/5] Evaluando contrato de UI en kiosko.html y admin.html...')
    const kioskoHtml = fs.readFileSync(path.join(__dirname, '../src/public/kiosko.html'), 'utf8')
    const adminHtml = fs.readFileSync(path.join(__dirname, '../src/public/admin.html'), 'utf8')
    const kioskoJs = fs.readFileSync(path.join(__dirname, '../src/public/js/pages/kiosko.js'), 'utf8')

    assert(kioskoHtml.includes('impresoraServidorActiva'), 'kiosko.html condiciona botones a impresoraServidorActiva')
    assert(kioskoJs.includes("payload.clave === 'impresora_activa'"), 'kiosko.js escucha actualización de impresora_activa por WS')
    assert(adminHtml.includes('<span>Impresión</span>'), 'admin.html contiene la pestaña de administración "Impresión"')
    assert(adminHtml.includes('impresora_ancho_papel'), 'admin.html permite configurar el ancho de papel (58mm/80mm)')

    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u
    assert(!emojiRegex.test(kioskoHtml), 'kiosko.html respeta norma de cero emojis')
    assert(!emojiRegex.test(adminHtml), 'admin.html respeta norma de cero emojis')

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
  console.error('\n[FAIL] Error fatal en kiosko_impresion_tickets:', err)
  process.exit(1)
})
