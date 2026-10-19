/**
 * scripts/run_tests.js
 *
 * Ejecuta la suite completa de tests con reset de BD entre grupos
 * para evitar interferencia de estado entre tests que comparten BD.
 *
 * Uso: npm run test:suite
 */
'use strict'

const { execSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')

function run(cmd, label) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(` ${label}`)
  console.log('='.repeat(60))
  try {
    const out = execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    process.stdout.write(out)
    return true
  } catch (err) {
    process.stdout.write(err.stdout || '')
    process.stderr.write(err.stderr || '')
    return false
  }
}

function seed() {
  console.log('\n[RESET] Reseeding BD para el siguiente grupo...')
  execSync('node scripts/seed.js', { cwd: root, stdio: 'inherit' })
}

const results = []

// ── Tests sin servidor (siempre primero, no necesitan BD activa)
results.push({ name: 'offline-docker-audit', ok: run('node tests/offline-docker-audit.test.js', 'AUDITORIA OFFLINE Y DOCKER') })

// ── Grupo 1: Invariantes de BD y configuracion
seed()
results.push({ name: 'verificacion', ok: run('node tests/verificacion.test.js', 'INVARIANTES DE BD') })
results.push({ name: 'audit-acciones', ok: run('node tests/audit-acciones.test.js', 'ACCIONES AUDIT_LOG') })
results.push({ name: 'verificar-configuracion', ok: run('node tests/verificar-configuracion.test.js', 'CONFIGURACION ADMIN') })

// ── Grupo 2: Mesas y turnos
seed()
results.push({ name: 'verificar-turnos-mesas', ok: run('node tests/verificar-turnos-mesas.test.js', 'MESAS Y TURNOS HUERFANOS') })
results.push({ name: 'concurrent', ok: run('node tests/concurrent.test.js', 'CONCURRENCIA ATOMICA') })

// ── Grupo 3: Panel y TV en tiempo real
seed()
results.push({ name: 'panel-audit', ok: run('node tests/panel-audit.test.js', 'PANEL DE MESA AUDITORIA') })

// ── Grupo 4: TV
seed()
results.push({ name: 'tv-audit', ok: run('node tests/tv-audit.test.js', 'PANTALLA TV AUDITORIA') })
results.push({ name: 'verificar-escalas-tv', ok: run('node tests/verificar-escalas-tv.test.js', 'ESCALAS TV INDEPENDIENTES') })

// ── Grupo 5: WebSocket y estres
seed()
results.push({ name: 'ws-suite', ok: run('node tests/ws-suite.test.js', 'WEBSOCKET SUITE COMPLETA') })

// ── Grupo 6: Stress
seed()
results.push({ name: 'panel-tv-stress', ok: run('node tests/panel-tv-stress.test.js', 'ESTRES 10 MESAS + 2 TV') })

// ── Grupo 7: Rezagado
seed()
results.push({ name: 'atender-rezagado', ok: run('node tests/atender-rezagado.test.js', 'BOTON ATENDER REZAGADO') })

// ── Grupo 8: Verificacion final integral
seed()
results.push({ name: 'verificacion-final', ok: run('node tests/verificacion-final.test.js', 'VERIFICACION FINAL INTEGRAL') })

// ── Kiosko (informativo, depende de configuracion)
seed()
results.push({ name: 'kiosko [INFO]', ok: run('node tests/kiosko.test.js', 'KIOSKO (depende de kiosko_web_activo)') })

// ── Resumen
console.log('\n' + '='.repeat(60))
console.log(' RESUMEN FINAL')
console.log('='.repeat(60))
let passed = 0, failed = 0
for (const r of results) {
  const icon = r.ok ? '[OK]  ' : '[FAIL]'
  console.log(`  ${icon}  ${r.name}`)
  if (r.ok) passed++; else failed++
}
console.log(`\n  Total: ${passed} OK, ${failed} FAIL`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)