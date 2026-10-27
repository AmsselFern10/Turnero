'use strict';

/**
 * ARCHIVO: scripts/run_rt_tests.js
 * DESCRIPCIÓN: Ejecuta la suite de pruebas de tiempo real, PgBouncer, reconexión con jitter
 *              y seguridad de sesiones sobre el servidor y PostgreSQL/PgBouncer/Redis.
 * EJECUCIÓN: node scripts/run_rt_tests.js
 *            npm run test:rt
 */

const { execSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')

const tests = [
  {
    file: 'tests/ws_canales_contrato.test.js',
    nombre: '1. Canales WS — Contrato, IDOR y Ataques de Stress'
  },
  {
    file: 'tests/pgbouncer_resiliencia.test.js',
    nombre: '2. PgBouncer — Compatibilidad, Pool y Concurrencia'
  },
  {
    file: 'tests/reconexion_jitter.test.js',
    nombre: '3. Reconexión — Jitter, Recuperación y Cortes'
  },
  {
    file: 'tests/auth_romper_sesiones.test.js',
    nombre: '4. Auth Sesiones — Sesión Única, Limpieza y Ataques'
  }
]

console.log('══════════════════════════════════════════════════════════════')
console.log('   SUITE DE PRUEBAS — TIEMPO REAL, PGBOUNCER, RECONEXIÓN     ')
console.log('══════════════════════════════════════════════════════════════')

let totalPassed = 0
let totalFailed = 0
const fallidos = []

for (const t of tests) {
  console.log(`\n>>> Ejecutando: ${t.nombre}...`)
  try {
    execSync(`node ${t.file}`, {
      cwd: root,
      stdio: 'inherit',
      timeout: 120_000 // 2 minutos máximo por test
    })
    totalPassed++
  } catch (err) {
    totalFailed++
    fallidos.push(t.nombre)
  }
}

console.log('\n══════════════════════════════════════════════════════════════')
console.log(` RESUMEN FINAL SUITE RT: ${totalPassed}/${tests.length} ARCHIVOS EXITOSOS`)
if (totalFailed > 0) {
  console.error(` ARCHIVOS CON FALLAS (${totalFailed}):`)
  fallidos.forEach(f => console.error(`   - ${f}`))
  process.exit(1)
} else {
  console.log(' ¡TODAS LAS PRUEBAS DE TIEMPO REAL PASARON SATISFACTORIAMENTE!')
  process.exit(0)
}

