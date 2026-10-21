-- =============================================================================
-- TURNERO DE MATRICULAS 2026 -- v2.1 (Consolidado)
-- Archivo 4/4: PERMISOS, PROTECCIONES Y AJUSTES FINALES
-- =============================================================================
-- Incluye: proteccion de audit_log, FK diferidas y cualquier ajuste
-- que no pertenece a los archivos de tablas, indices o funciones.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Proteccion de audit_log (principio de inmutabilidad de auditoria)
-- ---------------------------------------------------------------------------
-- Revocar permisos de modificacion al rol de aplicacion.
-- El usuario de aplicacion (definido en .env como DB_USER) puede INSERT
-- pero no UPDATE ni DELETE sobre audit_log.
-- Ajustar el nombre del rol si el entorno usa uno diferente a 'turnero_app'.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'turnero_app') THEN
        REVOKE UPDATE, DELETE ON audit_log FROM turnero_app;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Comentarios de tablas (documentacion en catalogo de PostgreSQL)
-- ---------------------------------------------------------------------------
COMMENT ON TABLE usuarios               IS 'Operadores y administradores del sistema (roles: operador, admin).';
COMMENT ON TABLE configuracion          IS 'Parametros dinamicos del sistema editables en caliente.';
COMMENT ON TABLE mesas                  IS 'Ventanillas o sitios de atencion en sala.';
COMMENT ON TABLE lotes_voucher          IS 'Contador central correlativo multi-dia para vouchers fisicos.';
COMMENT ON TABLE kiosko_contador_diario IS 'Contador diario correlativo independiente para el autoservicio Kiosko Web.';
COMMENT ON TABLE turnos                 IS 'Registro de turnos atendidos (voucher fisico) o en cola (kiosko web).';
COMMENT ON TABLE audit_log              IS 'Trazabilidad inmutable del sistema. Solo-INSERT.';

-- ---------------------------------------------------------------------------
-- 3. Comentarios en columnas clave
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN usuarios.eliminado_en
    IS 'NULL = activo o desactivado. NOT NULL = eliminado logicamente (oculto en UI).';
COMMENT ON COLUMN mesas.eliminado_en
    IS 'NULL = mesa vigente (activa/pausada/inactiva). NOT NULL = mesa eliminada logicamente.';
COMMENT ON COLUMN lotes_voucher.eliminado_en
    IS 'NULL = lote vigente. NOT NULL = lote eliminado logicamente.';
COMMENT ON COLUMN audit_log.accion
    IS 'Accion registrada. Lista cerrada por CHECK. TURNO_FINALIZADO agregado en v2.1.1.';

-- ---------------------------------------------------------------------------
-- 4. Notas de version
-- ---------------------------------------------------------------------------
-- v2.1   : Schema inicial (001_initial.sql)
-- v2.1.1 : + fn_atender_rezagado, TURNO_REZAGADO en audit_log (003)
--           + Borrado logico con indices parciales (004)
--           + tv_escala_turnos, tv_escala_principal, tv_escala_secundaria (002, 006)
--           + kiosko_modo_uso, kiosko_impresion_automatica (005, 007)
--           + kiosko_url_publica (008)
--           + fondo_imagen_url, fondo_imagen_activa (009)
-- v2.1.1c: CORRECCION H1: fn_atender_rezagado usa variable escalar
--           v_lote_numero en lugar de v_lote.numero_lote (evita error en kiosko).
--          CORRECCION H2: ux_mesas_operador_unico excluye mesas eliminadas.
--          CORRECCION H4: TURNO_FINALIZADO agregado al CHECK de audit_log.
--          CORRECCION H5: kiosko_modo_uso insertado en configuracion inicial.
--                         Descripciones de URL kiosko corregidas.
-- v2.1.2 : + tv_opacidad_principal, tv_opacidad_secundaria (011)

-- ---------------------------------------------------------------------------
-- 5. Claves de configuracion TV: opacidad de tarjetas (v2.1.2)
-- ---------------------------------------------------------------------------
INSERT INTO configuracion (clave, valor, descripcion)
VALUES
  (
    'tv_opacidad_principal',
    '100',
    'Opacidad del fondo de la tarjeta principal (turno en curso) en pantalla TV. Entero de 20 a 100; 100 = completamente opaco (sin cambio visual).'
  ),
  (
    'tv_opacidad_secundaria',
    '100',
    'Opacidad del fondo de las cuatro tarjetas de turnos anteriores en pantalla TV. Entero de 20 a 100; 100 = completamente opaco (sin cambio visual).'
  )
ON CONFLICT (clave) DO NOTHING;

-- =============================================================================
-- FIN ARCHIVO 4/4
-- =============================================================================