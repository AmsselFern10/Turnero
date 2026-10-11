'use strict'

/**
 * Script de seed para desarrollo.
 * Genera hashes bcrypt reales y puebla la BD con datos de prueba.
 *
 * Uso:
 *   node scripts/seed.js
 *   (requiere que la BD ya esté levantada: docker compose up -d db)
 */

require('dotenv').config({ path: '.env' })

const bcrypt = require('bcrypt')
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@localhost:${process.env.PGBOUNCER_PORT_EXPOSED || 5433}/${process.env.DB_NAME}`
})

const COST = parseInt(process.env.BCRYPT_COST || '12')

async function seed () {
  console.log('🌱 Iniciando seed de desarrollo...')
  console.log(`   bcrypt cost: ${COST}`)

  const hashes = {}
  const usuarios = [
    { username: 'admin',      password: 'Admin2026!',     nombre: 'Administrador del Sistema',  rol: 'admin' },
    { username: 'op1',        password: 'Operador2026!',  nombre: 'Operador Mesa 1',              rol: 'operador' },
    { username: 'op2',        password: 'Operador2026!',  nombre: 'Operador Mesa 2',              rol: 'operador' },
    { username: 'op3',        password: 'Operador2026!',  nombre: 'Operador Mesa 3',              rol: 'operador' },
    { username: 'op4',        password: 'Operador2026!',  nombre: 'Operador Mesa 4',              rol: 'operador' },
    { username: 'op5',        password: 'Operador2026!',  nombre: 'Operador Mesa 5',              rol: 'operador' },
    { username: 'porton',     password: 'Porton2026!',    nombre: 'Empleado Portón / Kiosko',     rol: 'operador' },
  ]

  console.log('\n📝 Generando hashes bcrypt...')
  for (const u of usuarios) {
    process.stdout.write(`   ${u.username}... `)
    hashes[u.username] = await bcrypt.hash(u.password, COST)
    console.log('✓')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Limpiar datos existentes (en orden para respetar FK)
    await client.query('TRUNCATE lotes_voucher, turnos, audit_log, mesas, usuarios RESTART IDENTITY CASCADE')
    console.log('\n🗑️  Tablas limpiadas')

    // Insertar usuarios
    for (const u of usuarios) {
      await client.query(
        `INSERT INTO usuarios (username, nombre_completo, password_hash, rol)
         VALUES ($1, $2, $3, $4)`,
        [u.username, u.nombre, hashes[u.username], u.rol]
      )
    }
    console.log(`✅ ${usuarios.length} usuarios insertados`)

    // Insertar mesas (12 ventanillas)
    const mesas = [
      [1,  'Mesa 1 — Matrícula'],
      [2,  'Mesa 2 — Matrícula'],
      [3,  'Mesa 3 — Pagos'],
      [4,  'Mesa 4 — Pagos'],
      [5,  'Mesa 5 — Documentos'],
      [6,  'Mesa 6 — Documentos'],
      [7,  'Mesa 7 — Inscripciones'],
      [8,  'Mesa 8 — Inscripciones'],
      [9,  'Mesa 9 — Validación'],
      [10, 'Mesa 10 — Validación'],
      [11, 'Mesa 11 — General'],
      [12, 'Mesa 12 — General'],
    ]

    for (const [numero, nombre] of mesas) {
      await client.query(
        `INSERT INTO mesas (numero, nombre) VALUES ($1, $2)`,
        [numero, nombre]
      )
    }
    console.log(`✅ ${mesas.length} mesas insertadas`)

    // Insertar lote de prueba (Lote 1, vouchers 1-50)
    await client.query(
      `INSERT INTO lotes_voucher (numero_desde, numero_hasta, estado, creado_por)
       VALUES (1, 50, 'preparado', 1)`
    )
    console.log('✅ Lote de prueba creado: Lote 1, vouchers 1–50 (estado: preparado)')

    await client.query('COMMIT')

    console.log('\n🎉 Seed completado exitosamente!')
    console.log('\n📋 Credenciales de acceso:')
    console.log('   admin       → Admin2026!')
    console.log('       console.log('   op1-op5     → Operador2026!')
    console.log('   porton      → Porton2026!')
    console.log('\n⚠️  Cambiar todas las contraseñas antes de producción.\n')

  } catch (err) {
    await client.query('ROLLBACK')
    console.error('\n❌ Error en seed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

seed()

