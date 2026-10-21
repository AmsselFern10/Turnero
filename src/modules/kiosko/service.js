'use strict'

const crypto = require('crypto')
const os = require('os')

/**
 * Servicio del Autoservicio Kiosko — Numeración propia e independiente (v2.1)
 *
 * Cumple con:
 * - Numeración diaria correlativa (1 a N por día) sin lotes de vouchers.
 * - Avance atómico en una sola instrucción con INSERT ... ON CONFLICT DO UPDATE.
 * - Idempotencia ante reintentos (Idempotency-Key) y límite de 1 turno por celular.
 * - Detección automática de IP local LAN para QR accesible desde otros dispositivos.
 * - Cancelación de turnos no atendidos del día anterior en cambio de día.
 */

// Cache de estado general del kiosko (TTL 4 segundos para evitar sobrecarga en picos)
let _estadoCache = null
let _estadoCacheExpira = 0
const ESTADO_CACHE_TTL_MS = 4000

/**
 * Obtiene la dirección IP local de la máquina en la red LAN.
 */
function getLanIpAddress () {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return 'localhost'
}

/**
 * Obtiene la fecha actual del sistema según la zona horaria configurada.
 */
async function obtenerFechaHoy (fastify) {
  const { rows } = await fastify.db.query(
    `SELECT (NOW() AT TIME ZONE COALESCE(
       (SELECT valor FROM configuracion WHERE clave = 'zona_horaria' LIMIT 1),
       'America/Tegucigalpa'
     ))::DATE AS fecha_hoy`
  )
  return rows[0]?.fecha_hoy
}

/**
 * Cancela turnos 'esperando' del día anterior al iniciar o cambiar de jornada.
 * Registra auditoría automática mediante triggers existentes.
 */
async function cancelarTurnosVencidosDiaAnterior (fastify, fechaHoy) {
  try {
    await fastify.db.query(
      `UPDATE turnos
       SET estado = 'cancelado',
           finalizado_en = NOW()
       WHERE estado = 'esperando'
         AND origen = 'kiosko_web'
         AND fecha_turno < $1`,
      [fechaHoy]
    )
  } catch (err) {
    fastify.log.warn({ err }, '[Kiosko] Advertencia al cancelar turnos de días anteriores')
  }
}

/**
 * Obtiene el estado público actual del Kiosko (con caché en memoria de 4 segundos).
 */
