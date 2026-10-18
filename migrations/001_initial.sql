-- =============================================================================
-- TURNERO DE MATRÍCULAS 2026 — SCHEMA INTEGRAL v2.1
-- Migración 001_initial.sql: Estructura, restricciones, índices, funciones y configuración
-- Motor: PostgreSQL 15+ (Mono-sede)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. EXTENSIONES Y SECUENCIAS
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE IF NOT EXISTS seq_numero_lote START 1 INCREMENT 1;

-- -----------------------------------------------------------------------------
-- 2. TABLAS BASE
-- -----------------------------------------------------------------------------

-- TABLA: usuarios
CREATE TABLE usuarios (
    id              BIGSERIAL    PRIMARY KEY,
    username        VARCHAR(30)  NOT NULL,
    nombre_completo VARCHAR(100) NOT NULL,
    password_hash   TEXT         NOT NULL,
    rol             VARCHAR(20)  NOT NULL DEFAULT 'operador'
                        CONSTRAINT ck_usuarios_rol CHECK (rol IN ('operador', 'admin')),
    activo          BOOLEAN      NOT NULL DEFAULT TRUE,
    creado_en       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ux_usuarios_username UNIQUE (username)
);

COMMENT ON TABLE usuarios IS 'Operadores y administradores del sistema (roles: operador, admin)';

-- TABLA: configuracion
CREATE TABLE configuracion (
    clave           VARCHAR(60)  PRIMARY KEY,
    valor           TEXT         NOT NULL,
    descripcion     TEXT,
    actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_por BIGINT       REFERENCES usuarios(id) ON DELETE SET NULL
);

COMMENT ON TABLE configuracion IS 'Parámetros dinámicos del sistema editables en caliente';

-- Función institucional para cálculo de fecha actual en la zona horaria oficial
CREATE OR REPLACE FUNCTION fn_fecha_hoy()
RETURNS DATE LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_zona TEXT;
BEGIN
    SELECT valor INTO v_zona FROM configuracion WHERE clave = 'zona_horaria';
    IF v_zona IS NULL OR v_zona = '' THEN
        v_zona := 'America/Tegucigalpa';
    END IF;
    RETURN (NOW() AT TIME ZONE v_zona)::DATE;
EXCEPTION WHEN OTHERS THEN
    RETURN (NOW() AT TIME ZONE 'America/Tegucigalpa')::DATE;
END;
$$;

