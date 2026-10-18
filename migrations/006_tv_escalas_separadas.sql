-- ==============================================================================
-- MIGRACIÓN 006: Dos escalas independientes para TV (principal y anteriores/banner)
-- Sistema Turnero de Matrículas 2026 (v2.1)
-- ==============================================================================

DO $$
DECLARE
  v_actual VARCHAR(255) := '100';
BEGIN
  -- Tomar el valor actual de tv_escala_turnos como punto de partida si existe
  SELECT valor INTO v_actual FROM configuracion WHERE clave = 'tv_escala_turnos';
  IF v_actual IS NULL OR v_actual = '' THEN
    v_actual := '100';
  END IF;

  INSERT INTO configuracion (clave, valor, descripcion)
  VALUES 
    ('tv_escala_principal', v_actual, 'Escala porcentual para el número de turno principal en pantalla TV (75 a 140, defecto: 100).'),
    ('tv_escala_secundaria', v_actual, 'Escala porcentual para turnos anteriores y banner de mesa en TV (75 a 140, defecto: 100).')
  ON CONFLICT (clave) DO NOTHING;
END $$;
