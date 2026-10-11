-- =============================================================================
-- MIGRACION 003 — Correcciones de Auditoría de Base de Datos
-- Turnero de Matrículas 2026 v2.1
--
-- Hallazgos resueltos:
--   DB-001 [CRÍTICO]: Invariante 3 — Crear UNIQUE INDEX uq_turnos_mesa_activa
--   DB-003 [CRÍTICO]: Invariante 6 — Trigger inmutable sobre audit_log (solo-INSERT)
--   DB-005 [ALTO]:    Función almacenada atómica fn_llamar_siguiente (1 round-trip)
--   DB-006 [ALTO]:    Añadir 'TURNO_RELLAMADO' al CHECK de audit_log.accion
--   DB-007 [ALTO]:    Idempotencia contra doble clic en fn_llamar_siguiente
--   DB-008 [ALTO]:    Alerta única atómica al agotarse el lote
--   DB-013 [MEDIO]:   Índices faltantes en Foreign Keys (turnos, audit_log)
--   DB-014 [BAJO]:    Índice UNIQUE en LOWER(usuarios.username)
--   DB-015 [BAJO]:    Trigger de no-regresión en lotes_voucher.ultimo_numero_llamado
-- =============================================================================

BEGIN TRANSACTION;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. DB-001: Garantizar Invariante 3 (Máx 1 turno 'en_atencion' por mesa)
-- ─────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS ix_turnos_mesa_activa;
DROP INDEX IF EXISTS uq_turnos_mesa_activa;

CREATE UNIQUE INDEX uq_turnos_mesa_activa
    ON turnos (mesa_id)
    WHERE estado = 'en_atencion';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. DB-003: Garantizar Invariante 6 (audit_log es estrictamente solo-INSERT)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_bloquear_modificacion_audit_log()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log es inmutable. No se permite UPDATE ni DELETE (SQLSTATE: 42501)';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_inmutable ON audit_log;
