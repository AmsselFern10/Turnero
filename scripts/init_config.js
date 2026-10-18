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
  ('alerta_vouchers_restantes', '20',                  'Alertar al admin cuando queden N vouchers en el lote.'),
  ('modo_generacion_turnos',    'voucher_fisico',      'Modo activo: voucher_fisico | kiosko_web'),
  ('kiosko_web_activo',         'false',               'Habilita URL/QR publica para generar turno desde celular o por empleado.'),
  ('mostrar_estimado_espera',   'true',                'Mostrar estimado de espera en TV cuando hay turnos en espera.'),
  ('zona_horaria',              'America/Tegucigalpa', 'Zona horaria del sistema para calculo de fecha y cambio de dia.'),
  ('kiosko_tope_diario',        '0',                   'Tope maximo de turnos diarios por kiosko (0 = ilimitado).'),
  ('kiosko_url_base',           '',                    'URL base publica para seguimiento QR (vacio = autodeteccion LAN).'),
  ('voz_anuncio_activa',        'true',                'Habilita el anuncio de voz sintetica en pantallas de TV.'),
  ('impresora_ip',              '',                    'IP de la impresora de tickets en la LAN (vacio = impresion desactivada).'),
  ('impresora_puerto',          '9100',                'Puerto TCP de la impresora ESC/POS (estandar: 9100).'),
  ('impresora_activa',          'false',               'Habilita la impresion directa ESC/POS desde el servidor.')
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
