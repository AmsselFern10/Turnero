'use strict'

const {
  llamarSiguiente,
  cancelarTurno,
  obtenerRezagados,
  atenderRezagado,
  generarTurnoKiosko,
  consultarMiTurno
} = require('./service')

/**
 * Módulo de turnos — Rutas Fastify
 * Prefijo: /turnos
 */
module.exports = async function turnosRoutes (fastify) {

  // ── POST /turnos/llamar — EL ENDPOINT PRINCIPAL (RF-TURN-01) ──────────────
  // Rate limit: máx 5 llamados/seg por operador (RNF-SEG-07)
  fastify.post('/llamar', {
    preHandler: [fastify.authorizeRol('operador', 'admin')],
    config: {
      rateLimit: {
        max:        30,
        timeWindow: '1 second',
        keyGenerator: (req) => {
          if (req.user?.id) return `turno:${req.user.id}`
          const auth = req.headers?.authorization
          if (auth && auth.startsWith('Bearer ')) {
            try {
              const decoded = fastify.jwt.decode(auth.slice(7))
              if (decoded?.id) return `turno:${decoded.id}`
            } catch (_) {}
          }
          return `turno:${req.ip}`
        },
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: 'Rate limit',
          message: 'Máximo 30 llamadas por segundo por operador.'
        })
      }
    },
    schema: {
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: {
          mesa_id: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { mesa_id } = request.body
    const operadorId   = request.user.id

    // ── Idempotency-Key: protege timeout + reintento = 2 turnos ──────────────
    const iKey = request.headers['idempotency-key']
    if (iKey) {
      // 1. Servir desde caché si ya completó
      if (fastify._idempotencyCache?.has(iKey)) {
        fastify.log.info({ iKey, mesa_id }, '[IDEM] Servido desde cache')
        const cached = fastify._idempotencyCache.get(iKey)
        return reply.status(200).send({ ...cached, es_idempotente: true })
      }
      // 2. Coalescing por iKey: Si hay un request en vuelo con la misma key, esperar a que termine
      if (fastify._idempotencyPromises?.has(iKey)) {
        fastify.log.info({ iKey, mesa_id }, '[IDEM] Esperando request concurrente en vuelo')
        const resultadoEnVuelo = await fastify._idempotencyPromises.get(iKey)
        return reply.status(200).send({ ...resultadoEnVuelo, es_idempotente: true })
      }
    }

    // 3. Coalescing por Mesa: si ya hay una llamada en vuelo en ESTA MISMA mesa, esperar el mismo resultado
    const mesaLockKey = `mesa:${mesa_id}`
    if (fastify._mesaLlamarPromises?.has(mesaLockKey)) {
      fastify.log.info({ mesa_id }, '[IDEM] Request en vuelo para esta mesa, coalescing concurrente')
      const resultadoMesa = await fastify._mesaLlamarPromises.get(mesaLockKey)
      return reply.status(200).send({ ...resultadoMesa, es_idempotente: true })
    }

    const operacionLlamar = (async () => {
      const resultado = await llamarSiguiente(fastify, {
        mesaId:     mesa_id,
        operadorId
      })

      const { turno, vouchers_restantes, proximo_numero, es_idempotente } = resultado

      // Si fue reintento/doble-clic idempotente, no re-anunciar a TV ni recargar cola
      if (!es_idempotente) {
        // Broadcast seguro desacoplado: se despacha en background post-commit sin queries extra a BD
        // El payload sale directamente de la transacción. Un fallo de WS no bloquea la respuesta ni causa 500.
        setImmediate(async () => {
          try {
            await Promise.allSettled([
              // TV: anuncia el nuevo número (payload de la transacción, 0 queries extra a BD)
              fastify.broadcast('tv:global', 'nuevo_llamado', {
                evento_id:      crypto.randomUUID(),
                turno:          turno.numero,
                numero:         turno.numero,
                mesa_numero:    turno.mesa_numero,
                mesa_nombre:    turno.mesa_nombre,
                lote_numero:    turno.lote_numero,
                proximo_numero: proximo_numero,
                llamado_en:     turno.llamado_en,
                historial:      []
              }),
              // Panel del operador: actualiza su panel
              fastify.broadcast(`mesa:${mesa_id}`, 'turno_llamado', {
                turno,
                proximo_numero,
                vouchers_restantes
              }),
              // Canal unificado de progreso de lote (RF-TURN-09): 1 broadcast, 0 queries extra a BD
              fastify.broadcast('lote:activo', 'proximo_actualizado', {
                lote:               turno.lote_numero,
                ultimo_llamado:     turno.numero,
                proximo_numero,
                vouchers_restantes
              }),
              // Admin: KPI update
              fastify.broadcast('admin:all', 'kpi_update', {
                mesa_id,
                turno_numero:       turno.numero,
                vouchers_restantes,
                tipo_evento:        'llamado'
              }),
              // Kiosko público: un solo canal de aviso para todos los smartphones en espera
              fastify.broadcast('kiosko:publico', 'llamados', {
                ultimo_llamado: {
                  id:             turno.id,
                  numero:         turno.numero,
                  origen:         turno.origen,
                  mesa_numero:    turno.mesa_numero,
                  mesa_nombre:    turno.mesa_nombre,
                  llamado_en:     turno.llamado_en
                },
                mesa_id,
                proximo_numero,
                turnos_esperando: vouchers_restantes
              })
            ])

            if (resultado.es_lote_agotado) {
              fastify.broadcast('admin:all', 'lote_agotado', {
                lote_id:        resultado.lote_id,
                numero_lote:    resultado.lote_numero,
                numero_hasta:   resultado.numero_hasta,
                ultimo_llamado: resultado.ultimo_llamado
              })
            }

            if (turno.origen === 'kiosko_web') {
              try {
                const { rows: [tkRow] } = await fastify.db.query(
                  `SELECT token_consulta FROM turnos WHERE id = $1 LIMIT 1`,
                  [turno.id]
                )
                if (tkRow?.token_consulta) {
                  try { if (fastify.redis?.del) await fastify.redis.del(`mi_turno:${tkRow.token_consulta}`) } catch (_) {}
                  await fastify.broadcast(`kiosko:${tkRow.token_consulta}`, 'tu_turno_llamado', {
                    turno_id:    turno.id,
                    numero:      turno.numero,
                    mesa_numero: turno.mesa_numero,
                    mesa_nombre: turno.mesa_nombre,
                    llamado_en:  turno.llamado_en
                  })
                }
              } catch (_) {}
            }
          } catch (broadcastErr) {
            fastify.log.error({ err: broadcastErr, mesa_id, turno_id: turno.id }, 'Error no fatal en broadcast WS post-commit')
          }
        })
      }

      return { turno, proximo_numero, vouchers_restantes, es_idempotente: Boolean(es_idempotente) }
    })()

    if (iKey && fastify._idempotencyPromises) {
      fastify._idempotencyPromises.set(iKey, operacionLlamar)
    }
    if (fastify._mesaLlamarPromises) {
      fastify._mesaLlamarPromises.set(mesaLockKey, operacionLlamar)
    }

    let responseBody
    try {
      responseBody = await operacionLlamar
    } finally {
      if (iKey && fastify._idempotencyPromises) {
        fastify._idempotencyPromises.delete(iKey)
      }
      if (fastify._mesaLlamarPromises) {
        fastify._mesaLlamarPromises.delete(mesaLockKey)
      }
    }

    // Guardar en cache de idempotencia para proteger reintentos posteriores tras timeout
    if (iKey && fastify._idempotencyCache) {
      fastify._idempotencyCache.set(iKey, responseBody)
      setTimeout(() => fastify._idempotencyCache.delete(iKey), 60_000)
    }

    return reply.status(200).send(responseBody)
  })

  // ── POST /turnos/:id/cancelar — No se presentó (RF-TURN-05) ───────────────
  fastify.post('/:id/cancelar', {
    preHandler: [fastify.authorizeRol('operador', 'admin')],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } }
      },
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: { mesa_id: { type: 'integer' } }
      }
    }
  }, async (request, reply) => {
    const turnoId    = parseInt(request.params.id)
    const { mesa_id } = request.body
    const operadorId   = request.user.id

    // Seguridad: Un operador solo puede actuar sobre su propia mesa asignada
    if (request.user.rol === 'operador') {
      const { rows: [mAsignada] } = await fastify.db.query(
        'SELECT id FROM mesas WHERE id = $1 AND operador_id = $2 AND estado != \'eliminada\'',
        [mesa_id, operadorId]
      )
      if (!mAsignada) {
        return reply.status(403).send({ error: 'Esta mesa no te está asignada' })
      }
    }

    const turno = await cancelarTurno(fastify, {
      turnoId,
      operadorId,
      mesaId: mesa_id
    })

    if (turno.token_consulta) {
      try { if (fastify.redis?.del) await fastify.redis.del(`mi_turno:${turno.token_consulta}`) } catch (_) {}
    }

    // Notificar al admin y actualizar listas de rezagados en operadores post-commit (desacoplado)
    setImmediate(async () => {
      try {
        await Promise.allSettled([
          fastify.broadcast('admin:all', 'turno_cancelado', {
            turno_id:    turno.id,
            turno_numero: turno.numero,
            mesa_id
          }),
          fastify.broadcast('lote:activo', 'rezagados_actualizados', {
            accion:       'cancelado',
            turno_id:     turno.id,
            turno_numero: turno.numero,
            mesa_id
          })
        ])
      } catch (err) {
        fastify.log.error({ err, turnoId }, 'Error en broadcast de cancelación')
      }
    })

    return reply.status(200).send({ message: 'Turno cancelado', turno })
  })

  // ── GET /turnos/rezagados — Listar turnos cancelados de la jornada ──────────
  fastify.get('/rezagados', {
    preHandler: [fastify.authorizeRol('operador', 'admin')]
  }, async (request, reply) => {
    const turnos = await obtenerRezagados(fastify)
    return reply.status(200).send({ turnos, total: turnos.length })
  })

  // ── POST /turnos/atender-rezagado — Atender un turno rezagado (atómico) ─────
  fastify.post('/atender-rezagado', {
    preHandler: [fastify.authorizeRol('operador', 'admin')],
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 second',
        keyGenerator: (req) => {
          if (req.user?.id) return `rezagado:${req.user.id}`
          const auth = req.headers?.authorization
          if (auth && auth.startsWith('Bearer ')) {
            try {
              const decoded = fastify.jwt.decode(auth.slice(7))
              if (decoded?.id) return `rezagado:${decoded.id}`
            } catch (_) {}
          }
          return `rezagado:${req.ip}`
        },
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: 'Rate limit',
          message: 'Máximo 30 solicitudes por segundo por operador.'
        })
      }
    },
    schema: {
      body: {
        type: 'object',
        required: ['turno_id', 'mesa_id'],
        properties: {
          turno_id: { type: 'integer', minimum: 1 },
          mesa_id:  { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { turno_id, mesa_id } = request.body
    const operadorId = request.user.id

    // Idempotency-Key
    const iKey = request.headers['idempotency-key']
    if (iKey) {
      if (fastify._idempotencyCache?.has(iKey)) {
        fastify.log.info({ iKey, mesa_id, turno_id }, '[IDEM] Rezagado servido desde cache')
        return reply.status(200).send(fastify._idempotencyCache.get(iKey))
      }
      if (fastify._idempotencyPromises?.has(iKey)) {
        fastify.log.info({ iKey, mesa_id, turno_id }, '[IDEM] Esperando rezagado concurrente')
        const enVuelo = await fastify._idempotencyPromises.get(iKey)
        return reply.status(200).send(enVuelo)
      }
    }

    const operacionRezagado = (async () => {
      const resultado = await atenderRezagado(fastify, {
        turnoId: turno_id,
        mesaId: mesa_id,
        operadorId
      })

      const { turno, vouchers_restantes, proximo_numero } = resultado

      setImmediate(async () => {
        try {
          await Promise.allSettled([
            // TV: anuncia el nuevo llamado del rezagado
            fastify.broadcast('tv:global', 'nuevo_llamado', {
              evento_id:      crypto.randomUUID(),
              turno:          turno.numero,
              numero:         turno.numero,
              mesa_numero:    turno.mesa_numero,
              mesa_nombre:    turno.mesa_nombre,
              lote_numero:    turno.lote_numero,
              proximo_numero: proximo_numero,
              llamado_en:     turno.llamado_en,
              es_rezagado:    true,
              historial:      []
            }),
            // Panel de la mesa: actualiza el turno actual
            fastify.broadcast(`mesa:${mesa_id}`, 'turno_llamado', {
              turno,
              proximo_numero,
              vouchers_restantes,
              es_rezagado: true
            }),
            // Admin: KPI update
            fastify.broadcast('admin:all', 'kpi_update', {
              mesa_id,
              turno_numero:       turno.numero,
              vouchers_restantes,
              tipo_evento:        'rezagado'
            }),
            // Kiosko público: avisa al celular del estudiante (si origen fue kiosko_web)
            fastify.broadcast('kiosko:publico', 'llamados', {
              ultimo_llamado: {
                id:             turno.id,
                numero:         turno.numero,
                origen:         turno.origen,
                mesa_numero:    turno.mesa_numero,
                mesa_nombre:    turno.mesa_nombre,
                llamado_en:     turno.llamado_en
              },
              mesa_id,
              proximo_numero,
              turnos_esperando: vouchers_restantes
            }),
            // Lote/mesas: sincroniza listas de rezagados entre operarios
            fastify.broadcast('lote:activo', 'rezagados_actualizados', {
              accion:       'atendido',
              turno_id:     turno.id,
              turno_numero: turno.numero,
              mesa_id,
              mesa_numero:  turno.mesa_numero
            })
          ])

          if (turno.origen === 'kiosko_web') {
            try {
              const { rows: [tkRow] } = await fastify.db.query(
                `SELECT token_consulta FROM turnos WHERE id = $1 LIMIT 1`,
                [turno.id]
              )
              if (tkRow?.token_consulta) {
                try { if (fastify.redis?.del) await fastify.redis.del(`mi_turno:${tkRow.token_consulta}`) } catch (_) {}
                await fastify.broadcast(`kiosko:${tkRow.token_consulta}`, 'tu_turno_llamado', {
                  turno_id:    turno.id,
                  numero:      turno.numero,
                  mesa_numero: turno.mesa_numero,
                  mesa_nombre: turno.mesa_nombre,
                  llamado_en:  turno.llamado_en
                })
              }
            } catch (_) {}
          }
        } catch (bErr) {
          fastify.log.error({ err: bErr, mesa_id, turno_id: turno.id }, 'Error en broadcast de rezagado post-commit')
        }
      })

      return { turno, proximo_numero, vouchers_restantes, es_rezagado: true }
    })()

    if (iKey && fastify._idempotencyPromises) {
      fastify._idempotencyPromises.set(iKey, operacionRezagado)
    }

    let responseBody
    try {
      responseBody = await operacionRezagado
    } finally {
      if (iKey && fastify._idempotencyPromises) {
        fastify._idempotencyPromises.delete(iKey)
      }
    }

    if (iKey && fastify._idempotencyCache) {
      fastify._idempotencyCache.set(iKey, responseBody)
      setTimeout(() => fastify._idempotencyCache.delete(iKey), 60_000)
    }

    return reply.status(200).send(responseBody)
  })

  // ── POST /turnos/:id/finalizar — Finalizar turno en atención (RF-TURN) ───────
  fastify.post('/:id/finalizar', {
    preHandler: [fastify.authorizeRol('operador', 'admin')],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } }
      },
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: { mesa_id: { type: 'integer' } }
      }
    }
  }, async (request, reply) => {
    const turnoId    = parseInt(request.params.id)
    const { mesa_id } = request.body
    const operadorId   = request.user.id

    const { rows } = await fastify.db.query(
      `UPDATE turnos
       SET estado = 'atendido'
       WHERE id = $1 AND mesa_id = $2 AND estado = 'en_atencion'
       RETURNING id, numero, lote_id, llamado_en, finalizado_en, duracion_atencion_seg`,
      [turnoId, mesa_id]
    )

    if (rows.length === 0) {
      return reply.status(200).send({ message: 'El turno ya no estaba en atención' })
    }

    const turno = rows[0]

    // Notificar admin, mesa y auditar
    await Promise.allSettled([
      fastify.broadcast('admin:all', 'kpi_update', {
        mesa_id,
        turno_numero: turno.numero,
        tipo_evento:  'finalizado'
      }),
      fastify.broadcast(`mesa:${mesa_id}`, 'mesa_actualizada', {
        mesa_id,
        turno_id: turno.id,
        estado:   'atendido'
      }),
      fastify.db.query(
        `INSERT INTO audit_log (mesa_id, turno_id, operador_id, accion, metadata_json, ip_origen)
         VALUES ($1, $2, $3, 'TURNO_FINALIZADO', $4, $5)`,
        [mesa_id, turno.id, operadorId, JSON.stringify({ numero: turno.numero }), request.ip]
      )
    ])

    return reply.status(200).send({ message: 'Turno finalizado con éxito', turno })
  })

  // ── POST /turnos/:id/rellamar — Re-llamar turno actual (RF-MESA / TV) ─────────
  fastify.post('/:id/rellamar', {
    preHandler: [fastify.authorizeRol('operador', 'admin')],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } }
      },
      body: {
        type: 'object',
        required: ['mesa_id'],
        properties: { mesa_id: { type: 'integer' } }
      }
    }
  }, async (request, reply) => {
    const mesa_id = parseInt(request.body.mesa_id)
    const operadorId  = request.user.id

    // Seguridad: Un operador solo puede actuar sobre su propia mesa asignada
    if (request.user.rol === 'operador') {
      const { rows: [mAsignada] } = await fastify.db.query(
        'SELECT id FROM mesas WHERE id = $1 AND operador_id = $2 AND estado != \'eliminada\'',
        [mesa_id, operadorId]
      )
      if (!mAsignada) {
        return reply.status(403).send({ error: 'Esta mesa no te está asignada' })
      }
    }

    // Cooldown de 3 s por mesa para evitar re-llamados espurios o saturación de TV
    if (!fastify._cooldownsRellamado) {
      fastify._cooldownsRellamado = new Map()
    }
    const ahora = Date.now()
    const ultimoRellamado = fastify._cooldownsRellamado.get(mesa_id) || 0
    if (ahora - ultimoRellamado < 3000) {
      return reply.status(429).send({ error: 'Debe esperar 3 segundos entre re-llamados a la TV' })
    }

    // El servidor re-llama el turno en_atencion de esa mesa (fuente de verdad en BD)
    const { rows: [turno] } = await fastify.db.query(
      `SELECT t.id, t.numero, t.mesa_id, t.origen, t.token_consulta, m.numero AS mesa_numero, m.nombre AS mesa_nombre, l.numero_lote
       FROM turnos t
       JOIN mesas m ON t.mesa_id = m.id
       LEFT JOIN lotes_voucher l ON t.lote_id = l.id
       WHERE t.mesa_id = $1 AND t.estado = 'en_atencion'
       LIMIT 1`,
      [mesa_id]
    )

    if (!turno) {
      return reply.status(409).send({ error: 'No hay turno en atención en esta mesa para re-llamar' })
    }

    // Registrar cooldown
    fastify._cooldownsRellamado.set(mesa_id, ahora)

    // Evento ID determinístico por ventana de cooldown (evita duplicación si llegan ráfagas en milisegundos idénticos)
    const ventanaCooldown = Math.floor(ahora / 3000)
    const evento_id = `rellamado_${mesa_id}_${turno.id}_${ventanaCooldown}`
    const payloadRellamado = {
      evento_id,
      turno:       turno.numero,
      numero:      turno.numero,
      mesa_numero: turno.mesa_numero,
      mesa_nombre: turno.mesa_nombre,
      lote_numero: turno.numero_lote || null,
      origen:      turno.origen || 'voucher_fisico',
      llamado_en:  new Date().toISOString()
    }

    // Re-anunciar a la TV pública y canal de Kiosko de forma desacoplada post-respuesta
    setImmediate(async () => {
      try {
        const broadcastPromises = [
          fastify.broadcast('tv:global', 'turno_rellamado', payloadRellamado),
          fastify.broadcast('kiosko:publico', 'turno_rellamado', payloadRellamado),
          fastify.broadcast('admin:all', 'turno_rellamado', payloadRellamado),
          fastify.broadcast('admin:all', 'kpi_update', {
            mesa_id,
            turno_numero: turno.numero,
            tipo_evento: 'rellamado'
          }),
          fastify.broadcast(`mesa:${mesa_id}`, 'turno_rellamado', payloadRellamado),
          fastify.db.query(
            `INSERT INTO audit_log (mesa_id, turno_id, operador_id, accion, metadata_json, ip_origen)
             VALUES ($1, $2, $3, 'TURNO_RELLAMADO', $4, $5)`,
            [mesa_id, turno.id, operadorId, JSON.stringify({ numero: turno.numero, evento_id }), request.ip]
          )
        ]

        if (turno.token_consulta) {
          broadcastPromises.push(
            fastify.broadcast(`kiosko:${turno.token_consulta}`, 'tu_turno_llamado', {
              turno_id:    turno.id,
              numero:      turno.numero,
              mesa_numero: turno.mesa_numero,
              mesa_nombre: turno.mesa_nombre,
              llamado_en:  payloadRellamado.llamado_en,
              es_rellamado: true
            })
          )
        }

        await Promise.allSettled(broadcastPromises)
      } catch (err) {
        fastify.log.error({ err, mesa_id, turno_id: turno.id }, 'Error en broadcast de re-llamado')
      }
    })

    return reply.status(200).send({ message: 'Turno re-llamado con éxito', turno })
  })

  // ── GET /turnos/estado — Snapshot para reconexión WS (1 sola query consolidada) ─
  fastify.get('/estado', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: { mesa_id: { type: 'integer' } }
      }
    }
  }, async (request, reply) => {
    const mesaId = request.query.mesa_id || null

    // Exactamente 1 query consolidada a PostgreSQL (presupuesto 1 query)
    const { rows: [estadoData] } = await fastify.db.query(
      `SELECT
         (SELECT valor FROM configuracion WHERE clave = 'modo_generacion_turnos' LIMIT 1) AS modo_config,
         (SELECT row_to_json(l) FROM (
            SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado, estado
            FROM lotes_voucher WHERE estado = 'activo' LIMIT 1
          ) l) AS lote,
         (CASE WHEN $1::int IS NOT NULL THEN
            (SELECT row_to_json(m) FROM (
               SELECT id, numero, nombre, estado
               FROM mesas WHERE id = $1::int
             ) m)
          ELSE NULL END) AS mesa,
         (CASE WHEN $1::int IS NOT NULL THEN
            (SELECT row_to_json(t) FROM (
               SELECT id, numero, llamado_en, estado
               FROM turnos
               WHERE mesa_id = $1::int AND estado = 'en_atencion'
                 AND fecha_turno = fn_fecha_hoy()
               LIMIT 1
             ) t)
          ELSE NULL END) AS turno_actual,
         (CASE WHEN $1::int IS NOT NULL THEN
            (SELECT COUNT(*)::int
             FROM turnos
             WHERE mesa_id = $1::int AND estado = 'atendido' AND fecha_turno = fn_fecha_hoy()
            )
          ELSE 0 END) AS atendidos_hoy,
         (SELECT numero
          FROM turnos
          WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()
          ORDER BY sesion ASC, numero ASC LIMIT 1
         ) AS proximo_kiosko,
         (SELECT COUNT(*)::int
          FROM turnos
          WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()
         ) AS turnos_en_espera_kiosko,
         (SELECT json_agg(u) FROM (
            SELECT t.numero, m.numero AS mesa_numero, m.nombre AS mesa_nombre, t.llamado_en
            FROM turnos t
            JOIN mesas m ON t.mesa_id = m.id
            WHERE t.estado IN ('en_atencion', 'atendido')
              AND t.fecha_turno = fn_fecha_hoy()
            ORDER BY t.llamado_en DESC
            LIMIT 10
          ) u) AS ultimos_turnos`,
      [mesaId]
    )

    const modo = estadoData?.modo_config || 'voucher_fisico'
    const lote = estadoData?.lote || null
    let proximoNumero = null
    let vouchersRestantes = 0

    if (modo === 'kiosko_web') {
      proximoNumero = estadoData?.proximo_kiosko ?? null
      vouchersRestantes = estadoData?.turnos_en_espera_kiosko ?? 0
    } else {
      proximoNumero = lote && lote.ultimo_numero_llamado < lote.numero_hasta ? lote.ultimo_numero_llamado + 1 : null
      vouchersRestantes = lote ? Math.max(0, lote.numero_hasta - lote.ultimo_numero_llamado) : 0
    }

    return reply.send({
      modo,
      lote,
      mesa:               estadoData?.mesa || null,
      turno_actual:       estadoData?.turno_actual || null,
      atendidos_hoy:      estadoData?.atendidos_hoy || 0,
      ultimos_turnos:     estadoData?.ultimos_turnos || [],
      proximo_numero:     proximoNumero,
      vouchers_restantes: vouchersRestantes
    })
  })

  // ── POST /turnos/generar — Kiosko web (RF-GEN-02 con numeración propia) ───
  // Rate limit: 5 intentos por IP o dispositivo cada 3 segundos
  fastify.post('/generar', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '3 seconds',
        keyGenerator: (req) => `kiosko:${req.headers['x-device-id'] || req.ip}`,
        errorResponseBuilder: () => ({
          statusCode: 429,
          error: { codigo: 'espere_antes_de_reintentar', mensaje: 'Demasiadas solicitudes. Espere unos segundos antes de solicitar otro turno.' }
        })
      }
    }
  }, async (request, reply) => {
    const idempotencyKey = request.headers['idempotency-key'] || request.body?.idempotency_key
    const deviceId       = request.headers['x-device-id'] || request.body?.device_id
    const esTablet       = request.query?.modo === 'tablet' || request.body?.modo === 'tablet'

    const reqHost     = request.headers['x-forwarded-host'] || request.headers.host
    const reqProtocol = request.headers['x-forwarded-proto'] || (request.raw.socket.encrypted ? 'https' : 'http')

    const resultado = await generarTurnoKiosko(fastify, {
      ip: request.ip,
      idempotencyKey,
      deviceId,
      esTablet,
      reqHost,
      reqProtocol
    })

    setImmediate(async () => {
      try {
        const { rows: [esperaData] } = await fastify.db.query(
          `SELECT
             COUNT(*)::int AS count,
             (SELECT numero FROM turnos
              WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()
              ORDER BY sesion ASC, numero ASC LIMIT 1) AS proximo
           FROM turnos
           WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = fn_fecha_hoy()`
        )
        const enEspera = esperaData?.count || 0
        const proximo = esperaData?.proximo ?? null
        await Promise.allSettled([
          fastify.broadcast('admin:all', 'kiosko_turno_generado', {
            numero: resultado.numero,
            posicion: resultado.posicion_en_cola,
            turnos_en_espera: enEspera,
            proximo_numero: proximo
          }),
          fastify.broadcast('lote:activo', 'proximo_actualizado', {
            proximo_numero: proximo,
            vouchers_restantes: enEspera,
            modo: 'kiosko_web'
          }),
          fastify.broadcast('kiosko:publico', 'llamados', {
            proximo_numero: proximo,
            turnos_esperando: enEspera
          })
        ])
      } catch (wsErr) {
        fastify.log.warn({ wsErr }, 'Error emitiendo eventos tras generar turno kiosko')
      }
    })

    return reply.status(201).send(resultado)
  })

  // ── GET /turnos/mi-turno/:token — Consulta kiosko (RF-GEN-03) ─────────────
  // Cache Redis 4 segundos: multiples consultas del mismo estudiante = 1 query a BD
  fastify.get('/mi-turno/:token', {
    schema: {
      params: {
        type: 'object',
        properties: { token: { type: 'string', minLength: 64, maxLength: 64 } }
      }
    }
  }, async (request, reply) => {
    const token = request.params.token
    const cacheKey = `mi_turno:${token}`

    // Intentar servir desde cache Redis (TTL 4s)
    try {
      const cached = await fastify.redis.get(cacheKey)
      if (cached) {
        return reply.header('X-Cache', 'HIT').send(JSON.parse(cached))
      }
    } catch (_) { /* Redis fallo — continuar sin cache */ }

    const resultado = await consultarMiTurno(fastify, { token })

    // Guardar en cache 4 segundos (solo si el turno sigue en espera)
    if (resultado.estado === 'esperando') {
      try {
        await fastify.redis.set(cacheKey, JSON.stringify(resultado), 'EX', 4)
      } catch (_) {}
    }

    return reply.header('X-Cache', 'MISS').send(resultado)
  })

  // ── GET /turnos/historial — Últimos N turnos del día ──────────────────────
  fastify.get('/historial', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limite:   { type: 'integer', default: 20, minimum: 1, maximum: 100 },
          mesa_id:  { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    const { limite = 20, mesa_id } = request.query

    const params  = [limite]
    let whereClause = `WHERE t.creado_en >= date_trunc('day', NOW())`

    if (mesa_id) {
      params.push(mesa_id)
      whereClause += ` AND t.mesa_id = $${params.length}`
    }

    const { rows } = await fastify.db.query(
      `SELECT t.id, t.numero, t.estado, t.origen,
              t.llamado_en, t.finalizado_en,
              t.duracion_atencion_seg,
              m.numero AS mesa_numero, m.nombre AS mesa_nombre,
              u.nombre_completo AS operador_nombre
       FROM turnos t
       LEFT JOIN mesas m ON t.mesa_id = m.id
       LEFT JOIN usuarios u ON t.operador_id = u.id
       ${whereClause}
       ORDER BY t.llamado_en DESC NULLS LAST
       LIMIT $1`,
      params
    )

    return reply.send({ turnos: rows })
  })

  // ── GET /turnos/configuracion-publica — Parámetros públicos para TV y Kiosko ──
  fastify.get('/configuracion-publica', async (request, reply) => {
    const { rows } = await fastify.db.query(
      `SELECT clave, valor FROM configuracion WHERE clave IN ('voz_anuncio_activa', 'kiosko_web_activo', 'alerta_vouchers_restantes', 'tv_escala_turnos', 'tv_escala_principal', 'tv_escala_secundaria', 'fondo_imagen_url', 'fondo_imagen_activa', 'fondo_imagen_escala', 'tv_opacidad_principal', 'tv_opacidad_secundaria')`
    )
    const configMap = {
      voz_anuncio_activa: true,
      kiosko_web_activo: false,
      alerta_vouchers_restantes: 20,
      tv_escala_turnos: 100,
      tv_escala_principal: 100,
      tv_escala_secundaria: 100,
      fondo_imagen_url: '',
      fondo_imagen_activa: false,
      fondo_imagen_escala: 100,
      tv_opacidad_principal: 100,
      tv_opacidad_secundaria: 100
    }
    for (const r of rows) {
      if (r.clave === 'voz_anuncio_activa') configMap.voz_anuncio_activa = r.valor !== 'false'
      else if (r.clave === 'kiosko_web_activo') configMap.kiosko_web_activo = r.valor === 'true'
      else if (r.clave === 'alerta_vouchers_restantes') configMap.alerta_vouchers_restantes = parseInt(r.valor, 10) || 20
      else if (r.clave === 'tv_escala_turnos') configMap.tv_escala_turnos = parseInt(r.valor, 10) || 100
      else if (r.clave === 'tv_escala_principal') configMap.tv_escala_principal = parseInt(r.valor, 10) || 100
      else if (r.clave === 'tv_escala_secundaria') configMap.tv_escala_secundaria = parseInt(r.valor, 10) || 100
      else if (r.clave === 'fondo_imagen_url') configMap.fondo_imagen_url = r.valor || ''
      else if (r.clave === 'fondo_imagen_activa') configMap.fondo_imagen_activa = r.valor === 'true'
      else if (r.clave === 'fondo_imagen_escala') configMap.fondo_imagen_escala = parseInt(r.valor, 10) || 100
      else if (r.clave === 'tv_opacidad_principal') configMap.tv_opacidad_principal = parseInt(r.valor, 10) || 100
      else if (r.clave === 'tv_opacidad_secundaria') configMap.tv_opacidad_secundaria = parseInt(r.valor, 10) || 100
    }
    if (!rows.some(r => r.clave === 'tv_escala_principal')) {
      configMap.tv_escala_principal = configMap.tv_escala_turnos
    }
    if (!rows.some(r => r.clave === 'tv_escala_secundaria')) {
      configMap.tv_escala_secundaria = configMap.tv_escala_turnos
    }
    return reply.send(configMap)
  })
}

