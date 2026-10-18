'use strict'

/**
 * AUDIT_ACCIONES — Fuente única de verdad para los valores de audit_log.accion.
 *
 * Estas constantes deben coincidir exactamente con el CHECK constraint de la BD
 * definido en migrations/001_initial.sql y actualizado en 002_fix_audit_log_y_mesas.sql.
 *
 * USO OBLIGATORIO: Todo el código de la aplicación que inserte en audit_log debe
 * usar estas constantes, nunca strings literales.
 *
 * TEST: tests/audit-acciones.test.js verifica que todos los valores aquí definidos
 * pasen el CHECK real de PostgreSQL (pg_get_constraintdef).
 */
const AUDIT_ACCIONES = {
  // ── Turno ──────────────────────────────────────────────────────────────────
  TURNO_GENERADO:         'TURNO_GENERADO',
  TURNO_LLAMADO:          'TURNO_LLAMADO',
  TURNO_RELLAMADO:        'TURNO_RELLAMADO',
  TURNO_REZAGADO:         'TURNO_REZAGADO',
  ATENCION_FINALIZADA:    'ATENCION_FINALIZADA',
  TURNO_CANCELADO:        'TURNO_CANCELADO',

  // ── Lote ───────────────────────────────────────────────────────────────────
  LOTE_CREADO:            'LOTE_CREADO',
  LOTE_ACTIVADO:          'LOTE_ACTIVADO',
  LOTE_PAUSADO:           'LOTE_PAUSADO',
  LOTE_AGOTADO:           'LOTE_AGOTADO',
  LOTE_EXTENDIDO:         'LOTE_EXTENDIDO',
  LOTE_CERRADO:           'LOTE_CERRADO',
  LOTE_NUEVO_DESDE_UNO:   'LOTE_NUEVO_DESDE_UNO',
  LOTE_CONTADOR_AJUSTADO: 'LOTE_CONTADOR_AJUSTADO',

  // ── Mesa / Operador ────────────────────────────────────────────────────────
  MESA_ACTIVADA:        'MESA_ACTIVADA',
  MESA_PAUSADA:         'MESA_PAUSADA',
  MESA_INACTIVADA:      'MESA_INACTIVADA',
  OPERADOR_ASIGNADO:    'OPERADOR_ASIGNADO',   // Admin asigna operador a mesa
  OPERADOR_LIBERADO:    'OPERADOR_LIBERADO',   // Operador libera su mesa ("Cambiar de mesa")

  // ── Sesion ─────────────────────────────────────────────────────────────────
  LOGIN_EXITOSO:        'LOGIN_EXITOSO',
  LOGIN_FALLIDO:        'LOGIN_FALLIDO',
  LOGOUT:               'LOGOUT',

  // ── Admin ──────────────────────────────────────────────────────────────────
  USUARIO_CREADO:       'USUARIO_CREADO',
  USUARIO_EDITADO:      'USUARIO_EDITADO',
  USUARIO_DESACTIVADO:  'USUARIO_DESACTIVADO',
  CONFIG_MODIFICADA:    'CONFIG_MODIFICADA',
  ADMIN_ACTION:         'ADMIN_ACTION'
}

/**
 * Lista de todos los valores permitidos (usada por el test de consistencia).
 * Debe ser un subconjunto exacto del CHECK de la BD.
 */
const AUDIT_ACCIONES_SET = new Set(Object.values(AUDIT_ACCIONES))

module.exports = { AUDIT_ACCIONES, AUDIT_ACCIONES_SET }