-- TABLA: mesas
CREATE TABLE mesas (
    id             BIGSERIAL    PRIMARY KEY,
    numero         INTEGER      NOT NULL CONSTRAINT ux_mesas_numero UNIQUE,
    nombre         VARCHAR(60)  NOT NULL,
    estado         VARCHAR(20)  NOT NULL DEFAULT 'inactiva'
                       CONSTRAINT ck_mesas_estado CHECK (estado IN ('activa', 'pausada', 'inactiva')),
    operador_id    BIGINT       REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE mesas IS 'Ventanillas o sitios de atención en sala';

-- TABLA: lotes_voucher
CREATE TABLE lotes_voucher (
    id                    BIGSERIAL    PRIMARY KEY,
    numero_lote           INTEGER      NOT NULL CONSTRAINT ux_lotes_numero_lote UNIQUE DEFAULT nextval('seq_numero_lote'),
    numero_desde          INTEGER      NOT NULL DEFAULT 1,
    numero_hasta          INTEGER      NOT NULL,
    ultimo_numero_llamado INTEGER      NOT NULL DEFAULT 0,
    estado                VARCHAR(20)  NOT NULL DEFAULT 'preparado'
                              CONSTRAINT ck_lotes_estado CHECK (estado IN (
                                  'preparado',
                                  'activo',
                                  'pausado',
                                  'agotado',
                                  'cerrado'
                              )),
    fecha_creacion        DATE         NOT NULL DEFAULT fn_fecha_hoy(),
    fecha_activacion      TIMESTAMPTZ,
    fecha_cierre          TIMESTAMPTZ,
    creado_por            BIGINT       REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_en        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_lote_rango
        CHECK (numero_desde >= 1 AND numero_hasta >= numero_desde),
    CONSTRAINT ck_lote_progreso
        CHECK (ultimo_numero_llamado >= 0 AND ultimo_numero_llamado <= numero_hasta)
);

COMMENT ON TABLE lotes_voucher IS 'Contador central correlativo multi-día para vouchers físicos';

-- TABLA: kiosko_contador_diario
CREATE TABLE kiosko_contador_diario (
    fecha          DATE        PRIMARY KEY,
    ultimo_numero  INTEGER     NOT NULL DEFAULT 0,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE kiosko_contador_diario IS 'Contador diario correlativo independiente para el autoservicio Kiosko Web';

-- TABLA: turnos
CREATE TABLE turnos (
    id                    BIGSERIAL    PRIMARY KEY,
    numero                INTEGER      NOT NULL,
    fecha_turno           DATE         NOT NULL DEFAULT fn_fecha_hoy(),
    lote_id               BIGINT       REFERENCES lotes_voucher(id),
    estado                VARCHAR(20)  NOT NULL DEFAULT 'esperando'
                              CONSTRAINT ck_turnos_estado CHECK (estado IN (
                                  'esperando',
                                  'en_atencion',
                                  'atendido',
                                  'cancelado'
                              )),
    origen                VARCHAR(20)  NOT NULL DEFAULT 'voucher_fisico'
                              CONSTRAINT ck_turnos_origen CHECK (origen IN (
                                  'voucher_fisico',
                                  'kiosko_web'
                              )),
    mesa_id               BIGINT       REFERENCES mesas(id) ON DELETE SET NULL,
    operador_id           BIGINT       REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    llamado_en            TIMESTAMPTZ,
    finalizado_en         TIMESTAMPTZ,
    duracion_espera_seg   INTEGER,
    duracion_atencion_seg INTEGER,
    token_consulta        VARCHAR(64)  CONSTRAINT ux_turnos_token_consulta UNIQUE,
    idempotency_key       VARCHAR(64),
    device_id             VARCHAR(64),

    CONSTRAINT ck_turnos_origen_atributos
        CHECK (
            (origen = 'voucher_fisico' AND lote_id IS NOT NULL) OR
            (origen = 'kiosko_web' AND token_consulta IS NOT NULL)
        )
);

COMMENT ON TABLE turnos IS 'Registro de turnos atendidos (voucher físico) o en cola (kiosko web)';

-- TABLA: audit_log
CREATE TABLE audit_log (
    id            BIGSERIAL    PRIMARY KEY,
    turno_id      BIGINT,
    mesa_id       BIGINT,
    operador_id   BIGINT,
    lote_id       BIGINT,
    accion        VARCHAR(50)  NOT NULL
                      CONSTRAINT audit_log_accion_check CHECK (accion IN (
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
                          'LOTE_CONTADOR_AJUSTADO',
                          -- Mesa / Operador
                          'MESA_ACTIVADA',
                          'MESA_PAUSADA',
                          'MESA_INACTIVADA',
                          'OPERADOR_ASIGNADO',
                          'OPERADOR_LIBERADO',
                          -- Sesión
                          'LOGIN_EXITOSO',
                          'LOGIN_FALLIDO',
                          'LOGOUT',
                          -- Administración
                          'USUARIO_CREADO',
                          'USUARIO_EDITADO',
                          'USUARIO_DESACTIVADO',
                          'CONFIG_MODIFICADA',
                          'ADMIN_ACTION'
                      )),
    timestamp     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    ip_origen     INET,
    metadata_json JSONB
);

COMMENT ON TABLE audit_log IS 'Trazabilidad inmutable del sistema. Solo-INSERT.';

-- -----------------------------------------------------------------------------
-- 3. ÍNDICES
-- -----------------------------------------------------------------------------

-- usuarios
CREATE UNIQUE INDEX ux_usuarios_username_lower
    ON usuarios (LOWER(username));

-- mesas
CREATE UNIQUE INDEX ux_mesas_operador_unico
    ON mesas (operador_id)
    WHERE operador_id IS NOT NULL;

-- lotes_voucher
CREATE UNIQUE INDEX ux_lotes_un_lote_activo
    ON lotes_voucher ((estado))
    WHERE estado = 'activo';

CREATE INDEX ix_lotes_estado
    ON lotes_voucher (estado)
    WHERE estado IN ('activo', 'pausado', 'preparado');

-- turnos
CREATE UNIQUE INDEX ux_turnos_lote_numero
    ON turnos (lote_id, numero)
    WHERE lote_id IS NOT NULL;

CREATE UNIQUE INDEX ux_turnos_mesa_activa
    ON turnos (mesa_id)
    WHERE estado = 'en_atencion';

CREATE UNIQUE INDEX ux_turnos_kiosko_dia_numero
    ON turnos (fecha_turno, numero)
    WHERE origen = 'kiosko_web';

CREATE UNIQUE INDEX ux_turnos_idempotency_key
    ON turnos (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX ux_turnos_device_esperando
    ON turnos (device_id)
    WHERE device_id IS NOT NULL AND estado = 'esperando';

CREATE INDEX ix_turnos_esperando_kiosko
    ON turnos (fecha_turno, numero ASC)
    WHERE estado = 'esperando' AND origen = 'kiosko_web';

CREATE INDEX ix_turnos_lote_estado
    ON turnos (lote_id, estado);

CREATE INDEX ix_turnos_fecha
    ON turnos (creado_en DESC);

CREATE INDEX ix_turnos_tv_recientes
    ON turnos (llamado_en DESC NULLS LAST)
    WHERE estado IN ('en_atencion', 'atendido');

CREATE INDEX ix_turnos_mesa_atendidos_hoy
    ON turnos (mesa_id, estado, llamado_en);

CREATE INDEX ix_turnos_operador_id
    ON turnos (operador_id);

-- audit_log
CREATE INDEX ix_audit_operador_ts ON audit_log (operador_id, timestamp DESC);
CREATE INDEX ix_audit_accion_ts   ON audit_log (accion, timestamp DESC);
CREATE INDEX ix_audit_lote        ON audit_log (lote_id, timestamp DESC);
CREATE INDEX ix_audit_turno_id    ON audit_log (turno_id);
CREATE INDEX ix_audit_mesa_id     ON audit_log (mesa_id);

-- -----------------------------------------------------------------------------
-- 4. FUNCIONES Y TRIGGERS
-- -----------------------------------------------------------------------------

-- Inmutabilidad estricta de audit_log
CREATE OR REPLACE FUNCTION fn_bloquear_modificacion_audit_log()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log es inmutable. No se permite UPDATE ni DELETE (SQLSTATE: 42501)';
END;
$$;

CREATE TRIGGER trg_audit_log_inmutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION fn_bloquear_modificacion_audit_log();

-- Actualización automática de columna actualizado_en
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

-- Cálculo automático de duraciones y transiciones de turnos
CREATE OR REPLACE FUNCTION fn_calcular_duraciones_turno()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- esperando → en_atencion (flujo kiosko_web)
    IF NEW.estado = 'en_atencion' AND OLD.estado = 'esperando' THEN
        NEW.llamado_en          := NOW();
        NEW.duracion_espera_seg := EXTRACT(EPOCH FROM (NOW() - OLD.creado_en))::INTEGER;
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

CREATE TRIGGER trg_turnos_duraciones
    BEFORE UPDATE ON turnos
    FOR EACH ROW EXECUTE FUNCTION fn_calcular_duraciones_turno();

-- Auditoría automática de turnos
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

-- Control de no-regresión de lotes con autorización explícita para contingencias
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

-- Función SQL atómica: Llamar Siguiente Turno (1 round-trip)
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
    es_idempotente BOOLEAN,
    modo VARCHAR(20)
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
    v_modo_activo VARCHAR(20);
    v_fecha_hoy DATE;
    v_turno_kiosko RECORD;
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
        RAISE EXCEPTION 'Mesa en estado "%". Solo mesas activas pueden llamar.', v_mesa.estado USING ERRCODE = 'P0001';
    END IF;

    IF v_mesa.operador_id IS DISTINCT FROM p_operador_id THEN
        RAISE EXCEPTION 'Esta mesa no te está asignada' USING ERRCODE = 'P0001';
    END IF;

    -- 3. Idempotencia ante doble clic rápido (< 1.5 segundos)
    SELECT t.id, t.numero, t.llamado_en, t.lote_id, t.origen
    INTO v_turno_existente
    FROM turnos t
    WHERE t.mesa_id = p_mesa_id AND t.estado = 'en_atencion'
    LIMIT 1;

    IF FOUND AND (NOW() - v_turno_existente.llamado_en) < INTERVAL '1.5 second' THEN
        IF v_turno_existente.origen = 'kiosko_web' OR v_modo_activo = 'kiosko_web' THEN
            SELECT COUNT(*)::int INTO v_vouchers_restantes
            FROM turnos WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = v_fecha_hoy;

            SELECT numero INTO v_proximo
            FROM turnos WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = v_fecha_hoy
            ORDER BY numero ASC LIMIT 1;

            RETURN QUERY SELECT
                v_turno_existente.id,
                v_turno_existente.numero,
                v_turno_existente.llamado_en,
                v_mesa.id,
                v_mesa.numero,
                v_mesa.nombre,
                NULL::BIGINT,
                NULL::INTEGER,
                NULL::INTEGER,
                v_turno_existente.numero,
                v_vouchers_restantes,
                v_proximo,
                FALSE,
                TRUE,
                'kiosko_web'::VARCHAR(20);
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
                TRUE,
                'voucher_fisico'::VARCHAR(20);
            RETURN;
        END IF;
    END IF;

    -- ─────────────────────────────────────────────────────────────────────────
    -- RAMA A: MODO KIOSKO_WEB (Toma de cola con FOR UPDATE SKIP LOCKED)
    -- ─────────────────────────────────────────────────────────────────────────
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

        -- Finalizar turno anterior en esta mesa
        UPDATE turnos
        SET estado = 'atendido'
        WHERE turnos.mesa_id = p_mesa_id AND turnos.estado = 'en_atencion';

        -- Asignar el turno a la mesa en 'en_atencion'
        v_llamado_en := NOW();
        UPDATE turnos
        SET estado = 'en_atencion',
            mesa_id = p_mesa_id,
            operador_id = p_operador_id,
            llamado_en = v_llamado_en
        WHERE turnos.id = v_turno_kiosko.id;

        -- Calcular próximos en espera
        SELECT COUNT(*)::int INTO v_vouchers_restantes
        FROM turnos WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = v_fecha_hoy;

        SELECT numero INTO v_proximo
        FROM turnos WHERE estado = 'esperando' AND origen = 'kiosko_web' AND fecha_turno = v_fecha_hoy
        ORDER BY numero ASC LIMIT 1;

        RETURN QUERY SELECT
            v_turno_kiosko.id,
            v_turno_kiosko.numero,
            v_llamado_en,
            v_mesa.id,
            v_mesa.numero,
            v_mesa.nombre,
            NULL::BIGINT,
            NULL::INTEGER,
            NULL::INTEGER,
            v_turno_kiosko.numero,
            v_vouchers_restantes,
            v_proximo,
            FALSE,
            FALSE,
            'kiosko_web'::VARCHAR(20);
        RETURN;
    END IF;

    -- ─────────────────────────────────────────────────────────────────────────
    -- RAMA B: MODO VOUCHER_FISICO (Contador central de lotes_voucher)
    -- ─────────────────────────────────────────────────────────────────────────
    SELECT lv.id, lv.numero_lote, lv.numero_desde, lv.numero_hasta, lv.ultimo_numero_llamado
    INTO v_lote
    FROM lotes_voucher lv
    WHERE lv.estado = 'activo'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No hay un lote activo. El admin debe activar un lote antes de llamar turnos.' USING ERRCODE = 'P0001';
    END IF;

    IF v_lote.ultimo_numero_llamado >= v_lote.numero_hasta THEN
        UPDATE lotes_voucher
        SET estado = 'agotado', fecha_cierre = NOW()
        WHERE id = v_lote.id AND estado = 'activo';

        RAISE EXCEPTION 'El lote de vouchers se ha agotado. El admin debe extenderlo o crear uno nuevo.' USING ERRCODE = 'P0001';
    END IF;

    -- Finalizar turno anterior de esta mesa
    UPDATE turnos
    SET estado = 'atendido'
    WHERE turnos.mesa_id = p_mesa_id AND turnos.estado = 'en_atencion';

    -- Avanzar contador del lote de forma atómica
    v_nuevo_numero := v_lote.ultimo_numero_llamado + 1;

    UPDATE lotes_voucher
    SET ultimo_numero_llamado = v_nuevo_numero
    WHERE id = v_lote.id;

    -- Crear el nuevo turno directo en 'en_atencion'
    v_llamado_en := NOW();
    INSERT INTO turnos (
        numero, fecha_turno, lote_id, estado, origen, mesa_id, operador_id, llamado_en
    ) VALUES (
        v_nuevo_numero, v_fecha_hoy, v_lote.id, 'en_atencion', 'voucher_fisico', p_mesa_id, p_operador_id, v_llamado_en
    )
    RETURNING id INTO v_turno_nuevo_id;

    -- Si este llamado fue el último voucher, marcar agotado atómicamente
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
        FALSE,
        'voucher_fisico'::VARCHAR(20);
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. CONFIGURACIÓN INICIAL DEL SISTEMA
-- -----------------------------------------------------------------------------
INSERT INTO configuracion (clave, valor, descripcion) VALUES
    ('alerta_vouchers_restantes', '20',                  'Alertar al admin cuando queden N vouchers en el lote.'),
    ('modo_generacion_turnos',    'voucher_fisico',      'Modo activo de operacion: voucher_fisico | kiosko_web.'),
    ('kiosko_web_activo',         'false',               'Habilita URL/QR publica para generar turno desde celular o kiosko.'),
    ('mostrar_estimado_espera',   'true',                'Mostrar estimado de espera en TV cuando hay turnos en espera.'),
    ('zona_horaria',              'America/Tegucigalpa', 'Zona horaria oficial del sistema para calculo de fecha y cambio de dia.'),
    ('kiosko_tope_diario',        '0',                   'Tope maximo de turnos diarios por kiosko (0 = ilimitado).'),
    ('kiosko_url_base',           '',                    'URL base publica para seguimiento QR (vacio = autodeteccion LAN).'),
    ('voz_anuncio_activa',        'true',                'Habilita el anuncio de voz sintetica en pantallas de TV.'),
    ('impresora_ip',              '',                    'IP de la impresora de tickets en la LAN (vacio = impresion desactivada).'),
    ('impresora_puerto',          '9100',                'Puerto TCP de la impresora ESC/POS (estandar: 9100).'),
    ('impresora_activa',          'false',               'Habilita la impresion directa ESC/POS desde el servidor.')
ON CONFLICT (clave) DO NOTHING;

-- =============================================================================
-- FIN DE LA MIGRACION INICIAL (v2.1)
-- =============================================================================
