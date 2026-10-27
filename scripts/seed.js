'use strict';

/**
 * ARCHIVO: scripts/seed.js
 * DESCRIPCIÓN: Puebla la base de datos con los datos iniciales de prueba y estado base operativo:
 *              administradores, operadores con contraseñas bcrypt reales, mesas inactivas,
 *              lote inicial activo y las 24 claves de configuración del sistema v2.1.
 * EJECUCIÓN: node scripts/seed.js
 *            npm run seed
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
    // Fallback nativo: cargar variables si dotenv no esta instalado aun
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
  console.error('----------------------------------------------------------------------')
  console.error('Si clonaste el repositorio recientemente, debes instalar sus modulos:')
  console.error('    npm install')
  console.error('')
  console.error('O si estas ejecutando con Docker Desktop:')
  console.error('    docker compose exec app node scripts/seed.js')
  console.error('----------------------------------------------------------------------\n')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || 'turnero')}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || process.env.PGBOUNCER_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
})

const COST = parseInt(process.env.BCRYPT_COST || '12', 10)

async function seed() {
  console.log('[INFO] Iniciando seed del sistema Turnero 2026...')
  let client
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      client = await pool.connect()
      break
    } catch (err) {
      if (attempt === 10) throw err
      console.log(`[INFO] Esperando conexion con base de datos para seed (intento ${attempt}/10)...`)
      await new Promise(r => setTimeout(r, 1500))
    }
  }

  try {
    console.log('[INFO] Generando credenciales y hashes bcrypt...')
    const adminHash    = await bcrypt.hash('soporte',        COST)
    const admin2Hash   = await bcrypt.hash('soporte',       COST)
    const operadorHash = await bcrypt.hash('Operador2026!', COST)

    await client.query('BEGIN')

    // 1. Limpieza total
    await client.query(`
      TRUNCATE turnos, lotes_voucher, audit_log, mesas, usuarios, kiosko_contador_diario
      RESTART IDENTITY CASCADE
    `)
    await client.query('ALTER SEQUENCE IF EXISTS seq_numero_lote RESTART WITH 1')
    console.log('[OK] Tablas truncadas y secuencias reiniciadas a 1.')

    // 2. Insertar 2 Administradores
    const resAdmin = await client.query(`
      INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
      VALUES ($1, $2, $3, $4, true)
      RETURNING id
    `, ['admin', 'Administrador del Sistema', adminHash, 'admin'])
    const adminId = resAdmin.rows[0].id

    await client.query(`
      INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
      VALUES ($1, $2, $3, $4, true)
    `, ['admin2', 'Administrador de Soporte', admin2Hash, 'admin'])

    // 3. Insertar 5 Operadores
    for (let i = 1; i <= 5; i++) {
      await client.query(`
        INSERT INTO usuarios (username, nombre_completo, password_hash, rol, activo)
        VALUES ($1, $2, $3, $4, true)
      `, [`op${i}`, `Operador ${i}`, operadorHash, 'operador'])
    }
    console.log('[OK] 2 Administradores y 5 Operadores insertados.')

    // 4. Insertar 10 Mesas
    for (let i = 1; i <= 10; i++) {
      await client.query(`
        INSERT INTO mesas (numero, nombre, estado, operador_id)
        VALUES ($1, $2, 'inactiva', NULL)
      `, [i, `Mesa ${i}`])
    }
    console.log('[OK] 10 Mesas creadas (Mesa 1 a Mesa 10, estado inactiva).')

    // 5. Insertar 1 Lote de 500 Vouchers (activo)
    await client.query(`
      INSERT INTO lotes_voucher (numero_desde, numero_hasta, ultimo_numero_llamado, estado, fecha_activacion, creado_por)
      VALUES (1, 500, 0, 'activo', NOW(), $1)
    `, [adminId])
    console.log('[OK] 1 Lote creado: Lote 1 (1-500, activo).')

    // 6. Configuracion del sistema (21 claves - sincronizado con 001_tablas_datos.sql y 004_complementos.sql)
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
      ['impresora_canal',             'directa',                                'Canal de impresion: directa (red LAN ESC/POS), sistema (dialogo del navegador) o bluetooth.'],
      ['impresora_ancho_papel',       '58',                                     'Ancho del papel termico en milimetros: 58 (32 caracteres) o 80 (48 caracteres).'],
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
        INSERT INTO configuracion (clave, valor, descripcion, actualizado_en)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (clave) DO UPDATE
          SET valor          = EXCLUDED.valor,
              descripcion    = EXCLUDED.descripcion,
              actualizado_en = NOW()
      `, [clave, valor, descripcion])
    }
    console.log('[OK] 24 parametros de configuracion actualizados.')

    await client.query('COMMIT')
    try {
      const Redis = require('ioredis')
      const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
      await redisClient.flushall()
      await redisClient.quit()
    } catch (_) {}

    console.log('\n[DONE] Seed completado exitosamente.')
    console.log('----------------------------------------------------')
    console.log('Credenciales configuradas:')
    console.log('  Admin 1:    usuario: admin  | contrasena: soporte')
    console.log('  Admin 2:    usuario: admin2 | contrasena: soporte')
    console.log('  Operadores: op1 a op5       | contrasena: Operador2026!')
    console.log('Mesas:         10 mesas listas (Mesa 1 a Mesa 10)')
    console.log('Lotes:         Lote 1 (1-500, activo)')
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