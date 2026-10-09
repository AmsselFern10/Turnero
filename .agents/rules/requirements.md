---
trigger: always_on
---

# Requerimientos del Sistema — Turnero de Matrículas 2026 (v2.1)
> Clasificación MoSCoW: MUST (obligatorio) · SHOULD (recomendado) · COULD (deseable)
> Actualizado: Octubre 2026 — Refleja decisiones de diseño confirmadas en schema v2.1

---

# PARTE I — REQUERIMIENTOS FUNCIONALES

---

## RF-AUTH — Autenticación y Sesión

| Código | Descripción | Criterio de Aceptación | Prioridad |
|---|---|---|---|
| RF-AUTH-01 | Login mediante usuario y contraseña | Login exitoso devuelve JWT y redirige al panel según rol | MUST |
| RF-AUTH-02 | Tres roles: `operador`, `supervisor`, `admin` | Cada rol accede solo a sus rutas y pantallas | MUST |
| RF-AUTH-03 | Selección de mesa post-login desde grilla dinámica | Grilla generada desde `GET /mesas`; mesas ocupadas deshabilitadas | MUST |
| RF-AUTH-04 | Cierre de sesión seguro | Token a blacklist Redis; `sessionStorage` limpiado | MUST |
| RF-AUTH-05 | Sesión en `sessionStorage` (no localStorage) | Al cerrar el tab la sesión expira automáticamente (PCs compartidas) | MUST |
| RF-AUTH-06 | JWT con expiración de 2 horas + refresh cookie HttpOnly | Refresh transparente sin re-login | MUST |
| RF-AUTH-07 | Un operador no puede estar asignado a dos mesas simultáneamente | Sistema rechaza segunda asignación con mensaje claro | MUST |
| RF-AUTH-08 | Passwords con bcrypt cost >= 12 | Ningún hash en texto plano, MD5 o SHA1 en la BD | MUST |

---

## RF-LOTE — Gestión de Lotes de Vouchers

| Código | Descripción | Criterio de Aceptación | Prioridad |
|---|---|---|---|
| RF-LOTE-01 | Admin puede crear un lote especificando `numero_hasta` | Sistema auto-asigna nombre "Lote N" correlativo | MUST |
| RF-LOTE-02 | Solo puede haber un lote activo a la vez | BD garantiza esto con índice único parcial; activar uno desactiva el anterior | MUST |
| RF-LOTE-03 | Admin puede activar un lote desde estado `preparado` o `pausado` | Activación inmediata; operadores pueden llamar turnos al instante | MUST |
| RF-LOTE-04 | Admin puede pausar el lote al fin del día | Estado pasa a `pausado`; `ultimo_numero_llamado` se conserva | MUST |
| RF-LOTE-05 | Lote multi-día: continúa donde se quedó | Reactivar lote pausado → continúa desde `ultimo_numero_llamado` | MUST |
| RF-LOTE-06 | Admin puede extender `numero_hasta` en caliente | Cambio de 500 → 700 sin reiniciar; vouchers 501-700 disponibles inmediatamente | MUST |
| RF-LOTE-07 | Sistema notifica al admin cuando quedan N vouchers | Alerta WS `admin:all` cuando `numero_hasta - ultimo_numero_llamado <= alerta_vouchers_restantes` | MUST |
| RF-LOTE-08 | Admin puede cerrar un lote y crear uno nuevo desde 1 | Cierre registrado en `audit_log`; nuevo lote recibe número correlativo | MUST |
| RF-LOTE-09 | Admin ve progreso del lote en tiempo real | Barra de progreso y contador de vouchers restantes en panel admin | SHOULD |

---

## RF-TURN — Gestión de Turnos (Core)

