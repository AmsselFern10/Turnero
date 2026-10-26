'use strict'

/**
 * printer.js — Servicio de impresión directa ESC/POS vía TCP/IP (LAN)
 *
 * Flujo:
 *  1. El frontend (modo tablet) llama POST /kiosko/imprimir
 *  2. El route handler llama imprimirTicketESCPOS(fastify, datosTicket)
 *  3. Este módulo lee la config (IP, puerto, activa) de la tabla configuracion
 *  4. Abre un socket TCP a IP:puerto (puerto estándar ESC/POS = 9100)
 *  5. Envía los bytes ESC/POS del voucher
 *  6. Cierra el socket
 *  7. Si algo falla (timeout, conexión rechazada) devuelve un error descriptivo
 *
 * ESC/POS implementado manualmente con Net (sin escpos lib) para evitar
 * problemas de compatibilidad con la versión alpha del paquete escpos.
 */

const net = require('node:net')

// ── Constantes ESC/POS ────────────────────────────────────────────────────────
const ESC = 0x1B
const GS  = 0x1D

const CMD = {
  INIT:           Buffer.from([ESC, 0x40]),              // Inicializar impresora
  SELECT_WPC1252: Buffer.from([ESC, 0x74, 0x10]),        // Tabla Windows-1252 / Latin-1 (tildes y ñ)
  SELECT_CP850:   Buffer.from([ESC, 0x74, 0x02]),        // Tabla CodePage 850 (Multilingual)
  ALIGN_CENTER:   Buffer.from([ESC, 0x61, 0x01]),        // Centrar texto
  ALIGN_LEFT:     Buffer.from([ESC, 0x61, 0x00]),        // Alinear izquierda
  BOLD_ON:        Buffer.from([ESC, 0x45, 0x01]),        // Negrita ON
  BOLD_OFF:       Buffer.from([ESC, 0x45, 0x00]),        // Negrita OFF
  DOUBLE_HEIGHT:  Buffer.from([ESC, 0x21, 0x10]),        // Texto doble alto
  NORMAL_SIZE:    Buffer.from([ESC, 0x21, 0x00]),        // Tamaño normal
  FONT_LARGE:     Buffer.from([GS,  0x21, 0x11]),        // Doble ancho y alto (4x)
  FONT_NORMAL:    Buffer.from([GS,  0x21, 0x00]),        // Volver a normal
  LINE_FEED:      Buffer.from([0x0A]),                   // Salto de línea
  CUT_FULL:       Buffer.from([GS,  0x56, 0x41, 0x02]),  // Avance 2 líneas y corte completo
  CUT_PARTIAL:    Buffer.from([GS,  0x56, 0x42, 0x02]),  // Avance 2 líneas y corte parcial
}

/**
 * Sanitiza texto eliminando caracteres especiales o multivariable incompatibles
 * Reemplaza la viñeta • por un guion limpio -
 */
