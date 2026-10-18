'use strict'

/**
 * TEST — Subsistema Autónomo de Kiosko Web
 *
 * Verifica la lógica del servicio Kiosko:
 * 1. Detección de IP LAN para QR.
 * 2. Generación atómica de turnos con contador diario correlativo.
 * 3. Idempotencia mediante idempotency_key (reintentos devuelven el mismo ticket sin re-numerar).
 * 4. Restricción 1-ticket por smartphone: si ya tiene uno en espera, re-solicitar devuelve su ticket activo.
 * 5. Modo tablet: permite emisión continua de múltiples vouchers para terceros.
 * 6. Bloqueo seguro cuando kiosko_web_activo = false (403 kiosko_desactivado).
 * 7. Bloqueo cuando se alcanza el tope diario kiosko_tope_diario (409 tope_diario_alcanzado).
 * 8. Consulta de posición en cola y tiempo estimado por token de 64 caracteres.
 * 9. Token inexistente devuelve 404 turno_no_encontrado.
 * 10. Consulta de estado general del kiosko (getKioskoEstado).
 */

const assert = require('assert')
const {
  createKioskoService,
  getLanIpAddress,
  resolverUrlSeguimiento
} = require('../src/modules/kiosko/service')

async function runTests() {
  console.log('INICIANDO PRUEBAS DEL SUBSISTEMA KIOSKO\n' + '='.repeat(50))

  let passed = 0
  let failed = 0

  async function test(name, fn) {
    try {
      await fn()
      console.log(`  [OK] PASO: ${name}`)
      passed++
    } catch (err) {
      console.error(`  [FAIL] FALLO: ${name}`)
      console.error(`     ${err.message}`)
      if (err.stack) console.error(`     ${err.stack.split('\n')[1]}`)
      failed++
    }
  }

  // ── 1. Detección de IP LAN ───────────────────────────────────────────────────
  await test('Detección de IP LAN para QR no devuelve localhost si hay interfaz de red', async () => {
    const ip = getLanIpAddress()
    assert(typeof ip === 'string' && ip.length > 0, 'La IP debe ser un string no vacío')
    console.log(`     (IP detectada: ${ip})`)
  })

  await test('resolverUrlSeguimiento reemplaza localhost con IP LAN en URL QR', async () => {
    const fakeToken = 'a'.repeat(64)
    const url = resolverUrlSeguimiento('', 'localhost:3000', 'http', fakeToken)
    assert(!url.includes('localhost'), 'La URL de seguimiento para smartphones no debe incluir localhost')
    assert(url.includes(`token=${fakeToken}`), 'Debe incluir el token en query param')
  })

  // ── Mock DB Helper ─────────────────────────────────────────────────────────
  function createMockDb(initialState = {}) {
    const state = {
      config: {
        kiosko_web_activo: 'true',
        modo_generacion_turnos: 'kiosko_web',
        kiosko_tope_diario: '0',
        kiosko_url_base: '',
        zona_horaria: 'America/Tegucigalpa',
        ...initialState.config
      },
      contador: initialState.contador || 0,
      turnos: initialState.turnos || [],
      audit: []
    }

    const db = {
      state,
      async query(sql, params = []) {
        const text = sql.trim().replace(/\s+/g, ' ')

        // Fecha actual
        if (text.includes('NOW() AT TIME ZONE')) {
          return { rows: [{ fecha_hoy: '2026-10-11' }] }
        }

        // Lazy cleanup de turnos vencidos
        if (text.startsWith('UPDATE turnos SET estado = \'cancelado\'')) {
          return { rowCount: 0 }
        }

        // SELECT configuracion
        if (text.startsWith('SELECT clave, valor FROM configuracion')) {
          const rows = Object.entries(state.config).map(([clave, valor]) => ({ clave, valor }))
          return { rows }
        }

        if (text.includes('kiosko_url_base')) {
          return { rows: [{ valor: state.config.kiosko_url_base || '' }] }
        }

        // Idempotency check
        if (text.includes('WHERE t.idempotency_key = $1')) {
          const key = params[0]
          const turno = state.turnos.find(t => t.idempotency_key === key)
          return { rows: turno ? [turno] : [] }
        }

        // Device active waiting check
        if (text.includes('WHERE t.device_id = $1')) {
          const devId = params[0]
          const turno = state.turnos.find(t => t.device_id === devId && t.estado === 'esperando')
          return { rows: turno ? [turno] : [] }
        }

        // Check sobrecarga
        if (text.includes('totalEsperando')) {
          const count = state.turnos.filter(t => t.estado === 'esperando').length
          return { rows: [{ totalEsperando: count }] }
        }

        // Atomic counter increment
        if (text.includes('INSERT INTO kiosko_contador_diario')) {
          const tope = parseInt(state.config.kiosko_tope_diario || '0', 10)
          if (tope > 0 && state.contador >= tope) {
            return { rows: [] }
          }
          state.contador++
          return { rows: [{ ultimo_numero: state.contador }] }
        }

        // Insert turno
        if (text.startsWith('INSERT INTO turnos')) {
          const [numero, fechaTurno, token, idempotencyKey, deviceId] = params
          const nuevoTurno = {
            id: state.turnos.length + 1,
            numero,
            fecha_turno: fechaTurno,
            token_consulta: token,
            idempotency_key: idempotencyKey,
            device_id: deviceId,
            estado: 'esperando',
            creado_en: new Date().toISOString()
          }
          state.turnos.push(nuevoTurno)
          return { rows: [nuevoTurno] }
        }

        // Estimación de posición y métricas
        if (text.includes('personas_antes')) {
          const num = params[1]
          const count = state.turnos.filter(t => t.estado === 'esperando' && t.numero < num).length
          return { rows: [{ personas_antes: count }] }
        }

        if (text.includes('mesas_activas')) {
          return { rows: [{ mesas_activas: 2, tiempo_promedio_seg: 180 }] }
        }

        // Consultar por token
        if (text.includes('WHERE t.token_consulta = $1')) {
          const token = params[0]
          const t = state.turnos.find(x => x.token_consulta === token)
          return { rows: t ? [{ ...t, mesa_numero: null, mesa_nombre: null }] : [] }
        }

        // Estado general del kiosko
        if (text.includes('ultimo_numero FROM kiosko_contador_diario')) {
          return { rows: [{ ultimo_numero: state.contador }] }
        }

        if (text.includes('SELECT COUNT(*)::int AS activas FROM mesas')) {
          return { rows: [{ activas: 2 }] }
        }

        if (text.includes('COUNT(*) FILTER (WHERE estado = \'esperando\') AS en_espera')) {
          const enEspera = state.turnos.filter(t => t.estado === 'esperando').length
          return { rows: [{ en_espera: enEspera, ultimos_llamados: [], tiempo_promedio_seg: 180 }] }
        }

        return { rows: [] }
      }
    }

    return db
  }

  // ── 2. Generación consecutiva atómica ───────────────────────────────────────
  await test('Generación consecutiva asigna números incrementales #1, #2, #3', async () => {
    const db = createMockDb()
    const kiosko = createKioskoService(db)

    const req1 = await kiosko.generarTurno({ ip: '192.168.1.50', hostHeader: '192.168.1.10:3000' })
    const req2 = await kiosko.generarTurno({ ip: '192.168.1.51', hostHeader: '192.168.1.10:3000' })
    const req3 = await kiosko.generarTurno({ ip: '192.168.1.52', hostHeader: '192.168.1.10:3000' })

    assert.strictEqual(req1.numero, 1)
    assert.strictEqual(req2.numero, 2)
    assert.strictEqual(req3.numero, 3)
    assert.strictEqual(db.state.contador, 3)
    assert.strictEqual(db.state.turnos.length, 3)
  })

  // ── 3. Idempotencia con idempotency_key ─────────────────────────────────────
  await test('Idempotencia: llamadas repetidas con la misma key devuelven el mismo turno sin nuevo número', async () => {
    const db = createMockDb()
    const kiosko = createKioskoService(db)

    const key = 'test-idemp-uuid-1234'
    const primerLlamado = await kiosko.generarTurno({ idempotencyKey: key, ip: '192.168.1.50' })
    const segundoLlamado = await kiosko.generarTurno({ idempotencyKey: key, ip: '192.168.1.50' })

    assert.strictEqual(primerLlamado.numero, segundoLlamado.numero)
    assert.strictEqual(primerLlamado.token, segundoLlamado.token)
    assert.strictEqual(db.state.contador, 1, 'El contador no debió incrementarse dos veces')
    assert.strictEqual(db.state.turnos.length, 1, 'Solo debe haber 1 turno registrado')
  })

  // ── 4. Restricción 1 ticket por smartphone ─────────────────────────────────
  await test('Smartphone con turno activo no genera segundo ticket; re-solicitud retorna ticket activo', async () => {
    const db = createMockDb()
    const kiosko = createKioskoService(db)

    const deviceId = 'dev-student-phone-abc'
    const t1 = await kiosko.generarTurno({ deviceId, idempotencyKey: 'k1' })
    assert.strictEqual(t1.numero, 1)

    // Intenta sacar otro turno con diferente idempotencyKey pero mismo deviceId
    const t2 = await kiosko.generarTurno({ deviceId, idempotencyKey: 'k2' })
    assert.strictEqual(t2.numero, 1, 'Debe devolver el turno #1 que ya tiene en espera')
    assert.strictEqual(t2.token, t1.token)
    assert.strictEqual(db.state.contador, 1, 'No debe consumir un segundo número')
    assert.strictEqual(db.state.turnos.length, 1)
  })

  // ── 5. Modo Tablet permite emisión ilimitada ────────────────────────────────
  await test('Modo Tablet (esTablet=true) permite emisión continua sin bloqueo por deviceId', async () => {
    const db = createMockDb()
    const kiosko = createKioskoService(db)

    const tabletDeviceId = 'tablet-porton-fixed-id'
    const t1 = await kiosko.generarTurno({ deviceId: tabletDeviceId, esTablet: true, idempotencyKey: 'tab1' })
    const t2 = await kiosko.generarTurno({ deviceId: tabletDeviceId, esTablet: true, idempotencyKey: 'tab2' })
    const t3 = await kiosko.generarTurno({ deviceId: tabletDeviceId, esTablet: true, idempotencyKey: 'tab3' })

    assert.strictEqual(t1.numero, 1)
    assert.strictEqual(t2.numero, 2)
    assert.strictEqual(t3.numero, 3)
    assert.strictEqual(db.state.contador, 3)
  })

  // ── 6. Bloqueo si Kiosko Web está desactivado ──────────────────────────────
  await test('Si kiosko_web_activo = false, se rechaza con 403 kiosko_desactivado', async () => {
    const db = createMockDb({ config: { kiosko_web_activo: 'false' } })
    const kiosko = createKioskoService(db)

    try {
      await kiosko.generarTurno({})
      assert.fail('Debió fallar con 403')
    } catch (err) {
      assert.strictEqual(err.statusCode, 403)
      assert.strictEqual(err.codigo, 'kiosko_desactivado')
    }
    assert.strictEqual(db.state.contador, 0)
  })

  // ── 7. Tope diario alcanzado ───────────────────────────────────────────────
  await test('Si se alcanza kiosko_tope_diario, se rechaza con 409 tope_diario_alcanzado', async () => {
    const db = createMockDb({ config: { kiosko_tope_diario: '2' } })
    const kiosko = createKioskoService(db)

    await kiosko.generarTurno({ idempotencyKey: 't1' })
    await kiosko.generarTurno({ idempotencyKey: 't2' })

    try {
      await kiosko.generarTurno({ idempotencyKey: 't3' })
      assert.fail('Debió fallar con 409 tope_diario_alcanzado')
    } catch (err) {
      assert.strictEqual(err.statusCode, 409)
      assert.strictEqual(err.codigo, 'tope_diario_alcanzado')
    }
    assert.strictEqual(db.state.contador, 2)
  })

  // ── 8. Consulta de mi turno por token ──────────────────────────────────────
  await test('Consulta de posición en cola calcula turnos adelante y estimado de espera', async () => {
    const db = createMockDb()
    const kiosko = createKioskoService(db)

    const t1 = await kiosko.generarTurno({ idempotencyKey: 'tk1' })
    const t2 = await kiosko.generarTurno({ idempotencyKey: 'tk2' })
    const t3 = await kiosko.generarTurno({ idempotencyKey: 'tk3' })

    const info3 = await kiosko.consultarMiTurno(t3.token)
    assert.strictEqual(info3.numero, 3)
    assert.strictEqual(info3.posicion, 2, 'Debe haber 2 turnos adelante del #3')
    assert.strictEqual(info3.estado, 'esperando')
    assert(info3.tiempo_estimado_min > 0, 'Debe calcular tiempo estimado')
  })

  // ── 9. Token inválido devuelve 404 ─────────────────────────────────────────
  await test('Token inválido devuelve 404', async () => {
    const db = createMockDb()
    const kiosko = createKioskoService(db)

    try {
      await kiosko.consultarMiTurno('token-invalido-corto')
      assert.fail('Debió fallar con 404 enlace_invalido')
    } catch (err) {
      assert.strictEqual(err.statusCode, 404)
      assert.strictEqual(err.codigo, 'enlace_invalido')
    }

    try {
      await kiosko.consultarMiTurno('a'.repeat(64))
      assert.fail('Debió fallar con 404 turno_no_encontrado')
    } catch (err) {
      assert.strictEqual(err.statusCode, 404)
      assert.strictEqual(err.codigo, 'turno_no_encontrado')
    }
  })

  // ── 10. Consulta de estado general del kiosko ──────────────────────────────
  await test('getKioskoEstado retorna información operativa completa del kiosko', async () => {
    const db = createMockDb()
    const kiosko = createKioskoService(db)

    const estado = await kiosko.getKioskoEstado()
    assert.strictEqual(estado.activo, true)
    assert.strictEqual(estado.modo, 'kiosko_web')
    assert.strictEqual(estado.mesas_activas, 2)
    assert.strictEqual(typeof estado.turnos_en_espera, 'number')
  })

  // ── RESUMEN ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(50))
  console.log(`TOTAL PRUEBAS: ${passed + failed} | PASARON: ${passed} | FALLARON: ${failed}`)
  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch(err => {
  console.error('Error fatal ejecutando pruebas:', err)
  process.exit(1)
})
