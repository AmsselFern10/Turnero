-- ==============================================================================
-- MIGRACIÓN 011: Opacidad independiente del fondo de tarjetas TV
-- Sistema Turnero de Matrículas 2026 (v2.1)
--
-- Agrega dos claves de configuración para controlar la transparencia del
-- fondo de las tarjetas de la pantalla pública TV:
--   tv_opacidad_principal  : Tarjeta del turno en curso (hero)
--   tv_opacidad_secundaria : Cuatro tarjetas de turnos anteriores
--
-- Rango válido: 20 a 100 (entero %). Defecto 100 = sin cambio visual.
-- ==============================================================================

INSERT INTO configuracion (clave, valor, descripcion)
VALUES
  (
    'tv_opacidad_principal',
    '100',
    'Opacidad del fondo de la tarjeta principal (turno en curso) en pantalla TV. Entero de 20 a 100; 100 = completamente opaco (sin cambio visual).'
  ),
  (
    'tv_opacidad_secundaria',
    '100',
    'Opacidad del fondo de las cuatro tarjetas de turnos anteriores en pantalla TV. Entero de 20 a 100; 100 = completamente opaco (sin cambio visual).'
  )
ON CONFLICT (clave) DO NOTHING;