function sanitizarTextoTicket (str) {
  if (!str) return ''
  return String(str)
    .replace(/\u2022/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
}

/**
 * Convierte texto sanitizado a Buffer latin1 (compatible con WPC1252 y tildes/ñ)
 */
function txt (str) {
  return Buffer.from(sanitizarTextoTicket(str) + '\n', 'latin1')
}

/**
 * Genera la secuencia estándar ESC/POS para imprimir un código QR nativo
 * @param {string} url
 * @param {number} moduleSize - Tamaño de módulo (3 puntos para 58mm, 4 para 80mm)
 */
function generarComandosQR (url, moduleSize = 3) {
  if (!url || typeof url !== 'string' || url.trim() === '') return []
  const data = Buffer.from(url.trim(), 'utf8')
  const pL = (data.length + 3) % 256
  const pH = Math.floor((data.length + 3) / 256)
  const sizeByte = Math.max(2, Math.min(6, parseInt(moduleSize, 10) || 3))

  return [
    CMD.ALIGN_CENTER,
    // Modelo 2: GS ( k 0x04 0x00 0x31 0x41 0x32 0x00
    Buffer.from([GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    // Tamaño de módulo (3 puntos para 58mm, 4 puntos para 80mm)
    Buffer.from([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, sizeByte]),
    // Corrección de error L (0x30): máxima velocidad y resolución compacta
    Buffer.from([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x30]),
    // Guardar datos en buffer: GS ( k pL pH 0x31 0x50 0x30 <data>
    Buffer.from([GS, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30]),
    data,
    // Imprimir código QR del buffer: GS ( k 0x03 0x00 0x31 0x51 0x30
    Buffer.from([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]),
    CMD.LINE_FEED
  ]
}

/**
 * Construye el buffer completo del voucher en formato ESC/POS
 * @param {object} ticket
 * @param {number} ticket.numero       - Número del turno (ej: 47)
 * @param {string} ticket.formato      - Número formateado (ej: "#047")
 * @param {string} ticket.modulo       - Nombre del módulo
 * @param {string} ticket.fecha        - Fecha legible (ej: "12/10/2026")
 * @param {string} ticket.hora         - Hora (ej: "16:30")
 * @param {string} ticket.tracking_url - URL de seguimiento
 * @param {number|string} [anchoPapel=58] - 58 u 80 milímetros
 */
function construirVoucher (ticket, anchoPapel = 58) {
  const es80mm = String(anchoPapel) === '80'
  const dividerStr = es80mm
    ? '------------------------------------------------\n' // 48 caracteres en 80mm
    : '--------------------------------\n'                 // 32 caracteres en 58mm
  const dividerBuf = Buffer.from(dividerStr, 'latin1')
  const qrSize = es80mm ? 4 : 3

  const fechaStr = ticket.fecha || ''
  const horaStr = ticket.hora || ''
  const fechaYHora = fechaStr && horaStr ? `${fechaStr} - ${horaStr}` : (fechaStr || horaStr)

  const partes = [
    CMD.INIT,
    CMD.SELECT_WPC1252,
    CMD.ALIGN_CENTER,

    // Encabezado institucional
    CMD.BOLD_ON,
    txt('MATRÍCULAS 2026'),
    CMD.BOLD_OFF,
    txt('Turno Digital de Atención'),
    CMD.LINE_FEED,

    dividerBuf,

    // Número del turno en gran formato
    CMD.FONT_LARGE,
    CMD.BOLD_ON,
    txt(ticket.formato || `#${String(ticket.numero || 0).padStart(3, '0')}`),
    CMD.BOLD_OFF,
    CMD.FONT_NORMAL,
    CMD.LINE_FEED,

    // Nombre del módulo
    CMD.DOUBLE_HEIGHT,
    txt(ticket.modulo || 'Módulo General de Matrículas'),
    CMD.NORMAL_SIZE,
    CMD.LINE_FEED,

    dividerBuf,

    // Código QR ESC/POS nativo
    ...generarComandosQR(ticket.tracking_url, qrSize),

    // Instrucción de seguimiento y URL
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON,
    txt('Escanea para seguir tu turno'),
    CMD.BOLD_OFF,
    txt(ticket.tracking_url || ''),
    CMD.LINE_FEED,

    // Pie con fecha y validez
    CMD.ALIGN_CENTER,
    txt(fechaYHora),
    txt('Válido solo para hoy'),
    CMD.LINE_FEED,
    CMD.LINE_FEED,

    // Corte parcial de papel
    CMD.CUT_PARTIAL,
  ]

  return Buffer.concat(partes)
}

/**
 * Lee la configuración de impresora desde la tabla `configuracion`
 * @param {import('fastify').FastifyInstance} fastify
 * @returns {Promise<{ ip: string, puerto: number, activa: boolean, canal: string, anchoPapel: number }>}
 */
async function leerConfigImpresora (fastify) {
  const { rows } = await fastify.db.query(
    `SELECT clave, valor FROM configuracion
     WHERE clave IN ('impresora_ip', 'impresora_puerto', 'impresora_activa', 'impresora_canal', 'impresora_ancho_papel')`
  )

  const cfg = {}
  rows.forEach(r => { cfg[r.clave] = r.valor })

  return {
    ip:          cfg.impresora_ip     || '',
    puerto:      parseInt(cfg.impresora_puerto || '9100', 10),
    activa:      cfg.impresora_activa === 'true',
    canal:       cfg.impresora_canal  || 'directa',
    anchoPapel:  parseInt(cfg.impresora_ancho_papel || '58', 10) || 58
  }
}

/**
 * Envía el buffer al socket TCP con timeout configurable
 * @param {string} ip
 * @param {number} puerto
 * @param {Buffer} data
 * @param {number} timeoutMs
 */
function enviarPorTCP (ip, puerto, data, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    let finalizado = false

    const terminar = (err) => {
      if (finalizado) return
      finalizado = true
      socket.destroy()
      if (err) reject(err)
      else resolve()
    }

    socket.setTimeout(timeoutMs)

    socket.connect(puerto, ip, () => {
      socket.write(data, (err) => {
        if (err) return terminar(err)
        // Pausa breve para permitir transmisión completa antes de cerrar
        setTimeout(() => terminar(null), 250)
      })
    })

    socket.on('timeout', () => terminar(
      Object.assign(new Error(`Timeout: la impresora en ${ip}:${puerto} no respondió en ${timeoutMs}ms. Verifique que la impresora esté encendida y en red.`), { code: 'TIMEOUT' })
    ))
    socket.on('error', (err) => terminar(err))
  })
}

/**
 * Punto de entrada principal del servicio.
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} ticket  - Datos del voucher (numero, formato, modulo, fecha, hora, tracking_url)
 * @param {object} [opciones] - Opciones adicionales ({ ip, puerto, forzar: false, anchoPapel })
 */
async function imprimirTicketESCPOS (fastify, ticket, opciones = {}) {
  const cfg = await leerConfigImpresora(fastify)
  const ipFinal = ((opciones.ip && String(opciones.ip).trim()) || cfg.ip).trim()
  const puertoFinal = parseInt(opciones.puerto || cfg.puerto || 9100, 10) || 9100
  const anchoFinal = parseInt(opciones.anchoPapel || cfg.anchoPapel || 58, 10) || 58

  if (!opciones.forzar && !cfg.activa) {
    const err = new Error('La impresión directa ESC/POS no está activada en la configuración.')
    err.code = 'IMPRESORA_INACTIVA'
    throw err
  }

  if (!ipFinal || ipFinal === '') {
    const err = new Error('No hay IP de impresora configurada. Ingrese la dirección IP en Configuración.')
    err.code = 'IP_NO_CONFIGURADA'
    throw err
  }

  const voucher = construirVoucher(ticket, anchoFinal)
  await enviarPorTCP(ipFinal, puertoFinal, voucher)
}

module.exports = { imprimirTicketESCPOS, leerConfigImpresora, construirVoucher, sanitizarTextoTicket }

