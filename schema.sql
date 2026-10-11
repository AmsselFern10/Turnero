-- =============================================================================
-- TURNERO DE MATRÍCULAS 2026
-- Schema de base de datos — v2.1
-- Motor: PostgreSQL 15+
--
-- Changelog v2.1:
--   - Eliminado sede_id de todas las tablas (sistema mono-sede)
--   - lotes_voucher: nombre eliminado, numeración automática (Lote 1, Lote 2…)
--   - origen simplificado: solo 'voucher_fisico' | 'kiosko_web'
--     (kiosko_web cubre tanto empleado en puerta como estudiante desde celular)
--   - Estado default de turnos: 'esperando'
--   - Flujo confirmado: "Llamar Siguiente" hace todo en 1 transacción atómica
-- =============================================================================

-- -----------------------------------------------------------------------------
-- EXTENSIONES
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_cron es opcional (solo si el contenedor/entorno tiene soporte de la extensión)
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible en este entorno; se omite la extensión.';
END $$;

-- Secuencia para numeración legible de lotes: Lote 1, Lote 2, Lote 3…
CREATE SEQUENCE IF NOT EXISTS seq_numero_lote START 1 INCREMENT 1;

-- =============================================================================
-- TABLA: usuarios
-- =============================================================================
CREATE TABLE usuarios (
    id              BIGSERIAL    PRIMARY KEY,
    username        VARCHAR(30)  NOT NULL UNIQUE,
    nombre_completo VARCHAR(100) NOT NULL,
    password_hash   TEXT         NOT NULL,       -- bcrypt cost >= 12 obligatorio
    rol             VARCHAR(20)  NOT NULL DEFAULT 'operador'
                        CHECK (rol IN ('operador', 'supervisor', 'admin')),
    activo          BOOLEAN      NOT NULL DEFAULT TRUE,
    creado_en       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  usuarios               IS 'Operadores, supervisores y administradores del sistema';
COMMENT ON COLUMN usuarios.password_hash IS 'Hash bcrypt cost >= 12. Nunca texto plano.';

-- =============================================================================
-- TABLA: mesas
-- El admin asigna operadores a mesas cada mañana desde el panel
-- =============================================================================
CREATE TABLE mesas (
    id             BIGSERIAL    PRIMARY KEY,
    numero         INTEGER      NOT NULL UNIQUE,  -- Número visible en TV y panel (1, 2…)
    nombre         VARCHAR(60)  NOT NULL,          -- "Mesa 1 — Caja", "Mesa 3 — Docs"
    estado         VARCHAR(20)  NOT NULL DEFAULT 'inactiva'
                       CHECK (estado IN ('activa', 'pausada', 'inactiva')),
    operador_id    BIGINT       REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  mesas             IS 'Ventanillas de atención. El admin reconfigura operadores cada mañana.';
COMMENT ON COLUMN mesas.operador_id IS 'Operador asignado hoy. NULL = mesa libre o inactiva.';

-- =============================================================================
-- TABLA: lotes_voucher
-- Representa un lote de tickets físicos impresos y distribuidos en el portón.
-- Es el CONTADOR CENTRAL — avanza atómicamente con cada llamado.
--
-- NUMERACIÓN:
--   Cada lote recibe un número correlativo automático: Lote 1, Lote 2…
--   via seq_numero_lote. No requiere que el admin ingrese nombre.
--
-- FLUJO:
--   Admin crea lote → activa → operadores llaman vouchers
--   → ultimo_numero_llamado avanza con FOR UPDATE (atómico, sin duplicados)
--   → al llegar a numero_hasta → alerta WS al admin
--
-- EXTENSIÓN EN CALIENTE:
--   Admin cambia numero_hasta de 500 → 700 sin reiniciar nada
--
-- REINICIO DESDE 1:
--   Admin cierra lote actual → crea Lote N+1 con numero_desde = 1
--
-- MULTI-DÍA:
--   El lote NO se reinicia automáticamente.
--   Hoy llegó al 300 → mañana continúa desde 301.
--   Al fin del día el admin pausa el lote; al día siguiente lo reactiva.
-- =============================================================================
CREATE TABLE lotes_voucher (
    id                    BIGSERIAL    PRIMARY KEY,
    numero_lote           INTEGER      NOT NULL UNIQUE DEFAULT nextval('seq_numero_lote'),
    numero_desde          INTEGER      NOT NULL DEFAULT 1,
    numero_hasta          INTEGER      NOT NULL,
    ultimo_numero_llamado INTEGER      NOT NULL DEFAULT 0,
    estado                VARCHAR(20)  NOT NULL DEFAULT 'preparado'
                              CHECK (estado IN (
                                  'preparado',  -- Creado, aún no iniciado
                                  'activo',     -- En uso actualmente
                                  'pausado',    -- Pausado entre días
                                  'agotado',    -- Llegó al último número
                                  'cerrado'     -- Cerrado definitivamente
                              )),
    fecha_creacion        DATE         NOT NULL DEFAULT CURRENT_DATE,
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

COMMENT ON TABLE  lotes_voucher                      IS 'Lotes de vouchers físicos. Contador central multi-día.';
COMMENT ON COLUMN lotes_voucher.numero_lote           IS 'Número correlativo auto-asignado: Lote 1, Lote 2… Se muestra en el UI.';
COMMENT ON COLUMN lotes_voucher.numero_hasta          IS 'Último voucher declarado. Admin puede aumentarlo en caliente.';
COMMENT ON COLUMN lotes_voucher.ultimo_numero_llamado IS 'Progreso actual. Avanza atómicamente con FOR UPDATE al llamar.';

-- Solo puede haber 1 lote activo a la vez (Garantía RF-LOTE-02)
CREATE UNIQUE INDEX ux_un_lote_activo
    ON lotes_voucher ((estado))
    WHERE estado = 'activo';

-- =============================================================================
-- TABLA: turnos
-- Registro de cada voucher llamado a una mesa.
-- Los turnos se crean en el momento del llamado, no antes.
--
-- FLUJO VOUCHER FÍSICO (modo principal):
--
--   Operador presiona "Llamar Siguiente":
--   ┌─────────────────────────────────────────────────┐
--   │ BEGIN                                           │
--   │  1. Finaliza turno anterior de esta mesa        │
--   │     UPDATE turnos SET estado='atendido'         │
--   │     WHERE mesa_id=$1 AND estado='en_atencion'   │
--   │                                                 │
--   │  2. Obtiene siguiente número del lote           │
--   │     SELECT ... FROM lotes_voucher               │
--   │     WHERE estado='activo' FOR UPDATE            │
--   │     → nuevo = ultimo_numero_llamado + 1         │
--   │     UPDATE lotes_voucher SET                    │
--   │     ultimo_numero_llamado = nuevo               │
--   │                                                 │
--   │  3. Crea el turno                               │
--   │     INSERT INTO turnos (numero, estado='en_atencion')│
--   │                                                 │
--   │  4. Si nuevo = numero_hasta → emite alerta WS   │
--   │ COMMIT                                          │
--   └─────────────────────────────────────────────────┘
--
-- FLUJO KIOSKO WEB (empleado en puerta o estudiante desde celular):
--   POST /turnos/generar → INSERT estado='esperando'
--   Operador llama → UPDATE estado='en_atencion'
-- =============================================================================
CREATE TABLE turnos (
    id                    BIGSERIAL    PRIMARY KEY,
    numero                INTEGER      NOT NULL,
    lote_id               BIGINT       NOT NULL REFERENCES lotes_voucher(id),

    -- -------------------------------------------------------------------------
    -- Estado — 4 estados, flujo de 1 clic
    -- -------------------------------------------------------------------------
    estado                VARCHAR(20)  NOT NULL DEFAULT 'esperando'
                              CHECK (estado IN (
                                  'esperando',    -- En cola (kiosko_web pre-registrado)
                                  'en_atencion',  -- Llamado + siendo atendido (voucher: nace aquí)
                                  'atendido',     -- Finalizado al presionar "Llamar Siguiente"
                                  'cancelado'     -- No se presentó / desistió
                              )),

    -- -------------------------------------------------------------------------
    -- Origen: quién/cómo generó el turno
    -- kiosko_web cubre tanto al empleado en puerta como al estudiante con celular
    -- -------------------------------------------------------------------------
    origen                VARCHAR(20)  NOT NULL DEFAULT 'voucher_fisico'
                              CHECK (origen IN (
                                  'voucher_fisico', -- Portón entrega papel → operador llama
                                  'kiosko_web'      -- URL/QR: empleado en puerta o estudiante
                              )),

    -- -------------------------------------------------------------------------
    -- Relaciones
    -- -------------------------------------------------------------------------
    mesa_id               BIGINT       REFERENCES mesas(id)    ON DELETE SET NULL,
    operador_id           BIGINT       REFERENCES usuarios(id)  ON DELETE SET NULL,

    -- -------------------------------------------------------------------------
    -- Timestamps del ciclo de vida
    -- -------------------------------------------------------------------------
    creado_en             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    llamado_en            TIMESTAMPTZ,          -- SET al pasar a en_atencion (trigger)
    finalizado_en         TIMESTAMPTZ,          -- SET al pasar a atendido/cancelado (trigger)

    -- -------------------------------------------------------------------------
    -- Métricas — calculadas automáticamente por trigger
    -- -------------------------------------------------------------------------
    duracion_espera_seg   INTEGER,              -- llamado_en - creado_en
    duracion_atencion_seg INTEGER,              -- finalizado_en - llamado_en

    -- Token para kiosko_web (NULL en voucher_fisico)
    token_consulta        VARCHAR(64)  UNIQUE
);

COMMENT ON TABLE  turnos                       IS 'Vouchers llamados a mesa. En flujo voucher: creados directo en en_atencion.';
COMMENT ON COLUMN turnos.numero                IS 'Número del voucher físico. Proviene del lote activo.';
COMMENT ON COLUMN turnos.estado                IS 'voucher_fisico: nace en en_atencion. kiosko_web: nace en esperando.';
COMMENT ON COLUMN turnos.origen                IS 'kiosko_web cubre empleado en puerta Y estudiante desde celular.';
COMMENT ON COLUMN turnos.duracion_espera_seg   IS 'Solo aplica en kiosko_web (tiempo entre registro y llamado).';
COMMENT ON COLUMN turnos.duracion_atencion_seg IS 'Segundos de atención efectiva. Calculado por trigger al finalizar.';

-- =============================================================================
-- TABLA: audit_log
-- Trazabilidad inmutable. Solo INSERT. Nunca UPDATE ni DELETE.
-- =============================================================================
CREATE TABLE audit_log (
    id            BIGSERIAL    PRIMARY KEY,
    turno_id      BIGINT       REFERENCES turnos(id)         ON DELETE SET NULL,
    mesa_id       BIGINT       REFERENCES mesas(id)          ON DELETE SET NULL,
    operador_id   BIGINT       REFERENCES usuarios(id)        ON DELETE SET NULL,
    lote_id       BIGINT       REFERENCES lotes_voucher(id)  ON DELETE SET NULL,
    accion        VARCHAR(50)  NOT NULL
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
                          -- Mesa
                          'MESA_ACTIVADA',
                          'MESA_PAUSADA',
                          'MESA_INACTIVADA',
                          'OPERADOR_ASIGNADO',
                          'OPERADOR_LIBERADO',
                          'TURNO_RELLAMADO',
                          -- Sesión
                          'LOGIN_EXITOSO',
                          'LOGIN_FALLIDO',
                          'LOGOUT',
                          -- Admin
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

COMMENT ON TABLE audit_log IS 'Log de auditoría inmutable. REVOKE UPDATE, DELETE para usuario de la app.';

-- =============================================================================
-- TABLA: configuracion
-- =============================================================================
CREATE TABLE configuracion (
    clave           VARCHAR(60)  PRIMARY KEY,
    valor           TEXT         NOT NULL,
    descripcion     TEXT,
    actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_por BIGINT       REFERENCES usuarios(id) ON DELETE SET NULL
);

INSERT INTO configuracion (clave, valor, descripcion) VALUES
    ('tiempo_max_atencion_min',   '10',             'Tiempo máximo sugerido por atención (min). Afecta semáforo en admin.'),
    ('tiempo_max_pausa_min',      '15',             'Tiempo máximo de pausa por mesa (min).'),
    ('alerta_vouchers_restantes', '20',             'Alertar al admin cuando queden N vouchers en el lote.'),
    ('modo_generacion_turnos',    'voucher_fisico', 'Modo activo: voucher_fisico | kiosko_web | mixto'),
    ('kiosko_web_activo',         'false',          'Habilita URL/QR pública para generar turno desde celular o por empleado.'),
    ('mostrar_estimado_espera',   'true',           'Mostrar estimado de espera en TV cuando hay turnos en espera.');

-- =============================================================================
-- ÍNDICES
-- =============================================================================

-- ── lotes_voucher ────────────────────────────────────────────────────────────

-- Búsqueda O(1) del lote activo para la transacción FOR UPDATE.
-- NOTA: el ux_un_lote_activo ya es un índice parcial WHERE estado='activo',
--       pero este índice compuesto acelera cualquier filtro por estado.
CREATE INDEX ix_lotes_estado
    ON lotes_voucher (estado)
    WHERE estado IN ('activo', 'pausado', 'preparado');

-- ── turnos ───────────────────────────────────────────────────────────────────

-- 2ª línea de defensa anti-duplicados (la 1ª es FOR UPDATE en el lote).
-- Si dos transacciones obtuvieran el mismo número (imposible con FOR UPDATE),
-- este UNIQUE index rechaza el segundo INSERT con error 23505.
CREATE UNIQUE INDEX ux_turnos_lote_numero
    ON turnos (lote_id, numero);

-- Turno activo de una mesa. Usado en:
--   UPDATE turnos SET estado='atendido' WHERE mesa_id=$1 AND estado='en_atencion'
-- Cardinalidad muy baja (1 fila por mesa activa) → O(1) siempre.
CREATE UNIQUE INDEX uq_turnos_mesa_activa
    ON turnos (mesa_id)
    WHERE estado = 'en_atencion';

-- Turnos en espera (modo kiosko_web). Usado para calcular posición en cola.
-- NO se usa SKIP LOCKED aquí — el orden de llamado es serial y garantizado
-- por el FOR UPDATE en lotes_voucher. SKIP LOCKED solo aplicaría si varios
-- workers procesaran turnos en paralelo sin importar el orden (no es el caso).
CREATE INDEX ix_turnos_esperando
    ON turnos (lote_id, numero ASC)
    WHERE estado = 'esperando';

-- Reportes por lote (KPIs del admin)
CREATE INDEX ix_turnos_lote_estado
    ON turnos (lote_id, estado);

-- Reportes históricos por fecha
CREATE INDEX ix_turnos_fecha
    ON turnos (creado_en DESC);

-- Índices en Foreign Keys (evitan Seq Scans en cascada y joins)
CREATE INDEX ix_turnos_operador_id ON turnos (operador_id);
CREATE INDEX ix_turnos_mesa_id     ON turnos (mesa_id);

-- Pantalla pública de TV (RF-TV-01, RF-TV-02) — últimos llamados ordenados rápidamente
CREATE INDEX ix_turnos_tv_recientes
    ON turnos (llamado_en DESC NULLS LAST)
    WHERE estado IN ('en_atencion', 'atendido');

-- Métricas por mesa del día (RF-MESA-04) — conteo de turnos atendidos hoy
CREATE INDEX ix_turnos_mesa_atendidos_hoy
    ON turnos (mesa_id, estado, llamado_en);

-- ── mesas ────────────────────────────────────────────────────────────────────

-- Un operador como máximo en 1 mesa asignada (Garantía RF-AUTH-07 e Invariante 4)
CREATE UNIQUE INDEX ux_mesas_operador_unico
    ON mesas (operador_id)
    WHERE operador_id IS NOT NULL;

-- ── usuarios ─────────────────────────────────────────────────────────────────

-- Login sin duplicados por mayúsculas
CREATE UNIQUE INDEX uq_usuarios_username_lower
    ON usuarios (LOWER(username));

-- ── audit_log ────────────────────────────────────────────────────────────────

CREATE INDEX ix_audit_operador_ts  ON audit_log (operador_id, timestamp DESC);
CREATE INDEX ix_audit_accion_ts    ON audit_log (accion, timestamp DESC);
CREATE INDEX ix_audit_lote         ON audit_log (lote_id, timestamp DESC);
CREATE INDEX ix_audit_turno_id     ON audit_log (turno_id);
CREATE INDEX ix_audit_mesa_id      ON audit_log (mesa_id);

-- =============================================================================
-- TRIGGERS
-- =============================================================================

-- ── 1. Actualizar actualizado_en ────────────────────────────────────────────
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

-- ── 2. Calcular timestamps y duraciones al cambiar estado ───────────────────
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

-- ── 3. Auditoría automática de turnos ───────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_audit_turno()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_accion VARCHAR(50);
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.estado = 'en_atencion' THEN
            v_accion := 'TURNO_LLAMADO';  -- Voucher físico: INSERT directo en en_atencion
        ELSIF NEW.estado = 'esperando' THEN
            v_accion := 'TURNO_GENERADO'; -- Kiosko web: pre-registro esperando turno
        ELSE
            v_accion := NULL;
        END IF;

    ELSIF TG_OP = 'UPDATE' AND OLD.estado IS DISTINCT FROM NEW.estado THEN
        CASE
            WHEN NEW.estado = 'en_atencion' AND OLD.estado = 'esperando'
                THEN v_accion := 'TURNO_LLAMADO';        -- kiosko_web: esperando → en_atencion
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

-- ── 4. Inmutabilidad estricta de audit_log (solo-INSERT) ─────────────────────
CREATE OR REPLACE FUNCTION fn_bloquear_modificacion_audit_log()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log es inmutable. No se permite UPDATE ni DELETE (SQLSTATE: 42501)';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_inmutable ON audit_log;
CREATE TRIGGER trg_audit_log_inmutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION fn_bloquear_modificacion_audit_log();

-- ── 5. Control de no-regresión en lotes_voucher.ultimo_numero_llamado ─────────
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

-- ── 6. Función transaccional atómica de 1 Round-Trip fn_llamar_siguiente ─────
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
    -- 1. Bloqueo y verificación de la mesa
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

-- =============================================================================
-- SEGURIDAD
-- =============================================================================

-- =============================================================================
-- pg_cron: mantenimiento nocturno 11:30 PM (si la extensión está disponible)
-- NO reinicia el lote — el admin decide cuándo pausarlo o cerrarlo
-- =============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule(
            'reset-mesas-noche',
            '30 23 * * *',
            $cron$
                UPDATE mesas
                SET estado = 'inactiva', operador_id = NULL
                WHERE estado IN ('activa', 'pausada');
            $cron$
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible; omitiendo schedule automático.';
END $$;

-- =============================================================================
-- SEED — Datos iniciales para desarrollo
-- Usar scripts/seed.js para generar hashes bcrypt reales
-- =============================================================================

INSERT INTO usuarios (username, nombre_completo, password_hash, rol) VALUES
    ('admin',       'Administrador del Sistema',  '$2b$12$PLACEHOLDER_ADMIN',  'admin'),
    ('supervisor1', 'Supervisor Principal',        '$2b$12$PLACEHOLDER_SUP',    'supervisor'),
    ('op1',         'Operador Mesa 1',             '$2b$12$PLACEHOLDER_OP1',    'operador'),
    ('op2',         'Operador Mesa 2',             '$2b$12$PLACEHOLDER_OP2',    'operador'),
    ('op3',         'Operador Mesa 3',             '$2b$12$PLACEHOLDER_OP3',    'operador'),
    ('op4',         'Operador Mesa 4',             '$2b$12$PLACEHOLDER_OP4',    'operador'),
    ('op5',         'Operador Mesa 5',             '$2b$12$PLACEHOLDER_OP5',    'operador'),
    ('portón',      'Empleado Portón / Kiosko',    '$2b$12$PLACEHOLDER_PORT',   'operador');

INSERT INTO mesas (numero, nombre, estado) VALUES
    (1,  'Mesa 1 — Matrícula',      'inactiva'),
    (2,  'Mesa 2 — Matrícula',      'inactiva'),
    (3,  'Mesa 3 — Pagos',          'inactiva'),
    (4,  'Mesa 4 — Pagos',          'inactiva'),
    (5,  'Mesa 5 — Documentos',     'inactiva'),
    (6,  'Mesa 6 — Documentos',     'inactiva'),
    (7,  'Mesa 7 — Inscripciones',  'inactiva'),
    (8,  'Mesa 8 — Inscripciones',  'inactiva'),
    (9,  'Mesa 9 — Validación',     'inactiva'),
    (10, 'Mesa 10 — Validación',    'inactiva'),
    (11, 'Mesa 11 — General',       'inactiva'),
    (12, 'Mesa 12 — General',       'inactiva');

-- Lote de prueba para desarrollo (Lote 1 automáticamente)
INSERT INTO lotes_voucher (numero_desde, numero_hasta, estado, creado_por)
VALUES (1, 50, 'preparado', 1);

-- =============================================================================
-- FIN DEL SCHEMA — Turnero de Matrículas 2026 v2.1
-- =============================================================================