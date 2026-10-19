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
    `postgresql://${process.env.DB_USER || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || 'turnero')}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
});

// 19 claves sincronizadas con 001_tablas_datos.sql (migracion consolidada v2.1)
const sql = `
INSERT INTO configuracion (clave, valor, descripcion) VALUES
  ('alerta_vouchers_restantes',   '20',                                    'Umbral de vouchers restantes en el lote activo para emitir alerta al administrador (1 a 500).'),
  ('modo_generacion_turnos',      'voucher_fisico',                         'Modo operativo activo del sistema: voucher_fisico (papel) o kiosko_web (digital).'),
  ('kiosko_web_activo',           'false',                                  'Habilitar toma de turnos en autoservicio o tablet (Kiosko Web).'),
  ('mostrar_estimado_espera',     'true',                                   'Mostrar u ocultar la estimacion de tiempo de espera en la pantalla publica de TV.'),
  ('zona_horaria',                'America/Tegucigalpa',                    'Zona horaria oficial del sistema para registro de marcas de tiempo y cortes diarios.'),
  ('kiosko_tope_diario',          '0',                                      'Limite maximo de turnos diarios emitidos por Kiosko Web (0 = sin limite).'),
  ('kiosko_url_base',             '',                                       'URL local (LAN) del kiosko para acceso desde la red interna y codigo QR (vacio = autodeteccion).'),
  ('voz_anuncio_activa',          'true',                                   'Reproducir anuncio por voz sintetica en la pantalla publica al llamar cada turno.'),
  ('impresora_ip',                '',                                       'Direccion IP de la impresora termica ESC/POS en la red local.'),
  ('impresora_puerto',            '9100',                                   'Puerto TCP de la impresora termica ESC/POS (estandar: 9100).'),
  ('impresora_activa',            'false',                                  'Habilitar la impresion fisica directa de tickets desde el servidor via LAN.'),
  ('tv_escala_turnos',            '100',                                    'Escala porcentual para el tamano de los numeros de turno en pantalla TV, compatibilidad (75-140).'),
  ('tv_escala_principal',         '100',                                    'Escala porcentual del numero de turno principal en pantalla TV (75-140).'),
  ('tv_escala_secundaria',        '100',                                    'Escala porcentual de turnos anteriores y banner de mesa en TV (75-140).'),
  ('kiosko_impresion_automatica', 'false',                                  'Imprimir comprobante automaticamente al generar turno en modo tablet.'),
  ('kiosko_url_publica',          'https://afternoon-bucket-hesitate.ngrok-free.app', 'URL publica (Internet / datos moviles) para acceso de participantes al kiosko y seguimiento QR.'),
  ('kiosko_modo_uso',             'asistido',                               'Modalidad del kiosko: asistido (tablet con operador) / estudiante (autoservicio movil).'),
  ('fondo_imagen_url',            '',                                       'URL o ruta de la imagen institucional de fondo para las pantallas del sistema.'),
  ('fondo_imagen_activa',         'false',                                  'Activar la imagen de fondo institucional en las pantallas del sistema.')
ON CONFLICT (clave) DO UPDATE
  SET valor       = EXCLUDED.valor,
      descripcion = EXCLUDED.descripcion,
      actualizado_en = NOW();
`;

pool.query(sql)
  .then(() => {
    console.log('[OK] CONFIGURACION INICIALIZADA EXITOSAMENTE (19 claves, kiosko desactivado)');
    pool.end();
  })
  .catch(err => {
    console.error('[FAIL] Error inicializando configuracion:', err.message);
    pool.end();
  });