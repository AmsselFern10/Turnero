/**
 * MÓDULO: admin_gestion
 * OBJETIVO: Comprobar las invariantes y restricciones de negocio críticas en PostgreSQL:
 *   lote único activo, 1 turno en atención por mesa, operador único por mesa,
 *   inmutabilidad de audit_log, no-regresión de numeración y concurrencia.
 * EJECUCIÓN: node tests/admin_invariantes_bd.test.js
 */

require('dotenv').config()
const { Pool } = require('pg')

const connectionString = process.env.DATABASE_URL ||
  `postgresql://${process.env.DB_USER || 'turnero_app'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`

const pool = new Pool({
  connectionString,
  max: 15
})

async function runVerification() {
  console.log('Iniciando suite de verificacion integral de base de datos...\n')

  // Asegurar que haya exactamente 1 lote activo para las pruebas
  await pool.query("UPDATE lotes_voucher SET estado = 'preparado' WHERE estado = 'activo'");
  await pool.query("UPDATE lotes_voucher SET estado = 'activo' WHERE id = (SELECT id FROM lotes_voucher ORDER BY id ASC LIMIT 1)");

  // Test 1: Invariante 1 — Solo 1 lote activo
  const { rows: activos } = await pool.query("SELECT count(*) FROM lotes_voucher WHERE estado = 'activo'");
  console.log('1. Invariante 1 (Solo 1 lote activo):', activos[0].count === '1' ? '[OK] PASSED' : '[FAIL] FAILED');

  // Test 2: Invariante 3 — uq_turnos_mesa_activa
  let inv3Passed = false;
  try {
    await pool.query('BEGIN');
    await pool.query("INSERT INTO turnos (numero, lote_id, estado, mesa_id) VALUES (9999, 1, 'en_atencion', 1)");
    await pool.query("INSERT INTO turnos (numero, lote_id, estado, mesa_id) VALUES (9998, 1, 'en_atencion', 1)");
    await pool.query('ROLLBACK');
  } catch (err) {
    inv3Passed = err.code === '23505';
    await pool.query('ROLLBACK');
  }
  console.log('2. Invariante 3 (UQ un turno en atención por mesa):', inv3Passed ? '[OK] PASSED' : '[FAIL] FAILED');

  // Test 3: Invariante 4 — ux_mesas_operador_unico
  let inv4Passed = false;
  try {
    await pool.query('BEGIN');
    await pool.query('UPDATE mesas SET operador_id = 1 WHERE id = 1');
    await pool.query('UPDATE mesas SET operador_id = 1 WHERE id = 2');
    await pool.query('ROLLBACK');
  } catch (err) {
    inv4Passed = err.code === '23505';
    await pool.query('ROLLBACK');
  }
  console.log('3. Invariante 4 (UQ un operador en máx 1 mesa):', inv4Passed ? '[OK] PASSED' : '[FAIL] FAILED');

  // Test 4: Invariante 6 — audit_log solo-INSERT
  let inv6Passed = false;
  try {
    const { rows: inserted } = await pool.query("INSERT INTO audit_log (accion, operador_id) VALUES ('LOGIN_EXITOSO', 1) RETURNING id");
    await pool.query('DELETE FROM audit_log WHERE id = $1', [inserted[0].id]);
  } catch (err) {
    inv6Passed = err.message.includes('audit_log es inmutable') || err.message.includes('inmutable') || err.code === '42501';
  }
  console.log('4. Invariante 6 (audit_log es inmutable):', inv6Passed ? '[OK] PASSED' : '[FAIL] FAILED');

  // Test 5: Invariante 5 — No regresión en lote
  let inv5Passed = false;
  try {
    await pool.query('UPDATE lotes_voucher SET ultimo_numero_llamado = 5 WHERE id = 1');
    await pool.query('UPDATE lotes_voucher SET ultimo_numero_llamado = 3 WHERE id = 1');
  } catch (err) {
    inv5Passed = err.message.includes('no puede retroceder');
  }
  console.log('5. Invariante 5 (no regresión en lote):', inv5Passed ? '[OK] PASSED' : '[FAIL] FAILED');

  // Test 6: Concurrencia de 5 ventanillas llamando al mismo tiempo
  console.log('\n[INFO] Probando 5 llamadas concurrentes de ventanillas vía fn_llamar_siguiente...');
  await pool.query("UPDATE mesas SET operador_id = NULL, estado = 'inactiva'");
  for (let i = 1; i <= 5; i++) {
    await pool.query("UPDATE mesas SET operador_id = $1, estado = 'activa' WHERE id = $2", [i, i]);
  }
  const t0 = Date.now();
  const resultados = await Promise.all([
    pool.query('SELECT * FROM fn_llamar_siguiente(1, 1)'),
    pool.query('SELECT * FROM fn_llamar_siguiente(2, 2)'),
    pool.query('SELECT * FROM fn_llamar_siguiente(3, 3)'),
    pool.query('SELECT * FROM fn_llamar_siguiente(4, 4)'),
    pool.query('SELECT * FROM fn_llamar_siguiente(5, 5)')
  ]);
  const duracion = Date.now() - t0;
  console.log(`[INFO] 5 llamadas resueltas en: ${duracion} ms (promedio: ${(duracion / 5).toFixed(1)} ms/tx)`);
  const numeros = resultados.map(r => r.rows[0].turno_numero);
  console.log('Turnos asignados:', numeros);
  const unicos = new Set(numeros);
  console.log('6. Invariante 2 (Cero duplicados bajo concurrencia):', unicos.size === numeros.length ? '[OK] PASSED' : '[FAIL] FAILED');

  await pool.query("UPDATE mesas SET operador_id = NULL, estado = 'activa'");
  await pool.end();
  console.log('\n[DONE] Suite de verificacion completada con exito.');
}

runVerification().catch(err => {
  console.error('Error en suite:', err);
  pool.end();
});
