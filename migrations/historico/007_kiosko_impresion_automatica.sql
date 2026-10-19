-- ==============================================================================
-- MIGRACIÓN 007: Ajuste de impresión automática para kiosko modo tablet
-- Sistema Turnero de Matrículas 2026 (v2.1)
--
-- Agrega la clave de configuración `kiosko_impresion_automatica`.
-- Cuando está en 'true' y el kiosko opera en modo tablet (empleado),
-- el servidor dispara la impresión ESC/POS inmediatamente al generar el turno,
-- sin que el empleado tenga que presionar ningún botón.
-- La clave se ignorará en modo celular (estudiante).
-- ==============================================================================

INSERT INTO configuracion (clave, valor, descripcion)
VALUES (
  'kiosko_impresion_automatica',
  'false',
  'Imprime el comprobante automáticamente al generar un turno en modo tablet (empleado). Requiere impresora ESC/POS configurada y activa. No aplica al modo celular (estudiante).'
)
ON CONFLICT (clave) DO NOTHING;
