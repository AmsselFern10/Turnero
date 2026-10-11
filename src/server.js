'use strict'

// Captura errores no controlados ANTES de levantar Fastify (RNF-MAN-05)
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECONNABORTED')) {
    console.warn('[WARN] Error de socket de red absorbido (cliente desconectado):', err.message)
    return
  }
  console.error('[FATAL] uncaughtException:', err)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason)
  process.exit(1)
})

require('dotenv').config()

const buildApp = require('./app')

async function start () {
  const app = await buildApp()

  try {
    await app.listen({
      port: parseInt(process.env.PORT || '3000', 10),
      host: '0.0.0.0'   // Necesario en Docker para aceptar conexiones externas
    })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }

  // Shutdown limpio — Docker envía SIGTERM al hacer docker compose down
  const shutdown = async (signal) => {
    app.log.info(`Recibida señal ${signal}. Cerrando servidor...`)
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

start()
