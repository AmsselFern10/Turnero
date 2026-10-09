
# 📋 Informe Técnico — Turnero de Matrículas 2026
> **Versión:** 2.1 | **Fecha:** Octubre 2026 | **Estado:** Schema definido / Pre-implementación

---

## 1. Descripción General del Proyecto

El **Turnero de Matrículas 2026** es un sistema digital de gestión de turnos en tiempo real para procesos masivos de atención estudiantil (matrículas, pagos, inscripciones, validación de documentos).

| Actor | Rol |
|---|---|
| **Empleado portón** | Entrega vouchers físicos numerados por orden de llegada |
| **Empleado auditorio** | Anuncia verbalmente qué grupo puede pasar a ventanillas |
| **Operador de mesa** | Llama, atiende y finaliza turnos desde su panel |
| **Supervisor / Admin** | Crea mesas, asigna operadores, gestiona lotes de vouchers, monitorea KPIs |

---

## 2. Flujo Completo del Sistema (v2.1)

### Fase 0 — Configuración diaria (Admin, antes de abrir)
1. Admin entra al panel → crea/activa el **lote de vouchers** del día (ej: Lote 2, vouchers 301–700)
2. Admin crea las mesas que operarán hoy (pueden ser más o menos que ayer)
3. Admin asigna un operador a cada mesa
4. Sistema queda listo — mesas pasan a estado `activa`

### Fase 1 — Distribución en el portón (Físico, fuera del sistema)
- Empleado en portón entrega **vouchers físicos de papel** numerados en orden de llegada
- Los vouchers son impresos externamente (el sistema solo necesita saber cuántos existen)
- Cada persona guarda su número de papel

### Fase 2 — Llamado en auditorio (Verbal, fuera del sistema)
- Persona en la puerta del auditorio dice: *"Del número X al Y, pasen a ventanillas"*
- Esta acción **no se registra en el sistema** — es coordinación verbal
- La TV del auditorio muestra la pantalla pública (`tv.html`) para referencia visual

### Fase 3 — Atención en ventanillas (Core del sistema)

```
Operador presiona "LLAMAR SIGUIENTE"
        │
        ▼ (1 transacción atómica en PostgreSQL)
        │
        ├── Si hay turno en_atencion en esta mesa:
        │       → UPDATE turnos SET estado='atendido'
        │         (duracion_atencion_seg calculada automáticamente por trigger)
        │
        ├── Obtiene siguiente número del lote:
        │       → SELECT FROM lotes_voucher FOR UPDATE
        │         ultimo_numero_llamado + 1
        │       → UPDATE lotes_voucher SET ultimo_numero_llamado = nuevo
        │
        ├── Crea el turno:
        │       → INSERT INTO turnos (numero, estado='en_atencion', llamado_en=NOW())
        │
        └── Si nuevo == numero_hasta:
                → Alerta WS al admin: "Lote agotado"

        Broadcast WebSocket:
        ├── tv:global   → TV anuncia "Turno 47 → Mesa 3"
        ├── mesa:<id>   → Panel del operador actualiza
        └── admin:all   → KPIs en tiempo real
```

### Fase 4 — Gestión de vouchers (Admin, en caliente)

| Situación | Acción del admin |
|---|---|
| Se acabaron los 500 vouchers | Extiende `numero_hasta` a 700 sin reiniciar |
| Proceso continúa mañana | Pausa el lote → al día siguiente lo reactiva (continúa del 301) |
| Se imprimen vouchers desde 1 nuevamente | Cierra lote actual → crea Lote N+1 con `numero_desde=1` |
| Llegan a los últimos 20 vouchers | Sistema notifica al admin automáticamente |

---

## 3. Stack Tecnológico

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLIENTES (Browser)                           │
│  login.html · panel_mesa.html · tv.html · admin.html · kiosko  │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP REST + WebSocket (WSS)
┌──────────────────────▼──────────────────────────────────────────┐
│                  CAPA DE APLICACIÓN                             │
│           Node.js 20 LTS  +  Fastify 4.x                       │
│      @fastify/websocket · @fastify/jwt · @fastify/cors          │
└──────────┬─────────────────────────────┬────────────────────────┘
           │                             │
