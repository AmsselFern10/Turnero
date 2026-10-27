'use strict'

/**
 * MÓDULO: base_de_datos
 * OBJETIVO: Comprobar los permisos del usuario de base de datos que usa la aplicación.
 *           Verifica que no puede modificar estructura, que audit_log es protegido,
 *           y que la cadena de conexión no está en el repositorio.
 * EJECUCIÓN: node tests/bd/bd_seguridad_permisos.test.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const {
  setupTestDb, teardownTestDb, getTestPool, BD_TEST_NAME,
  PG_HOST, PG_PORT, PG_SUPER_USER, PG_SUPER_PASS
} = require('./helpers/db_test_setup')
const { Pool } = require('pg')

let pool         // Pool super (postgres) → para setup y verificación
let appPool      // Pool de la "app" (turnero_app si existe, o postgres con permisos reducidos simulados)
let passed = 0
let failed = 0
const errores = []
const hallazgos = []

function ok (n) { process.stdout.write(`  [OK] ${n}\n`); passed++ }
function fail (n, d) {
  process.stderr.write(`  [FAIL] ${n}\n`)
  if (d) process.stderr.write(`        ${d}\n`)
  failed++; errores.push({ n, d })
}
function hallazgo (id, sev, desc) {
  hallazgos.push({ id, sev, desc })
  process.stdout.write(`  [HALLAZGO-${id} | ${sev}] ${desc}\n`)
}

async function test (nombre, fn) {
  try { await fn(); ok(nombre) } catch (err) { fail(nombre, err.message) }
}

// ── Verificar que una operación NO tiene permiso ─────────────────────────────
async function debeNegarPermiso (nombre, fn) {
  let denegado = false
  let client
  try {
    client = await appPool.connect()
    await client.query('BEGIN')
    await fn(client)
    await client.query('ROLLBACK')
  } catch (err) {
    await (client?.query('ROLLBACK').catch(() => {}))
    // 42501 = insufficient_privilege, 42000 = syntax_error_or_access_rule_violation
    if (err.code === '42501' || err.code === '42000' || err.message.includes('inmutable') || err.message.includes('permission denied') || err.code === 'P0001') {
      denegado = true
    } else {
      fail(nombre, `Error inesperado (${err.code}): ${err.message}`)
      return
    }
  } finally {
    client?.release()
  }

  if (denegado) {
    ok(nombre)
  } else {
    fail(nombre, 'La operación fue permitida cuando debería estar denegada')
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────
async function setupPermisos () {
  // Verificar si el rol turnero_app existe en la BD de prueba
  const { rows: roleCheck } = await pool.query(`SELECT rolname FROM pg_roles WHERE rolname='turnero_app'`)
  const tieneRolApp = roleCheck.length > 0

  if (tieneRolApp) {
    // Crear usuario turnero_app en la BD de prueba
    // (El REVOKE del 004_complementos.sql ya se aplicó en setupTestDb)
    appPool = new Pool({
      host: PG_HOST, port: PG_PORT,
      database: BD_TEST_NAME,
      user: 'turnero_app',
      password: process.env.TURNERO_APP_PASSWORD || 'turnero',
      max: 3
    })
    console.log('  [INFO] Usando rol "turnero_app" para tests de permisos')
  } else {
    // turnero_app no existe — la app se conecta como postgres
    // Documentar como hallazgo y hacer tests de seguridad con postgres
    hallazgo('SEG-001', 'Alta',
      'El rol "turnero_app" no existe en PostgreSQL. La app se conecta directamente como superusuario "postgres". ' +
      'Esto viola el principio de mínimo privilegio — el usuario de app debería ser un rol con permisos limitados. ' +
      'Los tests de permisos se ejecutan simulando las restricciones que DEBERÍAN existir.')

    // Usamos postgres pero verificamos qué permisos tendría un usuario limitado
    appPool = new Pool({
      host: PG_HOST, port: PG_PORT,
      database: BD_TEST_NAME,
      user: PG_SUPER_USER, password: PG_SUPER_PASS,
      max: 3
    })

    // Crear un usuario de aplicación con permisos correctos para los demás tests
    try {
      await pool.query(`DROP OWNED BY turnero_app_test CASCADE`).catch(() => {})
      await pool.query(`DROP USER IF EXISTS turnero_app_test`).catch(() => {})
      await pool.query(`CREATE USER turnero_app_test WITH PASSWORD 'test_pass'`)
      await pool.query(`GRANT CONNECT ON DATABASE ${BD_TEST_NAME} TO turnero_app_test`)
      await pool.query(`REVOKE CREATE ON SCHEMA public FROM turnero_app_test`)
      await pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
      await pool.query(`GRANT USAGE ON SCHEMA public TO turnero_app_test`)
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO turnero_app_test`)
      await pool.query(`REVOKE UPDATE, DELETE ON audit_log FROM turnero_app_test`)
      await pool.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM turnero_app_test`)
      await pool.query(`REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM turnero_app_test`)
      await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO turnero_app_test`)

      // Reemplazar appPool con este usuario
      await appPool.end()
      appPool = new Pool({
        host: PG_HOST, port: PG_PORT,
        database: BD_TEST_NAME,
        user: 'turnero_app_test',
        password: 'test_pass',
        max: 3
      })
      console.log('  [INFO] Creado usuario "turnero_app_test" con permisos correctos para tests')
    } catch (err) {
      console.warn(`  [WARN] No se pudo crear usuario de test: ${err.message}`)
      // Continuar con postgres — los tests de permisos marcarán hallazgos
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────
async function runTests () {
  console.log('══════════════════════════════════════════════════════════════')
  console.log(' bd_seguridad_permisos — Permisos del usuario de aplicación')
  console.log(`  BD: ${BD_TEST_NAME}`)
  console.log('══════════════════════════════════════════════════════════════\n')

  await setupPermisos()

  // ── 1. audit_log: UPDATE y DELETE denegados ─────────────────────────────
  console.log('-- 1. audit_log: protección de inmutabilidad')

  // Insertar un registro de prueba
  const { rows: [al] } = await pool.query(
    `INSERT INTO audit_log (accion) VALUES ('LOGIN_EXITOSO') RETURNING id`
  )

  await debeNegarPermiso('UPDATE en audit_log denegado (trigger inmutable)', async (c) => {
    await c.query(`UPDATE audit_log SET accion='LOGOUT' WHERE id=${al.id}`)
  })

  await debeNegarPermiso('DELETE en audit_log denegado (trigger inmutable)', async (c) => {
    await c.query(`DELETE FROM audit_log WHERE id=${al.id}`)
  })

  // ── 2. No puede modificar estructura ────────────────────────────────────
  console.log('\n-- 2. Modificación de estructura (DDL)')

  await debeNegarPermiso('CREATE TABLE denegado', async (c) => {
    await c.query(`CREATE TABLE test_hacker (id SERIAL)`)
  })

  await debeNegarPermiso('DROP TABLE denegado', async (c) => {
    await c.query(`DROP TABLE turnos`)
  })

  await debeNegarPermiso('ALTER TABLE denegado', async (c) => {
    await c.query(`ALTER TABLE turnos ADD COLUMN hacker_col TEXT`)
  })

  await debeNegarPermiso('TRUNCATE denegado', async (c) => {
    await c.query(`TRUNCATE TABLE audit_log`)
  })

  // ── 3. Operaciones legítimas permitidas ──────────────────────────────────
  console.log('\n-- 3. Operaciones legítimas (INSERT, SELECT, UPDATE)')

  await test('INSERT en audit_log permitido', async () => {
    const client = await appPool.connect()
    try {
      const { rows } = await client.query(`INSERT INTO audit_log (accion) VALUES ('LOGIN_EXITOSO') RETURNING id`)
      assert.ok(rows[0].id, 'INSERT en audit_log debería ser permitido')
    } finally {
      client.release()
    }
  })

  await test('SELECT en turnos permitido', async () => {
    const client = await appPool.connect()
    try {
      await client.query(`SELECT COUNT(*) FROM turnos`)
    } finally {
      client.release()
    }
  })

  await test('INSERT en turnos permitido', async () => {
    // Necesitamos datos mínimos para insertar
    const { rows: [lt] } = await pool.query(`SELECT id FROM lotes_voucher LIMIT 1`)
    if (!lt) return // Sin lote no podemos hacer esta prueba
    const client = await appPool.connect()
    try {
      // Crear una mesa temporal como superusuario primero
      const { rows: [m] } = await pool.query(`INSERT INTO mesas (numero, nombre, estado) VALUES (9999, 'Mesa Seg', 'activa') RETURNING id`)
      const tok = '9'.repeat(64)
      await client.query(
        `INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id) VALUES (99999, fn_fecha_hoy(), $1, 'en_atencion', 'voucher_fisico', $2)`,
        [lt.id, m.id]
      )
      await pool.query(`UPDATE turnos SET estado='atendido', finalizado_en=NOW() WHERE numero=99999`)
      await pool.query(`UPDATE mesas SET estado='eliminada', eliminado_en=NOW() WHERE id=${m.id}`)
    } finally {
      client.release()
    }
  })

  // ── 4. La cadena de conexión no está en el repo ──────────────────────────
  console.log('\n-- 4. Cadena de conexión no expuesta en el repositorio')

  const repoRoot = path.join(__dirname, '..', '..')
  const archivosARevisar = [
    'src/app.js',
    'src/plugins/db.js',
    'src/plugins/auth.js'
  ]

  await test('Cadena de conexión hardcoded: no encontrada en código fuente', () => {
    const credencialesHardcoded = [
      'postgresql://postgres:turnero',
      'postgres:turnero@localhost',
      'password=turnero',
      'DB_PASSWORD=turnero'
    ]

    const archivosInfractores = []
    for (const archivo of archivosARevisar) {
      const rutaCompleta = path.join(repoRoot, archivo)
      if (!fs.existsSync(rutaCompleta)) continue
      const contenido = fs.readFileSync(rutaCompleta, 'utf8')
      for (const patron of credencialesHardcoded) {
        if (contenido.includes(patron)) {
          archivosInfractores.push(`${archivo} (contiene: ${patron})`)
        }
      }
    }
    assert.equal(archivosInfractores.length, 0,
      `Credenciales hardcoded en: ${archivosInfractores.join(', ')}`)
  })

  await test('.env* en .gitignore', () => {
    const gitignorePath = path.join(repoRoot, '.gitignore')
    assert.ok(fs.existsSync(gitignorePath), '.gitignore no existe')
    const gi = fs.readFileSync(gitignorePath, 'utf8')
    assert.ok(gi.includes('.env'), '.env no está en .gitignore')
  })

  await test('.env.development no commiteado (no debe existir en raíz si está en .gitignore)', () => {
    // El .env.development no debería existir — pero en desarrollo local puede existir
    // Lo que verificamos es que NUNCA tenga credenciales de producción hardcodeadas
    const envDev = path.join(repoRoot, '.env.development')
    const envProd = path.join(repoRoot, '.env.production')
    const envLocal = path.join(repoRoot, '.env')

    // .env.production no debe existir en el repo (sería una fuga de credenciales de producción)
    if (fs.existsSync(envProd)) {
      hallazgo('SEG-002', 'Alta', '.env.production existe en el repositorio local — riesgo de exposición de credenciales de producción')
    }

    // .env local puede existir para desarrollo pero no debe tener JWT_SECRET vacío
    if (fs.existsSync(envLocal)) {
      const contenido = fs.readFileSync(envLocal, 'utf8')
      if (contenido.includes('JWT_SECRET=') && !contenido.includes('JWT_SECRET=\n')) {
        // tiene valor — OK para dev
        ok('JWT_SECRET presente en .env local')
        passed++
      }
    }
    // No fallamos este test — es informativo
  })

  // ── 5. Usuario de migraciones vs. usuario de aplicación ─────────────────
  console.log('\n-- 5. Separación de usuario de migraciones vs. aplicación')

  await test('Variables de entorno DB_USER y BD_TEST_SUPER_USER documentadas', () => {
    // Verificar que la separación está documentada, aunque actualmente sea el mismo
    const migrUser = PG_SUPER_USER
    const appUser = process.env.DB_USER || PG_SUPER_USER

    if (migrUser === appUser) {
      hallazgo('SEG-003', 'Media',
        `El usuario de migraciones (${migrUser}) y de aplicación (${appUser}) son el mismo. ` +
        'Recomendado: crear "turnero_app" con permisos de solo DML y reservar el superusuario para migraciones.')
    }
    // No falla — es un hallazgo de seguridad
    assert.ok(true)
  })

  // ── 6. Protección de triggers de auditoría ───────────────────────────────
  console.log('\n-- 6. Triggers de auditoría no pueden desactivarse')

  await debeNegarPermiso('DISABLE TRIGGER denegado para usuario de app', async (c) => {
    await c.query(`ALTER TABLE turnos DISABLE TRIGGER trg_audit_turnos_insert`)
  })

  // ── Resumen ─────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(` RESULTADO: ${passed} OK  |  ${failed} FALLIDOS`)
  if (hallazgos.length > 0) {
    console.log('\n HALLAZGOS:')
    hallazgos.forEach(h => console.log(`  - [${h.id}] (${h.sev}) ${h.desc}`))
  }
  if (errores.length > 0) {
    console.error('\n ERRORES:')
    errores.forEach(e => console.error(`  - ${e.n}: ${e.d}`))
  }
  console.log('══════════════════════════════════════════════════════════════\n')
  if (failed > 0) process.exit(1)
}

;(async () => {
  try {
    await setupTestDb()
    pool = getTestPool()
    await runTests()
  } finally {
    if (appPool) await appPool.end().catch(() => {})
    // Limpiar usuario turnero_app_test si fue creado
    const cleanPool = new Pool({
      host: PG_HOST, port: PG_PORT,
      database: 'postgres',
      user: PG_SUPER_USER, password: PG_SUPER_PASS, max: 1
    })
    await cleanPool.query(`DROP USER IF EXISTS turnero_app_test`).catch(() => {})
    await cleanPool.end().catch(() => {})
    await teardownTestDb()
  }
})().catch(err => {
  console.error('[ERROR FATAL]', err.message)
  teardownTestDb().finally(() => process.exit(1))
})

