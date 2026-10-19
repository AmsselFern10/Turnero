const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const envPath = fs.existsSync(path.resolve(__dirname, '../.env'))
  ? path.resolve(__dirname, '../.env')
  : path.resolve(__dirname, '../.env.development');

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || 'turnero')}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || process.env.PGBOUNCER_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
});

async function recrearDesdeCero() {
  console.log('========================================================');
  console.log(' RECONSTRUCCION COMPLETA DE BASE DE DATOS DESDE CERO');
  console.log('========================================================\n');

  let client;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      client = await pool.connect();
      break;
    } catch (err) {
      if (attempt === 10) throw err;
      console.log(`[INFO] Esperando conexion con PostgreSQL / pgBouncer (intento ${attempt}/10)...`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  try {
    // 1. Limpieza absoluta del schema public
    console.log('[1/3] Eliminando schema public completo (tablas, funciones, triggers, secuencias)...');
    await client.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO public;
    `);
    console.log('   [OK] Schema public reseteado a limpio.');

    // 2. Ejecutar todas las migraciones SQL en orden correlativo (001..007)
    console.log('\n[2/3] Ejecutando migraciones SQL en orden...');
    const migrationsDir = path.join(__dirname, '../migrations');
    const sqlFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of sqlFiles) {
      console.log(`   -> Aplicando ${file}...`);
      const sqlContent = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query(sqlContent);
      console.log(`   [OK] ${file} aplicada con exito.`);
    }

    // 3. Verificar objetos en el catalogo de PostgreSQL
    console.log('\n[3/3] Verificando catalogo de PostgreSQL...');
    const { rows: tablas } = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
    `);
    console.log(`   [OK] Tablas creadas (${tablas.length}): ${tablas.map(t => t.tablename).join(', ')}`);

    const { rows: indices } = await client.query(`
      SELECT tablename, indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname;
    `);
    console.log(`   [OK] Total de indices verificados: ${indices.length}`);

    const { rows: checks } = await client.query(`
      SELECT conname, relname
      FROM pg_constraint c
      JOIN pg_class r ON c.conrelid = r.oid
      WHERE c.contype = 'c'
      ORDER BY relname, conname;
    `);
    console.log(`   [OK] Total de constraints CHECK verificados: ${checks.length}`);

    console.log('\n[DONE] Base de datos reconstruida limpiamente desde la migracion consolidada.');

  } catch (err) {
    console.error('\n[FAIL] ERROR durante la reconstruccion:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

recrearDesdeCero();
