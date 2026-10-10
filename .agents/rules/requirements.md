---
trigger: always_on
---

# Requerimientos del Sistema — Turnero de Matrículas 2026 (v2.1)
> **MoSCoW:** [M] MUST (obligatorio) · [S] SHOULD (recomendado) · [C] COULD (deseable)  
> **Arquitectura:** Mono-sede · 1 Clic atómico · PostgreSQL + Redis + Fastify + WS

---

## PARTE I — REQUERIMIENTOS FUNCIONALES (RF)

### RF-AUTH — Autenticación y Sesión
- **[M] RF-AUTH-01 / 02:** Login usuario/password con JWT (2h) y refresh cookie HttpOnly. Roles: `operador`, `supervisor`, `admin` con validación estricta en backend.
- **[M] RF-AUTH-03:** Selección de mesa dinámica vía `GET /mesas` post-login; mesas ocupadas deshabilitadas.
- **[M] RF-AUTH-04 / 05:** Cierre de sesión seguro con blacklist en Redis. Sesión en `sessionStorage` (limpieza automática al cerrar pestaña en PCs compartidas).
- **[M] RF-AUTH-06:** Refresh token transparente sin forzar re-login al operador.
- **[M] RF-AUTH-07 / 08:** Un operador no puede asignarse a dos mesas simultáneas. Passwords con hash bcrypt (cost ≥ 12).

### RF-LOTE — Gestión de Lotes de Vouchers
- **[M] RF-LOTE-01 / 02:** Creación de lote correlativo ("Lote N") indicando `numero_hasta`. Solo 1 lote activo simultáneo (garantizado por índice único parcial en PostgreSQL).
- **[M] RF-LOTE-03 / 04 / 05:** Activación y pausa (fin de jornada) conservando `ultimo_numero_llamado`. Soporte multi-día continuando correlativo al reactivar.
- **[M] RF-LOTE-06:** Extensión en caliente de `numero_hasta` (ej: 500 → 700) sin reiniciar el sistema ni interrumpir la atención.
- **[M] RF-LOTE-07:** Alerta WS automática a `admin:all` cuando resten ≤ N vouchers (`alerta_vouchers_restantes`).
- **[M] RF-LOTE-08:** Cierre definitivo auditado en `audit_log`; nuevo lote correlativo reinicia secuencia desde 1.
- **[S] RF-LOTE-09:** Visualización del progreso del lote y vouchers restantes en tiempo real.

### RF-TURN — Gestión de Turnos (Core)
- **[M] RF-TURN-01 / 02 / 03:** "Llamar Siguiente" en 1 transacción atómica con `SELECT ... FOR UPDATE` sobre el lote: finaliza el turno anterior (`atendido`), reserva el siguiente número, crea turno (`en_atencion`) y emite broadcast WS. Cero números duplicados ante concurrencia de múltiples mesas.
- **[M] RF-TURN-04 / 05:** Flujo estándar de 1 clic por atención (cierre automático del anterior). Botón secundario "No se presentó" marca `cancelado` y audita.
- **[M] RF-TURN-06 / 07:** `duracion_atencion_seg` calculada automáticamente por trigger PostgreSQL (`finalizado_en - llamado_en`). Pausar una mesa no bloquea el lote ni afecta a otras ventanillas.
- **[M] RF-TURN-08:** Al agotarse el lote, el endpoint responde 409 y WS notifica `lote_agotado` a `admin:all`.
- **[S] RF-TURN-09:** Panel del operador anticipa el próximo número en espera (`ultimo_numero_llamado + 1`).

### RF-WS — WebSocket y Tiempo Real
- **[M] RF-WS-01 / 02:** Notificaciones 100% push WS; cero polling HTTP. Canales segmentados: `mesa:<id>`, `tv:global`, `admin:all`.
- **[M] RF-WS-03 / 04:** Handshake WS autenticado con JWT. Reconexión con backoff exponencial + jitter (`delay = min(base * 2^n + random, 30s)`).
- **[M] RF-WS-05 / 06 / 07:** Snapshot de estado completo al reconectar. Heartbeat cada 30s (limpieza de conexiones inactivas a los 60s). Protocolo de mensaje estándar: `{ tipo, payload, timestamp }`.

### RF-MESA — Panel del Operador (`panel_mesa.html`)
- **[M] RF-MESA-01 / 02:** Turno actual en JetBrains Mono gigante (≥ 96px, ej. 148px). Encabezado permanente "Mesa N — Operador".
- **[M] RF-MESA-03 / 04 / 05:** Cronómetro vivo desde `llamado_en`. Contador de turnos atendidos del día. Indicador visual de estado WS (verde/amarillo/rojo).
- **[M] RF-MESA-06 / 07 / 08:** Pantalla de cortesía al pausar mesa. Botón dominante: "LLAMAR SIGUIENTE". Botón secundario: "No se presentó" (solo visible con turno activo).
- **[S] RF-MESA-09:** Tarjeta lateral de próximo número anticipado en cola.

