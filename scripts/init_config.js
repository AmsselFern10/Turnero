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

const sql = `
INSERT INTO configuracion (clave, valor, descripcion) VALUES
  ('alerta_vouchers_restantes',    '20',                  'Umbral de turnos restantes en el lote activo para emitir alerta al administrador (1 a 500).'),
  ('modo_generacion_turnos',       'voucher_fisico',      'Modo operativo activo del sistema: voucher_fisico (papel) o kiosko_web (digital).'),
  ('kiosko_web_activo',            'false',               'Habilitar toma de turnos en autoservicio o tablet (Kiosko Web).'),
  ('kiosko_modo_uso',              'empleado',            'Modalidad de emisión del kiosko: estudiante (autoservicio libre) o empleado (asistido en recepción).'),
  ('kiosko_tope_diario',           '0',                   'Límite máximo de turnos diarios emitidos por Kiosko Web (0 = sin límite).'),
  ('kiosko_url_base',              '',                    'URL base pública para acceso desde móviles y código QR (vacío = autodetección LAN).'),
  ('kiosko_impresion_automatica',  'false',               'Envío directo del comprobante a la impresora ESC/POS al generar un turno en modo tablet (true/false).'),
  ('mostrar_estimado_espera',      'true',                'Mostrar u ocultar la estimación de tiempo de espera en la pantalla pública de TV.'),
  ('zona_horaria',                 'America/Tegucigalpa', 'Zona horaria oficial del sistema para registro de marcas de tiempo y cortes diarios.'),
  ('voz_anuncio_activa',           'true',                'Reproducir anuncio por voz sintética en la pantalla pública al llamar cada turno.'),
  ('tv_escala_turnos',             '100',                 'Escala porcentual para el tamaño de los números de turno en pantalla TV (75 a 140, defecto: 100).'),
  ('tv_escala_principal',          '100',                 'Escala porcentual del número de turno principal y banner de mesa en TV (75 a 140, defecto: 100).'),
  ('tv_escala_secundaria',         '100',                 'Escala porcentual de las tarjetas del historial de turnos anteriores en TV (75 a 140, defecto: 100).'),
  ('impresora_activa',             'false',               'Habilitar la impresión física directa de tickets desde el servidor vía LAN.'),
  ('impresora_ip',                 '',                    'Dirección IP de la impresora térmica ESC/POS en la red local.'),
  ('impresora_puerto',             '9100',                'Puerto TCP de la impresora térmica ESC/POS (estándar: 9100).')
ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, descripcion = EXCLUDED.descripcion, actualizado_en = NOW();
`;

pool.query(sql)
  .then(() => {
    console.log('[OK] CONFIGURACION INICIALIZADA EXITOSAMENTE (KIOSKO DESACTIVADO)');
    pool.end();
  })
  .catch(err => {
    console.error('[FAIL] Error inicializando configuracion:', err.message);
    pool.end();
  });