async function getKioskoEstado (fastify) {
  const now = Date.now()
  if (_estadoCache && now < _estadoCacheExpira) {
    return _estadoCache
  }

  const fechaHoy = await obtenerFechaHoy(fastify)

  // Consulta consolidada
  const [resConfig, resTurnos, resMesas, resContador] = await Promise.all([
    fastify.db.query(
      `SELECT clave, valor FROM configuracion
       WHERE clave IN ('kiosko_web_activo', 'modo_generacion_turnos', 'kiosko_tope_diario', 'kiosko_modo_uso', 'kiosko_impresion_automatica', 'kiosko_url_base', 'kiosko_url_publica')`
    ),
    fastify.db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM turnos
          WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = $1
         ) AS en_espera,
         (SELECT json_agg(u) FROM (
            SELECT t.numero, m.numero AS mesa_numero, m.nombre AS mesa_nombre, t.llamado_en
            FROM turnos t
            LEFT JOIN mesas m ON t.mesa_id = m.id
            WHERE t.estado IN ('en_atencion', 'atendido')
              AND t.fecha_turno = $1
            ORDER BY t.llamado_en DESC NULLS LAST
            LIMIT 10
          ) u) AS ultimos_llamados,
         (SELECT COALESCE(AVG(duracion_atencion_seg)::int, 180) FROM turnos
          WHERE estado = 'atendido' AND fecha_turno = $1 AND duracion_atencion_seg > 0
         ) AS tiempo_promedio_seg`,
      [fechaHoy]
    ),
    fastify.db.query(
      `SELECT COUNT(*)::int AS activas FROM mesas WHERE estado = 'activa'`
    ),
    fastify.db.query(
      `SELECT ultimo_numero FROM kiosko_contador_diario WHERE fecha = $1`,
      [fechaHoy]
    )
  ])

  const cfg = {}
  for (const r of resConfig.rows) {
    cfg[r.clave] = r.valor
  }

  const activo = cfg.kiosko_web_activo === 'true'
  const modo = cfg.modo_generacion_turnos || 'voucher_fisico'
  const modoUso = cfg.kiosko_modo_uso || 'asistido'
  const topeDiario = parseInt(cfg.kiosko_tope_diario || '0', 10)
  const impresionAutomatica = cfg.kiosko_impresion_automatica === 'true'
  const ultimoNumeroEmitido = resContador.rows[0]?.ultimo_numero || 0
  const topeAlcanzado = topeDiario > 0 && ultimoNumeroEmitido >= topeDiario

  const turnosData = resTurnos.rows[0] || {}
  const ultimosLlamados = turnosData.ultimos_llamados || []
  const ultimoLlamado = ultimosLlamados.length > 0 ? ultimosLlamados[0] : null
  const mesasActivas = resMesas.rows[0]?.activas || 0
  const tiempoPromedioSeg = turnosData.tiempo_promedio_seg || 180

  _estadoCache = {
    activo,
    modo,
    modo_uso: modoUso,
    tope_diario: topeDiario,
    tope_alcanzado: topeAlcanzado,
    impresion_automatica: impresionAutomatica,
    url_base: cfg.kiosko_url_base || '',
    url_publica: cfg.kiosko_url_publica || '',
    turnos_en_espera: turnosData.en_espera || 0,
    ultimo_llamado: ultimoLlamado,
    ultimos_llamados: ultimosLlamados,
    mesas_activas: mesasActivas,
    tiempo_promedio_seg: tiempoPromedioSeg,
    fecha: fechaHoy
  }
  _estadoCacheExpira = now + ESTADO_CACHE_TTL_MS

  return _estadoCache
}

/**
 * Resuelve la URL base completa para el enlace de seguimiento QR.
 */
function resolverUrlSeguimiento (baseUrlConfig, reqHost, reqProtocol, token) {
  if (baseUrlConfig && baseUrlConfig.trim() !== '') {
    const base = baseUrlConfig.trim().replace(/\/$/, '')
    if (base.endsWith('/kiosko.html')) {
      return `${base}?token=${encodeURIComponent(token)}`
    }
    return `${base}/kiosko.html?token=${encodeURIComponent(token)}`
  }

  const port = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
  let host = reqHost || `localhost:${port}`

  // Si se abrió localmente como localhost / 127.0.0.1, usar la IP real de LAN
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    const lanIp = getLanIpAddress()
    const portPart = host.includes(':') ? `:${host.split(':')[1]}` : `:${port}`
    host = `${lanIp}${portPart}`
  }

  const proto = reqProtocol || 'http'
  return `${proto}://${host}/kiosko.html?token=${encodeURIComponent(token)}`
}

/**
 * Genera un nuevo turno para el autoservicio Kiosko (RF-GEN-02 con numeración propia).
 */
async function generarTurno (fastify, { ip, idempotencyKey, deviceId, esTablet, reqHost, reqProtocol }) {
  const fechaHoy = await obtenerFechaHoy(fastify)

  // 1. Limpieza perezosa de turnos de días anteriores
  await cancelarTurnosVencidosDiaAnterior(fastify, fechaHoy)

  // 2. Comprobar Idempotency-Key si el cliente envió una (reintento por mala señal)
  if (idempotencyKey) {
    const { rows: [turnoExistente] } = await fastify.db.query(
      `SELECT t.id, t.numero, t.token_consulta, t.creado_en, t.estado, t.fecha_turno
       FROM turnos t
       WHERE t.idempotency_key = $1
       LIMIT 1`,
      [idempotencyKey]
    )

    if (turnoExistente) {
      fastify.log?.info?.({ idempotencyKey, turnoId: turnoExistente.id }, '[Kiosko IDEM] Turno retornado por idempotencia previa')
      return armarRespuestaTurno(fastify, turnoExistente, reqHost, reqProtocol)
    }
  }

  // 3. Comprobar si el smartphone del estudiante ya tiene un turno en espera hoy (no aplica a modalidad asistida en tablet)
  if (!esTablet && deviceId) {
    const { rows: [turnoDispositivo] } = await fastify.db.query(
      `SELECT t.id, t.numero, t.token_consulta, t.creado_en, t.estado, t.fecha_turno
       FROM turnos t
       WHERE t.device_id = $1
         AND t.estado = 'esperando'
         AND t.fecha_turno = $2
       LIMIT 1`,
      [deviceId, fechaHoy]
    )

    if (turnoDispositivo) {
      fastify.log?.info?.({ deviceId, turnoId: turnoDispositivo.id }, '[Kiosko Device] Turno activo existente retornado al estudiante')
      return armarRespuestaTurno(fastify, turnoDispositivo, reqHost, reqProtocol)
    }
  }

  // 4. Validar configuración activa del sistema
  const { rows: configRows } = await fastify.db.query(
    `SELECT clave, valor FROM configuracion
     WHERE clave IN ('kiosko_web_activo', 'modo_generacion_turnos', 'kiosko_tope_diario', 'kiosko_modo_uso', 'kiosko_url_base', 'kiosko_url_publica')`
  )

  const cfg = {}
  for (const r of configRows) {
    cfg[r.clave] = r.valor
  }

  if (cfg.kiosko_web_activo !== 'true') {
    throw Object.assign(new Error('El servicio de kiosko no está activo actualmente. Solicite su voucher físico.'), {
      statusCode: 403,
      codigo: 'kiosko_desactivado'
    })
  }

  if (cfg.modo_generacion_turnos !== 'kiosko_web') {
    throw Object.assign(new Error('El sistema opera actualmente mediante vouchers físicos.'), {
      statusCode: 403,
      codigo: 'modo_no_kiosko'
    })
  }

  // Si la modalidad activa es asistida, celulares en modo estudiante no pueden generar turnos
  const modoUso = cfg.kiosko_modo_uso || 'asistido'
  if (!esTablet && (modoUso === 'asistido' || modoUso === 'empleado')) {
    throw Object.assign(new Error('La emisión de turnos desde dispositivos móviles no está habilitada. Por favor solicite su turno en el módulo de atención asistida.'), {
      statusCode: 403,
      codigo: 'modo_asistido_activo'
    })
  }

  // 5. Verificar límite de sobrecarga de turnos en espera simultáneos (máximo 200)
  const { rows: [{ totalEsperando }] } = await fastify.db.query(
    `SELECT COUNT(*)::int AS "totalEsperando" FROM turnos
     WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = $1`,
    [fechaHoy]
  )

  if (totalEsperando >= 200) {
    const err = new Error('La cola de espera está saturada temporalmente. Intente en unos minutos.')
    err.statusCode = 503
    err.codigo = 'cola_llena'
    err.retryAfter = 30
    throw err
  }

  const topeDiario = parseInt(cfg.kiosko_tope_diario || '0', 10)

  // 6. Asignación atómica de número correlativo diario (1 a N)
  let nuevoNumero = null
  let sesionActual = 1

  if (topeDiario > 0) {
    const { rows: contadorRows } = await fastify.db.query(
      `INSERT INTO kiosko_contador_diario (fecha, ultimo_numero, sesion, actualizado_en)
       VALUES ($1, 1, 1, NOW())
       ON CONFLICT (fecha)
       DO UPDATE SET
         ultimo_numero = kiosko_contador_diario.ultimo_numero + 1,
         actualizado_en = NOW()
       WHERE kiosko_contador_diario.ultimo_numero < $2
       RETURNING ultimo_numero, sesion`,
      [fechaHoy, topeDiario]
    )

    if (contadorRows.length === 0) {
      throw Object.assign(new Error('Se ha alcanzado el límite máximo de turnos permitidos para el día de hoy.'), {
        statusCode: 409,
        codigo: 'tope_diario_alcanzado'
      })
    }
    nuevoNumero = contadorRows[0].ultimo_numero
    sesionActual = contadorRows[0].sesion || 1
  } else {
    const { rows: contadorRows } = await fastify.db.query(
      `INSERT INTO kiosko_contador_diario (fecha, ultimo_numero, sesion, actualizado_en)
       VALUES ($1, 1, 1, NOW())
       ON CONFLICT (fecha)
       DO UPDATE SET
         ultimo_numero = kiosko_contador_diario.ultimo_numero + 1,
         actualizado_en = NOW()
       RETURNING ultimo_numero, sesion`,
      [fechaHoy]
    )
    nuevoNumero = contadorRows[0].ultimo_numero
    sesionActual = contadorRows[0].sesion || 1
  }

  // 7. Generar token criptográfico efímero de 64 caracteres hex
  const token = crypto.randomBytes(32).toString('hex')
  const deviceIdGuardar = esTablet ? null : (deviceId || null)

  // 8. Crear el turno en estado 'esperando' (sin lote_id)
  let turnoCreado
  try {
    const resInsert = await fastify.db.query(
      `INSERT INTO turnos (
         numero, fecha_turno, sesion, lote_id, estado, origen, token_consulta,
         idempotency_key, device_id, creado_en
       ) VALUES (
         $1, $2, $3, NULL, 'esperando', 'kiosko_web', $4,
         $5, $6, NOW()
       )
       RETURNING id, numero, token_consulta, creado_en, estado, fecha_turno, sesion`,
      [nuevoNumero, fechaHoy, sesionActual, token, idempotencyKey || null, deviceIdGuardar]
    )
    turnoCreado = resInsert.rows[0]
  } catch (err) {
    if (idempotencyKey && err.code === '23505' && (err.constraint === 'ux_turnos_idempotency_key' || (err.message && err.message.includes('idempotency_key')))) {
      const { rows: [dup] } = await fastify.db.query(
        `SELECT id, numero, token_consulta, creado_en, estado, fecha_turno
         FROM turnos WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey]
      )
      if (dup) {
        return armarRespuestaTurno(fastify, dup, reqHost, reqProtocol, (cfg.kiosko_url_base || '').trim() || (cfg.kiosko_url_publica || '').trim())
      }
    }
    if (err.code === '23505' && (err.constraint === 'ux_turnos_kiosko_dia_numero' || (err.message && err.message.includes('ux_turnos_kiosko_dia_numero')))) {
      throw Object.assign(
        new Error(`El turno #${nuevoNumero} ya fue emitido hoy. El contador de kiosko debe sincronizarse.`),
        { statusCode: 409, codigo: 'turno_kiosko_duplicado' }
      )
    }
    throw err
  }

  // Invalidar caché de estado del kiosko
  _estadoCache = null

  return armarRespuestaTurno(fastify, turnoCreado, reqHost, reqProtocol, (cfg.kiosko_url_base || '').trim() || (cfg.kiosko_url_publica || '').trim())
}

// Caché en memoria para métricas globales de atención (mesas activas y tiempo promedio)
// Evita ejecutar AVG(duracion_atencion_seg) repetidamente en cada consulta de cada smartphone
let _metricasCache = null
let _metricasCacheExpira = 0
const METRICAS_CACHE_TTL_MS = 15000 // 15 segundos

async function obtenerMetricasAtencion (fastify, fecha) {
  const now = Date.now()
  if (_metricasCache && now < _metricasCacheExpira && _metricasCache.fecha === fecha) {
    return _metricasCache
  }

  const { rows } = await fastify.db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM mesas WHERE estado = 'activa') AS mesas_activas,
       (SELECT COALESCE(AVG(duracion_atencion_seg)::int, 180) FROM turnos
        WHERE estado = 'atendido' AND fecha_turno = $1 AND duracion_atencion_seg > 0
       ) AS tiempo_promedio_seg`,
    [fecha]
  )

  const data = rows[0] || {}
  _metricasCache = {
    fecha,
    mesas_activas: Math.max(1, data.mesas_activas || 1),
    tiempo_promedio_seg: data.tiempo_promedio_seg || 180
  }
  _metricasCacheExpira = now + METRICAS_CACHE_TTL_MS
  return _metricasCache
}

/**
 * Arma los datos del voucher/ticket incluyendo posición calculada y tiempo estimado.
 */
async function armarRespuestaTurno (fastify, turno, reqHost, reqProtocol, baseUrlConfig = null) {
  const fechaHoy = turno.fecha_turno

  const [resPos, metricas, resUrlBase] = await Promise.all([
    fastify.db.query(
      `SELECT COUNT(*)::int AS personas_antes
       FROM turnos
       WHERE estado = 'esperando'
         AND origen = 'kiosko_web'
         AND fecha_turno = $1
         AND numero < $2`,
      [fechaHoy, turno.numero]
    ),
    obtenerMetricasAtencion(fastify, fechaHoy),
    baseUrlConfig !== null
      ? Promise.resolve({ rows: [{ valor: baseUrlConfig }] })
      : fastify.db.query(`SELECT clave, valor FROM configuracion WHERE clave IN ('kiosko_url_publica', 'kiosko_url_base')`)
  ])

  const personasAntes = resPos.rows[0]?.personas_antes ?? 0
  const mesasActivas = metricas.mesas_activas
  const tiempoPromedioSeg = metricas.tiempo_promedio_seg

  // Estimado: (personas antes * tiempo promedio en minutos) / mesas atendiendo simultáneamente
  const tiempoEstimadoMin = Math.max(1, Math.round((personasAntes * (tiempoPromedioSeg / 60)) / mesasActivas))

  let urlBase = ''
  if (baseUrlConfig !== null) {
    urlBase = baseUrlConfig
  } else {
    const cfgMap = {}
    for (const r of resUrlBase.rows) cfgMap[r.clave] = r.valor
    urlBase = (cfgMap.kiosko_url_base || '').trim() || (cfgMap.kiosko_url_publica || '').trim()
  }

  const trackingUrl = resolverUrlSeguimiento(urlBase, reqHost, reqProtocol, turno.token_consulta)

  return {
    numero: turno.numero,
    token: turno.token_consulta,
    creado_en: turno.creado_en,
    posicion_en_cola: personasAntes,
    tiempo_estimado_min: tiempoEstimadoMin,
    tracking_url: trackingUrl
  }
}

/**
 * Consulta del estado y posición de un ticket por su token (RF-GEN-03).
 */
async function consultarMiTurno (fastify, param) {
  const token = typeof param === 'string' ? param : param?.token
  if (!token || typeof token !== 'string' || token.length !== 64) {
    throw Object.assign(new Error('Enlace de consulta inválido'), {
      statusCode: 404,
      codigo: 'enlace_invalido'
    })
  }

  const { rows: [turno] } = await fastify.db.query(
    `SELECT t.id, t.numero, t.estado, t.llamado_en, t.creado_en, t.fecha_turno,
            m.numero AS mesa_numero, m.nombre AS mesa_nombre
     FROM turnos t
     LEFT JOIN mesas m ON t.mesa_id = m.id
     WHERE t.token_consulta = $1`,
    [token]
  )

  if (!turno) {
    throw Object.assign(new Error('Turno no encontrado o enlace caducado'), {
      statusCode: 404,
      codigo: 'turno_no_encontrado'
    })
  }

  let personasAntes = 0
  let tiempoEstimadoMin = 0

  if (turno.estado === 'esperando') {
    const [resPos, metricas] = await Promise.all([
      fastify.db.query(
        `SELECT COUNT(*)::int AS personas_antes
         FROM turnos
         WHERE estado = 'esperando'
           AND origen = 'kiosko_web'
           AND fecha_turno = $1
           AND numero < $2`,
        [turno.fecha_turno, turno.numero]
      ),
      obtenerMetricasAtencion(fastify, turno.fecha_turno)
    ])

    personasAntes = resPos.rows[0]?.personas_antes ?? 0
    const mesasActivas = metricas.mesas_activas
    const tiempoPromedioSeg = metricas.tiempo_promedio_seg
    tiempoEstimadoMin = Math.max(1, Math.round((personasAntes * (tiempoPromedioSeg / 60)) / mesasActivas))
  }

  const nombreMesa = turno.mesa_nombre || (turno.mesa_numero ? `Mesa ${turno.mesa_numero}` : null)

  return {
    numero: turno.numero,
    estado: turno.estado,
    fecha_turno: turno.fecha_turno,
    mesa: nombreMesa,
    mesa_numero: turno.mesa_numero,
    posicion: personasAntes,
    tiempo_estimado_min: tiempoEstimadoMin,
    llamado_en: turno.llamado_en,
    creado_en: turno.creado_en
  }
}

/**
 * Factory helper para instanciar el servicio kiosko con un objeto fastify o db.
 */
function createKioskoService (fastifyOrDb) {
  const f = fastifyOrDb.db ? fastifyOrDb : { db: fastifyOrDb, log: { info: () => {}, warn: () => {}, error: () => {} } }
  return {
    getKioskoEstado: () => getKioskoEstado(f),
    generarTurno: (opts = {}) => generarTurno(f, { ...opts, reqHost: opts.hostHeader || opts.reqHost }),
    consultarMiTurno: (param) => consultarMiTurno(f, param),
    cancelarTurnosVencidosDiaAnterior: (fecha) => cancelarTurnosVencidosDiaAnterior(f, fecha)
  }
}

function invalidarCacheEstado () {
  _estadoCache = null
  _estadoCacheExpira = 0
}

module.exports = {
  createKioskoService,
  getKioskoEstado,
  generarTurno,
  consultarMiTurno,
  cancelarTurnosVencidosDiaAnterior,
  getLanIpAddress,
  resolverUrlSeguimiento,
  invalidarCacheEstado
}
