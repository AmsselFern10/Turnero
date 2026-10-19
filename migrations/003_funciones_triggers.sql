-- =============================================================================
-- TURNERO DE MATRICULAS 2026 -- v2.1 (Consolidado)
-- Archivo 3/4: FUNCIONES Y TRIGGERS
-- =============================================================================
-- Incluye todas las funciones y triggers en su version FINAL.
-- fn_atender_rezagado: version corregida (CORRECCION H1) -- no usa v_lote.numero_lote
-- cuando el modo es kiosko_web (evita "record not assigned yet").
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A. Inmutabilidad de audit_log
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_bloquear_modificacion_audit_log()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log es inmutable. No se permite UPDATE ni DELETE (SQLSTATE: 42501)';
END;
$$;

CREATE TRIGGER trg_audit_log_inmutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION fn_bloquear_modificacion_audit_log();

-- ---------------------------------------------------------------------------
-- B. Actualizacion automatica de actualizado_en
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_actualizado_en()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.actualizado_en = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_usuarios_actualizado_en
    BEFORE UPDATE ON usuarios
    FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

CREATE TRIGGER trg_mesas_actualizado_en
    BEFORE UPDATE ON mesas
    FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

CREATE TRIGGER trg_lotes_actualizado_en
    BEFORE UPDATE ON lotes_voucher
    FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

-- ---------------------------------------------------------------------------
-- C. Calculo automatico de duraciones y transiciones de turnos
--    Version final: incluye rama cancelado -> en_atencion (rezagado)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_calcular_duraciones_turno()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- esperando -> en_atencion (flujo kiosko_web)
    IF NEW.estado = 'en_atencion' AND OLD.estado = 'esperando' THEN
        NEW.llamado_en          := NOW();
        NEW.duracion_espera_seg := EXTRACT(EPOCH FROM (NOW() - OLD.creado_en))::INTEGER;
    END IF;

    -- cancelado -> en_atencion (atender rezagado)
    IF NEW.estado = 'en_atencion' AND OLD.estado = 'cancelado' THEN
        NEW.llamado_en            := NOW();
        NEW.finalizado_en         := NULL;
        NEW.duracion_atencion_seg := NULL;
    END IF;

    -- en_atencion -> atendido | cancelado
    IF NEW.estado IN ('atendido', 'cancelado') AND OLD.estado = 'en_atencion' THEN
        NEW.finalizado_en         := NOW();
        NEW.duracion_atencion_seg := EXTRACT(EPOCH FROM (NOW() - OLD.llamado_en))::INTEGER;
    END IF;

    -- esperando -> cancelado (kiosko_web cancelado antes de ser llamado)
    IF NEW.estado = 'cancelado' AND OLD.estado = 'esperando' THEN
        NEW.finalizado_en       := NOW();
        NEW.duracion_espera_seg := EXTRACT(EPOCH FROM (NOW() - OLD.creado_en))::INTEGER;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_turnos_duraciones
    BEFORE UPDATE ON turnos
    FOR EACH ROW EXECUTE FUNCTION fn_calcular_duraciones_turno();

-- ---------------------------------------------------------------------------
-- D. Auditoria automatica de turnos
--    Version final: incluye caso TURNO_REZAGADO (cancelado -> en_atencion)
-- ---------------------------------------------------------------------------
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

CREATE TRIGGER trg_audit_turnos_insert
    AFTER INSERT ON turnos
    FOR EACH ROW EXECUTE FUNCTION fn_audit_turno();

CREATE TRIGGER trg_audit_turnos_update
    AFTER UPDATE ON turnos
    FOR EACH ROW
    WHEN (OLD.estado IS DISTINCT FROM NEW.estado)
    EXECUTE FUNCTION fn_audit_turno();

-- ---------------------------------------------------------------------------
-- E. Control de no-regresion de lotes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_check_lote_no_regresion()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.ultimo_numero_llamado < OLD.ultimo_numero_llamado THEN
        IF current_setting('app.permitir_retroceso_lote', true) IN ('on', 'true') THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION 'El progreso del lote no puede retroceder de % a % sin autorizacion explicita',
            OLD.ultimo_numero_llamado, NEW.ultimo_numero_llamado;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lotes_no_regresion
    BEFORE UPDATE ON lotes_voucher
    FOR EACH ROW EXECUTE FUNCTION fn_check_lote_no_regresion();

