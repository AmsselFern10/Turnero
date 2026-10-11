'use strict'
const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')

require('dotenv').config({ path: path.join(__dirname, '../.env') })

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT_EXPOSED || process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'turnero',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'turnero'
})

async function run () {
  const file = process.argv[2]
  if (!file) { console.error('Usage: node run_migration.js <file.sql>'); process.exit(1) }
  const sql = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')
  await pool.query(sql)
  console.log(`✓ Applied: ${file}`)
  const { rows } = await pool.query(`SELECT rol, COUNT(*) as n FROM usuarios GROUP BY rol ORDER BY rol`)
  console.log('Roles en BD:')
  rows.forEach(r => console.log(`  ${r.rol}: ${r.n} usuario(s)`))
  await pool.end()
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1) })
