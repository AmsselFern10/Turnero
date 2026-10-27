'use strict';

/**
 * ARCHIVO: scripts/run_bd_tests.js
 * DESCRIPCIÓN: Ejecutor de la suite completa de pruebas de base de datos (módulo: base_de_datos).
 *              Corre los 7 archivos de pruebas contra una base de datos desechable e independiente
 *              (turnero_bd_test) garantizando contratos de esquema, invariantes, funciones, caos y volumen.
 * EJECUCIÓN: node scripts/run_bd_tests.js
 *            npm run test:bd
 */

const { execSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')

const tests = [
  { file: 'tests/bd/bd_contrato_esquema.test.js',       nombre: '1. Contrato de Esquema (DDL, Indices, Triggers)' },
  { file: 'tests/bd/bd_invariantes_integridad.test.js',  nombre: '2. Invariantes e Integridad de Reglas en BD' },
  { file: 'tests/bd/bd_funciones_triggers.test.js',      nombre: '3. Funciones y Triggers (Ramas y Atomicidad)' },
  { file: 'tests/bd/bd_contrato_codigo_vs_bd.test.js',   nombre: '4. Contrato Codigo vs. Base de Datos' },
  { file: 'tests/bd/bd_romper_concurrencia_caos.test.js',nombre: '5. Caos, Concurrencia y Resiliencia' },
  { file: 'tests/bd/bd_rendimiento_volumen.test.js',     nombre: '6. Rendimiento y Volumen Masivo (100k turnos)' },
  { file: 'tests/bd/bd_seguridad_permisos.test.js',      nombre: '7. Seguridad y Permisos del Rol de Aplicacion' }
]

console.log('══════════════════════════════════════════════════════════════')
console.log('   SUITE DE PRUEBAS DE BASE DE DATOS (MÓDULO: base_de_datos)  ')
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
      env: { ...process.env, BD_TEST_SAFE: '1' }
    })
    totalPassed++
  } catch (err) {
    totalFailed++
    fallidos.push(t.nombre)
  }
}

console.log('\n══════════════════════════════════════════════════════════════')
console.log(` RESUMEN FINAL SUITE BD: ${totalPassed}/${tests.length} ARCHIVOS EXITOSOS`)
if (totalFailed > 0) {
  console.error(` ARCHIVOS CON FALLAS (${totalFailed}):`)
  fallidos.forEach(f => console.error(`   - ${f}`))
  process.exit(1)
} else {
  console.log(' ¡TODAS LAS PRUEBAS DE BASE DE DATOS PASARON SATISFACTORIAMENTE!')
  process.exit(0)
}