-- ---------------------------------------------------------------------------
-- F. Llamar siguiente turno (transaccion atomica)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_llamar_siguiente(
    p_mesa_id     BIGINT,
    p_operador_id BIGINT
)
RETURNS TABLE (
    turno_id           BIGINT,
    turno_numero       INTEGER,
    llamado_en         TIMESTAMPTZ,
    mesa_id            BIGINT,
    mesa_numero        INTEGER,
    mesa_nombre        VARCHAR(60),
    lote_id            BIGINT,
    lote_numero        INTEGER,
    numero_hasta       INTEGER,
    ultimo_llamado     INTEGER,
    vouchers_restantes INTEGER,
    proximo_numero     INTEGER,
    es_lote_agotado    BOOLEAN,
    es_idempotente     BOOLEAN,
    modo               VARCHAR(20)
) LANGUAGE plpgsql AS $$
DECLARE
    v_mesa             RECORD;
    v_lote             RECORD;
    v_turno_existente  RECORD;
    v_nuevo_numero     INTEGER;
    v_turno_nuevo_id   BIGINT;
    v_llamado_en       TIMESTAMPTZ;
    v_vouchers_restantes INTEGER;
    v_proximo          INTEGER;
    v_es_agotado       BOOLEAN := FALSE;
    v_modo_activo      VARCHAR(20);
    v_fecha_hoy        DATE;
    v_turno_kiosko     RECORD;
BEGIN
    -- 1. Determinar modo de generacion y fecha oficial
    SELECT COALESCE(valor, 'voucher_fisico') INTO v_modo_activo
    FROM configuracion WHERE clave = 'modo_generacion_turnos';
    IF v_modo_activo IS NULL THEN v_modo_activo := 'voucher_fisico'; END IF;

    v_fecha_hoy := fn_fecha_hoy();

    -- 2. Bloqueo y verificacion de la mesa
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
        RAISE EXCEPTION 'Esta mesa no te esta asignada' USING ERRCODE = 'P0001';
    END IF;

    -- 3. Idempotencia ante doble clic rapido (< 1.5 segundos)
    SELECT t.id, t.numero, t.llamado_en, t.lote_id, t.origen
    INTO v_turno_existente
    FROM turnos t
    WHERE t.mesa_id = p_mesa_id AND t.estado = 'en_atencion'
    LIMIT 1;

    IF FOUND AND (NOW() - v_turno_existente.llamado_en) < INTERVAL '1.5 second' THEN
        IF v_turno_existente.origen = 'kiosko_web' OR v_modo_activo = 'kiosko_web' THEN
            SELECT COUNT(*)::int INTO v_vouchers_restantes
            FROM turnos WHERE turnos.estado = 'esperando' AND turnos.origen = 'kiosko_web' AND turnos.fecha_turno = v_fecha_hoy;

            SELECT numero INTO v_proximo
            FROM turnos WHERE turnos.estado = 'esperando' AND turnos.origen = 'kiosko_web' AND turnos.fecha_turno = v_fecha_hoy
            ORDER BY numero ASC LIMIT 1;

            RETURN QUERY SELECT
                v_turno_existente.id, v_turno_existente.numero, v_turno_existente.llamado_en,
                v_mesa.id, v_mesa.numero, v_mesa.nombre,
                NULL::BIGINT, NULL::INTEGER, NULL::INTEGER, v_turno_existente.numero,
                v_vouchers_restantes, v_proximo,
                FALSE, TRUE, 'kiosko_web'::VARCHAR(20);
            RETURN;
        ELSE
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
                v_turno_existente.id, v_turno_existente.numero, v_turno_existente.llamado_en,
                v_mesa.id, v_mesa.numero, v_mesa.nombre,
                v_turno_existente.lote_id, v_lote.numero_lote, v_lote.numero_hasta,
                v_lote.ultimo_numero_llamado, v_vouchers_restantes, v_proximo,
                FALSE, TRUE, 'voucher_fisico'::VARCHAR(20);
            RETURN;
        END IF;
    END IF;

    -- RAMA A: MODO KIOSKO_WEB
    IF v_modo_activo = 'kiosko_web' THEN
        SELECT t.id, t.numero, t.creado_en
        INTO v_turno_kiosko
        FROM turnos t
        WHERE t.estado = 'esperando'
          AND t.origen = 'kiosko_web'
          AND t.fecha_turno = v_fecha_hoy
        ORDER BY t.numero ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'No hay turnos en espera en este momento.' USING ERRCODE = 'P0001';
        END IF;

        UPDATE turnos SET estado = 'atendido'
        WHERE turnos.mesa_id = p_mesa_id AND turnos.estado = 'en_atencion';

        v_llamado_en := NOW();
        UPDATE turnos
        SET estado = 'en_atencion', mesa_id = p_mesa_id,
            operador_id = p_operador_id, llamado_en = v_llamado_en
        WHERE turnos.id = v_turno_kiosko.id;

        SELECT COUNT(*)::int INTO v_vouchers_restantes
        FROM turnos WHERE turnos.estado = 'esperando' AND turnos.origen = 'kiosko_web' AND turnos.fecha_turno = v_fecha_hoy;

        SELECT numero INTO v_proximo
        FROM turnos WHERE turnos.estado = 'esperando' AND turnos.origen = 'kiosko_web' AND turnos.fecha_turno = v_fecha_hoy
        ORDER BY numero ASC LIMIT 1;

        RETURN QUERY SELECT
            v_turno_kiosko.id, v_turno_kiosko.numero, v_llamado_en,
            v_mesa.id, v_mesa.numero, v_mesa.nombre,
            NULL::BIGINT, NULL::INTEGER, NULL::INTEGER, v_turno_kiosko.numero,
            v_vouchers_restantes, v_proximo,
            FALSE, FALSE, 'kiosko_web'::VARCHAR(20);
        RETURN;
    END IF;

    -- RAMA B: MODO VOUCHER_FISICO
    SELECT lv.id, lv.numero_lote, lv.numero_desde, lv.numero_hasta, lv.ultimo_numero_llamado
    INTO v_lote
    FROM lotes_voucher lv
    WHERE lv.estado = 'activo'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No hay un lote activo. El admin debe activar un lote antes de llamar turnos.' USING ERRCODE = 'P0001';
    END IF;

    IF v_lote.ultimo_numero_llamado >= v_lote.numero_hasta THEN
        UPDATE lotes_voucher SET estado = 'agotado', fecha_cierre = NOW()
        WHERE id = v_lote.id AND estado = 'activo';
        RAISE EXCEPTION 'El lote de vouchers se ha agotado. El admin debe extenderlo o crear uno nuevo.' USING ERRCODE = 'P0001';
    END IF;

    UPDATE turnos SET estado = 'atendido'
    WHERE turnos.mesa_id = p_mesa_id AND turnos.estado = 'en_atencion';

    v_nuevo_numero := v_lote.ultimo_numero_llamado + 1;
    UPDATE lotes_voucher SET ultimo_numero_llamado = v_nuevo_numero WHERE id = v_lote.id;

    v_llamado_en := NOW();
    INSERT INTO turnos (numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id, llamado_en)
    VALUES (v_nuevo_numero, v_fecha_hoy, v_lote.id, 'en_atencion', 'voucher_fisico', p_mesa_id, p_operador_id, v_llamado_en)
    RETURNING id INTO v_turno_nuevo_id;

    IF v_nuevo_numero >= v_lote.numero_hasta THEN
        UPDATE lotes_voucher SET estado = 'agotado', fecha_cierre = NOW() WHERE id = v_lote.id;
        v_es_agotado := TRUE;
    END IF;

    v_vouchers_restantes := GREATEST(0, v_lote.numero_hasta - v_nuevo_numero);
    IF v_nuevo_numero + 1 <= v_lote.numero_hasta THEN
        v_proximo := v_nuevo_numero + 1;
    ELSE
        v_proximo := NULL;
    END IF;

    RETURN QUERY SELECT
        v_turno_nuevo_id, v_nuevo_numero, v_llamado_en,
        v_mesa.id, v_mesa.numero, v_mesa.nombre,
        v_lote.id, v_lote.numero_lote, v_lote.numero_hasta, v_nuevo_numero,
        v_vouchers_restantes, v_proximo,
        v_es_agotado, FALSE, 'voucher_fisico'::VARCHAR(20);
