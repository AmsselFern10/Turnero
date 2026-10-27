# Arquitectura Técnica — Turnero de Matrículas 2026 (v2.1)

> **Documento de Referencia Técnica, Operativa y de Seguridad**  
> Describe la arquitectura interna del sistema, el catálogo de tecnologías, la organización de módulos en frontend y backend, los modelos de concurrencia y los mecanismos que garantizan consistencia transaccional absoluta y cero caídas durante jornadas masivas de atención.

---

## Tabla de Contenidos

1. [Principios de Diseño y Filosofía Arquitectónica](#1-principios-de-diseño-y-filosofía-arquitectónica)
2. [Arquitectura General en 4 Capas](#2-arquitectura-general-en-4-capas)
3. [Catálogo Tecnológico y Decisiones de Diseño](#3-catálogo-tecnológico-y-decisiones-de-diseño)
4. [Estructura del Proyecto y Organización de Código](#4-estructura-del-proyecto-y-organización-de-código)
5. [Especificación Detallada de Módulos (Backend y Frontend)](#5-especificación-detallada-de-módulos)
6. [Flujos Operativos: Las 3 Modalidades de Emisión](#6-flujos-operativos-las-3-modalidades-de-emisión)
7. [Desafío 1: Race Conditions y Asignación Atómica (`fn_llamar_siguiente`)](#7-desafío-1-race-conditions-y-asignación-atómica)
8. [Desafío 2: Alta Concurrencia y Pool pgBouncer](#8-desafío-2-alta-concurrencia-y-pool-pgbouncer)
9. [Desafío 3: Coordinación de Turnos en Pantalla TV (Cola FIFO)](#9-desafío-3-coordinación-de-turnos-en-pantalla-tv-cola-fifo)
10. [Desafío 4: Resiliencia ante Caídas, Jitter y Sincronización por Snapshot](#10-desafío-4-resiliencia-ante-caídas-jitter-y-sincronización-por-snapshot)
11. [Desafío 5: Comunicación en Tiempo Real y Canales WebSocket](#11-desafío-5-comunicación-en-tiempo-real-y-canales-websocket)
12. [Desafío 6: Idempotencia y Manejo de Rezagados](#12-desafío-6-idempotencia-y-manejo-de-rezagados)
13. [Desafío 7: Audio Híbrido, Locución Offline e Impresión ESC/POS](#13-desafío-7-audio-híbrido-locución-offline-e-impresión-escpos)
14. [Seguridad, Sesiones y Control de Acceso](#14-seguridad-sesiones-y-control-de-acceso)
15. [Base de Datos: Modelo Relacional, Triggers y Estados](#15-base-de-datos-modelo-relacional-triggers-y-estados)
16. [Matriz de Garantías Operativas](#16-matriz-de-garantías-operativas)

---

## 1. Principios de Diseño y Filosofía Arquitectónica

El sistema fue concebido para coordinar la atención masiva de personas en campus universitarios o sedes institucionales durante procesos de alta demanda (matrículas, inscripciones, cobros y validación documental). Opera primordialmente en red local (LAN / Wi-Fi institucional), con capacidad de extenderse a dispositivos móviles de estudiantes sin depender de servicios en la nube.

Cinco principios gobiernan cada línea de código:

1. **Cero Dependencias Externas en Ejecución (Autonomía 100% Offline):** Si el enlace a internet del campus se interrumpe, el sistema continúa funcionando con normalidad. Estilos de Tailwind CSS precompilados, Alpine.js v3, fuentes tipográficas (*Inter* y *JetBrains Mono* en WOFF2), audio institucional y síntesis de voz residen localmente en el servidor.
2. **Consistencia Transaccional Estricta (ACID):** Dos operadores jamás pueden recibir el mismo número correlativo ni atender al mismo estudiante. La lógica crítica de avance de lote y asignación de ventanilla se ejecuta en una única transacción atómica en PostgreSQL.
3. **Recuperación Autónoma sin Intervención Humana:** Ante microcortes de red, reinicios de routers o caídas momentáneas del servidor, los clientes web se reconectan automáticamente, aplican pausas con jitter aleatorio para no saturar la red y solicitan un snapshot en memoria para actualizarse sin parpadear ni recargar la página.
4. **Respuesta Inmediata (Latencia < 20 ms):** Al presionar *"Llamar Siguiente"*, la base de datos resuelve la transacción en < 4 ms y el WebSocket Hub difunde el evento a las pantallas públicas en < 10 ms.
5. **Idempotencia Defensiva:** El sistema es inmune a dobles clics accidentales de operadores, toques repetidos en pantallas táctiles y solicitudes duplicadas causadas por reintentos de red.

---

## 2. Arquitectura General en 4 Capas

El sistema se divide en cuatro capas claramente delimitadas y desacopladas:

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                   CAPA 1: PRESENTACIÓN Y CLIENTES WEB (FRONTEND)                        │
│                                                                                         │
│   ┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────────────┐   │
│   │   Panel Operador    │   │     Pantalla TV     │   │      Panel de Admin         │   │
│   │  (panel_mesa.html)  │   │      (tv.html)      │   │        (admin.html)         │   │
│   └──────────┬──────────┘   └──────────┬──────────┘   └──────────────┬──────────────┘   │
│              │                         │                             │                  │
│   ┌──────────┴──────────┐   ┌──────────┴──────────┐   ┌──────────────┴──────────────┐   │
│   │  Tablet de Entrada  │   │  Celular Estudiante │   │    Impresora Térmica LAN    │   │
│   │  (Kiosko Asistido)  │   │ (Autoservicio Móvil)│   │   (Tickets ESC/POS :9100)   │   │
│   └──────────┬──────────┘   └──────────┬──────────┘   └──────────────┬──────────────┘   │
└──────────────┼─────────────────────────┼─────────────────────────────┼──────────────────┘
               │ HTTP REST (JSON)        │ WebSocket Push (< 10 ms)    │ Sockets TCP RAW
               ▼                         ▼                             ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                    CAPA 2: SERVIDOR DE APLICACIÓN (FASTIFY 4 LTS)                       │
│                                                                                         │
│   ┌──────────────────────────────────────────┐  ┌───────────────────────────────────┐   │
│   │         API REST DE ALTO RENDIMIENTO     │  │       WEBSOCKET HUB EN VIVO       │   │
│   │  • /turnos   • /mesas   • /lotes         │  │  • Canales: tv:global, mesa:<id>  │   │
│   │  • /auth     • /admin   • /kiosko        │  │    admin:all, kiosko:<token>      │   │
│   │  • Seguridad: Helmet, CORS, Rate Limit   │  │  • Latidos simétricos Ping/Pong   │   │
│   │  • Validación por JSON Schema (Ajv)      │  │  • Sincronización por Snapshot    │   │
│   └────────────────────┬─────────────────────┘  └─────────────────┬─────────────────┘   │
│                        │                                          │                     │
│                        │       ┌──────────────────────────────────┴─────────────┐       │
│                        │       │ Servicio de Impresión LAN ESC/POS (TCP :9100)  │       │
│                        │       └────────────────────────────────────────────────┘       │
└────────────────────────┼──────────────────────────────────────────┬─────────────────────┘
                         │ Consultas SQL Atómicas                   │ Mensajería Pub/Sub
                         ▼                                          ▼
┌──────────────────────────────────────────────────┐  ┌───────────────────────────────────┐
│         CAPA 3: POOL Y PERSISTENCIA ACID         │  │     CAPA 4: CACHÉ Y TIEMPO REAL   │
│                                                  │  │                                   │
│   ┌──────────────────────────────────────────┐   │  ┌───────────────────────────────┐   │
│   │     pgBouncer (Pool Transaccional)       │   │  │    Redis 7 (In-Memory RAM)    │   │
│   │     10 conexiones reales a la BD         │   │  │  • Bus de eventos Pub/Sub     │   │
│   └────────────────────┬─────────────────────┘   │  │  • Lista negra de JWT         │   │
│                        │                         │  │  • Caché de snapshots (3s)    │   │
│                        ▼                         │  │  • Rate-limiting por IP       │   │
│   ┌──────────────────────────────────────────┐   │  │  • Claves de Idempotencia     │   │
│   │        PostgreSQL 15 (Relacional)        │   │  └───────────────────────────────┘   │
│   │  • Bloqueos de fila (SELECT FOR UPDATE)  │   │                                      │
│   │  • Cola concurrente FOR UPDATE SKIP LOCK │   │                                      │
│   │  • Función atómica fn_llamar_siguiente   │   │                                      │
│   │  • Función atómica fn_atender_rezagado   │   │                                      │
│   │  • Auditoría inmutable (audit_log)       │   │                                      │
│   └──────────────────────────────────────────┘   │                                      │
└──────────────────────────────────────────────────┘──────────────────────────────────────┘
```

---

## 3. Catálogo Tecnológico y Decisiones de Diseño

Cada herramienta del stack fue seleccionada por razones de rendimiento, resiliencia y aislamiento operativo:

| Tecnología | Rol en el Sistema | Justificación de Selección |
|---|---|---|
| **Node.js 20 LTS** | Runtime asíncrono del backend | Modelo de eventos no bloqueante con el motor V8; bajo consumo de recursos y excelente soporte de I/O en red. |
| **Fastify 4.x** | Framework HTTP del servidor | Hasta 2x más rápido que Express (~70,000 req/s); enrutador basado en Radix Tree, validación compilada con JSON Schema y sobrecarga cercana a cero. |
| **PostgreSQL 15** | Base de datos relacional (fuente de verdad) | Cumplimiento estricto de ACID, bloqueos finos de fila (`FOR UPDATE`), lectura de colas concurrentes (`FOR UPDATE SKIP LOCKED`) y funciones procedimentales en PL/pgSQL. |
| **pgBouncer** | Connection Pooler transaccional | Desacopla las conexiones entrantes de clientes. Mantiene **máximo 10 conexiones físicas reales** hacia PostgreSQL, evitando saturación de RAM por exceso de procesos. |
| **Redis 7** | Caché en RAM y bus Pub/Sub | Latencia sub-milisegundo (< 0.5 ms). Permite coordinar eventos en tiempo real entre múltiples procesos o réplicas, gestionar listas negras de tokens y almacenar claves de idempotencia. |
| **`@fastify/websocket`** | Hub de WebSockets nativo | Comunicación bidireccional push de baja latencia (< 10 ms). Elimina la sobrecarga del HTTP Polling y mantiene conexiones persistentes ligeras. |
| **HTML5 + Tailwind CSS 3** | Capa visual y tokens | Cero llamadas a CDN externas. Tailwind precompilado localmente (`src/public/css/tailwind.css`), tipografías *Inter* y *JetBrains Mono* autoalojadas. |
| **Alpine.js v3** | Reactividad liviana de UI | Reactividad declarativa para componentes de interfaz (< 15 KB minificado) sin requerir frameworks SPA pesados (React, Angular o Vue) ni cadenas de empaquetado complejas. |
| **ESC/POS sobre TCP** | Impresión térmica de tickets | Envío de secuencias binarias RAW directas al puerto TCP 9100 de impresoras térmicas (58 mm / 80 mm). Imprime y corta papel en < 300 ms sin depender del spooler de Windows. |
| **Docker Compose** | Contenedores e infraestructura | Despliegue reproducible de 4 servicios (`db`, `redis`, `pgbouncer`, `app`) con redes internas aisladas y políticas de auto-arranque `restart: unless-stopped`. |

---

## 4. Estructura del Proyecto y Organización de Código

El repositorio sigue una arquitectura modular donde la lógica de negocio se encuentra estrictamente separada de las rutas HTTP y de la presentación frontend:

```text
Turnero/
├── docker-compose.yml              ──► Orquestación multi-contenedor (db, redis, pgbouncer, app)
├── Dockerfile                      ──► Imagen de producción y desarrollo basada en Node 20 Alpine
├── package.json                    ──► Scripts npm, dependencias de producción y desarrollo
├── .env.example                    ──► Plantilla de configuración con valores listos para usar
│
├── iniciar_sistema.bat             ──► Lanzador rápido en Windows (Docker / PM2 / Node)
├── iniciar_dev.bat                 ──► Lanzador para desarrollo (Docker DB/Redis + Nodemon local)
├── detener_sistema.bat             ──► Apagado total, limpieza de puertos y liberación de recursos
├── actualizar_sistema.bat          ──► Actualizador seguro (git stash preventivo + git pull + build)
├── install.ps1                     ──► Instalador para Windows con fallback automático
├── install.sh                      ──► Instalador para Linux / macOS / servidores
│
├── migrations/                     ──► Migraciones SQL versionadas
│   ├── 001_tablas_datos.sql        (Estructura base, tablas, secuencias y catálogos)
│   ├── 002_indices.sql             (Índices B-Tree, índices parciales únicos)
│   ├── 003_funciones_triggers.sql  (fn_llamar_siguiente, fn_atender_rezagado, triggers)
│   └── 004_complementos.sql        (Parámetros complementarios, usuario no-root turnero_app)
│
├── scripts/                        ──► Herramientas operativas y utilidades
│   ├── seed.js                     (Carga inicial de administradores, operadores, mesas y lote 1)
│   ├── init_config.js              (Sincronización y reparación de las 24 claves de configuración)
│   ├── recrear_desde_cero.js       (Reconstrucción integral de la BD desde migraciones)
│   ├── run_migration.js            (Ejecutor de scripts SQL individuales)
│   ├── reset.js                    (Limpieza de turnos operativos conservando catálogos)
│   ├── backup.ps1 / backup.sh      (Respaldos SQL limpios con DROP IF EXISTS)
│   └── restore.ps1 / restore.sh    (Restauración con recreación de schema public)
│
├── src/
│   ├── server.js                   ──► Punto de entrada, listeners OS (SIGINT/SIGTERM) y graceful shutdown
│   ├── app.js                      ──► Registro de plugins Fastify, middlewares globales y rutas
│   │
│   ├── plugins/                    ──► Conectores y middlewares de infraestructura
│   │   ├── db.js                   (Pool cliente de pg hacia pgBouncer / PostgreSQL)
│   │   ├── redis.js                (Conexión ioredis para comandos y suscriptor Pub/Sub)
│   │   └── auth.js                 (Middleware JWT, validación de roles y control de acceso)
│   │
│   ├── modules/                    ──► Módulos de lógica de negocio (Backend)
│   │   ├── audit-acciones.js       (Helper de auditoría inmutable)
│   │   ├── auth/                   (Login, refresh token, ws-ticket y logout)
│   │   ├── turnos/                 (Llamar siguiente, cancelar, re-llamar, rezagados, snapshots)
│   │   ├── lotes/                  (Ciclo de vida de vouchers: crear, activar, extender, pausar)
│   │   ├── mesas/                  (Gestión de ventanillas y asignación de operadores)
│   │   ├── admin/                  (KPIs en vivo, CRUD usuarios, configuración y reportes)
│   │   ├── kiosko/                 (Emisión táctil, autoservicio QR, tracking e impresión ESC/POS)
│   │   └── ws/                     (Hub WebSocket, canales, autenticación y latidos)
│   │
│   └── public/                     ──► Frontend desacoplado (Cero JS inline en HTML)
│       ├── css/
│       │   ├── base.css            (Tokens visuales, fuentes Inter y JetBrains Mono)
│       │   ├── animations.css      (Keyframes de pulsos, glow de llamado y transiciones)
│       │   └── tailwind.css        (Tailwind CSS precompilado offline con CLI)
│       │
│       ├── js/
│       │   ├── api.js              (Cliente fetch con inyección de JWT e interceptor 401)
│       │   ├── ws-client.js        (Cliente WebSocket con backoff exponencial y jitter)
│       │   ├── utils.js            (Cronómetros, formateo de reloj y chime Web Audio API)
│       │   ├── escpos-printer.js   (Controlador cliente de impresión térmica)
│       │   ├── audio/speech.js     (Locución por voz con anclaje anti-garbage collection)
│       │   └── pages/              (Controladores modulares por pantalla)
│       │       ├── login.js        (Controlador de acceso y selección de mesa)
│       │       ├── panel_mesa.js   (Consola de trabajo del operador)
│       │       ├── tv.js           (Display pasivo para TV de auditorio 1080p)
│       │       ├── admin.js        (Panel de supervisión, lotes y métricas)
│       │       └── kiosko.js       (Consola táctil asistida / autoservicio móvil)
│       │
│       ├── vendor/                 ──► Dependencias de terceros autoalojadas
│       │   └── alpine-3.x.x.min.js (Alpine.js versión fijada sin CDN)
│       │
│       ├── assets/                 ──► Recursos estáticos
│       │   ├── audio/bell.mp3      (Tono institucional discreto)
│       │   └── fonts/              (Archivos WOFF2 de Inter y JetBrains Mono)
│       │
│       ├── index.html              ──► Pantalla de Login y grilla de selección de mesas
│       ├── panel_mesa.html         ──► Consola de ventanilla del operador
│       ├── tv.html                 ──► Pantalla pública de TV para auditorio
│       ├── admin.html              ──► Panel administrativo y dashboard
│       └── kiosko.html             ──► Kiosko web táctil / seguimiento personal
```

---

## 5. Especificación Detallada de Módulos

### Módulo 1: Autenticación y Sesiones (`/auth`)
- **Control de Acceso Basado en Roles (RBAC):** Tres niveles: `operador`, `supervisor`, `admin`.
- **Estrategia Híbrida de Tokens:**
  - **Access Token (JWT):** Vigencia de 2 horas. Contiene `id`, `username`, `rol` y un identificador único de sesión `jti`.
  - **Refresh Token:** Vigencia de 7 días, almacenado en cookie con atributos `HttpOnly; SameSite=Strict; Path=/auth`.
- **Sesión Única por Cuenta:** Al iniciar sesión en un nuevo dispositivo, el identificador `jti` anterior se almacena en la lista negra de Redis (`blacklist:jwt:<jti>`), forzando el cierre inmediato de sesiones previas del mismo usuario.
- **Ticket Efímero WebSocket (`/auth/ws-ticket`):** Para conectar WebSockets autenticados sin exponer el JWT en query parameters de la URL ni en logs de proxies, se solicita un ticket criptográfico de un solo uso con TTL de 30 segundos en Redis.
- **Persistencia en `sessionStorage`:** En terminales compartidas, al cerrar la pestaña se eliminan las credenciales locales inmediatamente.

### Módulo 2: Gestión de Turnos (`/turnos`)
- **`POST /turnos/llamar`:** Ejecuta `fn_llamar_siguiente(mesa_id, operador_id)` dentro de una sola transacción. Finaliza el turno previo, toma el siguiente número correlativo, actualiza el estado y emite la difusión por WebSockets.
- **`POST /turnos/:id/rellamar`:** Ejecuta un "Segundo Aviso". Notifica a la TV pública con prioridad visual y auditiva inmediata sin alterar el número correlativo ni el historial.
- **`POST /turnos/:id/cancelar`:** Marca el turno como `cancelado` cuando el estudiante no se presenta tras los llamados reglamentarios, liberando la ventanilla para continuar.
- **`POST /turnos/:id/atender-rezagado`:** Invoca `fn_atender_rezagado(turno_id, mesa_id, operador_id)` para rescatar un turno que había sido cancelado previamente y atenderlo sin consumir un nuevo voucher del lote.
- **`GET /turnos/estado`:** Retorna la instantánea completa (turno en curso de la mesa, último llamado global, historial de TV y estado del lote).

### Módulo 3: Lotes de Vouchers Físicos (`/lotes`)
- **Garantía de Lote Único Activo:** Índice parcial único en PostgreSQL (`CREATE UNIQUE INDEX idx_lotes_unico_activo ON lotes_voucher (estado) WHERE estado = 'activo'`).
- **Extensión en Caliente (`PATCH /lotes/:id/extender`):** Permite al supervisor ampliar el campo `numero_hasta` (ej. de 500 a 700) cuando la afluencia de personas supera lo estimado, sin reiniciar el sistema ni perder el avance correlativo.
- **Ciclo Multi-Día:** Un lote puede pasar a estado `pausado` al término de la jornada y reactivarse al día siguiente, continuando exactamente en el número siguiente al `ultimo_numero_llamado`.

### Módulo 4: Mesas y Ventanillas (`/mesas`)
- **Ciclo de Estados:** `inactiva` $\rightarrow$ `activa` $\rightleftharpoons$ `pausada`.
- **Asignación Dinámica:** Asigna operadores a mesas validando que una mesa activa no pueda ser operada por dos usuarios simultáneamente.
- **Pausa de Cortesía:** Al pausar una mesa (`PATCH /mesas/:id/estado`), la consola del operador muestra una pantalla de cortesía y la TV actualiza el estado de la ventanilla.

### Módulo 5: Kiosko Digital y Emisión (`/kiosko`)
- **Generación Atómica (`POST /kiosko/generar`):**
  - Incrementa la secuencia diaria atómicamente (`kiosko_contador_diario`).
  - Genera un token criptográfico seguro de consulta (`token_consulta` de 32 bytes en hexadecimal).
  - Admite cabecera `Idempotency-Key` para evitar turnos gemelos.
- **Seguimiento Personal (`GET /kiosko/mi-turno/:token`):** Permite al estudiante ver en su celular cuántas personas están antes que él y su tiempo de espera estimado en tiempo real vía WebSocket.
- **Cartel QR Automático (`GET /kiosko/cartel-qr`):** Genera una página HTML en alta resolución optimizada para impresión en 1 hoja, conteniendo el código QR que apunta a la dirección LAN del Kiosko.

### Módulo 6: Panel de Administración (`/admin`)
- **Métricas y Semáforo de Eficiencia:** Calcula en tiempo real turnos atendidos, tiempo medio de atención y colorea el semáforo de ventanillas (Verde: < 4 min, Amarillo: 4 a 7 min, Rojo: > 7 min).
- **Auditoría Inmutable:** Consulta eventos de `audit_log` con filtros de fecha, usuario y módulo.
- **Exportación de Reportes:** Genera descargas en formato CSV y Excel (.xls) con la trazabilidad completa de llamados y duraciones exactas calculadas por trigger.

### Módulo 7: WebSocket Hub (`/ws`)
- **Suscripciones Aisladas:**
  - `tv:global`: Mensajes públicos para auditorio.
  - `mesa:<id>`: Canal privado de la ventanilla con validación de identidad.
  - `admin:all`: Telemetría operativa completa para supervisión.
  - `kiosko:<token>`: Canal unifamiliar para el smartphone del alumno.
- **Heartbeat Simétrico:** Ping/Pong cada 30 segundos; conexiones sin respuesta tras 60 segundos se eliminan proactivamente para evitar acumulación de descriptores de socket (*memory leaks*).

---

## 6. Flujos Operativos: Las 3 Modalidades de Emisión

### Modalidad 1: Físico / Talonario (Predeterminado)

```text
┌────────────────┐          ┌──────────────────┐          ┌─────────────────┐
│ ADMIN (Antes)  │          │ PERSONAL PORTÓN  │          │ ESTUDIANTE      │
└───────┬────────┘          └────────┬─────────┘          └────────┬────────┘
        │                            │                             │
        │ 1. Crea Lote (ej: 1-500)   │                             │
        │    y activa mesas          │                             │
        │                            │ 2. Entrega ticket físico    │
        │                            │    de papel numerado        │
        │                            ├────────────────────────────►│ Recibe papel #47
        │                            │                             │ y aguarda en sala
        ▼                            ▼                             ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                      OPERADOR EN VENTANILLA DE ATENCIÓN                   │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     │ 3. Presiona "LLAMAR SIGUIENTE"
                                     ▼
                       ┌─────────────────────────────┐
                       │    POST /turnos/llamar      │
                       └──────────────┬──────────────┘
                                      │
                                      ▼ (Transacción Atómica SQL en < 4 ms)
                       ┌─────────────────────────────┐
                       │ • Bloquea Lote (FOR UPDATE) │
                       │ • Finaliza turno anterior   │
                       │ • Asigna siguiente: 47      │
                       │ • COMMIT y libera bloqueo   │
                       └──────────────┬──────────────┘
                                      │
              ┌───────────────────────┴───────────────────────┐
              │ Difusión Push por WebSocket (< 10 ms)         │
              ▼                                               ▼
┌─────────────────────────────┐               ┌─────────────────────────────┐
│     PANTALLA PÚBLICA TV     │               │       PANEL DE ADMIN        │
│                             │               │                             │
│ • Encola el turno #47       │               │ • Actualiza KPIs en vivo    │
│ • Destello visual azul      │               │ • Suma tiempo de atención   │
│ • Reproduce campana         │               │ • Actualiza semáforo mesa   │
│ • Voz: "Turno 47, Mesa 3"   │               │                             │
└─────────────────────────────┘               └─────────────────────────────┘
```

---

### Modalidad 2: Asistido (Tablet / Pulsador en Recepción)

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                     EMPLEADO CON TABLET EN LA ENTRADA                     │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     │ 1. Presiona botón táctil gigante:
                                     │    "ASIGNAR SIGUIENTE TURNO"
                                     ▼
                       ┌─────────────────────────────┐
                       │    POST /kiosko/generar     │
                       │    (esTablet = true)        │
                       └──────────────┬──────────────┘
                                      │
                                      ▼ (Base de datos)
                       ┌─────────────────────────────┐
                       │ • Incrementa contador diario│
                       │ • Crea turno 'esperando'    │
                       │ • Genera token de consulta  │
                       └──────────────┬──────────────┘
                                      │
              ┌───────────────────────┴───────────────────────┐
              │                                               │
              ▼                                               ▼
┌─────────────────────────────┐               ┌─────────────────────────────┐
│    COMPROBANTE EN TABLET    │               │  IMPRESORA TÉRMICA DE RED   │
│                             │               │                             │
│ • Muestra turno #047        │               │ • Conexión TCP socket :9100 │
│ • Renderiza código QR       │               │ • Imprime ticket físico     │
│ • Conteo regresivo: 15 seg  │               │ • Corte automático de papel │
│ • Botón "Asignar Siguiente" │               │                             │
│   inmediato para cadencia   │               │ (Si está apagada: aviso en  │
│ • Botón "Salir a Login"     │               │  pantalla sin trabar nada)  │
└─────────────────────────────┘               └─────────────────────────────┘
```

---

### Modalidad 3: Estudiantil (Autoservicio Móvil con Cartel QR)

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                       ESTUDIANTE CON SU TELÉFONO MÓVIL                    │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     │ 1. Escanea Cartel QR impreso en el campus
                                     │    (Accede vía Wi-Fi institucional a /kiosko.html)
                                     ▼
                       ┌─────────────────────────────┐
                       │   Pantalla Kiosko Móvil     │
                       │   Presiona "TOMAR MI TURNO" │
                       └──────────────┬──────────────┘
                                      │
                                      │ 2. Envía POST /kiosko/generar
                                      │    con Idempotency-Key única
                                      ▼
                       ┌─────────────────────────────┐
                       │ Asigna Turno #047 + Token   │
                       └──────────────┬──────────────┘
                                      │
                                      ▼ 3. Pasa automáticamente a:
┌───────────────────────────────────────────────────────────────────────────┐
│                       CONSOLA DE SEGUIMIENTO EN VIVO                      │
│                                                                           │
│ • "Tu turno es el #047"                                                   │
│ • Estado: "3 personas antes de ti" (Sincronizado vía WebSocket push)      │
│ • Estimación de espera: "~6 minutos"                                      │
│ • Sin necesidad de recargar la página                                     │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     │ 4. Ventanilla llama Turno #047
                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                       ALERTA INSTANTÁNEA EN EL CELULAR                    │
│                                                                           │
│ • El teléfono VIBRA con patrón de alerta                                  │
│ • Reproduce chime sonoro institucional                                    │
│ • Notificación en verde: "¡ES TU TURNO! DIRÍGETE A LA MESA 3"            │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Desafío 1: Race Conditions y Asignación Atómica

### El Problema
Si 10 operadores presionan *"Llamar Siguiente"* exactamente en el mismo instante, consultas tradicionales `SELECT` seguidas de `UPDATE` generarían colisiones de concurrencia, saltos de numeración o entrega del mismo número a múltiples ventanillas.

### La Solución: Función `fn_llamar_siguiente()` en PostgreSQL

La asignación se delega al motor de base de datos a través de una función procedimental atómica que implementa bloqueos según el modo activo del sistema:

```sql
SELECT * FROM fn_llamar_siguiente($1, $2);
```

#### Flujo de ejecución interno:

1. **Bloqueo y Verificación de Ventanilla:**
   ```sql
   SELECT id, numero, nombre, estado, operador_id 
   FROM mesas WHERE id = p_mesa_id FOR UPDATE;
   ```
   Garantiza que la mesa esté activa y pertenezca al operador solicitante.

2. **Ventana de Idempotencia (< 1.5 s):**
   Si la mesa ya tiene un turno `en_atencion` iniciado hace menos de 1.5 segundos, devuelve el turno existente con `es_idempotente = true` sin alterar los contadores.

3. **Cierre Atómico del Turno Previo:**
   Si existe un turno previo `en_atencion`, se actualiza a `atendido`, estableciendo `finalizado_en = NOW()`. Un trigger calcula automáticamente la duración exacta:
   ```sql
   duracion_atencion_seg = EXTRACT(EPOCH FROM (NEW.finalizado_en - NEW.llamado_en));
   ```

4. **Bifurcación por Modo Operativo:**
   - **Caso A: Modo `kiosko_web` (Cola Concurrente FIFO):**
     Toma el turno más antiguo en estado `esperando` mediante `SKIP LOCKED`:
     ```sql
     SELECT id, numero, token_consulta 
     FROM turnos 
     WHERE estado = 'esperando' AND fecha_turno = v_fecha_hoy 
     ORDER BY numero ASC 
     LIMIT 1 
     FOR UPDATE SKIP LOCKED;
     ```
     *Ventaja:* Múltiples operadores obtienen turnos distintos simultáneamente sin bloquearse entre sí.
   - **Caso B: Modo `voucher_fisico` (Contador de Lote Central):**
     Aplica bloqueo exclusivo sobre la fila del lote activo:
     ```sql
     SELECT id, numero_lote, numero_hasta, ultimo_numero_llamado 
     FROM lotes_voucher 
     WHERE estado = 'activo' 
     FOR UPDATE;
     ```
     Incrementa `ultimo_numero_llamado = ultimo_numero_llamado + 1` e inserta el nuevo registro en `turnos`.

5. **Detección de Agotamiento de Lote:**
   Si el nuevo número alcanza `numero_hasta`, el lote pasa a estado `agotado` y se emite la señal `es_lote_agotado = true` para alertar al administrador por WebSocket.

---

## 8. Desafío 2: Alta Concurrencia y Pool pgBouncer

### El Problema
PostgreSQL reserva un proceso del sistema operativo para cada conexión cliente, consumiendo entre 5 y 10 MB de memoria RAM por hilo. 50 dispositivos conectados colapsarían la memoria del servidor de la sede.

### La Solución: Pooler en Modo Transaccional

```text
┌──────────────────────────────────────────────┐
│  Decenas de Clientes Conectados (LAN / Web)  │
│  Mesas, Pantallas TV, Celulares, Kioskos     │
└──────────────────────┬───────────────────────┘
                       │ Hasta 100 slots cliente en Fastify
                       ▼
┌──────────────────────────────────────────────┐
│      pgBouncer (POOL_MODE: transaction)      │
└──────────────────────┬───────────────────────┘
                       │ Máximo 10 conexiones físicas reales
                       ▼
┌──────────────────────────────────────────────┐
│            PostgreSQL 15 Database            │
│            Consumo de RAM mínimo (<60 MB)    │
└──────────────────────────────────────────────┘
```

- **Mapeo desacoplado:** Cientos de conexiones WebSocket en Fastify **no abren conexiones a la base de datos**.
- **Liberación inmediata:** pgBouncer asigna una conexión física real a PostgreSQL únicamente durante los **3 a 4 milisegundos** que toma ejecutar la consulta SQL. En cuanto ocurre el `COMMIT`, la conexión se devuelve al pool para otra ventanilla.
- **Capacidad:** Con 10 conexiones reales, el sistema soporta más de 2,500 transacciones de llamado por minuto con un uso de CPU y RAM imperceptible.

---

## 9. Desafío 3: Coordinación de Turnos en Pantalla TV (Cola FIFO)

### El Problema
Si varias ventanillas llaman a estudiantes casi al mismo tiempo, los anuncios colisionarían en pantalla y la síntesis de voz se solaparía.

### La Solución: Cola FIFO en `tv.js`

El controlador de la pantalla pública gestiona una máquina de estados secuencial:

```text
Mensaje WebSocket recibido
         │
         ▼
¿Número de secuencia (seq) repetido? ───► SI: Descartar mensaje duplicado
         │ NO
         ▼
Encolar en la cola interna: _queue[]
         │
         ▼
¿Hay un anuncio reproduciéndose actualmente?
   ├──► SI: Aguardar turno ordenadamente en la cola
   └──► NO: Procesar turno al frente de la cola:
              1. Activar animación de atención (glow azul)
              2. Reproducir tono institucional (campana)
              3. Esperar finalización del audio (~850 ms)
              4. Locución verbal: "Turno 47, Mesa 3"
              5. Desplazar turno previo al historial lateral
              6. Esperar tiempo de exposición garantizado (mín. 4s)
              7. Desencolar y reproducir el siguiente turno
```

- **Prioridad para Re-llamados:** El "Segundo Aviso" se inserta al inicio de la cola con bandera prioritaria (`esRellamado = true`) y badge visual ámbar, sin alterar los contadores de la jornada.
- **Watchdog de Audio (12 s):** Si el sintetizador de voz del navegador se cuelga por problemas del sistema operativo, un temporizador de seguridad de 12 segundos destraba la cola automáticamente.

---

## 10. Desafío 4: Resiliencia ante Caídas, Jitter y Sincronización por Snapshot

### El Problema: El "Efecto Manada" (Thundering Herd)
Si el switch de red se reinicia, 50 pantallas intentarían reconectar simultáneamente en el segundo 0, saturando al servidor inmediatamente.

### La Solución: Backoff Exponencial con Full Jitter

El módulo `ws-client.js` dispersa los reintentos calculando esperas pseudoaleatorias:

$$\text{delay} = \min\left(30000, \text{baseDelay} \times 2^{\text{intentos}} + \text{random}(0, 1000)\right)$$

```text
Pantalla TV Auditorio:  ───[ Intento 1: 0.8s ]──► Conectada
Ventanilla 1:           ───────[ Intento 1: 1.4s ]──► Conectada
Ventanilla 2:           ──[ Intento 1: 0.6s ]──► Conectada
Tablet de Portón:       ───────────[ Intento 1: 2.1s ]──► Conectada
```

### Sincronización por Snapshot
Al restablecerse la conexión, el cliente **no recarga la página** (lo que reiniciaría el cronómetro del operador o provocaría parpadeos en la TV). En su lugar, envía un mensaje `solicitar_snapshot` y el servidor responde con el estado consolidado de la mesa, el último llamado global y el historial de llamados recientes.

---

## 11. Desafío 5: Comunicación en Tiempo Real y Canales WebSocket

### Segmentación de Canales y Prevención Anti-IDOR

| Canal | Audiencia | Payload y Eventos Emitidos |
|---|---|---|
| `tv:global` | Pantallas públicas de TV | `turno_llamado`, `turno_rellamado`, `historial_actualizado`, `tv_config_cambiada`. |
| `mesa:<id>` | Ventanilla específica | `turno_llamado`, `mesa_pausada`, `mesa_activada`, `turno_cancelado`. |
| `admin:all` | Panel de administración | Todos los eventos anteriores + `kpi_update`, `lote_agotado`, `alerta_lote_bajo`. |
| `kiosko:<token>`| Teléfono del estudiante | `mi_turno_posicion`, `mi_turno_llamado`. |

- **Seguridad Anti-IDOR:** Al solicitar suscripción a `mesa:<id>`, el backend valida que el `operador_id` del token JWT coincida con el operador asignado a esa ventanilla en la base de datos. Si no coincide, rechaza la suscripción con código de error de WebSocket `4403`.

---

## 12. Desafío 6: Idempotencia y Manejo de Rezagados

### Idempotencia en Ventanilla
Si un operador presiona reiteradamente el botón por lentitud de la red, la función `fn_llamar_siguiente` detecta el llamado reciente (< 1.5 s) y retorna el turno en curso con `es_idempotente = true`. El controlador frontend ignora la duplicación y no altera la cola de TV.

### Atención de Turnos Rezagados (`fn_atender_rezagado`)
Cuando un estudiante cuyo turno fue cancelado por no presentarse regresa más tarde a ventanilla, el operador puede invocar `fn_atender_rezagado(turno_id, mesa_id, operador_id)`:
1. Finaliza el turno que la mesa tenía en atención.
2. Reactiva el turno cancelado cambiándolo a estado `en_atencion`.
3. Asigna la mesa y el operador actual actualizando `llamado_en = NOW()`.
4. Emite el anuncio por WebSocket a la TV pública con etiqueta visual de rezagado.
5. **No consume vouchers del lote activo:** El correlativo general no se altera.

---

## 13. Desafío 7: Audio Híbrido, Locución Offline e Impresión ESC/POS

### Motor de Audio Híbrido (`utils.js` y `speech.js`)
Garantiza que la TV nunca quede muda ante caídas de red o fallas de archivos:

```text
Evento de Turno Llamado
         │
         ▼
¿El archivo /assets/audio/bell.mp3 está disponible en memoria?
   ├──► SI: Reproduce el buffer de audio pre-cargado
   └──► NO (Fallo de red o archivo corrupto):
              Sintetiza un doble tono senoidal institucional
              (Do5 a 523.25 Hz + Mi5 a 659.25 Hz) mediante la
              Web Audio API nativa del navegador.
         │
         ▼
Locución Verbal (Web Speech API)
"Turno 47, Mesa 3"
(Anclado a una variable global en speech.js para evitar que el Garbage Collector de V8 lo corte a mitad de frase)
```

### Impresión Térmica Directa ESC/POS (`printer.js`)
- **Protocolo:** Comunicación binaria RAW vía sockets TCP directos de Node.js al puerto 9100 de impresoras térmicas de red (Epson, Xprinter, etc.).
- **Compatibilidad de Bobinas:** Soporte nativo para 58 mm (32 columnas) y 80 mm (48 columnas).
- **Contenido del Ticket:**
  - Encabezado institucional centrado.
  - Número de turno en gran formato legible.
  - Fecha, hora y ventanilla de emisión.
  - Código QR con la URL de seguimiento para celular.
  - Comando ESC/POS de corte parcial o total de papel (`\x1D\x56\x00`).
- **Tolerancia a Fallos:** Si la impresora está apagada o sin papel, la promesa rechaza tras un timeout de 3 segundos sin bloquear el servidor y la interfaz del Kiosko permite imprimir mediante el diálogo nativo del navegador.

---

## 14. Seguridad, Sesiones y Control de Acceso

1. **Cifrado de Contraseñas:** `bcrypt` con costo 12 (`BCRYPT_COST=12`).
2. **Mitigación de Ataques de Fuerza Bruta:** Limitador de tasa (*Rate Limiter*) en Redis que restringe a 10 intentos de login por minuto por IP (`RATE_LIMIT_LOGIN_MAX=10`). Al exceder el umbral, responde HTTP 429.
3. **Encabezados de Seguridad (Helmet):** Protección con políticas CSP estrictas, prevención de clickjacking (`X-Frame-Options: SAMEORIGIN`) y bloqueo de MIME-sniffing.
4. **Auditoría Inmutable (`audit_log`):**
   - Estructura de sólo inserción (`REVOKE UPDATE, DELETE ON audit_log TO turnero_app`).
   - Registra fecha, usuario, rol, acción, entidad afectada, payload previo y nuevo, e IP origen.
   - En caso de requerir validación forense, cada registro puede verificar su integridad.
5. **Aislamiento de Privilegios de Base de Datos:**
   - Usuario de migraciones: `postgres` (superusuario para crear extensiones y triggers).
   - Usuario de aplicación en tiempo de ejecución: `turnero_app` (privilegios estrictos de `SELECT, INSERT, UPDATE` sobre tablas operativas).

---

## 15. Base de Datos: Modelo Relacional, Triggers y Estados

### Máquinas de Estado de las Entidades

```text
TURNO (Kiosko Web):
[ Creado ] ──► esperando ──► en_atencion ──► atendido (Fin exitoso)
                                      └──► cancelado (No se presentó)
                                                └──► (Rezagado) ──► en_atencion

TURNO (Voucher Físico):
[ Llamado ] ───────────────► en_atencion ──► atendido (Fin exitoso)
                                      └──► cancelado (No se presentó)

LOTE DE VOUCHERS:
[ Creado ] ──► preparado ──► activo ──► pausado ──► activo ... ──► cerrado
                                 └──► agotado (Alcanzó numero_hasta)

MESA:
[ Creada ] ──► inactiva ──► activa ──► pausada ──► activa ... ──► inactiva
```

### Diagrama Entidad-Relación Simplificado

```text
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│    USUARIOS     │          │      MESAS      │          │  LOTES_VOUCHER  │
├─────────────────┤          ├─────────────────┤          ├─────────────────┤
│ id (PK)         │◄──┐      │ id (PK)         │◄──┐      │ id (PK)         │◄──┐
│ username        │   │      │ numero          │   │      │ numero_lote     │   │
│ password_hash   │   └──────┼ operador_id(FK) │   │      │ numero_desde    │   │
│ nombre_completo │          │ nombre          │   │      │ numero_hasta    │   │
│ rol             │          │ estado          │   │      │ ultimo_llamado  │   │
│ activo          │          └─────────────────┘   │      │ estado          │   │
└─────────────────┘                                │      └─────────────────┘   │
                                                   │                            │
                                     ┌─────────────┴───┐                        │
                                     │     TURNOS      │                        │
                                     ├─────────────────┤                        │
                                     │ id (PK)         │                        │
                                     │ numero          │                        │
                                     │ estado          │                        │
                                     │ origen          │                        │
                                     │ mesa_id (FK)    │                        │
                                     │ operador_id(FK) │                        │
                                     │ lote_id (FK)────┼────────────────────────┘
                                     │ fecha_turno     │
                                     │ llamado_en      │
                                     │ finalizado_en   │
                                     │ duracion_seg    │
                                     │ token_consulta  │
                                     └─────────────────┘
```

---

## 16. Matriz de Garantías Operativas

| Desafío en Jornadas Masivas | Mecanismo Arquitectónico de Protección | Componente Responsable |
|---|---|---|
| **Llamados simultáneos en el mismo milisegundo** | Bloqueo a nivel de fila `SELECT FOR UPDATE` en transacción única | `fn_llamar_siguiente()` en PostgreSQL |
| **Colas de Kiosko sin contención entre operadores** | Bloqueo no bloqueante `FOR UPDATE SKIP LOCKED` | PostgreSQL PL/pgSQL |
| **Saturación de memoria con 100+ usuarios en LAN** | Pooler transaccional limitado a 10 conexiones reales | `pgBouncer` (`docker-compose.yml`) |
| **Peticiones duplicadas por doble clic del operador** | Ventana de protección de idempotencia temporal (1.5 segundos) | `fn_llamar_siguiente()` |
| **Peticiones duplicadas desde celulares o Kiosko** | Cabecera `Idempotency-Key` registrada con TTL en Redis | `src/modules/kiosko/service.js` |
| **Avalancha de pantallas tras microcorte de red** | Reconexión con backoff exponencial y jitter aleatorio | `ws-client.js` en frontend |
| **Pérdida de estado al reconectar pantallas** | Solicitud y reconciliación de Snapshot en memoria RAM | `hub.js` en backend Fastify |
| **Llamados que se pisan en la pantalla de TV** | Cola FIFO secuencial con tiempo mínimo de exposición | `tv.js` en pantalla pública |
| **Pantalla de TV muda por falla de red** | Tono de campana de respaldo con Web Audio API nativo | `utils.js` (Web Audio API) |
| **Voz sintética que se corta a mitad de frase** | Referencia global anclada anti-garbage collection | `src/public/js/audio/speech.js` |
| **Agotamiento de talonarios de papel en el día** | Extensión en caliente de `numero_hasta` sin reiniciar | `PATCH /lotes/:id/extender` |
| **Estudiante que regresa tras no presentarse** | Reactivación controlada sin consumir números de lote | `fn_atender_rezagado()` en PostgreSQL |
| **Impresión rápida de tickets en entrada** | Socket TCP RAW directo al puerto 9100 | `src/modules/kiosko/printer.js` |
| **Manipulación indebida del historial de atención** | Permisos `REVOKE UPDATE, DELETE` en tabla de auditoría | PostgreSQL DDL (`001_tablas_datos.sql`) |

---

*Turnero de Matrículas 2026 — Arquitectura Técnica de Grado Institucional (v2.1)*
