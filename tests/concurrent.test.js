/**
 * Prueba de Concurrencia Atomica — Operadores y Mesas Reales de la BD
 *
 * Lee los operadores con mesas ya asignadas directamente desde la base de datos.
 * No crea usuarios ficticios. Usa los que ya tienes configurados en admin.
 *
 * Si hay menos pares operador-mesa que N, trabaja con los que encuentre.
 * Si una mesa no tiene operador asignado, la omite sin error.
 *
 * Requiere: Servidor HTTP y Base de Datos corriendo con operadores asignados.
 * Ejecucion: node tests/concurrent.test.js
 */

const crypto = require('crypto')
require('dotenv').config()
const { Pool } = require('pg')
const bcrypt = require('bcrypt')

const PORT = process.env.APP_PORT_EXPOSED || process.env.APP_PORT || 3000
const BASE = process.env.APP_URL || `http://localhost:${PORT}`

// ─── MAXIMO DE OPERADORES A PROBAR (usa los que haya si hay menos) ────────────
const N = 10  // Ajusta segun cuantas mesas activas con operador tengas
// ─────────────────────────────────────────────────────────────────────────────

// Contrasena temporal que se asigna a los operadores durante el test.
// Se restaura al terminar. Cambiala si prefieres otra.
const TEST_PASSWORD = '_ConcurrentTest2026!'

async function restaurarHashes(pool, operadores) {
  for (const op of operadores) {
    await pool.query(
      `UPDATE usuarios SET password_hash = $1 WHERE id = $2`,
      [op.hash_original, op.usuario_id]
    )
  }
}

async function test() {
  const connectionString = process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER || 'turnero_app'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  const pool = new Pool({ connectionString })

  // ── PASO 1: Leer operadores reales con mesas activas asignadas ──────────────
  const { rows: operadores } = await pool.query(
    `SELECT u.id          AS usuario_id,
            u.username,
            u.password_hash AS hash_original,
            m.id          AS mesa_id,
            m.numero      AS mesa_numero,
            m.nombre      AS mesa_nombre
     FROM usuarios u
     JOIN mesas m ON m.operador_id = u.id
     WHERE u.rol = 'operador'
       AND u.activo = true
       AND u.eliminado_en IS NULL
       AND m.estado = 'activa'
       AND m.eliminado_en IS NULL
     ORDER BY m.numero
     LIMIT $1`,
    [N]
  )

  if (operadores.length === 0) {
    console.error('No se encontraron operadores con mesas activas asignadas.')
    console.error('Configura al menos 1 operador con mesa desde el panel admin.')
    await pool.end()
    process.exit(1)
  }

  const totalReal = operadores.length
  console.log(`Encontrados ${totalReal} par(es) operador-mesa en la BD (limite N=${N})`)
  operadores.forEach(op =>
    console.log(`  - ${op.username}  ->  Mesa ${op.mesa_numero} (id=${op.mesa_id})`)
  )

  // ── PASO 2: Asignar contrasena temporal para poder autenticar ───────────────
  const hashTest = await bcrypt.hash(TEST_PASSWORD, 10)
  for (const op of operadores) {
    await pool.query(`UPDATE usuarios SET password_hash = $1 WHERE id = $2`, [hashTest, op.usuario_id])
  }
  console.log(`\nContrasena temporal asignada. Autenticando...`)

  // ── PASO 3: Verificar / ampliar el lote activo ─────────────────────────────
  const { rows: [loteInfo] } = await pool.query(
    `SELECT id, ultimo_numero_llamado FROM lotes_voucher WHERE estado='activo' ORDER BY id DESC LIMIT 1`
  )
  if (!loteInfo) {
    await restaurarHashes(pool, operadores)
    await pool.end()
    throw new Error('No hay lote activo — activa uno desde admin antes de correr este test.')
  }
  const baseNum = loteInfo.ultimo_numero_llamado || 0
  await pool.query(
    `UPDATE lotes_voucher SET numero_hasta = $2 WHERE id = $1`,
    [loteInfo.id, baseNum + 5000]
  )

  // ── PASO 4: Login con los operadores reales ────────────────────────────────
  const loginResults = await Promise.all(
    operadores.map(op =>
      fetch(BASE + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: op.username, password: TEST_PASSWORD })
      }).then(r => r.json())
    )
  )

  const operadoresConToken = operadores.map((op, i) => ({ ...op, token: loginResults[i].token }))
  const activos = operadoresConToken.filter(op => op.token)
  const omitidos = operadoresConToken.filter(op => !op.token)

  activos.forEach(op => console.log(`  [OK]   ${op.username} autenticado`))
  omitidos.forEach(op => console.log(`  [SKIP] ${op.username} — no pudo autenticar (se omite)`))

  if (activos.length === 0) {
    console.error('\nNingun operador pudo autenticarse. Abortando.')
    await restaurarHashes(pool, operadores)
    await pool.end()
    process.exit(1)
  }

  // ── PASO 5: Disparar TODOS al mismo tiempo ─────────────────────────────────
  console.log(`\nDisparando ${activos.length} operadores llamando SIMULTANEAMENTE...`)
  const t0 = Date.now()

  const resultados = await Promise.all(
    activos.map(op =>
      fetch(BASE + '/turnos/llamar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + op.token,
          'Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify({ mesa_id: op.mesa_id })
      }).then(r => r.json())
        .then(data => ({ op, data }))
    )
  )

  const dt = Date.now() - t0

  // ── PASO 6: Resultados ─────────────────────────────────────────────────────
  console.log('\n--- RESULTADO (todos en ' + dt + 'ms) ---')
  resultados.forEach(({ op, data }) => {
    if (data.turno) {
      console.log(
        `Mesa ${op.mesa_numero} (${op.username}):` +
        `  turno = #${data.turno.numero}` +
        `  |  proximo = ${data.proximo_numero != null ? '#' + data.proximo_numero : 'null (lote agotado)'}`
      )
    } else {
      console.log(`Mesa ${op.mesa_numero} (${op.username}): ERROR = ${JSON.stringify(data)}`)
    }
  })

  const nums = resultados.filter(r => r.data.turno).map(r => r.data.turno.numero).sort((a, b) => a - b)
  const unicos = new Set(nums)
  console.log('\nTurnos asignados (ordenados): ', nums)
  console.log('Sin duplicados      :', unicos.size === nums.length ? 'SI (garantia atomica)' : 'NO (BUG!)')
  console.log('Son consecutivos    :', nums.every((n, i) => i === 0 || n === nums[i - 1] + 1) ? 'SI' : 'NO')
  console.log(`Operadores exitosos : ${nums.length} / ${activos.length}`)

  // ── PASO 7: Restaurar hashes originales (siempre, incluso si hubo errores) ─
  await restaurarHashes(pool, operadores)
  console.log('\nContrasenas originales restauradas.')

  await pool.end()
}

test().catch(async err => {
  console.error('Error fatal:', err.message || err)
  process.exit(1)
})



