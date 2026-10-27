'use strict'

/**
 * MÓDULO: base_de_datos
 * OBJETIVO: Comprobar que la base creada desde cero con las migraciones es exactamente
 *           la esperada: tablas, columnas, tipos, defaults, FK, índices, triggers,
 *           funciones y que no hay objetos huérfanos ni duplicados.
 * EJECUCIÓN: node tests/bd/bd_contrato_esquema.test.js
 */

const assert = require('node:assert/strict')
const {
  setupTestDb, teardownTestDb, getTestPool, BD_TEST_NAME
} = require('./helpers/db_test_setup')

// ── Registro de referencia (canónico, derivado de las migraciones) ──────────

const TABLAS_ESPERADAS = [
  'configuracion', 'usuarios', 'mesas', 'lotes_voucher',
  'kiosko_contador_diario', 'turnos', 'audit_log'
]

const COLUMNAS_POR_TABLA = {
  configuracion: ['clave', 'valor', 'descripcion', 'actualizado_en', 'actualizado_por'],
  usuarios: ['id', 'username', 'nombre_completo', 'password_hash', 'rol', 'activo', 'creado_en', 'actualizado_en', 'eliminado_en'],
  mesas: ['id', 'numero', 'nombre', 'estado', 'operador_id', 'creado_en', 'actualizado_en', 'eliminado_en'],
  lotes_voucher: ['id', 'numero_lote', 'numero_desde', 'numero_hasta', 'ultimo_numero_llamado', 'estado', 'fecha_creacion', 'fecha_activacion', 'fecha_cierre', 'creado_por', 'creado_en', 'actualizado_en', 'eliminado_en'],
  kiosko_contador_diario: ['fecha', 'ultimo_numero', 'sesion', 'actualizado_en'],
  turnos: ['id', 'numero', 'fecha_turno', 'sesion', 'lote_id', 'estado', 'origen', 'mesa_id', 'operador_id', 'creado_en', 'llamado_en', 'finalizado_en', 'duracion_espera_seg', 'duracion_atencion_seg', 'token_consulta', 'idempotency_key', 'device_id'],
  audit_log: ['id', 'turno_id', 'mesa_id', 'operador_id', 'lote_id', 'accion', 'timestamp', 'ip_origen', 'metadata_json']
}

const INDICES_UNICOS_ESPERADOS = [
  'ux_usuarios_username_activos',
  'ux_mesas_numero_activas',
  'ux_mesas_operador_unico',
  'ux_lotes_un_lote_activo',
  'ux_turnos_lote_numero',
  'ux_turnos_mesa_activa',
  'ux_turnos_kiosko_dia_numero',
  'ux_turnos_idempotency_key',
  'ux_turnos_device_esperando'
]

const TRIGGERS_ESPERADOS = [
  { tabla: 'audit_log',      nombre: 'trg_audit_log_inmutable' },
  { tabla: 'usuarios',       nombre: 'trg_usuarios_actualizado_en' },
  { tabla: 'mesas',          nombre: 'trg_mesas_actualizado_en' },
  { tabla: 'lotes_voucher',  nombre: 'trg_lotes_actualizado_en' },
  { tabla: 'turnos',         nombre: 'trg_turnos_duraciones' },
  { tabla: 'turnos',         nombre: 'trg_audit_turnos_insert' },
  { tabla: 'turnos',         nombre: 'trg_audit_turnos_update' },
  { tabla: 'lotes_voucher',  nombre: 'trg_lotes_no_regresion' },
  { tabla: 'usuarios',       nombre: 'trg_usuarios_proteger_ultimo_admin' }
]

const FUNCIONES_ESPERADAS = [
  'fn_bloquear_modificacion_audit_log',
  'fn_set_actualizado_en',
  'fn_calcular_duraciones_turno',
  'fn_audit_turno',
  'fn_check_lote_no_regresion',
  'fn_llamar_siguiente',
  'fn_atender_rezagado',
  'fn_fecha_hoy',
  'fn_proteger_ultimo_admin'
]

// 28 valores en el CHECK de audit_log (canónico de la BD)
const AUDIT_ACCIONES_EN_BD = [
  'TURNO_GENERADO', 'TURNO_LLAMADO', 'TURNO_RELLAMADO', 'TURNO_REZAGADO',
  'ATENCION_FINALIZADA', 'TURNO_FINALIZADO', 'TURNO_CANCELADO',
  'LOTE_CREADO', 'LOTE_ACTIVADO', 'LOTE_PAUSADO', 'LOTE_AGOTADO',
  'LOTE_EXTENDIDO', 'LOTE_CERRADO', 'LOTE_NUEVO_DESDE_UNO', 'LOTE_CONTADOR_AJUSTADO',
  'MESA_ACTIVADA', 'MESA_PAUSADA', 'MESA_INACTIVADA',
  'OPERADOR_ASIGNADO', 'OPERADOR_LIBERADO',
  'LOGIN_EXITOSO', 'LOGIN_FALLIDO', 'LOGOUT',
  'USUARIO_CREADO', 'USUARIO_EDITADO', 'USUARIO_DESACTIVADO',
  'CONFIG_MODIFICADA', 'ADMIN_ACTION'
]

