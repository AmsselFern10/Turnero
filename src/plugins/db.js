'use strict'

const fp = require('fastify-plugin')
const { Pool } = require('pg')

/**
 * Plugin de conexión a PostgreSQL via pgBouncer.
 * Expone app.db — pool de conexiones listo para usar en rutas y servicios.
 *
 * Uso en handlers:
 *   const client = await app.db.connect()
 *   try {
 *     await client.query('BEGIN')
 *     ...
 *     await client.query('COMMIT')
 *   } catch (e) {
 *     await client.query('ROLLBACK')
 *     throw e
 *   } finally {
 *     client.release()
 *   }
 *
 * Para queries simples (sin transacción):
 *   const { rows } = await app.db.query('SELECT ...', [params])
 */
async function dbPlugin (fastify) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max:              10,    // pgBouncer ya limita las reales; esto limita el pool del app
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // pgBouncer en modo transaccional no soporta SET SESSION — esto lo desactiva
    statement_timeout: 30000
  })

  // Verificar conexión al iniciar
  try {
    const client = await pool.connect()
    await client.query('SELECT 1')
    client.release()
    fastify.log.info('✅ PostgreSQL conectado (via pgBouncer)')
  } catch (err) {
    fastify.log.error({ err }, 'Error conectando a PostgreSQL')
    throw err
  }

  // Log de errores del pool (conexiones rotas, timeouts, etc.)
  pool.on('error', (err) => {
    fastify.log.error({ err }, 'Pool de PostgreSQL — error inesperado')
  })

  // Cerrar el pool cuando Fastify se cierra
  fastify.addHook('onClose', async () => {
    await pool.end()
    fastify.log.info('PostgreSQL desconectado')
  })

  fastify.decorate('db', pool)
}

module.exports = fp(dbPlugin, { name: 'db' })
