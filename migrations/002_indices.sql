-- =============================================================================
-- TURNERO DE MATRICULAS 2026 -- v2.1 (Consolidado)
-- Archivo 2/4: INDICES
-- =============================================================================
-- Incluye todos los indices en su version final.
-- Los indices parciales de borrado logico excluyen registros eliminados.
-- CORRECCION (H2): ux_mesas_operador_unico ahora excluye mesas eliminadas
--   para que un operador asignado a una mesa eliminada pueda tomar otra mesa.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- usuarios
-- ---------------------------------------------------------------------------
-- Unicidad de username entre usuarios activos (no eliminados).
-- Reemplaza el UNIQUE constraint inline que tenia la tabla en versiones anteriores.
CREATE UNIQUE INDEX ux_usuarios_username_activos
    ON usuarios (LOWER(username))
    WHERE eliminado_en IS NULL;

-- ---------------------------------------------------------------------------
-- mesas
-- ---------------------------------------------------------------------------
-- Unicidad de numero de mesa entre mesas no eliminadas.
CREATE UNIQUE INDEX ux_mesas_numero_activas
    ON mesas (numero)
    WHERE estado != 'eliminada' AND eliminado_en IS NULL;

-- Un operador solo puede tener una mesa activa (no eliminada) a la vez.
-- CORRECCION H2: condicion extendida para excluir mesas eliminadas,
-- de lo contrario un operador asignado a una mesa eliminada quedaba bloqueado.
CREATE UNIQUE INDEX ux_mesas_operador_unico
    ON mesas (operador_id)
    WHERE operador_id IS NOT NULL
      AND estado != 'eliminada'
      AND eliminado_en IS NULL;

-- ---------------------------------------------------------------------------
-- lotes_voucher
-- ---------------------------------------------------------------------------
-- Unicidad de numero_lote entre lotes no eliminados.
CREATE UNIQUE INDEX ux_lotes_numero_lote_activos
    ON lotes_voucher (numero_lote)
    WHERE estado != 'eliminado' AND eliminado_en IS NULL;

-- Solo puede existir un lote en estado 'activo' en cualquier momento.
CREATE UNIQUE INDEX ux_lotes_un_lote_activo
    ON lotes_voucher ((estado))
    WHERE estado = 'activo';

-- Acelera busqueda del lote activo y consultas de estado de lotes en uso.
CREATE INDEX ix_lotes_estado
    ON lotes_voucher (estado)
    WHERE estado IN ('activo', 'pausado', 'preparado');

-- ---------------------------------------------------------------------------
-- turnos
-- ---------------------------------------------------------------------------
-- Garantiza que no existan dos turnos con el mismo numero en el mismo lote.
CREATE UNIQUE INDEX ux_turnos_lote_numero
    ON turnos (lote_id, numero)
    WHERE lote_id IS NOT NULL;

-- Solo puede haber un turno en_atencion por mesa en cualquier momento.
CREATE UNIQUE INDEX ux_turnos_mesa_activa
    ON turnos (mesa_id)
    WHERE estado = 'en_atencion';

-- Garantiza unicidad de numero de turno kiosko por dia y sesion.
CREATE UNIQUE INDEX ux_turnos_kiosko_dia_numero
    ON turnos (fecha_turno, sesion, numero)
    WHERE origen = 'kiosko_web';

-- Idempotencia: evita crear dos turnos con la misma clave de idempotencia.
CREATE UNIQUE INDEX ux_turnos_idempotency_key
    ON turnos (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Evita que un mismo dispositivo tenga dos turnos en espera el mismo dia.
CREATE UNIQUE INDEX ux_turnos_device_esperando
    ON turnos (device_id)
    WHERE device_id IS NOT NULL AND estado = 'esperando';

-- Acelera la consulta de siguiente turno kiosko en espera (FOR UPDATE SKIP LOCKED).
CREATE INDEX ix_turnos_esperando_kiosko
    ON turnos (fecha_turno, numero ASC)
    WHERE estado = 'esperando' AND origen = 'kiosko_web';

-- Consultas por lote + estado (historial, reportes).
CREATE INDEX ix_turnos_lote_estado
    ON turnos (lote_id, estado);

-- Consultas de historial ordenadas por fecha de creacion.
CREATE INDEX ix_turnos_fecha
    ON turnos (creado_en DESC);

-- Historial reciente para la pantalla TV.
CREATE INDEX ix_turnos_tv_recientes
    ON turnos (llamado_en DESC NULLS LAST)
    WHERE estado IN ('en_atencion', 'atendido');

-- KPIs de mesa: atendidos del dia.
CREATE INDEX ix_turnos_mesa_atendidos_hoy
    ON turnos (mesa_id, estado, llamado_en);

-- Consultas de turnos por operador.
CREATE INDEX ix_turnos_operador_id
    ON turnos (operador_id);

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
CREATE INDEX ix_audit_operador_ts ON audit_log (operador_id, timestamp DESC);
CREATE INDEX ix_audit_accion_ts   ON audit_log (accion, timestamp DESC);
CREATE INDEX ix_audit_lote        ON audit_log (lote_id, timestamp DESC);
CREATE INDEX ix_audit_turno_id    ON audit_log (turno_id);
CREATE INDEX ix_audit_mesa_id     ON audit_log (mesa_id);

-- =============================================================================
-- FIN ARCHIVO 2/4
-- =============================================================================