┌──────────▼──────────┐     ┌────────────▼────────────────────────┐
│   CAPA DE CACHÉ      │     │         CAPA DE DATOS               │
│   Redis 7 (in-mem)  │     │   PostgreSQL 15+ (persistente)       │
│   Pub/Sub · TTL     │     │   pgBouncer (connection pool)        │
└─────────────────────┘     └─────────────────────────────────────┘
           │
┌──────────▼──────────┐
│   INFRAESTRUCTURA   │
│   Docker Compose    │
│  (db · redis · app) │
└─────────────────────┘
```

### Stack por capa

| Capa | Tecnología | Justificación |
|---|---|---|
| **Backend** | Node.js 20 LTS + Fastify 4.x | ~70,000 req/s, overhead mínimo |
| **Tiempo real** | `@fastify/websocket` | Canales segmentados, push-only, < 10ms |
| **Base de datos** | PostgreSQL 15+ | ACID, `FOR UPDATE SKIP LOCKED`, triggers |
| **Pool conexiones** | pgBouncer | Máx 10 conexiones reales a PG |
| **Caché / Pub-Sub** | Redis 7 | Estado en RAM < 1ms, difusión entre instancias |
| **Frontend** | HTML5 + Tailwind CSS 3 + Alpine.js v3 | Sin build step, < 40KB total |
| **Infra** | Docker Compose | Un solo `docker compose up` levanta todo |

---

## 4. Schema de Base de Datos (v2.1)

### Tablas

| Tabla | Propósito |
|---|---|
| `usuarios` | Operadores, supervisores, admins |
| `mesas` | Ventanillas con operador asignado |
| `lotes_voucher` | Contador central de vouchers físicos (multi-día) |
| `turnos` | Registro de cada voucher llamado a mesa |
| `audit_log` | Trazabilidad inmutable (solo INSERT) |
| `configuracion` | Parámetros del sistema editables en caliente |

### Estados de un turno

```
KIOSKO WEB:     esperando ──► en_atencion ──► atendido
                                          └──► cancelado

VOUCHER FÍSICO: (sin registro) ──► en_atencion ──► atendido
                                               └──► cancelado
```

### Orígenes de turno

| Origen | Descripción |
|---|---|
| `voucher_fisico` | Portón entrega papel → operador llama (modo principal) |
| `kiosko_web` | URL/QR: empleado en puerta con tablet O estudiante desde celular |

### Lote de vouchers

```sql
lotes_voucher
├── numero_lote           -- Auto: Lote 1, Lote 2, Lote 3...
├── numero_desde          -- Primer voucher (usualmente 1)
├── numero_hasta          -- Último declarado (extensible en caliente)
├── ultimo_numero_llamado -- Progreso actual (avanza con FOR UPDATE atómico)
└── estado                -- preparado | activo | pausado | agotado | cerrado
```

---

## 5. Buenas Prácticas y Protocolos

### Concurrencia — Anti-duplicados

```sql
BEGIN;
  -- Bloqueo a nivel de FILA sobre el lote
  SELECT id, ultimo_numero_llamado, numero_hasta
  FROM lotes_voucher WHERE estado = 'activo'
  FOR UPDATE;
  -- Incremento atómico + INSERT turno + UPDATE lote