### RF-TV — Pantalla Pública TV (`tv.html`)
- **[M] RF-TV-01 / 02:** Turno gigante ≥ 200px + Mesa ≥ 72px (legible a 5m en TV 40"). Historial de los 4 turnos más recientes.
- **[M] RF-TV-03 / 04 / 05:** Reloj digital sincronizado al segundo. Operación 100% pasiva vía WS. Banner animado "Reconectando..." ante caída WS sin borrar la pantalla (nunca pantalla en blanco).
- **[S] RF-TV-06:** Destello visual de alerta al anunciar nuevo llamado.

### RF-ADM — Panel de Administración (`admin.html`)
- **[M] RF-ADM-01 / 02:** Dashboard de KPIs en vivo (atendidos, tiempo promedio, mesas activas, vouchers restantes) y tabla de rendimiento por mesa con semáforo.
- **[M] RF-ADM-03 / 04 / 05:** Gestión integral de lotes (crear/activar/pausar/extender/cerrar), mesas y operadores. Pausar o reactivar mesas en caliente.
- **[M] RF-ADM-06:** CRUD de usuarios con asignación de roles (`operador`, `supervisor`, `admin`).
- **[S] RF-ADM-07 / 08 / 09:** Configuración dinámica de umbrales en BD. Exportación de reporte diario a CSV. Consulta paginada del `audit_log`.

### RF-GEN — Kiosko Web (Activable)
- **[S] RF-GEN-01..05:** URL pública sin login (`/kiosko`) para tablet de acceso o móvil del estudiante. Crea turno en `esperando` y retorna token. Consulta de cola en `GET /turnos/mi-turno/:token`. Activación controlada desde `configuracion.kiosko_web_activo`.

---

## PARTE II — REQUERIMIENTOS NO FUNCIONALES (RNF)

### RNF-REN — Rendimiento
- **[M] RNF-REN-01..04:** Latencia de llamado en DB < 20ms (p95). Broadcast WS < 10ms. Carga de UI < 500ms en LAN. Reconexión con snapshot < 1s.
- **[M] RNF-REN-05..07:** Capacidad hasta 20 mesas y 50 clientes WS simultáneos. 10 llamados concurrentes sin colisión ni pérdida.
- **[S] RNF-REN-08 / 09:** Throughput de hasta 2,000 turnos/día. Uso de CPU en reposo < 5%.

### RNF-SEG — Seguridad
- **[M] RNF-SEG-01..07:** HTTPS/WSS obligatorio en producción. Validación de permisos siempre en backend. Bcrypt cost ≥ 12. Blacklist JWT en Redis. Cookies de refresh `HttpOnly; Secure; SameSite=Strict`. Queries con parámetros preparados (cero inyección SQL). Rate limiting de 5 llamados/seg por operador.
- **[S] RNF-SEG-08 / 09:** Bloqueo temporal por reintentos fallidos (> 5 en 5 min). Cabeceras de seguridad HTTP (`CSP`, `X-Content-Type-Options`, `X-Frame-Options`).

### RNF-DIS — Disponibilidad y Resiliencia
- **[M] RNF-DIS-01 / 02 / 03 / 06:** Reconexión automática con backoff y jitter. Estado de mesas y lote en Redis con TTL ante reinicios de Node.js. Pantalla TV nunca en blanco ante micro-cortes. Operación autónoma en red local (LAN) sin requerir Internet.
- **[S] RNF-DIS-04 / 05:** Degeneración a PostgreSQL si Redis no responde. Copias de respaldo diarias (`pg_dump`).

### RNF-ESC / USA / MAN / POR / AUD
- **[M] Escalabilidad:** Configuración dinámica de mesas desde UI. Pool pgBouncer con máx 10 conexiones persistentes a PG. Sistema mono-sede.
- **[M] Usabilidad:** 1 clic por atención (RNF-USA-01). Tipografía JetBrains Mono legible a 1m (operador) y 5m (TV). Prohibición total de emojis en interfaces operativas (RNF-USA-04). Vistas operativas sin scroll (`h-screen overflow-hidden`).
- **[M] Mantenibilidad y Portabilidad:** Migraciones SQL versionadas (`/migrations/`). Variables en `.env`. Levantamiento con un solo comando `docker compose up`. Frontend estático sin build step.
- **[M] Auditoría:** Triggers inmutables en `audit_log` (`REVOKE UPDATE, DELETE`). Registro de operador, mesa, turno, acción y cambios de lote.