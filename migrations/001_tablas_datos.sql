-- =============================================================================
-- TURNERO DE MATRICULAS 2026 -- v2.1 (Consolidado)
-- Archivo 1/4: TABLAS, RESTRICCIONES Y DATOS INICIALES
-- =============================================================================
-- Incluye: extensiones, secuencias, fn_fecha_hoy (requerida por defaults),
-- todas las tablas con sus columnas finales (incluye borrado logico),
-- todos los CHECK constraints en version final, y los datos de configuracion.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. EXTENSIONES Y SECUENCIAS
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE IF NOT EXISTS seq_numero_lote START 1 INCREMENT 1;

-- ---------------------------------------------------------------------------
-- 2. FUNCION DE FECHA (necesaria para defaults de tablas)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3. TABLAS
-- ---------------------------------------------------------------------------

-- TABLA: configuracion (va antes de otras porque fn_fecha_hoy la consulta)
CREATE TABLE configuracion (
    clave           VARCHAR(60)  PRIMARY KEY,
    valor           TEXT         NOT NULL,
    descripcion     TEXT,
    actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_por BIGINT
);
COMMENT ON TABLE configuracion IS 'Parametros dinamicos del sistema editables en caliente.';

-- TABLA: usuarios
-- Sin UNIQUE inline en username: se usa indice parcial (borrado logico)
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
    eliminado_en    TIMESTAMPTZ  DEFAULT NULL
);
COMMENT ON TABLE usuarios IS 'Operadores y administradores del sistema (roles: operador, admin).';

-- FK diferida: configuracion.actualizado_por -> usuarios(id)
-- La columna ya existe en el CREATE TABLE; solo se agrega la restriccion referencial.
ALTER TABLE configuracion
    ADD CONSTRAINT fk_configuracion_actualizado_por
    FOREIGN KEY (actualizado_por) REFERENCES usuarios(id) ON DELETE SET NULL;

-- TABLA: mesas
-- CHECK estado incluye 'eliminada' (borrado logico independiente)
-- Sin UNIQUE inline en numero: se usa indice parcial
CREATE TABLE mesas (
    id             BIGSERIAL    PRIMARY KEY,
    numero         INTEGER      NOT NULL,
    nombre         VARCHAR(60)  NOT NULL,
    estado         VARCHAR(20)  NOT NULL DEFAULT 'inactiva'
                       CONSTRAINT ck_mesas_estado
                           CHECK (estado IN ('activa', 'pausada', 'inactiva', 'eliminada')),
    operador_id    BIGINT       REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    eliminado_en   TIMESTAMPTZ  DEFAULT NULL
);
COMMENT ON TABLE mesas IS 'Ventanillas o sitios de atencion en sala.';

-- TABLA: lotes_voucher
-- CHECK estado incluye 'eliminado' (borrado logico independiente)
-- Sin UNIQUE inline en numero_lote: se usa indice parcial
CREATE TABLE lotes_voucher (
    id                    BIGSERIAL    PRIMARY KEY,
    numero_lote           INTEGER      NOT NULL
                              DEFAULT nextval('seq_numero_lote'),
    numero_desde          INTEGER      NOT NULL DEFAULT 1,
    numero_hasta          INTEGER      NOT NULL,
    ultimo_numero_llamado INTEGER      NOT NULL DEFAULT 0,
    estado                VARCHAR(20)  NOT NULL DEFAULT 'preparado'
                              CONSTRAINT ck_lotes_estado CHECK (estado IN (
                                  'preparado',
                                  'activo',
                                  'pausado',
                                  'agotado',
                                  'cerrado',
                                  'eliminado'
                              )),
    fecha_creacion        DATE         NOT NULL DEFAULT fn_fecha_hoy(),
    fecha_activacion      TIMESTAMPTZ,
    fecha_cierre          TIMESTAMPTZ,
    creado_por            BIGINT       REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado_en        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    eliminado_en          TIMESTAMPTZ  DEFAULT NULL,

    CONSTRAINT ck_lote_rango
        CHECK (numero_desde >= 1 AND numero_hasta >= numero_desde),
    CONSTRAINT ck_lote_progreso
        CHECK (ultimo_numero_llamado >= 0 AND ultimo_numero_llamado <= numero_hasta)
);
COMMENT ON TABLE lotes_voucher IS 'Contador central correlativo multi-dia para vouchers fisicos.';

