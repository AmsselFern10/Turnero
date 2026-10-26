'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
require('dotenv').config()
const buildApp = require('../src/app')

test('Verificación de configuración de impresión y reactividad en kiosko/tablet', async (t) => {
  const fastify = await buildApp()
  t.after(async () => {
    await fastify.close()
  })

  // 1. Verificar HTML de admin.html
  const adminHtml = fs.readFileSync(path.join(__dirname, '../src/public/admin.html'), 'utf8')
  assert(!adminHtml.includes('<span>Impresora LAN</span>'), 'La pestaña no debe decir "Impresora LAN"')
  assert(adminHtml.includes('<span>Impresión</span>'), 'La pestaña debe llamarse "Impresión"')
  assert(adminHtml.includes('max-w-[320px]'), 'El selector de ancho de papel debe tener ancho máximo fijo')
  assert(adminHtml.includes('Habilitar módulo de impresión'), 'El toggle maestro debe tener texto descriptivo')
  assert(adminHtml.includes('Al apagar esto, el botón físico de imprimir desaparecerá'), 'Debe existir la advertencia interactiva de impacto')
  assert(adminHtml.includes('Ajustes de hardware solo disponibles al activar el'), 'Debe existir el aviso de visibilidad condicional si no es asistido')

  // Cero emojis en admin.html y kiosko.html
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u
  assert(!emojiRegex.test(adminHtml), 'admin.html no debe contener emojis')

  const kioskoHtml = fs.readFileSync(path.join(__dirname, '../src/public/kiosko.html'), 'utf8')
  assert(!emojiRegex.test(kioskoHtml), 'kiosko.html no debe contener emojis')
  assert(kioskoHtml.includes('impresoraServidorActiva'), 'kiosko.html debe condicionar botones de impresión a impresoraServidorActiva')

  const kioskoJs = fs.readFileSync(path.join(__dirname, '../src/public/js/pages/kiosko.js'), 'utf8')
  assert(kioskoJs.includes("payload.clave === 'impresora_activa'"), 'kiosko.js debe escuchar cambios de impresora_activa por WS')
  assert(kioskoJs.includes('if (!this.impresoraServidorActiva) return false;'), 'tieneImpresoraHabilitada debe comprobar impresoraServidorActiva')

  // 2. Verificar API /kiosko/estado
  const resEstado = await fastify.inject({
    method: 'GET',
    url: '/kiosko/estado'
  })
  assert.equal(resEstado.statusCode, 200)
  const estado = JSON.parse(resEstado.payload)
  assert('impresora_activa' in estado, 'El estado del kiosko debe contener impresora_activa')
  assert('impresion_automatica' in estado, 'El estado del kiosko debe contener impresion_automatica')
  assert('impresora_ancho_papel' in estado, 'El estado del kiosko debe contener impresora_ancho_papel')
})
