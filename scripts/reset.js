'use strict'

/**
 * Script de Reseteo Total — Turnero de Matriculas 2026 (v2.1)
 *
 * Accion:
 * - Vacia completamente todas las tablas operativas: turnos, lotes, mesas, audit_log y usuarios.
 * - Reinicia secuencias numericas.
 * - Crea UNICAMENTE el usuario administrador: admin / soporte
 * - Deja 0 mesas, 0 lotes y 0 operadores.
 * - Limpia llaves en Redis si esta disponible.
 * - Cero emojis en salida.
 */

const fs = require('fs')
const path = require('path')

const envPath = fs.existsSync(path.resolve(__dirname, '../.env'))
  ? path.resolve(__dirname, '../.env')
  : path.resolve(__dirname, '../.env.development')

if (fs.existsSync(envPath)) {
  try {
    require('dotenv').config({ path: envPath })
  } catch (e) {
    try {
      const envContent = fs.readFileSync(envPath, 'utf8')
      for (const line of envContent.split(/\r?\n/)) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/)
        if (match && !process.env[match[1]]) {
          let val = (match[2] || '').trim()
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
          }
          process.env[match[1]] = val
        }
      }
    } catch (_) {}
  }
}

let bcrypt, Pool
try {
  bcrypt = require('bcrypt')
  Pool = require('pg').Pool
} catch (err) {
  console.error('\n[ERROR] Faltan dependencias de Node.js en este equipo: ' + err.message)
  console.error('Si clonaste el repositorio recientemente, ejecuta primero: npm install\n')
  process.exit(1)
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
    const adminHash = await bcrypt.hash('soporte', COST)

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

    // 4. Restaurar configuracion base (21 claves completas)
    const configuraciones = [
      ['alerta_vouchers_restantes',   '20',                                    'Umbral de vouchers restantes en el lote activo para emitir alerta al administrador (1 a 500).'],
      ['modo_generacion_turnos',      'voucher_fisico',                         'Modo operativo activo del sistema: voucher_fisico (papel) o kiosko_web (digital).'],
      ['kiosko_web_activo',           'false',                                  'Habilitar toma de turnos en autoservicio o tablet (Kiosko Web).'],
      ['mostrar_estimado_espera',     'true',                                   'Mostrar u ocultar la estimacion de tiempo de espera en la pantalla publica de TV.'],
      ['zona_horaria',                'America/Tegucigalpa',                    'Zona horaria oficial del sistema para registro de marcas de tiempo y cortes diarios.'],
      ['kiosko_tope_diario',          '0',                                      'Limite maximo de turnos diarios emitidos por Kiosko Web (0 = sin limite).'],
      ['kiosko_url_base',             '',                                       'URL local (LAN) del kiosko para acceso desde la red interna y codigo QR (vacio = autodeteccion).'],
      ['voz_anuncio_activa',          'true',                                   'Reproducir anuncio por voz sintetica en la pantalla publica al llamar cada turno.'],
      ['impresora_ip',                '',                                       'Direccion IP de la impresora termica ESC/POS en la red local.'],
      ['impresora_puerto',            '9100',                                   'Puerto TCP de la impresora termica ESC/POS (estandar: 9100).'],
      ['impresora_activa',            'false',                                  'Habilitar la impresion fisica directa de tickets desde el servidor via LAN.'],
      ['tv_escala_turnos',            '100',                                    'Escala porcentual para el tamano de los numeros de turno en pantalla TV, compatibilidad (75-140).'],
      ['tv_escala_principal',         '100',                                    'Escala porcentual del numero de turno principal en pantalla TV (75-140).'],
      ['tv_escala_secundaria',        '100',                                    'Escala porcentual de turnos anteriores y banner de mesa en TV (75-140).'],
      ['kiosko_impresion_automatica', 'false',                                  'Imprimir comprobante automaticamente al generar turno en modo tablet.'],
      ['kiosko_url_publica',          '',                                       'URL publica opcional para acceso de participantes al kiosko (vacio = red local LAN).'],
      ['kiosko_modo_uso',             'asistido',                               'Modalidad del kiosko: asistido (tablet con operador) / estudiante (autoservicio movil).'],
      ['fondo_imagen_url',            '',                                       'URL o ruta de la imagen institucional de fondo para las pantallas del sistema.'],
      ['fondo_imagen_activa',         'false',                                  'Activar la imagen de fondo institucional en las pantallas del sistema.'],
      ['fondo_imagen_escala',         '100',                                    'Escala porcentual del fondo de pantalla institucional (50-200%).'],
      ['tv_opacidad_principal',       '100',                                    'Opacidad del fondo de la tarjeta principal (turno en curso) en pantalla TV. Entero de 20 a 100; 100 = completamente opaco.'],
      ['tv_opacidad_secundaria',      '100',                                    'Opacidad del fondo de las cuatro tarjetas de turnos anteriores en pantalla TV. Entero de 20 a 100; 100 = completamente opaco.']
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
    console.log('  Usuarios:    1 usuario (admin / soporte)')
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
