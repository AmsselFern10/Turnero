'use strict'

/**
 * Script de Reseteo Total — Turnero de Matriculas 2026 (v2.1)
 *
 * Accion:
 * - Vacia completamente todas las tablas operativas: turnos, lotes, mesas, audit_log y usuarios.
 * - Reinicia secuencias numericas.
 * - Crea UNICAMENTE el usuario administrador: admin / Admin2026!
 * - Deja 0 mesas, 0 lotes y 0 operadores.
 * - Limpia llaves en Redis si esta disponible.
 * - Cero emojis en salida.
 */

const fs = require('fs')
const path = require('path')
const bcrypt = require('bcrypt')
const { Pool } = require('pg')

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

async function resetearSistema() {
  console.log('[INFO] Iniciando reseteo completo del sistema...')

  const client = await pool.connect()

  try {
    const adminHash = await bcrypt.hash('Admin2026!', COST)

    await client.query('BEGIN')

    // 1. Truncate de todas las tablas dependientes
    await client.query(`
      TRUNCATE turnos, lotes_voucher, audit_log, mesas, usuarios, kiosko_contador_diario
      RESTART IDENTITY CASCADE
    `)

    // 2. Reiniciar secuencia de lotes
    await client.query('ALTER SEQUENCE IF EXISTS seq_numero_lote RESTART WITH 1')
    console.log('[OK] Tablas truncadas: turnos, lotes_voucher, audit_log, mesas, usuarios.')

    // 3. Crear UNICAMENTE el usuario admin
    const resAdmin = await client.query(`
      INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
      VALUES ($1, $2, $3, $4, true)
      RETURNING id
    `, ['admin', 'Administrador del Sistema', adminHash, 'admin'])
    const adminId = resAdmin.rows[0].id

    // 4. Restaurar configuracion base
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
      ['impresora_activa', 'false', 'Habilita la impresion directa ESC/POS desde el servidor.']
    ]

    for (const [clave, valor, descripcion] of configuraciones) {
      await client.query(`
        INSERT INTO configuracion (clave, valor, descripcion, actualizado_en, actualizado_por)
        VALUES ($1, $2, $3, NOW(), $4)
        ON CONFLICT (clave) DO UPDATE
          SET valor = EXCLUDED.valor,
              descripcion = EXCLUDED.descripcion,
              actualizado_en = NOW(),
              actualizado_por = EXCLUDED.actualizado_por
      `, [clave, valor, descripcion, adminId])
    }

    await client.query('COMMIT')
    console.log('[OK] Usuario admin creado exitosamente (id: ' + adminId + ').')
    console.log('[OK] Configuracion base restaurada con kiosko inactivo.')

    // 5. Intentar limpiar Redis si esta instalado
    try {
      const Redis = require('ioredis')
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
      const redis = new Redis(redisUrl, {
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: true
      })
      await redis.connect()
      await redis.flushall()
      await redis.quit()
      console.log('[OK] Cache y sesiones de Redis purgadas.')
    } catch (redisErr) {
      console.log('[INFO] Redis no conectado o no requiere purga (' + redisErr.message + ').')
    }

    console.log('\n[DONE] Reseteo finalizado.')
    console.log('----------------------------------------------------')
    console.log('Estado actual del sistema:')
    console.log('  Usuarios:    1 usuario (admin / Admin2026!)')
    console.log('  Operadores:  0')
    console.log('  Mesas:       0')
    console.log('  Lotes:       0')
    console.log('  Turnos:      0')
    console.log('----------------------------------------------------')
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('[FAIL] Error en reseteo:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

resetearSistema()
