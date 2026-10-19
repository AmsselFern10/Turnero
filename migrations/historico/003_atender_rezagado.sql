-- ==============================================================================
-- MIGRACIÓN 003: Soporte para Atender Rezagados
-- Sistema Turnero de Matrículas 2026 (v2.1)
-- ==============================================================================

-- 1. Actualizar check constraint en audit_log para incluir 'TURNO_REZAGADO'
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_accion_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_accion_check CHECK (accion IN (
    'TURNO_GENERADO',
    'TURNO_LLAMADO',
    'TURNO_RELLAMADO',
    'TURNO_REZAGADO',
    'ATENCION_FINALIZADA',
    'TURNO_CANCELADO',
    'LOTE_CREADO',
    'LOTE_ACTIVADO',
    'LOTE_PAUSADO',
    'LOTE_AGOTADO',
    'LOTE_EXTENDIDO',
    'LOTE_CERRADO',
    'LOTE_NUEVO_DESDE_UNO',
    'LOTE_CONTADOR_AJUSTADO',
    'MESA_ACTIVADA',
    'MESA_PAUSADA',
    'MESA_INACTIVADA',
    'OPERADOR_ASIGNADO',
    'OPERADOR_LIBERADO',
    'LOGIN_EXITOSO',
    'LOGIN_FALLIDO',
    'LOGOUT',
    'USUARIO_CREADO',
    'USUARIO_EDITADO',
    'USUARIO_DESACTIVADO',
    'CONFIG_MODIFICADA',
    'ADMIN_ACTION'
));

-- 2. Actualizar fn_calcular_duraciones_turno() para resetear duraciones en transición cancelado -> en_atencion
CREATE OR REPLACE FUNCTION fn_calcular_duraciones_turno()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- esperando → en_atencion (flujo kiosko_web)
    IF NEW.estado = 'en_atencion' AND OLD.estado = 'esperando' THEN
        NEW.llamado_en          := NOW();
        NEW.duracion_espera_seg := EXTRACT(EPOCH FROM (NOW() - OLD.creado_en))::INTEGER;
    END IF;

    -- cancelado → en_atencion (atender rezagado)
    IF NEW.estado = 'en_atencion' AND OLD.estado = 'cancelado' THEN
        NEW.llamado_en            := NOW();
        NEW.finalizado_en         := NULL;
        NEW.duracion_atencion_seg := NULL;
    END IF;

    -- en_atencion → atendido | cancelado
    IF NEW.estado IN ('atendido', 'cancelado') AND OLD.estado = 'en_atencion' THEN
        NEW.finalizado_en         := NOW();
        NEW.duracion_atencion_seg := EXTRACT(EPOCH FROM (NOW() - OLD.llamado_en))::INTEGER;
    END IF;

    -- esperando → cancelado (kiosko_web cancelado antes de ser llamado)
    IF NEW.estado = 'cancelado' AND OLD.estado = 'esperando' THEN
        NEW.finalizado_en         := NOW();
        NEW.duracion_espera_seg   := EXTRACT(EPOCH FROM (NOW() - OLD.creado_en))::INTEGER;
    END IF;

    RETURN NEW;
END;
$$;

-- 3. Actualizar función de auditoría automática de turnos para registrar TURNO_REZAGADO
CREATE OR REPLACE FUNCTION fn_audit_turno()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_accion VARCHAR(50);
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.estado = 'en_atencion' THEN
            v_accion := 'TURNO_LLAMADO';
        ELSIF NEW.estado = 'esperando' THEN
            v_accion := 'TURNO_GENERADO';
        ELSE
            v_accion := NULL;
        END IF;

    ELSIF TG_OP = 'UPDATE' AND OLD.estado IS DISTINCT FROM NEW.estado THEN
        CASE
            WHEN NEW.estado = 'en_atencion' AND OLD.estado = 'esperando'
                THEN v_accion := 'TURNO_LLAMADO';
            WHEN NEW.estado = 'en_atencion' AND OLD.estado = 'cancelado'
                THEN v_accion := 'TURNO_REZAGADO';
            WHEN NEW.estado = 'atendido'
                THEN v_accion := 'ATENCION_FINALIZADA';
            WHEN NEW.estado = 'cancelado'
                THEN v_accion := 'TURNO_CANCELADO';
            ELSE v_accion := NULL;
        END CASE;
    END IF;

    IF v_accion IS NOT NULL THEN
        INSERT INTO audit_log (turno_id, mesa_id, operador_id, lote_id, accion, metadata_json)
        VALUES (
            NEW.id,
            NEW.mesa_id,
            NEW.operador_id,
            NEW.lote_id,
            v_accion,
            jsonb_build_object(
                'turno_numero',          NEW.numero,
                'lote_numero',           (SELECT numero_lote FROM lotes_voucher WHERE id = NEW.lote_id),
                'origen',                NEW.origen,
                'estado_anterior',       CASE WHEN TG_OP = 'UPDATE' THEN OLD.estado ELSE NULL END,
                'estado_nuevo',          NEW.estado,
                'duracion_espera_seg',   NEW.duracion_espera_seg,
                'duracion_atencion_seg', NEW.duracion_atencion_seg
            )
        );
    END IF;

    RETURN NEW;
END;
$$;