END;
$$;

-- ---------------------------------------------------------------------------
-- G. Atender turno rezagado (transaccion atomica) -- CORRECCION H1
--    Variable escalar v_lote_numero evita acceso a RECORD no asignado
--    en modo kiosko_web (error "record v_lote is not assigned yet").
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_atender_rezagado(
    p_turno_id    BIGINT,
    p_mesa_id     BIGINT,
    p_operador_id BIGINT
)
RETURNS TABLE (
    turno_id           BIGINT,
    turno_numero       INTEGER,
    llamado_en         TIMESTAMPTZ,
    mesa_id            BIGINT,
    mesa_numero        INTEGER,
    mesa_nombre        VARCHAR(60),
    lote_id            BIGINT,
    lote_numero        INTEGER,
    vouchers_restantes INTEGER,
    proximo_numero     INTEGER,
    origen             VARCHAR(20),
    token_consulta     VARCHAR(64)
) LANGUAGE plpgsql AS $$
DECLARE
    v_mesa                RECORD;
    v_turno               RECORD;
    v_lote                RECORD;
    v_lote_numero         INTEGER     := NULL;
    v_llamado_en          TIMESTAMPTZ;
    v_vouchers_restantes  INTEGER     := 0;
    v_proximo             INTEGER     := NULL;
    v_modo_activo         VARCHAR(20);
    v_fecha_hoy           DATE;
    v_mesa_actual_numero  INTEGER;
