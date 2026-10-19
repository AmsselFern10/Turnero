-- ==============================================================================
-- MIGRACION 010: Fix fn_atender_rezagado -- modo kiosko_web
-- Sistema Turnero de Matriculas 2026
-- ==============================================================================
-- PROBLEMA (003_atender_rezagado.sql):
--   En el RETURN QUERY final se usa COALESCE(v_lote.numero_lote, NULL::INTEGER).
--   Cuando el modo activo es 'kiosko_web', la variable v_lote (tipo RECORD) nunca
--   se asigna. PostgreSQL lanza: ERROR: record "v_lote" is not assigned yet.
--   Esto hace que POST /turnos/atender-rezagado falle con HTTP 500 en modo kiosko.
--
-- CORRECCION:
--   Se declara la variable escalar v_lote_numero INTEGER := NULL y se asigna
--   unicamente dentro de la rama voucher_fisico. El RETURN QUERY usa esa variable,
--   que en modo kiosko vale NULL sin error.
-- ==============================================================================

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
    -- Variable escalar: evita acceder a v_lote (RECORD) cuando no fue asignado en rama kiosko
    v_lote_numero         INTEGER     := NULL;
    v_llamado_en          TIMESTAMPTZ;
    v_vouchers_restantes  INTEGER     := 0;
    v_proximo             INTEGER     := NULL;
    v_modo_activo         VARCHAR(20);
    v_fecha_hoy           DATE;
    v_mesa_actual_numero  INTEGER;
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
        RAISE EXCEPTION 'Mesa en estado "%". Solo mesas activas pueden atender.', v_mesa.estado USING ERRCODE = 'P0001';
    END IF;

    IF v_mesa.operador_id IS DISTINCT FROM p_operador_id THEN
        RAISE EXCEPTION 'Esta mesa no te esta asignada' USING ERRCODE = 'P0001';
    END IF;

    -- 3. Finalizar turno anterior en atencion en esta mesa
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

    IF v_turno.estado <> 'cancelado' THEN
        SELECT m.numero INTO v_mesa_actual_numero FROM mesas m WHERE m.id = v_turno.mesa_id;
        IF v_mesa_actual_numero IS NOT NULL THEN
            RAISE EXCEPTION 'El turno #% ya fue atendido por Mesa %', v_turno.numero, v_mesa_actual_numero USING ERRCODE = 'P0001';
        ELSE
            RAISE EXCEPTION 'El turno #% ya fue atendido o no esta disponible', v_turno.numero USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- 5. Asignar el turno a la mesa como en_atencion
    v_llamado_en := NOW();
    UPDATE turnos
    SET estado                = 'en_atencion',
        mesa_id               = p_mesa_id,
        operador_id           = p_operador_id,
        llamado_en            = v_llamado_en,
        finalizado_en         = NULL,
        duracion_atencion_seg = NULL
    WHERE turnos.id = p_turno_id;

    -- 6. Calcular metricas sin alterar contadores
    IF v_modo_activo = 'kiosko_web' THEN
        -- Modo kiosko: contar turnos en espera del dia.
        -- v_lote_numero permanece NULL (correcto: rezagado kiosko no tiene lote_id propio).
        SELECT COUNT(*)::int INTO v_vouchers_restantes
        FROM turnos
        WHERE estado      = 'esperando'
          AND origen      = 'kiosko_web'
          AND fecha_turno = v_fecha_hoy;

        SELECT numero INTO v_proximo
        FROM turnos
        WHERE estado      = 'esperando'
          AND origen      = 'kiosko_web'
          AND fecha_turno = v_fecha_hoy
        ORDER BY numero ASC LIMIT 1;

    ELSE
        -- Modo voucher_fisico: leer el lote del turno (o el lote activo como fallback)
        SELECT lv.numero_lote, lv.numero_hasta, lv.ultimo_numero_llamado
        INTO v_lote
        FROM lotes_voucher lv
        WHERE lv.id = v_turno.lote_id;

        IF NOT FOUND THEN
            SELECT lv.id, lv.numero_lote, lv.numero_hasta, lv.ultimo_numero_llamado
            INTO v_lote
            FROM lotes_voucher lv
            WHERE lv.estado = 'activo'
            LIMIT 1;
        END IF;

        IF v_lote.numero_hasta IS NOT NULL THEN
            -- Asignar escalar solo en esta rama
            v_lote_numero        := v_lote.numero_lote;
            v_vouchers_restantes := GREATEST(0, v_lote.numero_hasta - v_lote.ultimo_numero_llamado);
            IF v_lote.ultimo_numero_llamado + 1 <= v_lote.numero_hasta THEN
                v_proximo := v_lote.ultimo_numero_llamado + 1;
            ELSE
                v_proximo := NULL;
            END IF;
        END IF;
    END IF;

    -- 7. Retornar resultado.
    -- Se usa v_lote_numero (INTEGER escalar) en lugar de v_lote.numero_lote.
    -- En modo kiosko vale NULL sin lanzar "record not assigned". En modo
    -- voucher_fisico contiene el numero_lote del lote activo.
    RETURN QUERY SELECT
        v_turno.id,
        v_turno.numero,
        v_llamado_en,
        v_mesa.id,
        v_mesa.numero,
        v_mesa.nombre,
        v_turno.lote_id,
        v_lote_numero,
        v_vouchers_restantes,
        v_proximo,
        v_turno.origen,
        v_turno.token_consulta;
END;
$$;