| Código | Descripción | Criterio de Aceptación | Prioridad |
|---|---|---|---|
| RF-TURN-01 | "Llamar Siguiente" ejecuta todo en 1 transacción atómica | Finaliza turno anterior + obtiene siguiente número + crea nuevo turno + broadcast WS | MUST |
| RF-TURN-02 | Cero turnos duplicados bajo cualquier escenario de concurrencia | 10 mesas simultáneas → 10 números distintos en orden; verificable con prueba de carga | MUST |
| RF-TURN-03 | La transacción de llamado usa `FOR UPDATE` sobre el lote | Bloqueo a nivel de fila; ningún otro proceso puede obtener el mismo número | MUST |
| RF-TURN-04 | El turno anterior se marca `atendido` automáticamente al llamar el siguiente | Sin botón "Finalizar" separado; 1 clic por estudiante en el flujo normal | MUST |
| RF-TURN-05 | El operador puede marcar un turno como `cancelado` (no se presentó) | Botón secundario "No se presentó"; registrado en `audit_log` | MUST |
| RF-TURN-06 | Las duraciones son calculadas automáticamente por triggers de PG | `duracion_atencion_seg` = `finalizado_en - llamado_en`; sin lógica en el backend | MUST |
| RF-TURN-07 | El operador puede pausar su mesa sin afectar el lote activo | Mesa en `pausado`; lote sigue disponible para otras mesas | MUST |
| RF-TURN-08 | Al agotarse el lote, el sistema impide llamar más turnos y notifica | Endpoint retorna 409; WS emite `lote_agotado` a `admin:all` | MUST |
| RF-TURN-09 | El panel del operador muestra el próximo número en espera | Calculado como `ultimo_numero_llamado + 1` del lote activo | SHOULD |

---

## RF-WS — WebSocket / Tiempo Real

| Código | Descripción | Criterio de Aceptación | Prioridad |
|---|---|---|---|
| RF-WS-01 | Todo update de estado se difunde por WS; cero polling HTTP | Ningún cliente realiza peticiones periódicas para actualizar pantalla | MUST |
| RF-WS-02 | Canales segmentados: `mesa:<id>`, `tv:global`, `admin:all` | Cada cliente solo recibe eventos relevantes a su rol/contexto | MUST |
| RF-WS-03 | Conexión WS autenticada con JWT en el handshake | Conexiones sin token válido rechazadas antes de establecerse | MUST |
| RF-WS-04 | Reconexión automática con backoff exponencial + jitter | `delay = min(base * 2^n + random(0,1s), 30s)`; feedback visual al usuario | MUST |
| RF-WS-05 | Al reconectar, el cliente recibe snapshot del estado actual | Primer mensaje post-reconexión contiene estado completo de la mesa/lote | MUST |
| RF-WS-06 | Heartbeat cada 30s; conexiones fantasma cerradas en 60s | Servidor detecta y limpia conexiones muertas automáticamente | MUST |
| RF-WS-07 | Protocolo de mensaje uniforme: `{ tipo, payload, timestamp }` | Todos los mensajes siguen el mismo esquema JSON | MUST |

---

## RF-MESA — Panel del Operador (`panel_mesa.html`)

| Código | Descripción | Criterio de Aceptación | Prioridad |
|---|---|---|---|
| RF-MESA-01 | Turno actual en tipografía gigante (JetBrains Mono, ≥ 96px) | Legible desde 1 metro en monitor estándar | MUST |
| RF-MESA-02 | Encabezado permanente: "Mesa N — Nombre Operador" | Nunca desaparece, visible en todos los estados | MUST |
| RF-MESA-03 | Cronómetro de atención corriendo desde `llamado_en` | Se reinicia con cada nuevo turno | MUST |
| RF-MESA-04 | Contador de turnos atendidos en el día por esta mesa | Actualizado en tiempo real vía WS; persiste con recarga de página | MUST |
| RF-MESA-05 | Indicador visual de estado de conexión WS | Verde/Amarillo parpadeante/Rojo según estado | MUST |
| RF-MESA-06 | Pantalla de cortesía cuando la mesa está pausada | "Mesa en pausa" reemplaza el panel de atención | MUST |
| RF-MESA-07 | Botón principal: LLAMAR SIGUIENTE (siempre visible) | Único botón necesario para el flujo normal | MUST |
| RF-MESA-08 | Botón secundario: No se presentó (solo con turno activo) | Visible solo cuando hay turno en estado `en_atencion` | MUST |
| RF-MESA-09 | Próximo turno anticipado en tarjeta secundaria | Muestra `ultimo_numero_llamado + 1` del lote activo | SHOULD |