-- 4. Función SQL atómica: Atender Turno Rezagado (1 round-trip)
CREATE OR REPLACE FUNCTION fn_atender_rezagado(
    p_turno_id BIGINT,
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
    vouchers_restantes INTEGER,
    proximo_numero INTEGER,
    origen VARCHAR(20),
    token_consulta VARCHAR(64)
) LANGUAGE plpgsql AS $$
DECLARE
    v_mesa RECORD;
    v_turno RECORD;
    v_lote RECORD;
    v_llamado_en TIMESTAMPTZ;
    v_vouchers_restantes INTEGER := 0;
    v_proximo INTEGER := NULL;
    v_modo_activo VARCHAR(20);
    v_fecha_hoy DATE;
    v_mesa_actual_numero INTEGER;
BEGIN
    -- 1. Determinar modo de generación y fecha oficial
    SELECT COALESCE(valor, 'voucher_fisico') INTO v_modo_activo
    FROM configuracion WHERE clave = 'modo_generacion_turnos';
    IF v_modo_activo IS NULL THEN v_modo_activo := 'voucher_fisico'; END IF;

    v_fecha_hoy := fn_fecha_hoy();

    -- 2. Bloqueo y verificación de la mesa
    SELECT m.id, m.numero, m.nombre, m.estado, m.operador_id
    INTO v_mesa
    FROM mesas m
    WHERE m.id = p_mesa_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Mesa % no encontrada', p_mesa_id USING ERRCODE = 'P0002';
    END IF;

    IF v_mesa.estado <> 'activa' THEN
        RAISE EXCEPTION 'Mesa en estado "%". Solo mesas activas pueden atender.', v_mesa.estado USING ERRCODE = 'P0001';
    END IF;

    IF v_mesa.operador_id IS DISTINCT FROM p_operador_id THEN
        RAISE EXCEPTION 'Esta mesa no te está asignada' USING ERRCODE = 'P0001';
    END IF;

    -- 3. Finalizar turno anterior en atención en esta mesa (coherente con llamar siguiente)
    UPDATE turnos
    SET estado = 'atendido'
    WHERE turnos.mesa_id = p_mesa_id AND turnos.estado = 'en_atencion';

    -- 4. Bloqueo exclusivo del turno rezagado
    SELECT t.id, t.numero, t.estado, t.origen, t.lote_id, t.token_consulta, t.fecha_turno, t.mesa_id
    INTO v_turno
    FROM turnos t
    WHERE t.id = p_turno_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Turno % no encontrado', p_turno_id USING ERRCODE = 'P0002';
    END IF;

    -- Verificar que el turno siga cancelado
    IF v_turno.estado <> 'cancelado' THEN
        SELECT m.numero INTO v_mesa_actual_numero FROM mesas m WHERE m.id = v_turno.mesa_id;
        IF v_mesa_actual_numero IS NOT NULL THEN
            RAISE EXCEPTION 'El turno #% ya fue atendido por Mesa %', v_turno.numero, v_mesa_actual_numero USING ERRCODE = 'P0001';
        ELSE
            RAISE EXCEPTION 'El turno #% ya fue atendido o no está disponible', v_turno.numero USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- 5. Asignar el turno a la mesa como 'en_atencion' con llamado_en = NOW()
    v_llamado_en := NOW();
    UPDATE turnos
    SET estado = 'en_atencion',
        mesa_id = p_mesa_id,
        operador_id = p_operador_id,
        llamado_en = v_llamado_en,
        finalizado_en = NULL,
        duracion_atencion_seg = NULL
    WHERE turnos.id = p_turno_id;

    -- 6. Calcular métricas sin alterar contador del lote ni del kiosko
    IF v_modo_activo = 'kiosko_web' THEN
        SELECT COUNT(*)::int INTO v_vouchers_restantes
        FROM turnos WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = v_fecha_hoy;

        SELECT numero INTO v_proximo
        FROM turnos WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = v_fecha_hoy
        ORDER BY numero ASC LIMIT 1;
    ELSE
        SELECT lv.numero_lote, lv.numero_hasta, lv.ultimo_numero_llamado
        INTO v_lote
        FROM lotes_voucher lv WHERE lv.id = v_turno.lote_id;

        IF NOT FOUND THEN
            SELECT lv.id, lv.numero_lote, lv.numero_hasta, lv.ultimo_numero_llamado
            INTO v_lote
            FROM lotes_voucher lv WHERE lv.estado = 'activo' LIMIT 1;
        END IF;

        IF v_lote.numero_hasta IS NOT NULL THEN
            v_vouchers_restantes := GREATEST(0, v_lote.numero_hasta - v_lote.ultimo_numero_llamado);
            IF v_lote.ultimo_numero_llamado + 1 <= v_lote.numero_hasta THEN
                v_proximo := v_lote.ultimo_numero_llamado + 1;
            ELSE
                v_proximo := NULL;
            END IF;
        END IF;
    END IF;

    RETURN QUERY SELECT
        v_turno.id,
        v_turno.numero,
        v_llamado_en,
        v_mesa.id,
        v_mesa.numero,
        v_mesa.nombre,
        v_turno.lote_id,
        COALESCE(v_lote.numero_lote, NULL::INTEGER),
        v_vouchers_restantes,
        v_proximo,
        v_turno.origen,
        v_turno.token_consulta;
END;
$$;
