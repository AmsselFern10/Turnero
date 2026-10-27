'use strict'

/**
 * HELPER: db_test_setup.js
 * OBJETIVO: Crear y destruir la base de datos de prueba desechable 'turnero_bd_test'.
 *           Nunca toca la BD de desarrollo (turnero) ni producción.
 *
 * SEGURO OBLIGATORIO:
 *   - El nombre de la BD de prueba DEBE terminar en '_test'
 *   - O la variable de entorno BD_TEST_SAFE=1 debe estar presente
 *   - Si ninguna condición se cumple, el proceso aborta con código 1
 *
 * USO:
 *   const { setupTestDb, teardownTestDb, getTestPool, BD_TEST_NAME } = require('./db_test_setup')
 *   await setupTestDb()      // crea BD y aplica migraciones
 *   const pool = getTestPool()
 *   ...
 *   await teardownTestDb()   // elimina BD de prueba (en finally)
 */

const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')

// ── Constantes de conexión ──────────────────────────────────────────────────
const BD_TEST_NAME  = process.env.BD_TEST_DB_NAME || 'turnero_bd_test'
const PG_HOST       = process.env.DB_HOST         || 'localhost'
const PG_PORT       = parseInt(process.env.DB_PORT_EXPOSED || '5432', 10)
const PG_SUPER_USER = process.env.BD_TEST_SUPER_USER || process.env.DB_USER || 'postgres'
const PG_SUPER_PASS = process.env.BD_TEST_SUPER_PASS || process.env.DB_PASSWORD || 'turnero'

// Pool de administración (conecta a 'postgres' para crear/destruir BDs)
let _adminPool = null
// Pool hacia la BD de prueba
let _testPool  = null

// ── Seguro obligatorio ──────────────────────────────────────────────────────
function verificarSeguro () {
  const esBdTest = BD_TEST_NAME.endsWith('_test')
  const bypassExplicito = process.env.BD_TEST_SAFE === '1'
  if (!esBdTest && !bypassExplicito) {
    console.error('═══════════════════════════════════════════════════════════════')
    console.error('[SEGURO] ABORTANDO: La BD de prueba debe terminar en "_test"')
    console.error(`         BD_TEST_DB_NAME="${BD_TEST_NAME}" no cumple la condicion.`)
    console.error('         Para omitir este control use BD_TEST_SAFE=1 (solo testing CI).')
    console.error('═══════════════════════════════════════════════════════════════')
    process.exit(1)
  }
  // Doble verificación: nunca la BD de desarrollo ni producción
  const bdsProhibidas = ['turnero', 'postgres', 'template0', 'template1', 'production', 'prod']
  if (bdsProhibidas.includes(BD_TEST_NAME.toLowerCase())) {
    console.error('[SEGURO] ABORTANDO: Nombre de BD prohibido:', BD_TEST_NAME)
    process.exit(1)
  }
}

// ── Crear BD de prueba desde cero ──────────────────────────────────────────
async function setupTestDb () {
  verificarSeguro()

  _adminPool = new Pool({
    host: PG_HOST, port: PG_PORT,
    database: 'postgres',
    user: PG_SUPER_USER, password: PG_SUPER_PASS,
    max: 3
  })

  // Eliminar si existe (por ejecución anterior fallida)
  await _adminPool.query(`DROP DATABASE IF EXISTS ${BD_TEST_NAME}`)
  await _adminPool.query(`CREATE DATABASE ${BD_TEST_NAME}`)

  // Conectar a la BD de prueba para aplicar migraciones
  _testPool = new Pool({
    host: PG_HOST, port: PG_PORT,
    database: BD_TEST_NAME,
    user: PG_SUPER_USER, password: PG_SUPER_PASS,
    max: 20
  })

  // Aplicar las 4 migraciones en orden
  const migrationsDir = path.join(__dirname, '..', '..', '..', 'migrations')
  const archivos = ['001_tablas_datos.sql', '002_indices.sql', '003_funciones_triggers.sql', '004_complementos.sql']

  for (const archivo of archivos) {
    const sqlPath = path.join(migrationsDir, archivo)
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Migracion no encontrada: ${sqlPath}`)
    }
    const sql = fs.readFileSync(sqlPath, 'utf8')
    await _testPool.query(sql)
  }

  // Insertar 1 usuario admin mínimo (requerido por FK en configuracion y seeds de tests)
  const bcrypt = require('bcrypt')
  const hash = await bcrypt.hash('Admin_Test_2026!', 10)
  await _testPool.query(`
    INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
    VALUES ('admin_test', 'Admin Test', $1, 'admin', true)
    ON CONFLICT DO NOTHING
  `, [hash])

  return _testPool
}

// ── Obtener pool de prueba ──────────────────────────────────────────────────
function getTestPool () {
  if (!_testPool) throw new Error('setupTestDb() debe llamarse antes de getTestPool()')
  return _testPool
}

// ── Destruir BD de prueba ───────────────────────────────────────────────────
async function teardownTestDb () {
  try {
    if (_testPool) {
      await _testPool.end()
      _testPool = null
    }
  } catch (_) { /* ignorar errores al cerrar */ }

  try {
    if (_adminPool) {
      // Terminar conexiones activas antes de DROP
      await _adminPool.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${BD_TEST_NAME}' AND pid <> pg_backend_pid()
      `)
      await _adminPool.query(`DROP DATABASE IF EXISTS ${BD_TEST_NAME}`)
      await _adminPool.end()
      _adminPool = null
    }
  } catch (err) {
    console.error('[CLEANUP] Error al destruir BD de prueba:', err.message)
  }
}

// ── Conexión directa (para un test que necesite su propio cliente) ──────────
function newTestClient () {
  return new Pool({
    host: PG_HOST, port: PG_PORT,
    database: BD_TEST_NAME,
    user: PG_SUPER_USER, password: PG_SUPER_PASS,
    max: 5
  })
}

module.exports = {
  setupTestDb,
  teardownTestDb,
  getTestPool,
  newTestClient,
  BD_TEST_NAME,
  PG_HOST,
  PG_PORT,
  PG_SUPER_USER,
  PG_SUPER_PASS
}
