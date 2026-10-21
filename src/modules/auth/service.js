'use strict'

const bcrypt = require('bcrypt')

/**
 * Servicio de autenticación.
 * Toda la lógica de negocio aquí — las rutas solo validan y delegan.
 */

/**
 * Login: valida credenciales, retorna JWT + crea refresh token.
 */
async function login (fastify, { username, password, ip }) {
  // 1. Buscar usuario activo
  const { rows } = await fastify.db.query(
    `SELECT id, username, nombre_completo, password_hash, rol, activo
     FROM usuarios
     WHERE LOWER(username) = LOWER($1) AND eliminado_en IS NULL`,
    [username]
  )

  const usuario = rows[0]

  // 2. Verificar password — siempre ejecutar bcrypt.compare para evitar timing attacks
  const passwordValido = usuario
    ? await bcrypt.compare(password, usuario.password_hash)
    : await bcrypt.compare(password, '$2b$12$invalidhashtopreventtiming00000') // dummy

  if (!usuario || !passwordValido || !usuario.activo) {
    // Registrar intento fallido en audit_log
    await fastify.db.query(
      `INSERT INTO audit_log (accion, ip_origen, metadata_json)
       VALUES ('LOGIN_FALLIDO', $1, $2)`,
      [ip, JSON.stringify({ username_intentado: username })]
    )
    const error = new Error('Credenciales inválidas')
    error.statusCode = 401
    throw error
  }

  // 3. Generar JWT (2h)
  const jti   = require('crypto').randomUUID()
  const token = fastify.jwt.sign({
    id:       usuario.id,
    username: usuario.username,
    nombre:   usuario.nombre_completo,
    rol:      usuario.rol,
    jti
  })

  // 4. Generar refresh token (7d) — guardado en cookie HttpOnly
  const refreshJti   = require('crypto').randomUUID()
  const refreshToken = require('jsonwebtoken').sign(
    { id: usuario.id, jti: refreshJti, type: 'refresh' },
    process.env.REFRESH_SECRET,
    { expiresIn: process.env.REFRESH_EXPIRES_IN || '7d' }
  )

  // 5. Guardar refresh en Redis (para invalidación)
  const refreshTtl = 7 * 24 * 60 * 60 // 7 días en segundos
  await fastify.redis.setex(`refresh:${refreshJti}`, refreshTtl, usuario.id.toString())

  // 6. Consultar si tiene mesa pre-asignada por el admin (RF-ADM-04 / RF-AUTH-03)
  let mesaAsignada = null
  const { rows: mesasRows } = await fastify.db.query(
    `SELECT id, numero, nombre, estado FROM mesas WHERE operador_id = $1 AND estado != 'inactiva' LIMIT 1`,
    [usuario.id]
  )
  if (mesasRows.length > 0) {
    mesaAsignada = mesasRows[0]
  }

  // 7. Audit log
  await fastify.db.query(
    `INSERT INTO audit_log (operador_id, accion, ip_origen, metadata_json)
     VALUES ($1, 'LOGIN_EXITOSO', $2, $3)`,
    [usuario.id, ip, JSON.stringify({ rol: usuario.rol })]
  )

  return {
    token,
    refreshToken,
    usuario: {
      id:            usuario.id,
      username:      usuario.username,
      nombre:        usuario.nombre_completo,
      rol:           usuario.rol,
      mesa_asignada: mesaAsignada
    }
  }
}

/**
 * Logout: revoca el JWT actual añadiéndolo a la blacklist de Redis.
 */
async function logout (fastify, { userId, jti, exp, ip }) {
  // TTL = segundos restantes hasta que el JWT expire (viene del claim exp del token).
  // Si exp no está disponible, usar 2h como fallback conservador.
  const ttl = exp ? exp - Math.floor(Date.now() / 1000) : 7200

  if (ttl > 0) {
    await fastify.redis.setex(`bl:${jti}`, ttl, '1')
  }

  // Si el usuario tenía una mesa asignada, cancelar turnos en atención y liberar la mesa
  const { rows: mesasUsuario } = await fastify.db.query(
    `SELECT id, numero, nombre, estado FROM mesas WHERE operador_id = $1`, [userId]
  )
  for (const m of mesasUsuario) {
    const { rows: turnosCanc } = await fastify.db.query(
      `UPDATE turnos SET estado = 'cancelado', finalizado_en = NOW()
       WHERE mesa_id = $1 AND estado = 'en_atencion'
       RETURNING id, numero`,
      [m.id]
    )
    for (const tc of turnosCanc) {
      await fastify.db.query(
        `INSERT INTO audit_log (mesa_id, operador_id, turno_id, accion, ip_origen, metadata_json)
         VALUES ($1, $2, $3, 'TURNO_CANCELADO', $4, $5)`,
        [m.id, userId, tc.id, ip, JSON.stringify({ motivo: 'operador_logout', turno_numero: tc.numero })]
      )
      await fastify.broadcast('admin:all', 'turno_cancelado', { turno_id: tc.id, turno_numero: tc.numero, mesa_id: m.id })
      await fastify.broadcast('lote:activo', 'rezagados_actualizados', { accion: 'cancelado', turno_id: tc.id, turno_numero: tc.numero, mesa_id: m.id })
    }
  }

  // Al hacer logout, NO se libera la mesa (operador_id se mantiene).
  // Solo se pasa a estado 'pausada' si estaba activa.
  const { rows: mesasPausadas } = await fastify.db.query(
    `UPDATE mesas SET estado = 'pausada'
     WHERE operador_id = $1 AND estado = 'activa'
     RETURNING id, numero, nombre, estado, operador_id`,
    [userId]
  )
  for (const mesa of mesasPausadas) {
    await fastify.broadcast('admin:all', 'mesa_actualizada', { mesa })
    await fastify.broadcast('tv:global', 'mesas_disponibles_actualizadas', { mesa, accion: 'pausada' })
  }

  await fastify.db.query(
    `INSERT INTO audit_log (operador_id, accion, ip_origen)
     VALUES ($1, 'LOGOUT', $2)`,
    [userId, ip]
  )
}

/**
 * Refresh: genera un nuevo JWT a partir de un refresh token válido.
 */
async function refresh (fastify, { refreshToken }) {
  let payload
  try {
    payload = require('jsonwebtoken').verify(refreshToken, process.env.REFRESH_SECRET)
  } catch {
    const error = new Error('Refresh token inválido')
    error.statusCode = 401
    throw error
  }

  if (payload.type !== 'refresh') {
    const error = new Error('Token incorrecto')
    error.statusCode = 401
    throw error
  }

  // Verificar que el refresh token no fue revocado
  const existe = await fastify.redis.get(`refresh:${payload.jti}`)
  if (!existe) {
    const error = new Error('Refresh token expirado o revocado')
    error.statusCode = 401
    throw error
  }

  // Obtener datos actualizados del usuario
  const { rows } = await fastify.db.query(
    `SELECT id, username, nombre_completo, rol, activo FROM usuarios WHERE id = $1`,
    [payload.id]
  )

  if (!rows[0]?.activo) {
    const error = new Error('Usuario desactivado')
    error.statusCode = 403
    throw error
  }

  const usuario = rows[0]
  const nuevoJti = require('crypto').randomUUID()
  const nuevoToken = fastify.jwt.sign({
    id:       usuario.id,
    username: usuario.username,
    nombre:   usuario.nombre_completo,
    rol:      usuario.rol,
    jti:      nuevoJti
  })

  return { token: nuevoToken }
}

module.exports = { login, logout, refresh }
