'use strict'

const fp     = require('fastify-plugin')
const Redis  = require('ioredis')

/**
 * Plugin de Redis para Fastify.
 * Expone dos clientes:
 *   app.redis     → cliente general (caché, rate-limit, blacklist JWT)
 *   app.redisSub  → cliente de suscripción Pub/Sub (no puede usarse para commands)
 *
 * IMPORTANTE: Redis requiere clientes separados para publish y subscribe.
 * - app.redis      → PUBLISH + comandos normales (GET, SET, EXPIRE, etc.)
 * - app.redisSub   → SUBSCRIBE (bloqueado para otros comandos)
 */
async function redisPlugin (fastify) {
  const redisUrl = process.env.REDIS_URL ||
    `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD || 'turnero_redis')}@${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT_EXPOSED || '6379'}`

  const opts = {
    lazyConnect:        false,
    connectTimeout:     5000,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    password: process.env.REDIS_URL
      ? undefined  // La URL ya incluye la contraseña
      : process.env.REDIS_PASSWORD
  }

  // Cliente principal
  const redis = new Redis(redisUrl, opts)

  redis.on('connect', () => fastify.log.info('✅ Redis conectado'))
  redis.on('error',   (err) => fastify.log.error({ err }, 'Redis — error'))

  // Cliente de suscripción (Pub/Sub — canal de WS)
  const redisSub = new Redis(redisUrl, opts)
  redisSub.on('error', (err) => fastify.log.error({ err }, 'RedisSub — error'))

  // Verificar conexión
  await redis.ping()

  fastify.addHook('onClose', async () => {
    await redis.quit()
    await redisSub.quit()
    fastify.log.info('Redis desconectado')
  })

  fastify.decorate('redis',    redis)
  fastify.decorate('redisSub', redisSub)
}

module.exports = fp(redisPlugin, { name: 'redis' })
