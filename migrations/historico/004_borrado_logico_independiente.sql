-- =============================================================================
-- MIGRACIÓN 004: BORRADO LÓGICO INDEPENDIENTE CON LIBERACIÓN DE IDENTIFICADORES
-- Turnero de Matrículas 2026 (v2.1)
--
-- Objetivos:
-- 1. Diferenciar claramente 'desactivar' de 'eliminar'.
-- 2. Eliminar oculta permanentemente el registro de la UI/sistema sin romper
--    la integridad referencial ni la auditoría/reportes históricos en la BD.
-- 3. Liberar números de mesa y usernames al ser eliminados para evitar errores
--    de duplicidad al volver a crearlos con el mismo número o username.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. TABLA: mesas
-- -----------------------------------------------------------------------------
ALTER TABLE mesas ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ DEFAULT NULL;

-- Permitir estado 'eliminada' en el check constraint
ALTER TABLE mesas DROP CONSTRAINT IF EXISTS ck_mesas_estado;
ALTER TABLE mesas ADD CONSTRAINT ck_mesas_estado 
    CHECK (estado IN ('activa', 'pausada', 'inactiva', 'eliminada'));

-- Reemplazar unicidad global de número por índice parcial (solo mesas no eliminadas)
ALTER TABLE mesas DROP CONSTRAINT IF EXISTS ux_mesas_numero;
DROP INDEX IF EXISTS ux_mesas_numero;
DROP INDEX IF EXISTS ux_mesas_numero_activas;
CREATE UNIQUE INDEX ux_mesas_numero_activas 
    ON mesas (numero) 
    WHERE estado != 'eliminada' AND eliminado_en IS NULL;

-- -----------------------------------------------------------------------------
-- 2. TABLA: usuarios
-- -----------------------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ DEFAULT NULL;

-- Reemplazar unicidad global de username por índice parcial (solo usuarios no eliminados)
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS ux_usuarios_username;
DROP INDEX IF EXISTS ux_usuarios_username;
DROP INDEX IF EXISTS ux_usuarios_username_lower;
DROP INDEX IF EXISTS ux_usuarios_username_activos;
CREATE UNIQUE INDEX ux_usuarios_username_activos 
    ON usuarios (LOWER(username)) 
    WHERE eliminado_en IS NULL;

-- -----------------------------------------------------------------------------
-- 3. TABLA: lotes_voucher
-- -----------------------------------------------------------------------------
ALTER TABLE lotes_voucher ADD COLUMN IF NOT EXISTS eliminado_en TIMESTAMPTZ DEFAULT NULL;

-- Permitir estado 'eliminado' en el check constraint
ALTER TABLE lotes_voucher DROP CONSTRAINT IF EXISTS ck_lotes_estado;
ALTER TABLE lotes_voucher ADD CONSTRAINT ck_lotes_estado 
    CHECK (estado IN ('preparado', 'activo', 'pausado', 'agotado', 'cerrado', 'eliminado'));

-- Reemplazar unicidad global de numero_lote por índice parcial (solo lotes no eliminados)
ALTER TABLE lotes_voucher DROP CONSTRAINT IF EXISTS ux_lotes_numero_lote;
DROP INDEX IF EXISTS ux_lotes_numero_lote;
DROP INDEX IF EXISTS ux_lotes_numero_lote_activos;
CREATE UNIQUE INDEX ux_lotes_numero_lote_activos 
    ON lotes_voucher (numero_lote) 
    WHERE estado != 'eliminado' AND eliminado_en IS NULL;