COMMIT;
```

**Garantía:** 10 mesas presionando "Llamar Siguiente" al mismo tiempo → 10 números distintos, en orden, sin duplicados.

### WebSocket — Canales

| Canal | Suscriptores | Eventos |
|---|---|---|
| `mesa:<id>` | Panel del operador | `turno_llamado`, `mesa_pausada` |
| `tv:global` | Pantallas públicas | `nuevo_llamado`, `historial` |
| `admin:all` | Panel admin | Todos + `kpi_update`, `lote_agotado` |

### Reconexión — Backoff exponencial con jitter

```javascript
delay = Math.min(base * 2^intentos + random(0, 1000), 30000)
// 1s → 2s → 4s → 8s → 16s (cap 30s)
```

### Seguridad

| Práctica | Detalle |
|---|---|
| Passwords | bcrypt cost 12 |
| Sesión | `sessionStorage` + JWT 2h + refresh cookie HttpOnly |
| Autorización | Middleware de rol en cada ruta Fastify (backend valida siempre) |
| Rate limiting | Redis counter: máx 5 llamados/seg por operador |
| SQL | Parámetros preparados — cero concatenación |
| Auditoría | `audit_log` inmutable — `REVOKE UPDATE, DELETE` para usuario de app |

---

## 6. Módulos del Sistema

### Módulo 0 — Infraestructura
- `docker-compose.yml` con PG + Redis + App
- Migraciones SQL versionadas (`/migrations/`)
- Variables de entorno en `.env` (nunca en repo)
- Script de seed con datos de prueba

### Módulo 1 — Autenticación (`/auth`)
- `POST /auth/login` → JWT + refresh cookie HttpOnly
- `POST /auth/logout` → blacklist token en Redis
- `POST /auth/refresh` → nuevo JWT sin re-login
- Selección de mesa desde grilla dinámica post-login

### Módulo 2 — Gestión de Lotes y Turnos (`/turnos`, `/lotes`)
- `POST /turnos/llamar` → transacción atómica (finaliza anterior + llama siguiente)
- `POST /turnos/:id/cancelar` → marca como cancelado
- `GET /turnos/estado` → snapshot para reconexión WS
- `POST /lotes` → crear nuevo lote
- `PATCH /lotes/:id/activar` → activar lote
- `PATCH /lotes/:id/extender` → cambiar `numero_hasta` en caliente
- `PATCH /lotes/:id/pausar` / `cerrar`

### Módulo 3 — WebSocket Hub (`/ws`)
- Autenticación JWT en handshake
- Suscripción automática por rol
- Heartbeat 30s
- Snapshot de estado al reconectar

### Módulo 4 — Panel Operador (`panel_mesa.html`)
- Turno actual en gran formato (JetBrains Mono)
- Botón único: **LLAMAR SIGUIENTE**
- Botón secundario: **No se presentó** (cancelar)
- Cronómetro en vivo + contador de atendidos del día
- Indicador de estado WS + próximo en espera

### Módulo 5 — Pantalla TV (`tv.html`)
- Último llamado en tipografía gigante
- Historial 4 turnos recientes
- Reloj sincronizado
- Banner de reconexión animado (nunca pantalla en blanco)

### Módulo 6 — Panel Admin (`admin.html`)
- KPIs en tiempo real (atendidos, espera promedio, mesas activas, vouchers restantes)
- Gestión de lotes: crear, activar, pausar, extender, cerrar
- Configuración diaria de mesas y operadores
- Tabla de rendimiento por mesa con semáforo
- Gestión de usuarios (CRUD)
- Exportar reporte CSV del día

### Módulo 7 — Kiosko Web (`/kiosko`) — Activable
- URL/QR pública accesible desde celular (empleado en puerta o estudiante)
- `POST /turnos/generar` → crea turno en estado `esperando`
- `GET /turnos/mi-turno/:token` → consulta posición en cola
- Activable/desactivable desde `configuracion.kiosko_web_activo`

---

## 7. Prioridades de Rendimiento

| Operación | Objetivo |
|---|---|
| Llamar siguiente (DB + WS) | < 20ms |
| Broadcast a TV/mesas | < 10ms |
| Carga inicial panel_mesa | < 500ms |
| Reconexión WS + snapshot | < 1 segundo |

- **Mesas simultáneas:** hasta 20
- **Clientes WS:** hasta 50
- **Turnos/día:** hasta 2,000

---

## 8. Decisiones Pendientes

| Decisión | Estado |
|---|---|
| ¿Se activa kiosko_web? ¿Empleado en puerta o estudiante? | Pendiente |
| ¿Ambiente de producción? VPS / servidor local / nube | Pendiente |
| ¿Impresión de tickets en kiosko? | Pendiente |
