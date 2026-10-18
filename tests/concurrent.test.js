/**
 * Prueba de Concurrencia Atomica — Llamado Simultaneo de 5 Operadores
 *
 * Simula 5 operadores de ventanilla presionando "Llamar Siguiente" en el mismo
 * milisegundo. Verifica que no haya duplicados ni colisiones de numero.
 *
 * Requiere: Servidor HTTP y Base de Datos corriendo.
 * Ejecucion: node tests/concurrent.test.js
 */

const crypto = require('crypto')
require('dotenv').config()
const { Pool } = require('pg')
const bcrypt = require('bcrypt')

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE = process.env.APP_URL || `http://localhost:${PORT}`

async function test() {
  const connectionString = process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER || 'turnero_app'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  const pool = new Pool({ connectionString })
  const hash = await bcrypt.hash('Operador2026!', 10)

  // Asegurar 5 operadores y 5 mesas activas
  for (let i = 1; i <= 5; i++) {
    await pool.query(
      `INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
       VALUES ($1, $2, 'operador', $3, true)
       ON CONFLICT (username) WHERE eliminado_en IS NULL DO UPDATE SET activo=true, password_hash=$2`,
      ['op' + i, hash, 'Operador ' + i]
    )
    await pool.query(
      `INSERT INTO mesas (numero, nombre, estado)
       VALUES ($1, $2, 'activa')
       ON CONFLICT (numero) WHERE estado != 'eliminada' AND eliminado_en IS NULL DO UPDATE SET estado='activa', nombre=$2`,
      [i, 'Mesa ' + i]
    )
  }
  await pool.query(
    `UPDATE mesas SET operador_id = NULL WHERE operador_id IN (SELECT id FROM usuarios WHERE username LIKE 'op_')`
  )
  await pool.query(
    `UPDATE mesas m
     SET operador_id = (SELECT id FROM usuarios WHERE username = 'op' || m.numero::text)
     WHERE m.numero BETWEEN 1 AND 5`
  )

  // Leer el ultimo_numero_llamado real del lote activo y ampliar numero_hasta
  const { rows: [loteInfo] } = await pool.query(
    `SELECT id, ultimo_numero_llamado FROM lotes_voucher WHERE estado='activo' ORDER BY id DESC LIMIT 1`
  )
  if (!loteInfo) throw new Error('No hay lote activo — activa uno desde admin.')
  const baseNum = loteInfo.ultimo_numero_llamado || 0
  await pool.query(
    `UPDATE lotes_voucher
     SET numero_hasta=$2
     WHERE id=$1`,
    [loteInfo.id, baseNum + 5000]
  )

  // Login 5 operadores
  const logins = await Promise.all([1, 2, 3, 4, 5].map(i =>
    fetch(BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'op' + i, password: 'Operador2026!' })
    }).then(r => r.json())
  ))
  const tokens = logins.map(l => l.token)

  // DISPARAR LOS 5 AL MISMO TIEMPO
  console.log('Disparando 5 operadores llamando SIMULTANEAMENTE...')
  const t0 = Date.now()
  const resultados = await Promise.all([1, 2, 3, 4, 5].map((mesaId, idx) =>
    fetch(BASE + '/turnos/llamar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tokens[idx],
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify({ mesa_id: mesaId })
    }).then(r => r.json())
  ))
  const dt = Date.now() - t0

  console.log('\n--- RESULTADO (todos en ' + dt + 'ms) ---')
  resultados.forEach((r, i) => {
    if (r.turno) {
      console.log(
        'Mesa ' + (i + 1) +
        ':  turno asignado = #' + r.turno.numero +
        '  |  proximo_numero mostrado en su card = ' +
        (r.proximo_numero != null ? '#' + r.proximo_numero : 'null (lote agotado)')
      )
    } else {
      console.log('Mesa ' + (i + 1) + ': ERROR = ' + JSON.stringify(r))
    }
  })

  const nums = resultados.filter(r => r.turno).map(r => r.turno.numero).sort((a, b) => a - b)
  const unicos = new Set(nums)
  console.log('\nTurnos asignados (ordenados): ', nums)
  console.log('Sin duplicados      :', unicos.size === nums.length ? 'SI (garantia atomica)' : 'NO (BUG!)')
  console.log('Son consecutivos    :', nums.every((n, i) => i === 0 || n === nums[i - 1] + 1) ? 'SI' : 'NO')

  await pool.end()
}
test().catch(console.error)