---

## RF-TV — Pantalla Pública (`tv.html`)

| Código | Descripción | Criterio de Aceptación | Prioridad |
|---|---|---|---|
| RF-TV-01 | Último llamado: número ≥ 200px + mesa ≥ 72px | Legible a 5 metros en TV de 40" | MUST |
| RF-TV-02 | Historial de los últimos 4 turnos llamados | Lista actualizada automáticamente; más reciente primero | MUST |
| RF-TV-03 | Reloj digital sincronizado visible | Actualizado cada segundo | MUST |
| RF-TV-04 | Actualización 100% pasiva via WS (sin F5) | Operación completamente autónoma | MUST |
| RF-TV-05 | Banner animado "Reconectando…" si WS cae | Nunca pantalla en blanco; último estado visible con banner | MUST |
| RF-TV-06 | Animación/destello al recibir nuevo llamado | Efecto visual de atención al actualizar "Último Llamado" | SHOULD |

---

## RF-ADM — Panel de Administración (`admin.html`)

| Código | Descripción | Criterio de Aceptación | Prioridad |
|---|---|---|---|
| RF-ADM-01 | KPIs en tiempo real: atendidos, promedio, mesas activas, vouchers restantes | Actualizados via WS `admin:all` sin recargar | MUST |
| RF-ADM-02 | Tabla de rendimiento por mesa: Mesa · Operador · Estado · Turno · Atendidos · Tiempo · Semáforo | Actualización en vivo | MUST |
| RF-ADM-03 | Gestión de lotes: crear, activar, pausar, extender, cerrar | Todas las acciones con confirmación y registro en `audit_log` | MUST |
| RF-ADM-04 | Configuración diaria: crear mesas y asignar operadores | Cambios reflejados inmediatamente en grilla de login | MUST |
| RF-ADM-05 | Pausar o activar cualquier mesa desde admin | Propagado a todos los clientes vía WS | MUST |
| RF-ADM-06 | CRUD de usuarios con asignación de roles | Crear, editar, activar/desactivar operadores y supervisores | MUST |
| RF-ADM-07 | Configurar tiempo máximo de atención y umbral de alerta de lote | Parámetros en tabla `configuracion`; aplicados en caliente | SHOULD |
| RF-ADM-08 | Exportar reporte CSV del día | Columnas: turno, mesa, operador, duración, hora inicio/fin | SHOULD |
| RF-ADM-09 | Ver log de auditoría por fecha con paginación | `GET /admin/auditoria?fecha=YYYY-MM-DD` | SHOULD |

---

## RF-GEN — Módulo Kiosko Web (Activable, `kiosko_web`)

> **Estado actual:** Desactivado por defecto (`kiosko_web_activo = false`).
> **Casos de uso cuando se active:**
> - Empleado en puerta con tablet asigna número al estudiante
> - Estudiante escanea QR y genera su propio turno desde su celular
> Ambos casos usan el mismo flujo; `origen = 'kiosko_web'` en ambos.

| Código | Descripción | Criterio de Aceptación | Prioridad |
|---|---|---|---|
| RF-GEN-01 | URL/QR pública sin login para generar turno | `GET /kiosko` accesible sin autenticación | SHOULD |
| RF-GEN-02 | `POST /turnos/generar` crea turno en estado `esperando` | Devuelve número asignado + token único | SHOULD |
| RF-GEN-03 | Estudiante puede consultar posición en cola via token | `GET /turnos/mi-turno/:token` devuelve posición y estimado | SHOULD |
| RF-GEN-04 | Al ser llamado, el turno `kiosko_web` pasa a `en_atencion` | Mismo flujo del operador; la transacción es atómica | SHOULD |
| RF-GEN-05 | Activable/desactivable desde admin sin reiniciar | Toggle en `configuracion.kiosko_web_activo` | SHOULD |

