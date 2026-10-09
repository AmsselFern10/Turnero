# Turnero de Matrículas 2026

Sistema digital de gestión de turnos en tiempo real para procesos masivos de atención estudiantil.

**Stack:** Node.js 20 + Fastify 4 · PostgreSQL 15 · Redis 7 · pgBouncer · Docker Compose

---

## ⚡ Levantar en 5 minutos

### Prerequisitos
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado y corriendo

### 1. Clonar y configurar
```bash
git clone <repo-url>
cd Turnero

# Copiar template de variables de entorno
cp .env.example .env
```

### 2. Editar `.env`
Abrir `.env` y completar los valores marcados con `<CAMBIAR>`:
```
DB_PASSWORD=<CAMBIAR_PASSWORD_SEGURO>
REDIS_PASSWORD=<CAMBIAR_REDIS_PASSWORD>
JWT_SECRET=<CAMBIAR_64_CHARS>
REFRESH_SECRET=<CAMBIAR_64_CHARS>
```

> **Generar secrets seguros:**
> ```bash
> node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
> ```

### 3. Levantar el stack
```bash
docker compose up
```

Esperar a ver:
```
turnero-app  | ✅ PostgreSQL conectado (via pgBouncer)
turnero-app  | ✅ Redis conectado
turnero-app  | Server listening at http://0.0.0.0:3000
```

### 4. Cargar datos de prueba
```bash
# En otra terminal
docker compose exec app node scripts/seed.js
```

### 5. Acceder
| URL | Descripción |
|---|---|
| `http://localhost:3000` | Login principal |
| `http://localhost:3000/panel_mesa.html` | Panel del operador |
| `http://localhost:3000/tv.html` | Pantalla TV pública |
| `http://localhost:3000/admin.html` | Panel de administración |
| `http://localhost:3000/health` | Health check del servidor |

**Credenciales de prueba:**
```
admin       → Admin2026!
supervisor1 → Super2026!
op1-op5     → Operador2026!
porton      → Porton2026!
```

---

## 🏗️ Estructura del Proyecto

```
Turnero/
├── migrations/
│   └── 001_initial.sql        # Migración inicial (se aplica automáticamente)
├── schema.sql                  # Schema completo (fuente de verdad)
├── scripts/
│   └── seed.js                # Datos de prueba con hashes bcrypt reales
├── src/
│   ├── server.js              # Entry point
│   ├── app.js                 # Instancia Fastify + registro de plugins
│   ├── plugins/
│   │   ├── db.js              # Pool PostgreSQL
│   │   ├── redis.js           # Redis (caché + pub/sub)
│   │   └── auth.js            # JWT + autorización por rol
│   ├── modules/
│   │   ├── auth/              # Login, logout, refresh
│   │   ├── turnos/            # Llamar siguiente (FOR UPDATE), cancelar, kiosko
│   │   ├── lotes/             # Crear, activar, pausar, extender, cerrar lotes
│   │   ├── mesas/             # Gestión de ventanillas
│   │   ├── admin/             # KPIs, usuarios, auditoría, CSV, configuración
│   │   └── ws/
│   │       └── hub.js         # WebSocket Hub (canales, heartbeat, snapshot)
│   └── public/                # Frontend estático (HTML, CSS, JS)
├── docker-compose.yml
├── Dockerfile
├── .env.example               # Template de variables de entorno
└── package.json
```

---

## 🔄 Flujo del Sistema

### Configuración diaria (Admin)
1. Crear/activar lote de vouchers (ej: Lote 2, vouchers 301-700)
2. Asignar operadores a mesas
3. Las mesas quedan activas — operadores pueden iniciar sesión

### Llamado de turno (Operador) — 1 clic
```
LLAMAR SIGUIENTE →
  1. Finaliza turno anterior (atendido)
  2. FOR UPDATE en lote → obtiene siguiente número
  3. Crea turno en en_atencion
  4. Broadcast WS a TV + panel + admin
```

