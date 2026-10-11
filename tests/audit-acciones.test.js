'use strict'

/**
 * TEST 13 — Consistencia de audit_log.accion
 *
 * Verifica que TODOS los valores en AUDIT_ACCIONES coincidan con el CHECK
 * constraint real de PostgreSQL. Falla si el codigo usa una accion que la BD
 * rechazaria (como el caso original de 'OPERADOR_AUTO_ASIGNADO').
 *
 * Requiere: BD accesible (se lee el CHECK via pg_get_constraintdef).
 * Ejecutar: node tests/audit-acciones.test.js
 * O via npm: npm test (si esta configurado en package.json)
 */

const { Client } = require('pg')
require('dotenv').config()

const { AUDIT_ACCIONES, AUDIT_ACCIONES_SET } = require('../src/modules/audit-acciones')

async function main () {
  const client = new Client({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'turnero',
    user:     process.env.DB_USER     || 'turnero_app',
    password: process.env.DB_PASSWORD || ''
  })

  await client.connect()

  console.log('TEST 13 — Consistencia de audit_log.accion')
  console.log('===========================================\n')

  // 1. Obtener el CHECK real de PostgreSQL
  const { rows } = await client.query(`
    SELECT pg_get_constraintdef(oid) AS definicion
    FROM pg_constraint
    WHERE conname = 'audit_log_accion_check'
      AND conrelid = 'audit_log'::regclass
  `)

  if (rows.length === 0) {
    console.error('ERROR: No se encontro audit_log_accion_check en la BD.')
    console.error('       Ejecuta la migracion 002_fix_audit_log_y_mesas.sql primero.')
    await client.end()
    process.exit(1)
  }

  const definicion = rows[0].definicion
  console.log('CHECK real en BD:')
  console.log(definicion)
  console.log()

  // 2. Extraer valores del CHECK con regex
  const valoresEnBD = new Set(
    [...definicion.matchAll(/'([A-Z_]+)'/g)].map(m => m[1])
  )

  // 3. Verificar que cada valor del modulo esta en la BD
  let errores = 0
  console.log('Verificando cada accion del modulo contra el CHECK de la BD:')
  for (const accion of AUDIT_ACCIONES_SET) {
    const ok = valoresEnBD.has(accion)
    const signo = ok ? 'OK' : 'FALLA'
    console.log(`  [${signo}] ${accion}`)
    if (!ok) errores++
  }

  // 4. Verificar que no haya valores en la BD que no esten en el modulo (aviso)
  console.log('\nAcciones en BD pero NO en el modulo (avisos):')
  let avisos = 0
  for (const v of valoresEnBD) {
    if (!AUDIT_ACCIONES_SET.has(v)) {
      console.log(`  [AVISO] '${v}' esta en el CHECK de BD pero no en AUDIT_ACCIONES`)
      avisos++
    }
  }
  if (avisos === 0) console.log('  (ninguno)')

  await client.end()

  console.log('\n---')
  if (errores > 0) {
    console.error(`RESULTADO: FALLIDO — ${errores} accion(es) del modulo no estan en el CHECK de la BD.`)
    console.error('Accion: agregar el valor a la migracion 002 (ALTER TABLE audit_log ADD CONSTRAINT).')
    process.exit(1)
  } else {
    console.log(`RESULTADO: PASADO — Todas las ${AUDIT_ACCIONES_SET.size} acciones del modulo son validas en la BD.`)
    process.exit(0)
  }
}

main().catch(err => {
  console.error('Error inesperado en el test:', err)
  process.exit(1)
})