---

# PARTE II — REQUERIMIENTOS NO FUNCIONALES

---

## RNF-REN — Rendimiento

| Código | Requerimiento | Métrica / Criterio | Prioridad |
|---|---|---|---|
| RNF-REN-01 | Latencia de llamado de turno (transacción DB) | < 20ms en el percentil 95 bajo carga normal | MUST |
| RNF-REN-02 | Latencia de broadcast WebSocket post-llamado | < 10ms desde commit de DB hasta recepción en cliente TV/mesa | MUST |
| RNF-REN-03 | Tiempo de carga inicial de `panel_mesa.html` | < 500ms en red local (LAN) | MUST |
| RNF-REN-04 | Tiempo de reconexión WebSocket con snapshot de estado | < 1 segundo desde reconexión hasta estado actualizado en pantalla | MUST |
| RNF-REN-05 | Capacidad de mesas simultáneas | Hasta 20 mesas operando concurrentemente sin degradación | MUST |
| RNF-REN-06 | Capacidad de clientes WebSocket simultáneos | Hasta 50 conexiones (mesas + TVs + admins) sin aumento de latencia | MUST |
| RNF-REN-07 | Pico de concurrencia en llamados | 10 llamados simultáneos procesados correctamente sin duplicados ni pérdidas | MUST |
| RNF-REN-08 | Throughput diario | Hasta 2,000 turnos/día sin degradación acumulativa | SHOULD |
| RNF-REN-09 | Consumo de CPU en reposo | < 5% CPU con 20 mesas conectadas pero sin actividad | SHOULD |

---

## RNF-SEG — Seguridad

| Código | Requerimiento | Métrica / Criterio | Prioridad |
|---|---|---|---|
| RNF-SEG-01 | Toda comunicación cifrada en producción | HTTPS/WSS obligatorio; HTTP redirige a HTTPS (301) | MUST |
| RNF-SEG-02 | Autorización de rol validada en backend, nunca solo en frontend | Sin token válido → 401; rol incorrecto → 403 | MUST |
| RNF-SEG-03 | Passwords con bcrypt (cost ≥ 12) | Sin hashes débiles ni texto plano en BD | MUST |
| RNF-SEG-04 | Tokens JWT revocados en blacklist Redis | Logout efectivo inmediatamente | MUST |
| RNF-SEG-05 | Cookies de refresh: `HttpOnly; Secure; SameSite=Strict` | No accesibles por JS; protegidos contra XSS y CSRF | MUST |
| RNF-SEG-06 | Todas las queries con parámetros preparados | Cero concatenaciones de strings en queries SQL | MUST |
| RNF-SEG-07 | Rate limiting por operador en acciones críticas | Máx 5 llamados de turno/segundo por `operador_id`; exceso → 429 | MUST |
| RNF-SEG-08 | Registro de intentos de acceso fallidos | > 5 intentos en 5 min desde misma IP → bloqueo 15 min | SHOULD |
| RNF-SEG-09 | Headers HTTP de seguridad presentes | `X-Content-Type-Options`, `X-Frame-Options`, `CSP` en todas las respuestas | SHOULD |

---

## RNF-DIS — Disponibilidad y Resiliencia

| Código | Requerimiento | Métrica / Criterio | Prioridad |
|---|---|---|---|
| RNF-DIS-01 | Reconexión automática tras micro-cortes | Cliente WS reintenta con backoff exponencial; feedback visual permanente | MUST |
| RNF-DIS-02 | Estado del sistema sobrevive reinicios del servidor | Estado de mesas y lote activo en Redis con TTL; no se pierde al reiniciar Node.js | MUST |
| RNF-DIS-03 | Pantalla TV nunca en blanco ante desconexión | Último estado conocido visible + banner "Reconectando…" | MUST |
| RNF-DIS-04 | Fallo de Redis no detiene los llamados | Sistema degrada a PG directo si Redis no responde | SHOULD |
| RNF-DIS-05 | Backups automáticos diarios de PG | `pg_dump` vía cron; retenido mínimo 7 días | SHOULD |
| RNF-DIS-06 | Sistema funciona en LAN sin acceso a Internet | Todas las dependencias de frontend servidas localmente o en bundle | MUST |