-- TABLA: kiosko_contador_diario
CREATE TABLE kiosko_contador_diario (
    fecha          DATE        PRIMARY KEY,
    ultimo_numero  INTEGER     NOT NULL DEFAULT 0,
    sesion         INTEGER     NOT NULL DEFAULT 1,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE kiosko_contador_diario IS 'Contador diario correlativo independiente para el autoservicio Kiosko Web.';

-- TABLA: turnos
CREATE TABLE turnos (
    id                    BIGSERIAL    PRIMARY KEY,
    numero                INTEGER      NOT NULL,
    fecha_turno           DATE         NOT NULL DEFAULT fn_fecha_hoy(),
    sesion                INTEGER      NOT NULL DEFAULT 1,
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
            (origen = 'kiosko_web'     AND token_consulta IS NOT NULL)
        )
);
COMMENT ON TABLE turnos IS 'Registro de turnos atendidos (voucher fisico) o en cola (kiosko web).';

-- TABLA: audit_log
-- CHECK accion: version final con TURNO_REZAGADO (003) y TURNO_FINALIZADO (correccion)
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
                          'TURNO_REZAGADO',
                          'ATENCION_FINALIZADA',
                          'TURNO_FINALIZADO',
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
                          -- Sesion
                          'LOGIN_EXITOSO',
                          'LOGIN_FALLIDO',
                          'LOGOUT',
                          -- Administracion
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
COMMENT ON TABLE audit_log IS 'Trazabilidad inmutable del sistema. Solo-INSERT. TURNO_FINALIZADO agregado en v2.1.1.';

-- ---------------------------------------------------------------------------
-- 4. CONFIGURACION INICIAL DEL SISTEMA
-- ---------------------------------------------------------------------------
-- kiosko_url_base  = URL local LAN.
-- kiosko_url_publica = URL publica opcional (vacio = red local LAN).
-- ---------------------------------------------------------------------------
INSERT INTO configuracion (clave, valor, descripcion) VALUES
    ('alerta_vouchers_restantes',  '20',
     'Umbral de vouchers restantes en el lote activo para emitir alerta al administrador (1 a 500).'),
    ('modo_generacion_turnos',     'voucher_fisico',
     'Modo operativo activo del sistema: voucher_fisico (papel) o kiosko_web (digital).'),
    ('kiosko_web_activo',          'false',
     'Habilitar toma de turnos en autoservicio o tablet (Kiosko Web).'),
    ('mostrar_estimado_espera',    'true',
     'Mostrar u ocultar la estimacion de tiempo de espera en la pantalla publica de TV.'),
    ('zona_horaria',               'America/Tegucigalpa',
     'Zona horaria oficial del sistema para registro de marcas de tiempo y cortes diarios.'),
    ('kiosko_tope_diario',         '0',
     'Limite maximo de turnos diarios emitidos por Kiosko Web (0 = sin limite).'),
    ('kiosko_url_base',            '',
     'URL local (LAN) del kiosko para acceso desde la red interna y codigo QR (vacio = autodeteccion).'),
    ('voz_anuncio_activa',         'true',
     'Reproducir anuncio por voz sintetica en la pantalla publica al llamar cada turno.'),
    ('impresora_ip',               '',
     'Direccion IP de la impresora termica ESC/POS en la red local.'),
    ('impresora_puerto',           '9100',
     'Puerto TCP de la impresora termica ESC/POS (estandar: 9100).'),
    ('impresora_activa',           'false',
     'Habilitar la impresion fisica directa de tickets desde el servidor via LAN.'),
    ('tv_escala_turnos',           '100',
     'Escala porcentual para el tamano de los numeros de turno en pantalla TV, compatibilidad (75-140).'),
    ('tv_escala_principal',        '100',
     'Escala porcentual del numero de turno principal en pantalla TV (75-140).'),
    ('tv_escala_secundaria',       '100',
     'Escala porcentual de turnos anteriores y banner de mesa en TV (75-140).'),
    ('kiosko_impresion_automatica','false',
     'Imprimir comprobante automaticamente al generar turno en modo tablet.'),
    ('kiosko_url_publica',         '',
     'URL publica opcional para acceso de participantes al kiosko y seguimiento QR (vacio = red local LAN).'),
    ('kiosko_modo_uso',            'asistido',
     'Modalidad del kiosko: asistido (tablet con operador) / estudiante (autoservicio movil).'),
    ('fondo_imagen_url',           '',
     'URL o ruta de la imagen institucional de fondo para las pantallas del sistema.'),
    ('fondo_imagen_activa',        'false',
     'Activar la imagen de fondo institucional en las pantallas del sistema.')
ON CONFLICT (clave) DO NOTHING;

-- =============================================================================
-- FIN ARCHIVO 1/4
-- =============================================================================