CREATE TRIGGER trg_audit_log_inmutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION fn_bloquear_modificacion_audit_log();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. DB-006: Ampliar CHECK de audit_log.accion para incluir TURNO_RELLAMADO
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE audit_log
    DROP CONSTRAINT IF EXISTS audit_log_accion_check;

ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_accion_check
    CHECK (accion IN (
        -- Turno
        'TURNO_GENERADO',
        'TURNO_LLAMADO',
        'TURNO_RELLAMADO',
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
        'OPERADOR_ASIGNADO',
        'OPERADOR_LIBERADO',
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
-- 4. DB-013: Índices para Foreign Keys (elimina Seq Scans en cascada y joins)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ix_turnos_operador_id ON turnos (operador_id);
CREATE INDEX IF NOT EXISTS ix_turnos_mesa_id     ON turnos (mesa_id);
CREATE INDEX IF NOT EXISTS ix_audit_turno_id     ON audit_log (turno_id);
CREATE INDEX IF NOT EXISTS ix_audit_mesa_id      ON audit_log (mesa_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. DB-014: Unicidad de usuarios insensitiva a mayúsculas
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_username_lower
    ON usuarios (LOWER(username));

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. DB-015: Trigger de no-regresión en lotes_voucher.ultimo_numero_llamado
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_check_lote_no_regresion()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.ultimo_numero_llamado < OLD.ultimo_numero_llamado THEN
        RAISE EXCEPTION 'El progreso del lote no puede retroceder de % a %',
            OLD.ultimo_numero_llamado, NEW.ultimo_numero_llamado;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lotes_no_regresion ON lotes_voucher;
CREATE TRIGGER trg_lotes_no_regresion
    BEFORE UPDATE ON lotes_voucher
    FOR EACH ROW EXECUTE FUNCTION fn_check_lote_no_regresion();

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. DB-005, DB-007, DB-008: Función SQL atómica de 1 Round-Trip fn_llamar_siguiente
--    - Bloqueo ordenado: mesas -> lotes_voucher -> turnos (cero deadlocks)
--    - Idempotencia: doble clic < 1.5s devuelve el turno actual sin quemar número
--    - Avance atómico y control de fin de lote en una sola ejecución del motor
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_llamar_siguiente(
    p_mesa_id BIGINT,
    p_operador_id BIGINT
)
RETURNS TABLE (
    turno_id BIGINT,
    turno_numero INTEGER,
    llamado_en TIMESTAMPTZ,
    mesa_id BIGINT,
    mesa_numero INTEGER,
    mesa_nombre VARCHAR(60),
    lote_id BIGINT,
    lote_numero INTEGER,
    numero_hasta INTEGER,
    ultimo_llamado INTEGER,
    vouchers_restantes INTEGER,
    proximo_numero INTEGER,
    es_lote_agotado BOOLEAN,
    es_idempotente BOOLEAN
) LANGUAGE plpgsql AS $$
DECLARE
    v_mesa RECORD;
    v_lote RECORD;
    v_turno_existente RECORD;
    v_nuevo_numero INTEGER;
    v_turno_nuevo_id BIGINT;
    v_llamado_en TIMESTAMPTZ;
    v_vouchers_restantes INTEGER;
    v_proximo INTEGER;
    v_es_agotado BOOLEAN := FALSE;
BEGIN
    -- 1. Bloqueo y verificación de la mesa (lock a nivel de fila)
    SELECT m.id, m.numero, m.nombre, m.estado, m.operador_id
    INTO v_mesa
    FROM mesas m
    WHERE m.id = p_mesa_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Mesa % no encontrada', p_mesa_id USING ERRCODE = 'P0002';
    END IF;

    IF v_mesa.estado <> 'activa' THEN
        RAISE EXCEPTION 'Mesa en estado "%". Solo mesas activas pueden llamar.', v_mesa.estado USING ERRCODE = 'P0001';
    END IF;

    IF v_mesa.operador_id IS DISTINCT FROM p_operador_id THEN
        RAISE EXCEPTION 'Esta mesa no te está asignada' USING ERRCODE = 'P0001';
    END IF;

    -- 2. Idempotencia ante doble clic rápido (< 1.5 segundos)
    SELECT t.id, t.numero, t.llamado_en, t.lote_id
    INTO v_turno_existente
    FROM turnos t
    WHERE t.mesa_id = p_mesa_id AND t.estado = 'en_atencion'
    LIMIT 1;

    IF FOUND AND (NOW() - v_turno_existente.llamado_en) < INTERVAL '1.5 second' THEN
        -- Retornar el turno ya activo sin quemar un nuevo voucher
        SELECT lv.numero_lote, lv.numero_hasta, lv.ultimo_numero_llamado
        INTO v_lote
        FROM lotes_voucher lv WHERE lv.id = v_turno_existente.lote_id;

        v_vouchers_restantes := GREATEST(0, v_lote.numero_hasta - v_lote.ultimo_numero_llamado);
        IF v_lote.ultimo_numero_llamado + 1 <= v_lote.numero_hasta THEN
            v_proximo := v_lote.ultimo_numero_llamado + 1;
        ELSE
            v_proximo := NULL;
        END IF;

        RETURN QUERY SELECT
            v_turno_existente.id,
            v_turno_existente.numero,
            v_turno_existente.llamado_en,
            v_mesa.id,
            v_mesa.numero,
            v_mesa.nombre,
            v_turno_existente.lote_id,
            v_lote.numero_lote,
            v_lote.numero_hasta,
            v_lote.ultimo_numero_llamado,
            v_vouchers_restantes,
            v_proximo,
            FALSE,
            TRUE;
        RETURN;
    END IF;

    -- 3. Bloqueo y verificación del lote activo (FOR UPDATE serializado)
    SELECT lv.id, lv.numero_lote, lv.numero_desde, lv.numero_hasta, lv.ultimo_numero_llamado
    INTO v_lote
    FROM lotes_voucher lv
    WHERE lv.estado = 'activo'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No hay un lote activo. El admin debe activar un lote antes de llamar turnos.' USING ERRCODE = 'P0001';
    END IF;

    -- 4. Verificar si el lote ya estaba agotado antes de este llamado
    IF v_lote.ultimo_numero_llamado >= v_lote.numero_hasta THEN
        UPDATE lotes_voucher
        SET estado = 'agotado', fecha_cierre = NOW()
        WHERE id = v_lote.id AND estado = 'activo';

        RAISE EXCEPTION 'El lote de vouchers se ha agotado. El admin debe extenderlo o crear uno nuevo.' USING ERRCODE = 'P0001';
    END IF;

    -- 5. Finalizar turno anterior de esta mesa (si existía)
    UPDATE turnos
    SET estado = 'atendido'
    WHERE turnos.mesa_id = p_mesa_id AND turnos.estado = 'en_atencion';

    -- 6. Avanzar contador del lote de forma atómica
    v_nuevo_numero := v_lote.ultimo_numero_llamado + 1;

    UPDATE lotes_voucher
    SET ultimo_numero_llamado = v_nuevo_numero
    WHERE id = v_lote.id;

    -- 7. Crear el nuevo turno directo en 'en_atencion'
    v_llamado_en := NOW();
    INSERT INTO turnos (
        numero, lote_id, estado, origen, mesa_id, operador_id, llamado_en
    ) VALUES (
        v_nuevo_numero, v_lote.id, 'en_atencion', 'voucher_fisico', p_mesa_id, p_operador_id, v_llamado_en
    )
    RETURNING id INTO v_turno_nuevo_id;

    -- 8. Si este llamado fue el último voucher, marcar agotado atómicamente
    IF v_nuevo_numero >= v_lote.numero_hasta THEN
        UPDATE lotes_voucher
        SET estado = 'agotado', fecha_cierre = NOW()
        WHERE id = v_lote.id;
        v_es_agotado := TRUE;
    END IF;

    v_vouchers_restantes := GREATEST(0, v_lote.numero_hasta - v_nuevo_numero);
    IF v_nuevo_numero + 1 <= v_lote.numero_hasta THEN
        v_proximo := v_nuevo_numero + 1;
    ELSE
        v_proximo := NULL;
    END IF;

    RETURN QUERY SELECT
        v_turno_nuevo_id,
        v_nuevo_numero,
        v_llamado_en,
        v_mesa.id,
        v_mesa.numero,
        v_mesa.nombre,
        v_lote.id,
        v_lote.numero_lote,
        v_lote.numero_hasta,
        v_nuevo_numero,
        v_vouchers_restantes,
        v_proximo,
        v_es_agotado,
        FALSE;
END;
$$;

COMMIT TRANSACTION;
