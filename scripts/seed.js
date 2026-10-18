'use strict'

/**
 * Script de Seed — Turnero de Matriculas 2026 (v2.1)
 *
 * Limpia la base de datos y genera el estado base operativo:
 * - 1 Administrador: admin / Admin2026!
 * - 5 Operadores: op1 a op5 / Operador2026!
 * - 10 Mesas: Mesa 1 a Mesa 10 (sin descripcion adicional)
 * - 2 Lotes de Vouchers:
 *     * Lote 1: 1 a 250 (estado: activo)
 *     * Lote 2: 251 a 350 (100 vouchers, estado: preparado)
 * - Configuracion del sistema: kiosko_web_activo = false, modo_generacion_turnos = voucher_fisico
 *
 * Cero emojis en salida para compatibilidad total de terminales institucionales.
 */

const fs = require('fs')
const path = require('path')
const bcrypt = require('bcrypt')
const { Pool } = require('pg')

// Cargar .env o .env.development
const envPath = fs.existsSync(path.resolve(__dirname, '../.env'))
  ? path.resolve(__dirname, '../.env')
  : path.resolve(__dirname, '../.env.development')

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath })
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || 'turnero')}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || process.env.PGBOUNCER_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
})

const COST = parseInt(process.env.BCRYPT_COST || '12', 10)

async function seed() {
  console.log('[INFO] Iniciando seed del sistema Turnero 2026...')
  console.log(`[INFO] Parametro bcrypt cost: ${COST}`)

  const client = await pool.connect()

  try {
    // 1. Hashear contraseñas
    console.log('[INFO] Generando credenciales y hashes bcrypt...')
    const adminHash = await bcrypt.hash('Admin2026!', COST)
    const operadorHash = await bcrypt.hash('Operador2026!', COST)

    await client.query('BEGIN')

    // 2. Limpieza total con reseteo de secuencias
    await client.query(`
      TRUNCATE turnos, lotes_voucher, audit_log, mesas, usuarios, kiosko_contador_diario
      RESTART IDENTITY CASCADE
    `)
    await client.query('ALTER SEQUENCE IF EXISTS seq_numero_lote RESTART WITH 1')
    console.log('[OK] Tablas truncadas y secuencias reiniciadas a 1.')

    // 3. Insertar 1 Admin
    const resAdmin = await client.query(`
      INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
      VALUES ($1, $2, $3, $4, true)
      RETURNING id
    `, ['admin', 'Administrador del Sistema', adminHash, 'admin'])
    const adminId = resAdmin.rows[0].id

    // 4. Insertar 5 Operadores
    for (let i = 1; i <= 5; i++) {
      await client.query(`
        INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
        VALUES ($1, $2, $3, $4, true)
      `, [`op${i}`, `Operador ${i}`, operadorHash, 'operador'])
    }
    console.log('[OK] 1 Administrador y 5 Operadores insertados.')

    // 5. Insertar 10 Mesas (sin descripcion, solo Mesa y numero)
    for (let i = 1; i <= 10; i++) {
      await client.query(`
        INSERT INTO mesas (numero, nombre, estado, operador_id)
        VALUES ($1, $2, 'inactiva', NULL)
      `, [i, `Mesa ${i}`])
    }
    console.log('[OK] 10 Mesas creadas (Mesa 1 a Mesa 10, estado inactiva).')

    // 6. Insertar 2 Lotes de Vouchers
    // Lote 1: 1 a 250 (activo)
    await client.query(`
      INSERT INTO lotes_voucher (
        numero_desde,
        numero_hasta,
        ultimo_numero_llamado,
        estado,
        fecha_activacion,
        creado_por
      )
      VALUES (1, 250, 0, 'activo', NOW(), $1)
    `, [adminId])

    // Lote 2: 251 a 350 (100 vouchers, preparado)
    await client.query(`
      INSERT INTO lotes_voucher (
        numero_desde,
        numero_hasta,
        ultimo_numero_llamado,
        estado,
        creado_por
      )
      VALUES (251, 350, 250, 'preparado', $1)
    `, [adminId])
    console.log('[OK] 2 Lotes creados: Lote 1 (1-250, activo) y Lote 2 (251-350, preparado).')

    // 7. Configuracion del sistema
    const configuraciones = [
      ['kiosko_web_activo', 'false', 'Habilita URL/QR publica para generar turno desde celular o por empleado.'],
      ['modo_generacion_turnos', 'voucher_fisico', 'Modo activo: voucher_fisico | kiosko_web'],
      ['alerta_vouchers_restantes', '20', 'Alertar al admin cuando queden N vouchers en el lote.'],
      ['mostrar_estimado_espera', 'true', 'Mostrar estimado de espera en TV cuando hay turnos en espera.'],
      ['zona_horaria', 'America/Tegucigalpa', 'Zona horaria del sistema para calculo de fecha y cambio de dia.'],
      ['kiosko_tope_diario', '0', 'Tope maximo de turnos diarios por kiosko (0 = ilimitado).'],
      ['kiosko_url_base', '', 'URL base publica para seguimiento QR (vacio = autodeteccion LAN).'],
      ['voz_anuncio_activa', 'true', 'Habilita el anuncio de voz sintetica en pantallas de TV.'],
      ['impresora_ip', '', 'IP de la impresora de tickets en la LAN (vacio = impresion desactivada).'],
      ['impresora_puerto', '9100', 'Puerto TCP de la impresora ESC/POS (estandar: 9100).'],
      ['impresora_activa', 'false', 'Habilita la impresion directa ESC/POS desde el servidor.'],
      ['tv_escala_turnos', '100', 'Escala porcentual para el tamaño de los números de turno en pantalla TV (75 a 140, defecto: 100).'],
      ['tv_escala_principal', '100', 'Escala porcentual del número de turno principal y banner de mesa en TV (75 a 140, defecto: 100).'],
      ['tv_escala_secundaria', '100', 'Escala porcentual de las tarjetas del historial de turnos anteriores en TV (75 a 140, defecto: 100).'],
      ['kiosko_impresion_automatica', 'false', 'Envío directo del comprobante a la impresora ESC/POS al generar un turno en modo tablet (true/false).']
    ]

    for (const [clave, valor, descripcion] of configuraciones) {
      await client.query(`
        INSERT INTO configuracion (clave, valor, descripcion, actualizado_en)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (clave) DO UPDATE
          SET valor = EXCLUDED.valor,
              descripcion = EXCLUDED.descripcion,
              actualizado_en = NOW()
      `, [clave, valor, descripcion])
    }
    console.log('[OK] Parametros de configuracion actualizados (kiosko desactivado, modo voucher fisico).')

    await client.query('COMMIT')

    console.log('\n[DONE] Seed completado exitosamente.')
    console.log('----------------------------------------------------')
    console.log('Credenciales configuradas:')
    console.log('  Admin:       usuario: admin   | contrasena: Admin2026!')
    console.log('  Operadores:  op1 a op5        | contrasena: Operador2026!')
    console.log('Mesas:         10 mesas listas (Mesa 1 a Mesa 10)')
    console.log('Lotes:         Lote 1 (1-250 activo), Lote 2 (251-350 preparado)')
    console.log('Configuracion: Kiosko desactivado | Modo voucher fisico')
    console.log('----------------------------------------------------')
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('[FAIL] Error ejecutando seed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

seed()
