-- =============================================================================
-- MIGRACIÓN 002 — Eliminar rol 'supervisor', unificar en dos roles: operador y admin
-- Fecha: 2026-10-11
-- Descripción:
--   El sistema operará con solo dos roles: operador y admin.
--   Los usuarios con rol 'supervisor' son promovidos a 'admin'.
--   Se actualiza el CHECK constraint de la tabla usuarios.
-- =============================================================================

BEGIN;

-- 1. Promover supervisores existentes a admin
UPDATE usuarios
  SET rol = 'admin', actualizado_en = NOW()
  WHERE rol = 'supervisor';

-- 2. Eliminar el CHECK constraint existente sobre la columna rol
ALTER TABLE usuarios
  DROP CONSTRAINT IF EXISTS usuarios_rol_check;

-- 3. Agregar nuevo CHECK constraint solo con los dos roles válidos
ALTER TABLE usuarios
  ADD CONSTRAINT usuarios_rol_check
    CHECK (rol IN ('operador', 'admin'));

-- 4. Actualizar comentario de tabla
COMMENT ON TABLE usuarios IS 'Operadores y administradores del sistema (2 roles: operador, admin)';

-- 5. Verificar resultado
SELECT rol, COUNT(*) AS n FROM usuarios GROUP BY rol ORDER BY rol;

COMMIT;

