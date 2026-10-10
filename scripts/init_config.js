require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
INSERT INTO configuracion (clave, valor, descripcion) VALUES
  ('tiempo_max_atencion_min',   '10',             'Tiempo máximo sugerido por atención (min). Afecta semáforo en admin.'),
  ('tiempo_max_pausa_min',      '15',             'Tiempo máximo de pausa por mesa (min).'),
  ('alerta_vouchers_restantes', '20',             'Alertar al admin cuando queden N vouchers en el lote.'),
  ('modo_generacion_turnos',    'voucher_fisico', 'Modo activo: voucher_fisico | kiosko_web | mixto'),
  ('kiosko_web_activo',         'true',           'Habilita URL/QR pública para generar turno desde celular o por empleado.'),
  ('mostrar_estimado_espera',   'true',           'Mostrar estimado de espera en TV cuando hay turnos en espera.')
ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor;
`;

pool.query(sql)
  .then(() => {
    console.log('CONFIGURACION INICIALIZADA EXITOSAMENTE');
    pool.end();
  })
  .catch(err => {
    console.error(err);
    pool.end();
  });
