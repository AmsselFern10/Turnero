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
  INIT:          Buffer.from([ESC, 0x40]),              // Inicializar impresora
  ALIGN_CENTER:  Buffer.from([ESC, 0x61, 0x01]),        // Centrar texto
  ALIGN_LEFT:    Buffer.from([ESC, 0x61, 0x00]),        // Alinear izquierda
  BOLD_ON:       Buffer.from([ESC, 0x45, 0x01]),        // Negrita ON
  BOLD_OFF:      Buffer.from([ESC, 0x45, 0x00]),        // Negrita OFF
  DOUBLE_HEIGHT: Buffer.from([ESC, 0x21, 0x10]),        // Texto doble alto
  NORMAL_SIZE:   Buffer.from([ESC, 0x21, 0x00]),        // Tamaño normal
  FONT_LARGE:    Buffer.from([GS,  0x21, 0x11]),        // Doble ancho y alto (4x)
  FONT_NORMAL:   Buffer.from([GS,  0x21, 0x00]),        // Volver a normal
  LINE_FEED:     Buffer.from([0x0A]),                    // Salto de línea
  CUT_FULL:      Buffer.from([GS,  0x56, 0x00]),        // Corte completo de papel
  CUT_PARTIAL:   Buffer.from([GS,  0x56, 0x01]),        // Corte parcial
  DIVIDER:       Buffer.from('--------------------------------\n', 'latin1'),
}

/**
 * Genera la secuencia estándar ESC/POS para imprimir un código QR nativo
 * Compatible con impresoras térmicas ESC/POS estándar (Epson, Xprinter, Rongta, POS-58/80)
 */
function generarComandosQR (url) {
  if (!url || typeof url !== 'string' || url.trim() === '') return []
  const data = Buffer.from(url.trim(), 'utf8')
  const pL = (data.length + 3) % 256
  const pH = Math.floor((data.length + 3) / 256)
  return [
    CMD.ALIGN_CENTER,
    // Modelo 2: GS ( k 0x04 0x00 0x31 0x41 0x32 0x00
    Buffer.from([GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    // Tamaño de módulo (5 puntos): GS ( k 0x03 0x00 0x31 0x43 0x05
    Buffer.from([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x05]),
    // Corrección de error M: GS ( k 0x03 0x00 0x31 0x45 0x31
    Buffer.from([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31]),
    // Guardar datos en buffer: GS ( k pL pH 0x31 0x50 0x30 <data>
    Buffer.from([GS, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30]),
    data,
    // Imprimir código QR del buffer: GS ( k 0x03 0x00 0x31 0x51 0x30
    Buffer.from([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]),
    CMD.LINE_FEED
  ]
}

/**
 * Convierte texto a Buffer latin1 (compatible con impresoras térmicas básicas)
 */
function txt (str) {
  return Buffer.from(str + '\n', 'latin1')
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
 */
function construirVoucher (ticket) {
  const partes = [
    CMD.INIT,
    CMD.ALIGN_CENTER,

    // Encabezado
    CMD.BOLD_ON,
    txt('MATRICULAS 2026'),
    CMD.BOLD_OFF,
    txt('Turno Digital'),
    CMD.LINE_FEED,

    CMD.DIVIDER,

    // Número del turno en grande
    CMD.FONT_LARGE,
    CMD.BOLD_ON,
    txt(ticket.formato || `#${String(ticket.numero).padStart(3, '0')}`),
    CMD.BOLD_OFF,
    CMD.FONT_NORMAL,
    CMD.LINE_FEED,

    // Módulo
    CMD.DOUBLE_HEIGHT,
    txt(ticket.modulo || 'Modulo General'),
    CMD.NORMAL_SIZE,
    CMD.LINE_FEED,

    CMD.DIVIDER,

    // Código QR ESC/POS nativo
    ...generarComandosQR(ticket.tracking_url),

    // URL de seguimiento
    CMD.ALIGN_CENTER,
    CMD.BOLD_ON,
    txt('Consulta tu turno:'),
    CMD.BOLD_OFF,
    txt(ticket.tracking_url || ''),
    CMD.LINE_FEED,

    // Pie
    CMD.ALIGN_CENTER,
    txt(`${ticket.fecha || ''} ${ticket.hora || ''}`),
    txt('Valido solo para hoy'),
    CMD.LINE_FEED,
    CMD.LINE_FEED,

    // Corte de papel
    CMD.CUT_PARTIAL,
  ]

  return Buffer.concat(partes)
}

/**
 * Lee la configuración de impresora desde la tabla `configuracion`
 * @param {import('fastify').FastifyInstance} fastify
 * @returns {{ ip: string, puerto: number, activa: boolean }}
 */
async function leerConfigImpresora (fastify) {
  const { rows } = await fastify.db.query(
    `SELECT clave, valor FROM configuracion
     WHERE clave IN ('impresora_ip', 'impresora_puerto', 'impresora_activa')`
  )

  const cfg = {}
  rows.forEach(r => { cfg[r.clave] = r.valor })

  return {
    ip:     cfg.impresora_ip     || '',
    puerto: parseInt(cfg.impresora_puerto || '9100', 10),
    activa: cfg.impresora_activa === 'true',
  }
}

/**
 * Envía el buffer al socket TCP con timeout configurable
 * @param {string} ip
 * @param {number} puerto
 * @param {Buffer} data
 * @param {number} timeoutMs
 */
function enviarPorTCP (ip, puerto, data, timeoutMs = 5000) {
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
        // Pequeña pausa para que la impresora procese antes de cerrar
        setTimeout(() => terminar(null), 300)
      })
    })

    socket.on('timeout', () => terminar(
      Object.assign(new Error(`Timeout: la impresora ${ip}:${puerto} no respondió en ${timeoutMs}ms`), { code: 'TIMEOUT' })
    ))
    socket.on('error', (err) => terminar(err))
  })
}

/**
 * Punto de entrada principal del servicio.
 * Llamar desde el route handler: await imprimirTicketESCPOS(fastify, ticket, opciones)
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} ticket  - Datos del voucher (numero, formato, modulo, fecha, hora, tracking_url)
 * @param {object} [opciones] - Opciones adicionales ({ ip, puerto, forzar: false })
 * @throws Error con .code = 'IMPRESORA_INACTIVA' | 'IP_NO_CONFIGURADA' | 'TIMEOUT' | 'ECONNREFUSED' | etc.
 */
async function imprimirTicketESCPOS (fastify, ticket, opciones = {}) {
  const cfg = await leerConfigImpresora(fastify)
  const ipFinal = ((opciones.ip && String(opciones.ip).trim()) || cfg.ip).trim()
  const puertoFinal = parseInt(opciones.puerto || cfg.puerto || 9100, 10) || 9100

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

  const voucher = construirVoucher(ticket)
  await enviarPorTCP(ipFinal, puertoFinal, voucher)
}

module.exports = { imprimirTicketESCPOS, leerConfigImpresora }
