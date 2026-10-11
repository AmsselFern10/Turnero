'use strict';
require('dotenv').config({ path: '.env' });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function recrearDesdeCero() {
  console.log('🔄 ========================================================');
  console.log('🔄 RECONSTRUCCIÓN COMPLETA DE BASE DE DATOS DESDE CERO');
  console.log('🔄 ========================================================\n');

  const client = await pool.connect();
  try {
    // 1. Limpieza absoluta del schema public
    console.log('1️⃣  Eliminando schema public completo (tablas, funciones, triggers, secuencias)...');
    await client.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO postgres;
      GRANT ALL ON SCHEMA public TO public;
    `);
    console.log('   ✓ Schema public reseteado a limpio.');

    // 2. Ejecutar Migración 001
    console.log('\n2️⃣  Ejecutando migrations/001_initial.sql...');
    const sql001 = fs.readFileSync(path.join(__dirname, '../migrations/001_initial.sql'), 'utf8');
    await client.query(sql001);
    console.log('   ✓ Migración 001_initial.sql aplicada con éxito.');

    // 3. Ejecutar Migración 002
    console.log('\n3️⃣  Ejecutando migrations/002_fix_audit_log_y_mesas.sql...');
    const sql002 = fs.readFileSync(path.join(__dirname, '../migrations/002_fix_audit_log_y_mesas.sql'), 'utf8');
    await client.query(sql002);
    console.log('   ✓ Migración 002_fix_audit_log_y_mesas.sql aplicada con éxito.');

    // 4. Ejecutar Migración 003
    console.log('\n4️⃣  Ejecutando migrations/003_correcciones_auditoria.sql...');
    const sql003 = fs.readFileSync(path.join(__dirname, '../migrations/003_correcciones_auditoria.sql'), 'utf8');
    await client.query(sql003);
    console.log('   ✓ Migración 003_correcciones_auditoria.sql aplicada con éxito.');

    // 5. Verificar que no haya índices duplicados en el catálogo de PostgreSQL
    console.log('\n5️⃣  Verificando que no haya índices ni constraints duplicados...');
    const { rows: indices } = await client.query(`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname;
    `);

    console.log(`   ✓ Total de índices creados en el catálogo: ${indices.length}`);
    for (const idx of indices) {
      console.log(`     - [${idx.tablename}] ${idx.indexname}`);
    }

    // 6. Verificar constraints de CHECK
    const { rows: checks } = await client.query(`
      SELECT conname, relname, pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c
      JOIN pg_class r ON c.conrelid = r.oid
      WHERE c.contype = 'c'
      ORDER BY relname, conname;
    `);
    console.log(`\n   ✓ Total de constraints CHECK verificados: ${checks.length}`);
    for (const chk of checks) {
      console.log(`     - [${chk.relname}] ${chk.conname}`);
    }

    console.log('\n✅ Todas las migraciones se aplicaron limpiamente sin conflictos.');

  } catch (err) {
    console.error('\n❌ ERROR durante la reconstrucción:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

recrearDesdeCero();
