---
trigger: always_on
---


# Especificación de Módulos — Turnero de Matrículas 2026 (v2.1)

---

## Módulo 0 — Infraestructura Base

- `docker-compose.yml`: servicios `turnero-db` (PG15), `turnero-redis` (Redis7), `turnero-app` (Node20)
- Migraciones SQL versionadas en `/migrations/001_initial.sql`
- `.env.development` y `.env.production` — credenciales nunca en el repo
- `/scripts/seed.js` — genera hashes bcrypt reales y puebla la BD

---

## Módulo 1 — Autenticación y Sesión (`/auth`)

- `POST /auth/login` → JWT (2h) + refresh token en cookie `HttpOnly; Secure; SameSite=Strict`
- `POST /auth/logout` → token a blacklist en Redis
- `POST /auth/refresh` → nuevo JWT sin re-login
- Post-login: grilla dinámica de mesas (`GET /mesas`) — solo mesas activas/disponibles
- Middleware de rol en Fastify — backend siempre valida, nunca solo frontend
- Sesión en `sessionStorage` (se limpia al cerrar el tab — PCs compartidas)

---

## Módulo 2 — Gestión de Lotes de Vouchers (`/lotes`)

### Endpoints

| Método | Ruta | Acción |
|---|---|---|
| `POST` | `/lotes` | Crear nuevo lote (auto-nombrado: Lote N) |
| `GET` | `/lotes` | Listar lotes (con estado y progreso) |
| `GET` | `/lotes/activo` | Estado del lote activo actual |
| `PATCH` | `/lotes/:id/activar` | Activar lote (solo 1 activo a la vez) |
| `PATCH` | `/lotes/:id/pausar` | Pausar al fin del día |
| `PATCH` | `/lotes/:id/extender` | Cambiar `numero_hasta` en caliente |
| `PATCH` | `/lotes/:id/cerrar` | Cerrar lote definitivamente |

### Comportamientos clave

- **Extensión en caliente**: `numero_hasta` 500 → 700 sin reiniciar — vouchers 501-700 listos inmediatamente
- **Cierre y nuevo**: cerrar Lote 1 → crear Lote 2 con `numero_desde=1`
- **Multi-día**: lote pausado al fin del día → reactivado al día siguiente → continúa desde `ultimo_numero_llamado`
- **Alerta de agotamiento**: cuando `ultimo_numero_llamado >= numero_hasta - alerta_vouchers_restantes` → WS `admin:all` notifica
- **Un solo lote activo**: índice único parcial en BD lo garantiza

---

## Módulo 3 — Gestión de Turnos (`/turnos`)

### Endpoint principal

```
POST /turnos/llamar
```

**Transacción atómica (1 clic → todo ocurre):**
1. `UPDATE turnos SET estado='atendido'` donde `mesa_id=$1 AND estado='en_atencion'`
2. `SELECT FROM lotes_voucher WHERE estado='activo' FOR UPDATE`
3. `UPDATE lotes_voucher SET ultimo_numero_llamado = nuevo`
4. `INSERT INTO turnos (numero=nuevo, estado='en_atencion', llamado_en=NOW())`
5. Si `nuevo == numero_hasta` → broadcast `lote_agotado` a `admin:all`
6. Broadcast WS: `tv:global`, `mesa:<id>`, `admin:all`

**Garantía de concurrencia:** `FOR UPDATE` en el lote → 10 mesas simultáneas → 10 números distintos, sin duplicados.

### Otros endpoints

| Método | Ruta | Acción |
|---|---|---|
| `POST` | `/turnos/:id/cancelar` | Marcar como cancelado (no se presentó) |
| `GET` | `/turnos/estado` | Snapshot completo para reconexión WS |
| `GET` | `/turnos/historial` | Últimos N turnos del día |
| `POST` | `/turnos/generar` | Crear turno `esperando` (kiosko_web) |
| `GET` | `/turnos/mi-turno/:token` | Posición en cola (kiosko_web) |

---

## Módulo 4 — WebSocket Hub (`/ws`)

### Canales

| Canal | Suscriptores | Eventos recibidos |
|---|---|---|
| `mesa:<id>` | Panel operador | `turno_llamado`, `mesa_pausada`, `mesa_activada` |
| `tv:global` | Pantallas TV | `nuevo_llamado`, `historial_actualizado` |
| `admin:all` | Panel admin | Todos + `kpi_update`, `lote_agotado`, `lote_extendido` |

### Protocolo de mensajes

```json
{
  "tipo": "turno_llamado",
  "payload": {
    "turno": 47,
    "mesa": 3,
    "operador": "María González",
    "lote": 2,
    "vouchers_restantes": 153,
    "timestamp": "2026-10-08T09:15:33Z"
  }
}
```

### Reconexión — Backoff exponencial con jitter