BEGIN
    SELECT COALESCE(valor, 'voucher_fisico') INTO v_modo_activo
    FROM configuracion WHERE clave = 'modo_generacion_turnos';
    IF v_modo_activo IS NULL THEN v_modo_activo := 'voucher_fisico'; END IF;

    v_fecha_hoy := fn_fecha_hoy();

    SELECT m.id, m.numero, m.nombre, m.estado, m.operador_id
    INTO v_mesa FROM mesas m WHERE m.id = p_mesa_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Mesa % no encontrada', p_mesa_id USING ERRCODE = 'P0002';
    END IF;

    IF v_mesa.estado <> 'activa' THEN
        RAISE EXCEPTION 'Mesa en estado "%". Solo mesas activas pueden atender.', v_mesa.estado USING ERRCODE = 'P0001';
    END IF;

    IF v_mesa.operador_id IS DISTINCT FROM p_operador_id THEN
        RAISE EXCEPTION 'Esta mesa no te esta asignada' USING ERRCODE = 'P0001';
    END IF;

    UPDATE turnos SET estado = 'atendido'
    WHERE turnos.mesa_id = p_mesa_id AND turnos.estado = 'en_atencion';

    SELECT t.id, t.numero, t.estado, t.origen, t.lote_id, t.token_consulta, t.fecha_turno, t.mesa_id
    INTO v_turno FROM turnos t WHERE t.id = p_turno_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Turno % no encontrado', p_turno_id USING ERRCODE = 'P0002';
    END IF;

    IF v_turno.estado <> 'cancelado' THEN
        SELECT m.numero INTO v_mesa_actual_numero FROM mesas m WHERE m.id = v_turno.mesa_id;
        IF v_mesa_actual_numero IS NOT NULL THEN
            RAISE EXCEPTION 'El turno #% ya fue atendido por Mesa %', v_turno.numero, v_mesa_actual_numero USING ERRCODE = 'P0001';
        ELSE
            RAISE EXCEPTION 'El turno #% ya fue atendido o no esta disponible', v_turno.numero USING ERRCODE = 'P0001';
        END IF;
    END IF;

    v_llamado_en := NOW();
    UPDATE turnos
    SET estado = 'en_atencion', mesa_id = p_mesa_id, operador_id = p_operador_id,
        llamado_en = v_llamado_en, finalizado_en = NULL, duracion_atencion_seg = NULL
    WHERE turnos.id = p_turno_id;

    IF v_modo_activo = 'kiosko_web' THEN
        -- v_lote_numero permanece NULL (rezagado kiosko no tiene lote_id propio)
        SELECT COUNT(*)::int INTO v_vouchers_restantes
        FROM turnos
        WHERE turnos.estado = 'esperando' AND turnos.origen = 'kiosko_web' AND turnos.fecha_turno = v_fecha_hoy;

        SELECT turnos.numero INTO v_proximo
        FROM turnos
        WHERE turnos.estado = 'esperando' AND turnos.origen = 'kiosko_web' AND turnos.fecha_turno = v_fecha_hoy
        ORDER BY turnos.numero ASC LIMIT 1;
    ELSE
        SELECT lv.numero_lote, lv.numero_hasta, lv.ultimo_numero_llamado
        INTO v_lote FROM lotes_voucher lv WHERE lv.id = v_turno.lote_id;

        IF NOT FOUND THEN
            SELECT lv.id, lv.numero_lote, lv.numero_hasta, lv.ultimo_numero_llamado
            INTO v_lote FROM lotes_voucher lv WHERE lv.estado = 'activo' LIMIT 1;
        END IF;

        IF v_lote.numero_hasta IS NOT NULL THEN
            v_lote_numero        := v_lote.numero_lote;
            v_vouchers_restantes := GREATEST(0, v_lote.numero_hasta - v_lote.ultimo_numero_llamado);
            IF v_lote.ultimo_numero_llamado + 1 <= v_lote.numero_hasta THEN
                v_proximo := v_lote.ultimo_numero_llamado + 1;
            ELSE
                v_proximo := NULL;
            END IF;
        END IF;
    END IF;

    RETURN QUERY SELECT
        v_turno.id, v_turno.numero, v_llamado_en,
        v_mesa.id, v_mesa.numero, v_mesa.nombre,
        v_turno.lote_id,
        v_lote_numero,
        v_vouchers_restantes, v_proximo,
        v_turno.origen, v_turno.token_consulta;
END;
$$;

-- =============================================================================
-- FIN ARCHIVO 3/4
-- =============================================================================