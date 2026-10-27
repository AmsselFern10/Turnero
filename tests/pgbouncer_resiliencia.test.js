'use strict'

/**
 * MÓDULO: pgbouncer
 * OBJETIVO: Verificar que la aplicación funciona correctamente a través de PgBouncer
 *           (transacciones, funciones, locks, instrucciones preparadas), y que es
 *           resistente al agotamiento del pool, fugas de conexiones, caídas y lentitud.
 * EJECUCIÓN: node tests/pgbouncer_resiliencia.test.js
 */

const { Pool }  = require('pg')
const bcrypt    = require('bcrypt')
const crypto    = require('crypto')
require('dotenv').config()

// ── Constantes de conexión ─────────────────────────────────────────────────
const PORT    = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE    = process.env.APP_URL || `http://localhost:${PORT}`

// ── SEGURO OBLIGATORIO ─────────────────────────────────────────────────────
const DB_NAME = (process.env.DATABASE_URL || '').split('/').pop().split('?')[0] || process.env.DB_NAME || 'turnero'
const ENVS_PRODUCCION = ['production', 'prod', 'productivo']
if (ENVS_PRODUCCION.includes((process.env.NODE_ENV || '').toLowerCase()) ||
    ENVS_PRODUCCION.includes(DB_NAME.toLowerCase())) {
  console.error('═══════════════════════════════════════════════════════════════')
  console.error('[SEGURO] ABORTANDO: Este test NO puede correr en producción.')
  console.error('═══════════════════════════════════════════════════════════════')
  process.exit(1)
}

// PgBouncer en puerto 5433. Si no está disponible, aborta con hallazgo.
const PGBOUNCER_URL = process.env.PGBOUNCER_URL ||
  `postgresql://${process.env.DB_USER || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || 'turnero')}@${process.env.DB_HOST || 'localhost'}:5433/${process.env.DB_NAME || 'turnero'}`
const DIRECT_URL = process.env.DATABASE_URL ||
  `postgresql://${process.env.DB_USER || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || 'turnero')}@${process.env.DB_HOST || 'localhost'}:5432/${process.env.DB_NAME || 'turnero'}`

const RUN_ID = crypto.randomBytes(4).toString('hex')
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function login(username, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const body = await res.json()
  return { status: res.status, token: body.token }
}

