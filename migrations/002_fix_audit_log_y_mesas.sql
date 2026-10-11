-- =============================================================================
-- MIGRACION 002 — Fix audit_log CHECK + indice unico de operador en mesas
-- Turnero de Matriculas 2026 v2.1
--
-- Problemas corregidos:
--   INC-1: 'OPERADOR_AUTO_ASIGNADO' no estaba en el CHECK -> se elimina el
--          valor incorrecto y se usa 'OPERADOR_ASIGNADO' (ya existente) + se
--          agrega 'OPERADOR_LIBERADO' para la accion liberar-mesa (INC-3).
--   INC-4: No existia indice unico parcial en mesas(operador_id); se crea para
--          garantizar a nivel de BD que un operador no ocupa dos mesas.
-- =============================================================================

BEGIN TRANSACTION;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Ampliar el CHECK de audit_log.accion
--    Se elimina primero por nombre para luego recrearlo con la lista completa.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE audit_log
    DROP CONSTRAINT IF EXISTS audit_log_accion_check;

ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_accion_check
    CHECK (accion IN (
        -- Turno
        'TURNO_GENERADO',
        'TURNO_LLAMADO',
        'ATENCION_FINALIZADA',
        'TURNO_CANCELADO',
        -- Lote
        'LOTE_CREADO',
        'LOTE_ACTIVADO',
        'LOTE_PAUSADO',
        'LOTE_AGOTADO',
        'LOTE_EXTENDIDO',
        'LOTE_CERRADO',
        'LOTE_NUEVO_DESDE_UNO',
        -- Mesa / Operador
        'MESA_ACTIVADA',
        'MESA_PAUSADA',
        'MESA_INACTIVADA',
        'OPERADOR_ASIGNADO',     -- Admin asigna operador a mesa (desde panel)
        'OPERADOR_LIBERADO',     -- Operador libera su mesa via "Cambiar de mesa" (INC-3)
        -- Sesion
        'LOGIN_EXITOSO',
        'LOGIN_FALLIDO',
        'LOGOUT',
        -- Admin
        'USUARIO_CREADO',
        'USUARIO_EDITADO',
        'USUARIO_DESACTIVADO',
        'CONFIG_MODIFICADA',
        'ADMIN_ACTION'
    ));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Indice UNIQUE PARTIAL: un operador -> maxima 1 mesa asignada (INC-4)
--    Garantia de BD complementaria al UPDATE atomico con FOR UPDATE.
--    Eliminar el indice no-unico previo ix_mesas_operador para no duplicar indices.
-- ─────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS ix_mesas_operador;
DROP INDEX IF EXISTS ux_mesas_operador_unico;
CREATE UNIQUE INDEX ux_mesas_operador_unico
    ON mesas (operador_id)
    WHERE operador_id IS NOT NULL;

COMMIT TRANSACTION;