---

## RNF-ESC — Escalabilidad

| Código | Requerimiento | Métrica / Criterio | Prioridad |
|---|---|---|---|
| RNF-ESC-01 | Número de mesas configurable desde admin sin cambios de código | Agregar/eliminar mesas desde interfaz; reflejo inmediato en grilla de login | MUST |
| RNF-ESC-02 | pgBouncer gestiona pool de conexiones a PostgreSQL | Máx 10 conexiones reales a PG independientemente de la carga | MUST |
| RNF-ESC-03 | Arquitectura permite escalar horizontalmente | Redis Pub/Sub como bus compartido entre múltiples instancias Node.js | COULD |
| ~~RNF-ESC-04~~ | ~~sede_id para multi-sede~~ | **ELIMINADO en v2.1** — Sistema mono-sede | — |

---

## RNF-USA — Usabilidad

| Código | Requerimiento | Métrica / Criterio | Prioridad |
|---|---|---|---|
| RNF-USA-01 | Operador llama, atiende y finaliza en **1 acción** | **1 clic** "Llamar Siguiente" → atiende → siguiente clic llama al próximo y cierra el anterior | MUST |
| RNF-USA-02 | Números de turno legibles desde 1 metro | ≥ 96px en escritorio 1080p (JetBrains Mono) | MUST |
| RNF-USA-03 | Panel TV legible a 5 metros en TV de 40" | Turno ≥ 200px; nombre de mesa ≥ 72px | MUST |
| RNF-USA-04 | Sin emojis como elementos funcionales de UI | Iconografía profesional SVG/Lucide para acciones | MUST |
| RNF-USA-05 | Operable sin mouse (accesibilidad teclado) | Todos los botones con `tabindex`, responden a `Enter`/`Space` | SHOULD |
| RNF-USA-06 | Panel operador funciona en resoluciones desde 1024×768 | Layout responsivo; ningún botón fuera de vista | SHOULD |
| RNF-USA-07 | Kiosko web: 1 toque para obtener turno | Máx 1 clic desde `/kiosko` hasta recibir número | SHOULD |

---

## RNF-MAN — Mantenibilidad

| Código | Requerimiento | Métrica / Criterio | Prioridad |
|---|---|---|---|
| RNF-MAN-01 | Migraciones BD versionadas y automáticas | `/migrations/001_initial.sql`, `002_...`; aplicadas al iniciar la app | MUST |
| RNF-MAN-02 | Variables de entorno en `.env` | Cero credenciales hardcodeadas en el código fuente | MUST |
| RNF-MAN-03 | README.md con instrucciones de instalación | `docker compose up` levanta todo en < 5 minutos | MUST |
| RNF-MAN-04 | Logs JSON estructurados con Pino | Campos: `level`, `time`, `msg`, `operador_id`, `mesa_id`, `turno_id`, `lote_id` | SHOULD |
| RNF-MAN-05 | Errores no controlados capturados sin caer el servidor | `process.on('uncaughtException')` + `onError` de Fastify | MUST |
| RNF-MAN-06 | Backend organizado en módulos por dominio | `/modules/auth`, `/modules/turnos`, `/modules/lotes`, `/modules/ws`, `/modules/admin` | SHOULD |

---

## RNF-POR — Portabilidad

| Código | Requerimiento | Métrica / Criterio | Prioridad |
|---|---|---|---|
| RNF-POR-01 | Stack completo levanta con un comando | `docker compose up` sin configuración manual adicional | MUST |
| RNF-POR-02 | Frontend funciona en navegadores modernos | Chrome 90+, Firefox 90+, Edge 90+ — sin plugins | MUST |
| RNF-POR-03 | Opera en Windows Server, Ubuntu y Debian | Docker abstrae el SO | MUST |
| RNF-POR-04 | Fuentes servidas localmente con fallback | Si Google Fonts no responde → `font-family` de sistema equivalente | SHOULD |