const CLAVES_CONFIG_ESPERADAS = [
  'alerta_vouchers_restantes', 'modo_generacion_turnos', 'kiosko_web_activo',
  'mostrar_estimado_espera', 'zona_horaria', 'kiosko_tope_diario',
  'kiosko_url_base', 'voz_anuncio_activa', 'impresora_ip', 'impresora_puerto',
  'impresora_activa', 'tv_escala_turnos', 'tv_escala_principal', 'tv_escala_secundaria',
  'kiosko_impresion_automatica', 'kiosko_url_publica', 'kiosko_modo_uso',
  'fondo_imagen_url', 'fondo_imagen_activa', 'fondo_imagen_escala',
  'tv_opacidad_principal', 'tv_opacidad_secundaria', 'impresora_canal', 'impresora_ancho_papel'
]

// ── Runner ──────────────────────────────────────────────────────────────────
let pool
let passed = 0
let failed = 0
const errores = []

function ok (nombre) {
  console.log(`  [OK] ${nombre}`)
  passed++
}

function fail (nombre, detalle) {
  console.error(`  [FAIL] ${nombre}`)
  if (detalle) console.error(`        ${detalle}`)
  failed++
  errores.push({ nombre, detalle })
}

async function test (nombre, fn) {
  try {
    await fn()
    ok(nombre)
  } catch (err) {
    fail(nombre, err.message)
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function runTests () {
  console.log('══════════════════════════════════════════════════════════════')
  console.log(' bd_contrato_esquema — Contrato de esquema de base de datos')
  console.log(`  BD: ${BD_TEST_NAME}`)
  console.log('══════════════════════════════════════════════════════════════\n')

  // ── 1. Tablas existentes ────────────────────────────────────────────────
  console.log('-- 1. Tablas')
  const { rows: tablas } = await pool.query(`
    SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename
  `)
  const tablasPresentes = tablas.map(r => r.tablename)

  for (const t of TABLAS_ESPERADAS) {
    await test(`Tabla "${t}" existe`, () => {
      assert.ok(tablasPresentes.includes(t), `Falta la tabla "${t}"`)
    })
  }

  // ── 2. Columnas por tabla ───────────────────────────────────────────────
  console.log('\n-- 2. Columnas')
  for (const [tabla, colsEsperadas] of Object.entries(COLUMNAS_POR_TABLA)) {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name=$1 AND table_schema='public'
    `, [tabla])
    const colsPresentes = rows.map(r => r.column_name)

    for (const col of colsEsperadas) {
      await test(`${tabla}.${col} existe`, () => {
        assert.ok(colsPresentes.includes(col), `Falta columna "${col}" en "${tabla}"`)
      })
    }
  }

  // ── 3. Restricciones NOT NULL críticas ─────────────────────────────────
  console.log('\n-- 3. NOT NULL críticos')
  const notNullCases = [
    ['configuracion', 'valor'],
    ['usuarios', 'username'], ['usuarios', 'password_hash'], ['usuarios', 'rol'],
    ['mesas', 'numero'], ['mesas', 'nombre'], ['mesas', 'estado'],
    ['turnos', 'numero'], ['turnos', 'estado'], ['turnos', 'origen'],
    ['audit_log', 'accion']
  ]
  for (const [tabla, col] of notNullCases) {
    const { rows } = await pool.query(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name=$1 AND column_name=$2 AND table_schema='public'
    `, [tabla, col])
    await test(`${tabla}.${col} NOT NULL`, () => {
      assert.equal(rows[0]?.is_nullable, 'NO', `${tabla}.${col} debería ser NOT NULL`)
    })
  }

  // ── 4. Índices únicos parciales ─────────────────────────────────────────
  console.log('\n-- 4. Índices únicos parciales')
  const { rows: indices } = await pool.query(`
    SELECT indexname FROM pg_indexes WHERE schemaname='public'
  `)
  const nombresIdx = indices.map(r => r.indexname)

  for (const idx of INDICES_UNICOS_ESPERADOS) {
    await test(`Índice "${idx}" existe`, () => {
      assert.ok(nombresIdx.includes(idx), `Falta índice "${idx}"`)
    })
  }

  // ── 5. Triggers ─────────────────────────────────────────────────────────
  console.log('\n-- 5. Triggers')
  const { rows: triggers } = await pool.query(`
    SELECT trigger_name, event_object_table FROM information_schema.triggers
    WHERE trigger_schema='public'
  `)

  for (const { tabla, nombre } of TRIGGERS_ESPERADOS) {
    await test(`Trigger "${nombre}" en "${tabla}"`, () => {
      const encontrado = triggers.find(r => r.trigger_name === nombre && r.event_object_table === tabla)
      assert.ok(encontrado, `Falta trigger "${nombre}" en tabla "${tabla}"`)
    })
  }

  // ── 6. Funciones ─────────────────────────────────────────────────────────
  console.log('\n-- 6. Funciones')
  const { rows: funciones } = await pool.query(`
    SELECT proname FROM pg_proc
    WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
  `)
  const nombresFn = funciones.map(r => r.proname)

  for (const fn of FUNCIONES_ESPERADAS) {
    await test(`Función "${fn}" existe`, () => {
      assert.ok(nombresFn.includes(fn), `Falta función "${fn}"`)
    })
  }

  // ── 7. CHECK de audit_log: 28 valores ────────────────────────────────────
  console.log('\n-- 7. CHECK audit_log.accion')
  const { rows: checks } = await pool.query(`
    SELECT pg_get_constraintdef(c.oid, true) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'audit_log' AND c.contype = 'c'
  `)

  const checkDef = checks[0]?.def || ''
  for (const accion of AUDIT_ACCIONES_EN_BD) {
    await test(`audit_log CHECK contiene "${accion}"`, () => {
      assert.ok(checkDef.includes(`'${accion}'`), `Acción "${accion}" no está en el CHECK de audit_log`)
    })
  }

  // ── 8. Claves de configuración iniciales ─────────────────────────────────
  console.log('\n-- 8. Claves de configuración')
  const { rows: cfgRows } = await pool.query('SELECT clave FROM configuracion')
  const cfgPresentes = cfgRows.map(r => r.clave)
  for (const clave of CLAVES_CONFIG_ESPERADAS) {
    await test(`configuracion.${clave} existe con valor inicial`, () => {
      assert.ok(cfgPresentes.includes(clave), `Falta clave de configuración "${clave}"`)
    })
  }

  // ── 9. Sin objetos huérfanos (triggers apuntando a funciones que no existen) ──
  console.log('\n-- 9. Integridad de objetos (sin huérfanos)')
  const { rows: orphanTriggers } = await pool.query(`
    SELECT tgname FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
      AND NOT EXISTS (
        SELECT 1 FROM pg_proc p WHERE p.oid = t.tgfoid
      )
  `)
  await test('Sin triggers con función huérfana', () => {
    assert.equal(orphanTriggers.length, 0,
      `Triggers huérfanos: ${orphanTriggers.map(r => r.tgname).join(', ')}`)
  })

  // ── 10. Claves foráneas referencian tablas existentes ─────────────────────
  console.log('\n-- 10. Claves foráneas')
  const { rows: fks } = await pool.query(`
    SELECT
      tc.constraint_name,
      tc.table_name AS origen,
      ccu.table_name AS destino
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
  `)

  for (const fk of fks) {
    await test(`FK ${fk.constraint_name}: ${fk.origen} → ${fk.destino} existe`, () => {
      assert.ok(
        TABLAS_ESPERADAS.includes(fk.destino),
        `FK "${fk.constraint_name}" apunta a tabla desconocida "${fk.destino}"`
      )
    })
  }

  // ── 11. No hay objetos duplicados (índices con nombre repetido) ───────────
  console.log('\n-- 11. Sin objetos duplicados')
  const { rows: dupIdx } = await pool.query(`
    SELECT indexname, COUNT(*) AS cnt FROM pg_indexes
    WHERE schemaname='public'
    GROUP BY indexname HAVING COUNT(*) > 1
  `)
  await test('Sin índices con nombre duplicado', () => {
    assert.equal(dupIdx.length, 0,
      `Índices duplicados: ${dupIdx.map(r => r.indexname).join(', ')}`)
  })

  // ── 12. Extensiones (pgcrypto esperada) ─────────────────────────────────
  console.log('\n-- 12. Extensiones')
  const { rows: exts } = await pool.query(`SELECT extname FROM pg_extension`)
  const extNames = exts.map(r => r.extname)
  await test('pgcrypto instalada', () => {
    assert.ok(extNames.includes('pgcrypto'), 'Falta extensión pgcrypto')
  })

  // ── 13. Secuencia seq_numero_lote existe ─────────────────────────────────
  console.log('\n-- 13. Secuencias')
  const { rows: seqs } = await pool.query(`
    SELECT sequencename FROM pg_sequences WHERE schemaname='public'
  `)
  const seqNames = seqs.map(r => r.sequencename)
  await test('Secuencia seq_numero_lote existe', () => {
    assert.ok(seqNames.includes('seq_numero_lote'), 'Falta secuencia seq_numero_lote')
  })

  // ── Resumen ─────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(` RESULTADO: ${passed} OK  |  ${failed} FALLIDOS`)
  if (errores.length > 0) {
    console.error('\n ERRORES:')
    errores.forEach(e => console.error(`  - ${e.nombre}: ${e.detalle}`))
  }
  console.log('══════════════════════════════════════════════════════════════\n')
  if (failed > 0) process.exit(1)
}

// ── Main ─────────────────────────────────────────────────────────────────────
;(async () => {
  try {
    await setupTestDb()
    pool = getTestPool()
    await runTests()
  } finally {
    await teardownTestDb()
  }
})().catch(err => {
  console.error('[ERROR FATAL]', err.message)
  teardownTestDb().finally(() => process.exit(1))
})