```javascript
delay = Math.min(baseDelay * 2^intentos + Math.random() * 1000, 30000)
// 1s → ~2s → ~4s → ~8s → ~16s (cap 30s)
```

### Heartbeat

- Ping cada 30s desde el servidor
- Conexiones sin pong en 60s → cerradas y limpiadas

---

## Módulo 5 — Panel del Operador (`panel_mesa.html`)

### Elementos de UI

- **Encabezado**: "Mesa 3 — María González" (permanente)
- **Turno actual**: número en JetBrains Mono, tamaño gigante (≥ 96px)
- **Estado**: "En atención" / "Mesa pausada" / "Sin turno activo"
- **Cronómetro**: desde `llamado_en`, corre en vivo
- **Próximo**: tarjeta secundaria con el siguiente número del lote
- **Contador**: "Atendidos hoy: 23"
- **Indicador WS**: verde/amarillo/rojo

### Botones de acción

| Botón | Acción | Visibilidad |
|---|---|---|
| **LLAMAR SIGUIENTE** | `POST /turnos/llamar` | Siempre (principal) |
| **No se presentó** | `POST /turnos/:id/cancelar` | Solo con turno `en_atencion` |
| **Pausar Mesa** | `PATCH /mesas/:id/pausar` | Siempre |
| **Cambiar Mesa** | Limpia sesión de mesa, vuelve a selección | Siempre |

---

## Módulo 6 — Pantalla TV (`tv.html`)

- Último llamado: número ≥ 200px + mesa ≥ 72px (legible a 5m en TV 40")
- Historial: últimos 4 turnos con fade-in/out animado
- Reloj digital sincronizado
- Banner "Reconectando…" animado si WS cae (nunca pantalla en blanco)
- Sin interacción — display pasivo puro
- Funciona sin Internet (assets servidos localmente)

---

## Módulo 7 — Panel de Administración (`admin.html`)

### Pestaña: Dashboard (tiempo real)

- KPIs: Atendidos hoy / Tiempo promedio / Mesas activas / Vouchers restantes en lote
- Alerta visual cuando quedan N vouchers (configurable)
- Tabla por mesa: Mesa · Operador · Estado · Turno actual · Atendidos · Tiempo medio · Semáforo

### Pestaña: Gestión de Lotes

- Ver lote activo + progreso (barra visual)
- Crear nuevo lote (auto-nombrado Lote N, ingresar `numero_hasta`)
- Botones: Activar / Pausar / Extender (campo inline) / Cerrar / Nuevo desde 1
- Historial de lotes anteriores

### Pestaña: Configuración Diaria de Mesas

- Crear mesas (asignar número y nombre)
- Activar/desactivar mesas para el día
- Asignar operador a cada mesa desde dropdown
- Ver qué mesas tienen operador asignado

### Pestaña: Gestión de Usuarios

- CRUD completo: crear, editar rol, activar/desactivar
- Roles: `operador` / `supervisor` / `admin`

### Pestaña: Configuración del Sistema

- `tiempo_max_atencion_min` — semáforo de eficiencia
- `alerta_vouchers_restantes` — umbral de alerta de lote
- `kiosko_web_activo` — toggle on/off para activar módulo kiosko
- `modo_generacion_turnos` — modo activo

### Pestaña: Reportes

- Exportar CSV del día: turno, mesa, operador, duración, hora inicio/fin
- Ver log de auditoría por fecha con paginación

---

## Módulo 8 — Kiosko Web (`/kiosko`) — Activable

> Activado desde `configuracion.kiosko_web_activo = true`  
> Cubre dos casos de uso con el mismo flujo:  
> a) Empleado en puerta con tablet asigna el número al estudiante  
> b) Estudiante escanea QR y genera su propio turno desde su celular

- URL pública sin login: `/kiosko`
- Interfaz mínima: botón único "TOMAR MI TURNO"
- `POST /turnos/generar` → crea turno `esperando`, devuelve número + token
- Muestra: "Tu turno es el **#47**" + QR/link para consultar posición
- `GET /turnos/mi-turno/:token` → posición actual + estimado de espera
- Cuando el operador llama ese número: notificación en la página del estudiante (WS)

---

## Flujo Multi-día de Lotes

```
DÍA 1:
  Admin crea Lote 1 (1→500) → activa
  Operadores atienden del 1 al 300
  Fin de jornada → Admin pausa Lote 1 (ultimo=300)

DÍA 2:
  Admin reactiva Lote 1
  Operadores continúan del 301 al 500

  Al llegar al 500 → ALERTA al admin: "Lote agotado"
  Admin extiende a 700 (imprime vouchers 501-700)
  Operadores continúan del 501...

DÍA 3 (o cuando decidan reiniciar):
  Admin cierra Lote 1
  Admin crea Lote 2 (1→400) → activa
  Sistema imprime nuevos vouchers desde 1
```
