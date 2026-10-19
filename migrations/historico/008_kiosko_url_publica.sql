-- Migración 008: Dirección pública para acceso de estudiantes al kiosko
INSERT INTO configuracion (clave, valor, descripcion)
VALUES (
    'kiosko_url_publica',
    '',
    'Dirección pública (Internet / Datos móviles) para acceso de estudiantes al kiosko y seguimiento QR'
)
ON CONFLICT (clave) DO NOTHING;