---

## RNF-AUD — Auditoría y Trazabilidad

| Código | Requerimiento | Métrica / Criterio | Prioridad |
|---|---|---|---|
| RNF-AUD-01 | Cada llamado, finalización y cancelación registrada en `audit_log` | Trigger de PG ejecuta INSERT automáticamente; no puede omitirse | MUST |
| RNF-AUD-02 | Registros de auditoría inmutables | `REVOKE UPDATE, DELETE ON audit_log` para usuario de la app | MUST |
| RNF-AUD-03 | Auditoría incluye: quién, qué, cuándo, mesa, turno, lote | Campos: `operador_id`, `accion`, `timestamp`, `mesa_id`, `turno_id`, `lote_id`, `metadata_json` | MUST |
| RNF-AUD-04 | Admin consulta historial de auditoría por fecha | `GET /admin/auditoria?fecha=YYYY-MM-DD` con paginación | SHOULD |
| RNF-AUD-05 | Acciones de gestión de lotes logueadas | Crear, activar, pausar, extender, cerrar lote → `audit_log` con `tipo=ADMIN_ACTION` | MUST |
| RNF-AUD-06 | Acciones admin críticas logueadas | Reset de operadores, creación de usuarios → `audit_log` | MUST |

---

## Resumen de conteos

| Categoría | MUST | SHOULD | COULD | Total |
|---|---|---|---|---|
| RF-AUTH | 8 | 0 | 0 | 8 |
| RF-LOTE | 8 | 1 | 0 | 9 |
| RF-TURN | 8 | 1 | 0 | 9 |
| RF-WS | 7 | 0 | 0 | 7 |
| RF-MESA | 8 | 1 | 0 | 9 |
| RF-TV | 4 | 1 | 0 | 5 |
| RF-ADM | 6 | 3 | 0 | 9 |
| RF-GEN | 0 | 5 | 0 | 5 |
| **Total RF** | **49** | **12** | **0** | **61** |
| RNF-REN | 7 | 2 | 0 | 9 |
| RNF-SEG | 7 | 2 | 0 | 9 |
| RNF-DIS | 4 | 2 | 0 | 6 |
| RNF-ESC | 2 | 0 | 1 | 3 |
| RNF-USA | 4 | 3 | 0 | 7 |
| RNF-MAN | 4 | 2 | 0 | 6 |
| RNF-POR | 3 | 1 | 0 | 4 |
| RNF-AUD | 5 | 1 | 0 | 6 |
| **Total RNF** | **36** | **13** | **1** | **50** |
| **GRAN TOTAL** | **85** | **25** | **1** | **111** |

---

## Decisiones de diseño confirmadas (v2.1)

| Decisión | Resolución |
|---|---|
| Multi-sede | ❌ Eliminado — sistema mono-sede |
| Estado `llamado` en turnos | ❌ Eliminado — flujo de 1 clic directo a `en_atencion` |
| Kiosko físico | ❌ Eliminado — cubierto por `kiosko_web` |
| Nombre del lote | Auto-generado: Lote 1, Lote 2… |
| Secuencia diaria (pg_cron reset) | ❌ Reemplazada por `lotes_voucher.ultimo_numero_llamado` |
| Origen de turnos | Solo 2: `voucher_fisico` \| `kiosko_web` |
| Flujo del operador | 1 clic = finaliza anterior + llama siguiente |
| Generación de vouchers | Externa al sistema; admin registra cuántos existen |
| Pase del X al Y (auditorio) | Verbal, no gestionado por el sistema |

## Decisiones pendientes

| Decisión | Estado |
|---|---|
| ¿Se activa `kiosko_web`? ¿Empleado, estudiante o ambos? | Pendiente |
| Ambiente de producción: VPS / servidor local / nube | Pendiente |
| ¿Impresión de tickets en kiosko físico? | Pendiente (COULD) |