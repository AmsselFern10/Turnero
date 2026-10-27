'use strict';

/**
 * ARCHIVO: scripts/run_tests.js
 * DESCRIPCIÓN: Suite principal de pruebas de integración y módulos del Turnero de Matrículas 2026.
 *              Ejecuta secuencialmente todos los grupos de pruebas con reset de base de datos
 *              entre módulos para asegurar aislamiento total de estado.
 * EJECUCIÓN: node scripts/run_tests.js
 *            npm run test:suite
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
results.push({ name: 'offline_docker_audit', ok: run('node tests/offline_docker_audit.test.js', 'AUDITORIA OFFLINE Y DOCKER') })

// ── Módulo 1: panel_mesa
seed()
results.push({ name: 'mesa_concurrencia_race_condition', ok: run('node tests/mesa_concurrencia_race_condition.test.js', 'CONCURRENCIA ATOMICA — RACE CONDITION') })
results.push({ name: 'mesa_acciones_snapshot_idempotencia', ok: run('node tests/mesa_acciones_snapshot_idempotencia.test.js', 'PANEL DE MESA — SNAPSHOT E IDEMPOTENCIA') })
results.push({ name: 'mesa_acciones_rellamar', ok: run('node tests/mesa_acciones_rellamar.test.js', 'PANEL DE MESA — RELLAMAR A TV') })
results.push({ name: 'mesa_acciones_rezagados', ok: run('node tests/mesa_acciones_rezagados.test.js', 'BOTON ATENDER REZAGADO') })
results.push({ name: 'mesa_acciones_doble_clic', ok: run('node tests/mesa_acciones_doble_clic.test.js', 'PANEL — PROTECCIÓN ANTI-DOBLE-CLIC') })
results.push({ name: 'mesa_acciones_cancelar', ok: run('node tests/mesa_acciones_cancelar.test.js', 'PANEL — CANCELAR TURNO (NO SE PRESENTÓ)') })
results.push({ name: 'mesa_ws_reconexion_panel', ok: run('node tests/mesa_ws_reconexion_panel.test.js', 'PANEL — RECONEXIÓN WS Y SNAPSHOT') })
results.push({ name: 'mesa_lote_ciclo_completo', ok: run('node tests/mesa_lote_ciclo_completo.test.js', 'PANEL — CICLO LOTE + MODOS KIOSKO') })
results.push({ name: 'mesa_flujo_combinado_fifo_tv', ok: run('node tests/mesa_flujo_combinado_fifo_tv.test.js', 'FLUJO COMBINADO FIFO + TV') })
results.push({ name: 'mesa_estres_carga_masiva', ok: run('node tests/mesa_estres_carga_masiva.test.js', 'ESTRES 20 MESAS + 4 TV') })

// ── Módulo 2: tv_pantalla_publica
seed()
results.push({ name: 'tv_flujo_orden_turnos', ok: run('node tests/tv_flujo_orden_turnos.test.js', 'TV — FLUJO Y ORDEN DE TURNOS') })
results.push({ name: 'tv_sistema_sonido', ok: run('node tests/tv_sistema_sonido.test.js', 'TV — SISTEMA DE SONIDO Y VOZ') })
results.push({ name: 'tv_sincronizacion_historial', ok: run('node tests/tv_sincronizacion_historial.test.js', 'TV — HISTORIAL Y RECONEXIÓN') })

// ── Módulo 3: index_autenticacion_seguridad
seed()
results.push({ name: 'auth_acceso_y_mesas', ok: run('node tests/auth_acceso_y_mesas.test.js', 'AUTH — ACCESO Y MESAS') })
results.push({ name: 'auth_seguridad_rbac_sesiones', ok: run('node tests/auth_seguridad_rbac_sesiones.test.js', 'AUTH — SEGURIDAD RBAC Y SESIONES') })

// ── Módulo 4: kiosko_autonomo
seed()
results.push({ name: 'kiosko_emision_turnos', ok: run('node tests/kiosko_emision_turnos.test.js', 'KIOSKO — EMISIÓN DE TURNOS') })
results.push({ name: 'kiosko_seguimiento_tracking', ok: run('node tests/kiosko_seguimiento_tracking.test.js', 'KIOSKO — SEGUIMIENTO Y TRACKING') })
results.push({ name: 'kiosko_impresion_tickets', ok: run('node tests/kiosko_impresion_tickets.test.js', 'KIOSKO — IMPRESIÓN DE TICKETS') })

// ── Módulo 5: admin_gestion
seed()
results.push({ name: 'admin_monitoreo_en_vivo', ok: run('node tests/admin_monitoreo_en_vivo.test.js', 'ADMIN — MONITOREO EN VIVO') })
results.push({ name: 'admin_configuracion_tv', ok: run('node tests/admin_configuracion_tv.test.js', 'ADMIN — CONFIGURACIÓN TV') })
results.push({ name: 'admin_ciclo_vida_entidades', ok: run('node tests/admin_ciclo_vida_entidades.test.js', 'ADMIN — CICLO DE VIDA ENTIDADES') })
results.push({ name: 'admin_configuracion_sistema', ok: run('node tests/admin_configuracion_sistema.test.js', 'ADMIN — CONFIGURACIÓN SISTEMA') })
results.push({ name: 'admin_invariantes_bd', ok: run('node tests/admin_invariantes_bd.test.js', 'ADMIN — INVARIANTES BD') })
results.push({ name: 'admin_audit_acciones', ok: run('node tests/admin_audit_acciones.test.js', 'ADMIN — AUDIT ACCIONES') })

// ── Módulos complementarios de infraestructura
seed()
results.push({ name: 'ws_suite', ok: run('node tests/ws_suite.test.js', 'WEBSOCKET SUITE COMPLETA') })
results.push({ name: 'admin_integracion_global', ok: run('node tests/admin_integracion_global.test.js', 'VERIFICACIÓN FINAL INTEGRAL GLOBAL') })

// ── Módulo 6: tiempo_real, pgbouncer, reconexión y sesiones
seed()
results.push({ name: 'ws_canales_contrato', ok: run('node tests/ws_canales_contrato.test.js', 'TIEMPO REAL — CANALES Y CONTRATO') })
results.push({ name: 'pgbouncer_resiliencia', ok: run('node tests/pgbouncer_resiliencia.test.js', 'PGBOUNCER — RESILIENCIA Y POOL') })
results.push({ name: 'reconexion_jitter', ok: run('node tests/reconexion_jitter.test.js', 'RECONEXIÓN — JITTER Y RECUPERACIÓN') })
results.push({ name: 'auth_romper_sesiones', ok: run('node tests/auth_romper_sesiones.test.js', 'AUTH — ROMPER SESIONES Y SEGURIDAD') })

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