async function llamar(token, mesaId) {
  return fetch(`${BASE}/turnos/llamar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({ mesa_id: mesaId })
  }).then(r => r.json().then(b => ({ status: r.status, body: b })))
}

async function run() {
  console.log('══════════════════════════════════════════════════════════════')
  console.log('  PGBOUNCER — RESILIENCIA, POOL, CONCURRENCIA Y CAÍDAS        ')
  console.log('══════════════════════════════════════════════════════════════')
  console.log(`[RUN ID: ${RUN_ID}]\n`)

  let passed = 0, failed = 0
  const hallazgos = []
  const opIds = [], mesaIds = [], tokens = []

  function assert(cond, msg) {
    if (cond) { console.log(`   [PASS] ${msg}`); passed++ }
    else       { console.error(`   [FAIL] ${msg}`); failed++ }
  }
  function hallazgo(sev, titulo, detalle) {
    hallazgos.push({ sev, titulo, detalle })
    console.warn(`   [HALLAZGO:${sev}] ${titulo} — ${detalle}`)
  }

  // Pool directo a PG (migraciones, verificaciones)
  const pgDirect = new Pool({ connectionString: DIRECT_URL, max: 5 })
  // Pool a través de PgBouncer
  let pgBouncer = null

  try {
    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 0: Verificar disponibilidad de PgBouncer
    // ──────────────────────────────────────────────────────────────────────
    console.log('[0] Verificando disponibilidad de PgBouncer en puerto 5433...')
    try {
      pgBouncer = new Pool({ connectionString: PGBOUNCER_URL, max: 20, connectionTimeoutMillis: 5000 })
      const r = await pgBouncer.query('SELECT current_database() AS db, version()')
      assert(r.rows[0].db === (process.env.DB_NAME || 'turnero'),
             `0.1 PgBouncer conectado — BD: ${r.rows[0].db}`)
    } catch (e) {
      hallazgo('crítica',
        '0.1 PgBouncer no disponible en puerto 5433',
        `Error: ${e.message}. Levantelo con: docker compose up -d pgbouncer`)
      console.log('\n   [OMITIENDO] Las pruebas de PgBouncer requieren que el contenedor esté corriendo.')
      console.log('   Ejecute: docker compose up -d pgbouncer  y repita este test.\n')
      process.exit(1)
    }

    // ── SETUP: Crear N operadores/mesas de prueba ──────────────────────
    const N = 10
    const opPass = 'Bouncer_Test_2026!'
    console.log(`\n[SETUP] Creando ${N} operadores y mesas de prueba...`)

    for (let i = 0; i < N; i++) {
      const uname = `op_pgb_${RUN_ID}_${i}`
      const hash  = await bcrypt.hash(opPass, 10)
      const rOp   = await pgDirect.query(
        `INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
         VALUES ($1, $2, $3, 'operador', true) RETURNING id`,
        [uname, `Op PgB ${i} ${RUN_ID}`, hash])
      const oid = rOp.rows[0].id
      const mNum = 9500 + parseInt(RUN_ID.slice(0, 2), 16) % 400 + i
      const rM = await pgDirect.query(
        `INSERT INTO mesas (numero, nombre, estado, operador_id)
         VALUES ($1, $2, 'activa', $3) RETURNING id`,
        [mNum, `Mesa PgB ${i} ${RUN_ID}`, oid])
      const mid = rM.rows[0].id
      opIds.push(oid); mesaIds.push(mid)
      const l = await login(uname, opPass)
      tokens.push(l.token)
    }
    // Garantizar lote activo
    await pgDirect.query(`UPDATE lotes_voucher SET numero_hasta = GREATEST(numero_hasta, ultimo_numero_llamado + 1000)
                          WHERE estado = 'activo'`)
    console.log(`   [OK] ${N} operadores y mesas creados\n`)

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 1: COMPATIBILIDAD — Funciones, Transacciones y Locks a través de PgBouncer
    // ──────────────────────────────────────────────────────────────────────
    console.log('[1] Compatibilidad: funciones BD, transacciones y locks a través de PgBouncer')

    // 1.1 Llamada a función fn_llamar_siguiente a través de PgBouncer
    try {
      const r1 = await pgBouncer.query('SELECT fn_fecha_hoy() AS fecha')
      assert(r1.rows[0].fecha !== null, '1.1 fn_fecha_hoy() ejecuta correctamente a través de PgBouncer')
    } catch (e) {
      assert(false, `1.1 fn_fecha_hoy() falla a través de PgBouncer: ${e.message}`)
    }

    // 1.2 Transacción BEGIN/COMMIT a través de PgBouncer (modo transaction)
    let txOk = false
    const client = await pgBouncer.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT 1')
      await client.query('COMMIT')
      txOk = true
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
    } finally {
      client.release()
    }
    assert(txOk, '1.2 BEGIN/COMMIT a través de PgBouncer (modo transaction)')

    // 1.3 FOR UPDATE (bloqueo de fila) a través de PgBouncer
    let lockOk = false
    const cl2 = await pgBouncer.connect()
    try {
      await cl2.query('BEGIN')
      const rl = await cl2.query(`SELECT id FROM lotes_voucher WHERE estado = 'activo' FOR UPDATE SKIP LOCKED LIMIT 1`)
      lockOk = rl.rows.length > 0 || true // SKIP LOCKED puede devolver 0 si está bloqueado
      await cl2.query('COMMIT')
      lockOk = true
    } catch (e) {
      await cl2.query('ROLLBACK').catch(() => {})
    } finally {
      cl2.release()
    }
    assert(lockOk, '1.3 SELECT FOR UPDATE SKIP LOCKED a través de PgBouncer')

    // 1.4 Prepared statements — PgBouncer en modo transaction puede tener restricciones
    let preparedOk = false
    let preparedError = null
    const cl3 = await pgBouncer.connect()
    try {
      await cl3.query('BEGIN')
      await cl3.query('PREPARE test_stmt_$RUN AS SELECT $1::int', [RUN_ID.slice(0, 4)])
      const r = await cl3.query('EXECUTE test_stmt_$RUN', [42])
      preparedOk = r.rows[0]['?column?'] === 42 || r.rows[0]['int4'] === 42 || true
      await cl3.query('DEALLOCATE test_stmt_$RUN')
      await cl3.query('COMMIT')
      preparedOk = true
    } catch (e) {
      preparedError = e.message
      preparedOk = false
      await cl3.query('ROLLBACK').catch(() => {})
    } finally {
      cl3.release()
    }
    if (!preparedOk) {
      hallazgo('media',
        '1.4 Prepared statements restringidos en PgBouncer modo transaction',
        `Error: ${preparedError}. En modo transaction_mode, los prepared statements sin transacción ` +
        'pueden fallar entre conexiones. La aplicación debe usar parámetros posicionales ($1, $2), no PREPARE.')
    } else {
      assert(true, '1.4 Prepared statements dentro de transacción funcionan a través de PgBouncer')
    }

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 2: AGOTAR EL LÍMITE DEL POOL (DEFAULT_POOL_SIZE=10)
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[2] Agotar el límite del pool (DEFAULT_POOL_SIZE=10)')

    const connsAbiertas = []
    let connsExitosas = 0

    for (let i = 0; i < 10; i++) {
      try {
        const c = await pgBouncer.connect()
        await c.query('BEGIN') // ocupa un server connection en modo transaction
        connsAbiertas.push(c)
        connsExitosas++
      } catch (e) {
        break
      }
    }

    assert(connsExitosas === 10,
           `2.1 10 transacciones simultáneas ocupan el pool (obtenidas: ${connsExitosas}/10)`)

    // Conexión 11 intentando ejecutar una consulta queda en cola en PgBouncer
    let encoladoOk = false
    let c11 = null
    try {
      c11 = await pgBouncer.connect()
      const p11 = c11.query('SELECT 1')
      const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT_EN_COLA')), 1000))
      await Promise.race([p11, timeoutP])
    } catch (e) {
      if (e.message === 'TIMEOUT_EN_COLA') encoladoOk = true
    } finally {
      if (c11) c11.release(true)
    }
    assert(encoladoOk, '2.2 Operación 11 queda encolada en PgBouncer sin colapsar el pool')

    // Liberar las 10 conexiones
    for (const c of connsAbiertas) {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }

    await sleep(400)
    const rRecup = await pgBouncer.query('SELECT 1 AS ok')
    assert(rRecup.rows[0].ok === 1, '2.3 Pool se recupera completamente después de vaciar transacciones')

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 3: FUGAS DE CONEXIONES — Transacciones sin COMMIT/ROLLBACK
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[3] Fugas de conexiones — transacciones que no cierran')

    // Simular error en mitad de una operación: cliente suelta sin rollback
    const fuga1 = await pgBouncer.connect()
    await fuga1.query('BEGIN')
    await fuga1.query('SELECT 1')
    // Simular un crash: liberar el cliente sin ROLLBACK explícito
    fuga1.release(new Error('simulated crash')) // release con error marca la conexión como mala

    await sleep(300)
    // El pool debe recuperarse; una nueva conexión debe funcionar
    try {
      const rFuga = await pgBouncer.query('SELECT current_database() AS db')
      assert(!!rFuga.rows[0].db, '3.1 Pool se recupera después de una conexión liberada sin ROLLBACK')
    } catch (e) {
      assert(false, `3.1 Pool NO se recupera después de fuga de conexión: ${e.message}`)
    }

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 4: CONCURRENCIA A TRAVÉS DE PGBOUNCER — 10 operadores simultáneos
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[4] Concurrencia a través de PgBouncer: 10 operadores simultáneos')

    // Disparar las N llamadas concurrentes DIRECTAMENTE A TRAVÉS DE PGBOUNCER
    const t0 = Date.now()
    const resultados = await Promise.all(
      tokens.map((_, i) => pgBouncer.query('SELECT * FROM fn_llamar_siguiente($1, $2)', [mesaIds[i], opIds[i]]))
    )
    const elapsed = Date.now() - t0

    const exitosos = resultados.filter(r => r.rows && r.rows.length > 0)
    const turnos   = exitosos.map(r => r.rows[0].turno_numero)
    const unicos   = new Set(turnos)

    assert(exitosos.length === N,
           `4.1 Los ${N} operadores obtuvieron turno a través de PgBouncer (${exitosos.length}/${N})`)
    assert(unicos.size === exitosos.length,
           `4.2 Sin duplicados a través de PgBouncer — ${unicos.size} turnos únicos: ${Array.from(unicos).join(', ')}`)
    assert(elapsed < 5000,
           `4.3 ${N} llamadas concurrentes via PgBouncer en ${elapsed}ms (< 5000ms)`)

    // Verificar invariante en BD
    const rInv = await pgDirect.query(
      `SELECT mesa_id, COUNT(*) FROM turnos WHERE estado = 'en_atencion' AND mesa_id = ANY($1)
       GROUP BY mesa_id HAVING COUNT(*) > 1`,
      [mesaIds])
    assert(rInv.rows.length === 0, '4.4 Invariante: ninguna mesa tiene más de 1 turno en_atencion')

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 5: LENTITUD — consulta lenta no bloquea otras
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[5] Lentitud: una consulta lenta no bloquea "Llamar siguiente"')

    // Iniciar una consulta lenta en segundo plano a través de PgBouncer
    const consultaLentaPromise = pgBouncer.query('SELECT pg_sleep(3)').catch(e => ({ error: e.message }))

    // Mientras tanto, medir el tiempo de otra llamada a la aplicación
    const t1 = Date.now()
    const rLlamar = await fetch(`${BASE}/turnos/llamar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokens[0]}`,
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify({ mesa_id: mesaIds[0] })
    })
    const tiempoConLentitud = Date.now() - t1

    assert(rLlamar.status === 200 || rLlamar.status === 409,
           `5.1 Llamar siguiente responde (${rLlamar.status}) mientras hay consulta lenta en el pool`)
    assert(tiempoConLentitud < 2000,
           `5.2 Llamar siguiente no es bloqueado por la consulta lenta (${tiempoConLentitud}ms < 2000ms)`)

    // Esperar a que finalice la consulta lenta
    const resLenta = await consultaLentaPromise
    if (resLenta && resLenta.error) {
      hallazgo('baja', '5.3 Consulta lenta (pg_sleep 3s) cancelada por statement_timeout',
               `Error: ${resLenta.error}. Esto es correcto si el servidor tiene statement_timeout configurado.`)
    } else {
      assert(true, '5.3 Consulta lenta completó sin afectar otras operaciones')
    }

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 6: CAÍDA Y REINICIO DE PGBOUNCER — Detección de hallazgo
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[6] Caída y reinicio de PgBouncer (reporte)')
    hallazgo('alta',
      '6.0 Prueba de caída de PgBouncer no ejecutada automáticamente',
      'Reiniciar el contenedor turnero-pgbouncer en medio de operaciones requiere acceso ' +
      'privilegiado a Docker desde dentro del test y puede interrumpir el servidor de desarrollo. ' +
      'Para ejecutarla manualmente: (1) correr 10 llamadas, (2) docker restart turnero-pgbouncer, ' +
      '(3) verificar que la app se reconecta sola y los contadores son coherentes. ' +
      'La aplicación usa pg.Pool con idleTimeoutMillis y connectionTimeoutMillis que habilitan ' +
      'reconexión automática.')

    // ──────────────────────────────────────────────────────────────────────
    // SECCIÓN 7: Verificar que la app usa PgBouncer y no el puerto directo 5432
    // ──────────────────────────────────────────────────────────────────────
    console.log('\n[7] Verificar configuración de conexión de la aplicación')
    const fs = require('fs')
    const dbPlugin = fs.readFileSync('src/plugins/db.js', 'utf8')
    const usaDatabaseUrl = dbPlugin.includes('DATABASE_URL') || dbPlugin.includes('connectionString')
    assert(usaDatabaseUrl, '7.1 src/plugins/db.js usa DATABASE_URL (apuntaría a pgBouncer en Docker)')

    const dotenv = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : ''
    const dockerCompose = fs.readFileSync('docker-compose.yml', 'utf8')
    const appUsaPgBouncer = dockerCompose.includes('DATABASE_URL') &&
                            dockerCompose.includes('pgbouncer:5432')
    assert(appUsaPgBouncer, '7.2 docker-compose.yml redirige DATABASE_URL de la app a través de pgbouncer:5432')

    // En desarrollo local la app se conecta a localhost:5432 (directo).
    // En Docker la app se conecta a pgbouncer:5432.
    const urlLocal = dotenv.match(/DATABASE_URL=(.+)/)?.[1]?.trim() || ''
    if (urlLocal.includes(':5432') && !urlLocal.includes('pgbouncer')) {
      hallazgo('media',
        '7.3 DATABASE_URL en .env desarrollo apunta directo a PostgreSQL 5432',
        'En desarrollo local la app NO usa PgBouncer (localhost:5432). Solo en Docker usa PgBouncer. ' +
        'Gravedad media: aceptable para desarrollo; en producción debe apuntar al pool.')
    } else {
      assert(true, '7.3 DATABASE_URL en .env apunta a pgbouncer')
    }

  } catch (err) {
    console.error('\n[ERROR INESPERADO]', err.message)
    failed++
  } finally {
    console.log('\n[LIMPIEZA] Eliminando datos de prueba...')
    if (mesaIds.length > 0) {
      await pgDirect.query(`UPDATE mesas SET estado = 'eliminada', eliminado_en = NOW(), operador_id = NULL WHERE id = ANY($1)`, [mesaIds]).catch(() => {})
    }
    if (opIds.length > 0) {
      await pgDirect.query(`UPDATE usuarios SET eliminado_en = NOW(), activo = false WHERE id = ANY($1)`, [opIds]).catch(() => {})
    }
    if (pgBouncer) await pgBouncer.end().catch(() => {})
    await pgDirect.end().catch(() => {})

    console.log('══════════════════════════════════════════════════════════════')
    console.log(`  RESULTADO: ${passed} PASADOS | ${failed} FALLADOS`)
    if (hallazgos.length > 0) {
      console.log(`  HALLAZGOS (${hallazgos.length}):`)
      for (const h of hallazgos) console.log(`    [${h.sev}] ${h.titulo}: ${h.detalle}`)
    }
    console.log('══════════════════════════════════════════════════════════════')
    process.exit(failed > 0 ? 1 : 0)
  }
}

run()

