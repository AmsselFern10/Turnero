-- ==============================================================================
-- MIGRACIÓN 002: Parámetro de Escala de Números de Turno en TV
-- Sistema Turnero de Matrículas 2026 (v2.1)
-- ==============================================================================

INSERT INTO configuracion (clave, valor, descripcion)
VALUES (
  'tv_escala_turnos',
  '100',
  'Escala porcentual para el tamaño de los números de turno en pantalla TV (75 a 140, defecto: 100)'
)
ON CONFLICT (clave) DO NOTHING;
