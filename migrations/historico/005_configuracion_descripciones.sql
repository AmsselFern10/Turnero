-- ==============================================================================
-- MIGRACIÓN 005: DESCRIPCIONES Y ESTANDARIZACIÓN DE CONFIGURACIÓN
-- Sistema Turnero de Matrículas 2026 (v2.1)
-- ==============================================================================

UPDATE configuracion SET descripcion = 'Umbral de turnos restantes en el lote activo para emitir alerta al administrador (1 a 500).' WHERE clave = 'alerta_vouchers_restantes';
UPDATE configuracion SET descripcion = 'Zona horaria oficial del sistema para registro de marcas de tiempo y cortes diarios.' WHERE clave = 'zona_horaria';
UPDATE configuracion SET descripcion = 'Mostrar u ocultar la estimación de tiempo de espera en la pantalla pública de TV.' WHERE clave = 'mostrar_estimado_espera';
UPDATE configuracion SET descripcion = 'Reproducir anuncio por voz sintética en la pantalla pública al llamar cada turno.' WHERE clave = 'voz_anuncio_activa';
UPDATE configuracion SET descripcion = 'Escala porcentual para el tamaño de los números de turno en pantalla TV (75 a 140, defecto: 100).' WHERE clave = 'tv_escala_turnos';
UPDATE configuracion SET descripcion = 'Habilitar toma de turnos en autoservicio o tablet (Kiosko Web).' WHERE clave = 'kiosko_web_activo';
UPDATE configuracion SET descripcion = 'Modo operativo activo del sistema: voucher_fisico (papel) o kiosko_web (digital).' WHERE clave = 'modo_generacion_turnos';
UPDATE configuracion SET descripcion = 'Modalidad de emisión del kiosko: estudiante (autoservicio libre) o empleado (asistido en recepción).' WHERE clave = 'kiosko_modo_uso';
UPDATE configuracion SET descripcion = 'Límite máximo de turnos diarios emitidos por Kiosko Web (0 = sin límite).' WHERE clave = 'kiosko_tope_diario';
UPDATE configuracion SET descripcion = 'URL base pública para acceso desde móviles y código QR (vacío = autodetección LAN).' WHERE clave = 'kiosko_url_base';
UPDATE configuracion SET descripcion = 'Habilitar la impresión física directa de tickets desde el servidor vía LAN.' WHERE clave = 'impresora_activa';
UPDATE configuracion SET descripcion = 'Dirección IP de la impresora térmica ESC/POS en la red local.' WHERE clave = 'impresora_ip';
UPDATE configuracion SET descripcion = 'Puerto TCP de la impresora térmica ESC/POS (estándar: 9100).' WHERE clave = 'impresora_puerto';