### Gestión multi-día del lote
```
Hoy llega al 300 → Admin pausa el lote
Mañana → Admin reactiva → continúa desde 301
Si se agota → Admin extiende (500→700) en caliente
```

---

## 🐳 Comandos Docker Compose

```bash
# Levantar todo
docker compose up -d

# Ver logs en tiempo real
docker compose logs -f app

# Detener (mantiene datos)
docker compose down

# Detener + borrar datos (reset completo)
docker compose down -v

# Ejecutar comando dentro del contenedor
docker compose exec app node scripts/seed.js

# Conectar a PostgreSQL directamente
docker compose exec db psql -U turnero_app -d turnero
```

---

## 🔌 API — Endpoints principales

### Autenticación
```
POST /auth/login                → { token, usuario }
POST /auth/logout               → Revoca JWT
POST /auth/refresh              → Nuevo JWT
GET  /auth/mesas                → Grilla de mesas para login
```

### Turnos (operador)
```
POST /turnos/llamar             → { mesa_id } → Llama siguiente
POST /turnos/:id/cancelar       → No se presentó
GET  /turnos/estado?mesa_id=X   → Snapshot para reconexión WS
GET  /turnos/historial          → Historial del día
POST /turnos/generar            → Kiosko web (si activo)
GET  /turnos/mi-turno/:token    → Consulta posición en cola
```

### Lotes (admin)
```
POST   /lotes                   → Crear lote (auto: "Lote N")
GET    /lotes/activo            → Estado del lote activo
PATCH  /lotes/:id/activar       → Activar lote
PATCH  /lotes/:id/pausar        → Pausar lote (fin del día)
PATCH  /lotes/:id/extender      → Cambiar numero_hasta en caliente
PATCH  /lotes/:id/cerrar        → Cerrar lote
```

### Mesas (admin)
```
GET    /mesas                   → Listar con métricas en tiempo real
POST   /mesas                   → Crear ventanilla
PATCH  /mesas/:id/asignar       → Asignar operador
PATCH  /mesas/:id/estado        → Pausar/activar
```

### Admin
```
GET    /admin/kpis              → KPIs tiempo real
GET    /admin/usuarios          → Listar usuarios
POST   /admin/usuarios          → Crear usuario
PATCH  /admin/usuarios/:id      → Editar usuario
GET    /admin/auditoria?fecha=  → Log de auditoría paginado
GET    /admin/reporte/csv?fecha= → Exportar CSV
PATCH  /admin/configuracion/:clave → Parámetro en caliente
```

### WebSocket
```
WS /ws?token=<JWT>&canal=<canal>&mesa_id=<id>

Canales:
  mesa:<id>   → Panel del operador
  tv:global   → Pantalla TV
  admin:all   → Panel admin
```

---

## 🔒 Seguridad

- **Passwords:** bcrypt cost 12 mínimo
- **JWT:** expiración 2h + refresh cookie HttpOnly/Secure/SameSite=Strict
- **Blacklist:** logout revoca el token inmediatamente (Redis)
- **Rate limiting:** máx 5 llamados/seg por operador
- **SQL:** solo parámetros preparados — cero concatenación
- **Auditoría:** audit_log inmutable (REVOKE UPDATE, DELETE)
- **Headers:** Helmet con CSP, X-Frame-Options, X-Content-Type-Options

---

## 📊 Requisitos de Rendimiento

| Métrica | Objetivo |
|---|---|
| Latencia llamado de turno (P95) | < 20ms |
| Broadcast WS post-llamado | < 10ms |
| Mesas simultáneas | hasta 20 |
| Clientes WS | hasta 50 |
| Throughput diario | hasta 2,000 turnos |

---

## 🛠️ Desarrollo local (sin Docker)

```bash
npm install

# Requiere PostgreSQL y Redis locales con .env configurado
npm run dev   # nodemon con hot-reload
```
