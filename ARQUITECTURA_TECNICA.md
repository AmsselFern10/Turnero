# Arquitectura Técnica — Turnero de Matrículas 2026 (v2.1)

> **Documento de Referencia Técnica y Operativa**  
> Explica la arquitectura interna del sistema, el catálogo de tecnologías utilizadas, la organización de módulos y los mecanismos que garantizan consistencia absoluta y cero caídas durante jornadas masivas de atención.

---

## Tabla de Contenidos

1. [Contexto y Principios de Diseño](#1-contexto-y-principios-de-diseño)
2. [Arquitectura General del Sistema](#2-arquitectura-general-del-sistema)
3. [Tecnologías Utilizadas y Decisiones de Diseño](#3-tecnologías-utilizadas-y-decisiones-de-diseño)
4. [Estructura del Proyecto y Organización de Código](#4-estructura-del-proyecto-y-organización-de-código)
5. [Especificación Detallada de Módulos](#5-especificación-detallada-de-módulos)
6. [Flujos Operativos de Trabajo](#6-flujos-operativos-de-trabajo)
7. [Desafío 1 — Race Conditions y Asignación Atómica](#7-desafío-1--race-conditions-y-asignación-atómica)
8. [Desafío 2 — Alta Concurrencia y Pool pgBouncer](#8-desafío-2--alta-concurrencia-y-pool-pgbouncer)
9. [Desafío 3 — Coordinación de Turnos en Pantalla TV (Cola FIFO)](#9-desafío-3--coordinación-de-turnos-en-pantalla-tv-cola-fifo)
10. [Desafío 4 — Resiliencia ante Caídas, Reconexión y Snapshot](#10-desafío-4--resiliencia-ante-caídas-reconexión-y-snapshot)
11. [Desafío 5 — Comunicación en Tiempo Real y WebSockets Push](#11-desafío-5--comunicación-en-tiempo-real-y-websockets-push)
12. [Desafío 6 — Idempotencia en Ventanillas y Kiosko](#12-desafío-6--idempotencia-en-ventanillas-y-kiosko)
13. [Desafío 7 — Sistema de Audio Híbrido y Respaldo Offline](#13-desafío-7--sistema-de-audio-híbrido-y-respaldo-offline)
14. [Base de Datos: Modelo Relacional y Estados](#14-base-de-datos-modelo-relacional-y-estados)
15. [Resumen de Garantías Operativas](#15-resumen-de-garantías-operativas)

---

## 1. Contexto y Principios de Diseño

El sistema está diseñado para coordinar la atención masiva de personas en campus universitarios o sedes institucionales durante procesos como matrículas, inscripciones, validación de documentos o pagos. Opera principalmente en red local (LAN) con capacidad de extensión segura a internet mediante túneles SSL para dispositivos móviles.

Cuatro principios fundamentales gobiernan cada componente del sistema:

1. **Cero dependencias externas en tiempo de ejecución:** Si la conexión a internet de la sede se interrumpe, el sistema sigue funcionando al 100%. Las fuentes tipográficas, hojas de estilo, scripts y tonos de audio están autoalojados en el servidor local.
2. **Consistencia transaccional absoluta:** Dos operadores jamás pueden llamar al mismo estudiante ni recibir el mismo número de turno. Las operaciones críticas son atómicas a nivel de motor de base de datos.
3. **Recuperación autónoma sin intervención humana:** Si un cable de red se desconecta o se reinicia un dispositivo, el cliente web se reconecta solo, recupera su estado sin recargar la página y no parpadea ni pierde información.
4. **Respuesta inmediata (Latencia < 20 ms):** Cuando un operador presiona "Llamar Siguiente", el anuncio visual y sonoro aparece en las pantallas públicas de inmediato.

---

## 2. Arquitectura General del Sistema

El sistema está estructurado en tres capas claramente delimitadas: **Capa de Clientes (Frontend Ligero)**, **Capa de Aplicación y Lógica (Fastify + WebSockets)** y **Capa de Datos y Persistencia (PostgreSQL + pgBouncer + Redis)**:

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                               CAPA DE CLIENTES (FRONTEND)                               │
│                                                                                         │
│   ┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────────────┐   │
│   │   Panel Operador    │   │     Pantalla TV     │   │      Panel de Admin         │   │
│   │  (panel_mesa.html)  │   │      (tv.html)      │   │        (admin.html)         │   │
│   └──────────┬──────────┘   └──────────┬──────────┘   └──────────────┬──────────────┘   │
│              │                         │                             │                  │
│   ┌──────────┴──────────┐   ┌──────────┴──────────┐   ┌──────────────┴──────────────┐   │
│   │  Tablet de Portón   │   │  Celular Estudiante │   │    Impresora Térmica LAN    │   │
│   │  (Kiosko Asistido)  │   │ (Autoservicio Móvil)│   │   (Tickets ESC/POS :9100)   │   │
│   └──────────┬──────────┘   └──────────┬──────────┘   └──────────────┬──────────────┘   │
└──────────────┼─────────────────────────┼─────────────────────────────┼──────────────────┘
               │ HTTP REST (JSON)        │ WebSocket Push (< 10ms)     │ Sockets TCP RAW
               ▼                         ▼                             ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                       CAPA DE SERVIDOR Y LÓGICA (NODE.JS + FASTIFY)                     │
│                                                                                         │
│   ┌──────────────────────────────────────────┐  ┌───────────────────────────────────┐   │
│   │         API REST DE ALTO RENDIMIENTO     │  │       WEBSOCKET HUB EN VIVO       │   │
│   │  • /turnos   • /mesas   • /lotes         │  │  • Canales: tv:global, mesa:<id>  │   │
│   │  • /auth     • /admin   • /kiosko        │  │  • Latidos Ping/Pong (30s)        │   │
│   │  • Validación por JSON Schema (Ajv)      │  │  • Snapshot en memoria para recon │   │
│   └────────────────────┬─────────────────────┘  └─────────────────┬─────────────────┘   │
│                        │                                          │                     │
│                        │       ┌──────────────────────────────────┴─────────────┐       │
│                        │       │ Servicio de Impresión LAN ESC/POS (TCP :9100)  │       │
│                        │       └────────────────────────────────────────────────┘       │
└────────────────────────┼──────────────────────────────────────────┬─────────────────────┘
                         │ Consultas SQL Atómicas                   │ Mensajería Pub/Sub
                         ▼                                          ▼
┌──────────────────────────────────────────────────┐  ┌───────────────────────────────────┐
│             CAPA DE PERSISTENCIA ACID            │  │          CAPA DE MEMORIA          │
│                                                  │  │                                   │
│   ┌──────────────────────────────────────────┐   │  ┌───────────────────────────────┐   │
│   │     pgBouncer (Pool Transaccional)       │   │  │    Redis 7 (In-Memory Cache)  │   │
│   │     10 conexiones reales a la BD         │   │  │  • Eventos Pub/Sub en vivo    │   │
│   └────────────────────┬─────────────────────┘   │  │  • Lista negra de JWT         │   │
│                        │                         │  │  • Caché de snapshots (3s)    │   │
│                        ▼                         │  │  • Claves de Idempotencia     │   │
│   ┌──────────────────────────────────────────┐   │  └───────────────────────────────┘   │
│   │        PostgreSQL 15 (Relacional)        │   │                                      │
│   │  • Bloqueos de fila (SELECT FOR UPDATE)  │   │                                      │
│   │  • Función atómica fn_llamar_siguiente   │   │                                      │
│   │  • Auditoría inmutable (audit_log)       │   │                                      │
│   └──────────────────────────────────────────┘   │                                      │
└──────────────────────────────────────────────────┘──────────────────────────────────────┘
```

---

## 3. Tecnologías Utilizadas y Decisiones de Diseño

Cada tecnología fue elegida de forma deliberada por sus capacidades específicas para resolver las demandas de alta concurrencia, tiempo real y tolerancia a fallos:

---

### 1. Node.js 20 LTS + Fastify 4.x
* **¿Qué es?**  
  Node.js es el entorno de ejecución asíncrono basado en el motor V8 de Google. Fastify es un framework web de última generación enfocado en mínima sobrecarga y máximo rendimiento.
* **¿Para qué sirve en este sistema?**  
  Es el núcleo del servidor. Procesa todas las solicitudes HTTP de los paneles, valida los datos de entrada, ejecuta la lógica de negocio y coordina la conexión con la base de datos y la mensajería en tiempo real.
* **¿Por qué se eligió?**  
  Posee un enrutador basado en árboles de prefijos (*radix tree*) que localiza rutas de forma instantánea y compila validadores nativos con *JSON Schema* antes de atender cada petición. Es capaz de gestionar más de 70,000 peticiones por segundo con un consumo de CPU y memoria insignificante, garantizando tiempos de respuesta inmediatos.

---

### 2. PostgreSQL 15
* **¿Qué es?**  
  Es un sistema de gestión de bases de datos relacional orientado a objetos, reconocido mundialmente por su robustez, fidelidad a los estándares SQL y estricto cumplimiento ACID.
* **¿Para qué sirve en este sistema?**  
  Es la fuente de verdad persistente e inmutable del turnero. Almacena usuarios, mesas, lotes de vouchers, turnos, registros de auditoría y configuraciones operativas. Aloja la función almacenada `fn_llamar_siguiente()`.
* **¿Por qué se eligió?**  
  Implementa bloqueos exclusivos a nivel de fila (`SELECT ... FOR UPDATE`), lo que permite que múltiples ventanillas soliciten turnos en el mismo milisegundo sin que ninguna obtenga un número duplicado. Además, su lenguaje procedimental `PL/pgSQL` ejecuta el avance de turno, cálculo de tiempos y finalización en una única transacción interna de 3 milisegundos.

---

### 3. pgBouncer (Connection Pooler)
* **¿Qué es?**  
  Es un gestor ligero de conexiones intermedias diseñado específicamente para PostgreSQL.
* **¿Para qué sirve en este sistema?**  
  Se interpone entre Fastify y PostgreSQL. Recibe las conexiones concurrentes de los servidores web y las distribuye reutilizando únicamente **10 conexiones físicas reales** hacia la base de datos.
* **¿Por qué se eligió?**  
  PostgreSQL crea un proceso del sistema operativo por cada conexión (consumiendo 5 a 10 MB de RAM cada uno). Si decenas de pantallas y ventanillas se conectaran directamente, saturarían la memoria del servidor. Configurado en modo transaccional (`POOL_MODE: transaction`), pgBouncer entrega una conexión física sólo durante los 3 ms que dura la transacción SQL y la libera inmediatamente para la siguiente ventanilla.

---

### 4. Redis 7
* **¿Qué es?**  
  Es un motor de estructura de datos en memoria (RAM) ultra veloz que funciona como base de datos de clave-valor y sistema de publicación/suscripción (Pub/Sub).
* **¿Para qué sirve en este sistema?**  
  Cumple dos funciones esenciales:
  1. **Bus de difusión en vivo:** Retransmite los llamados de turno instantáneamente entre los procesos del servidor y el hub de WebSockets.
  2. **Almacenamiento volátil de alta velocidad:** Guarda tokens temporales de WebSocket (TTL 30s), lista negra de sesiones cerradas, claves de idempotencia contra doble clic y snapshots de sincronización (TTL 3s).
* **¿Por qué se eligió?**  
  Las lecturas y escrituras toman menos de 0.5 milisegundos. Permite que las pantallas se enteren de un nuevo turno sin saturar el disco ni la base de datos principal, y permite escalar a múltiples instancias de servidor en paralelo manteniendo a todos los clientes sincronizados.

---

### 5. WebSockets Nativo (`@fastify/websocket`)
* **¿Qué es?**  
  Protocolo de comunicación bidireccional y persistente que mantiene un canal TCP abierto entre el navegador y el servidor.
* **¿Para qué sirve en este sistema?**  
  Envía los avisos de turnos llamados, re-llamados y cambios de estado directamente a las pantallas de TV, consolas de ventanilla y celulares de estudiantes en menos de 10 milisegundos.
* **¿Por qué se eligió?**  
  Elimina el problema del *HTTP Polling* (donde 50 pantallas consultan cada 2 segundos si hay novedades, consumiendo ancho de banda). Con WebSockets el servidor habla solo cuando hay un evento, reduciendo el tráfico de red de megabytes a simples tramas de pocos bytes.

---

### 6. Frontend Ligero (HTML5 Semántico + Tailwind CSS 3 + Alpine.js v3)
* **¿Qué es?**  
  Arquitectura web basada en tecnologías nativas del navegador, con estilos precompilados de Tailwind y reactividad declarativa ligera provista por Alpine.js.
* **¿Para qué sirve en este sistema?**  
  Construye todas las pantallas de usuario: Login, Consola de Ventanilla, Pantalla TV de Auditorio, Panel de Administración y Kiosko Web.
* **¿Por qué se eligió?**  
  Toda la interfaz pesa menos de 40 KB en total y no requiere frameworks pesados (como React o Angular) ni pasos de compilación complejos en tiempo de ejecución. Cualquier computadora antigua de oficina o pantalla inteligente abre la interfaz en menos de 50 milisegundos sin pantallas en blanco.

---

### 7. Impresión Térmica Directa ESC/POS vía TCP
* **¿Qué es?**  
  Estándar industrial de comunicación binaria para impresoras térmicas de tickets (Epson, Xprinter, Rongta, etc.) a través de sockets TCP de red (puerto 9100).
* **¿Para qué sirve en este sistema?**  
  Emite de forma automática e instantánea los comprobantes físicos con número de turno en gran formato y código QR de seguimiento en el Kiosko de recepción.
* **¿Por qué se eligió?**  
  Al comunicarse directamente con la IP de la impresora en la red local mediante sockets puros de Node.js, imprime en menos de 300 ms sin requerir drivers de Windows, diálogos de impresión ni dependencias externas.

---

## 4. Estructura del Proyecto y Organización de Código

El proyecto está diseñado bajo una arquitectura modular limpia y desacoplada, separando la lógica del servidor de la capa de presentación:

```text
Turnero/
├── docker-compose.yml         ──► Orquestación: db (Postgres), redis, pgbouncer y app
├── Dockerfile                 ──► Imagen optimizada de Node.js 20 LTS
├── iniciar_sistema.bat        ──► Script de inicio rápido del sistema (Docker / PM2 / Node)
├── migrations/                ──► Migraciones SQL versionadas (tablas, funciones, triggers)
│
├── src/
│   ├── server.js              ──► Arranque HTTP/WS, manejo de señales OS y cierre ordenado
│   ├── app.js                 ──► Registro de plugins Fastify, middlewares y prefijos de ruta
│   │
│   ├── plugins/               ──► Conectores reutilizables
│   │   ├── db.js              (Pool cliente hacia pgBouncer)
│   │   ├── redis.js           (Clientes ioredis para comandos y suscriptor Pub/Sub)
│   │   └── auth.js            (Verificación JWT y control de acceso por rol)
│   │
│   ├── modules/               ──► LÓGICA DE NEGOCIO (Backend modular)
│   │   ├── auth/              (Autenticación, refresh token y tickets efímeros)
│   │   ├── turnos/            (Llamar siguiente, cancelar, historial, snapshots)
│   │   ├── lotes/             (Control de lotes de vouchers físicos multi-día)
│   │   ├── mesas/             (Gestión de ventanillas y asignación de operadores)
│   │   ├── admin/             (KPIs, usuarios, auditoría, reportes Excel y ajustes)
│   │   ├── kiosko/            (Turnos digitales, impresión ESC/POS y cartel QR)
│   │   └── ws/                (Hub central de WebSockets, canales y latidos)
│   │
│   └── public/                ──► PRESENTACIÓN FRONTEND (Vistas limpias y desacopladas)
│       ├── css/               (Estilos base, animaciones y tailwind.css compilado)
│       ├── js/                (api.js centralizado, ws-client.js, utils.js)
│       ├── js/pages/          (Controladores modulares por vista: cero JS inline)
│       ├── assets/            (Fuentes Inter/JetBrains Mono, audio bell.mp3, iconos SVG)
│       ├── vendor/            (Alpine.js autoalojado offline)
│       │
│       ├── index.html         (Acceso y grilla de selección de mesas)
│       ├── panel_mesa.html    (Consola ergonómica del operador de ventanilla)
│       ├── tv.html            (Display público Full HD para auditorio)
│       ├── admin.html         (Panel de administración, métricas y configuración)
│       └── kiosko.html        (Consola asistida en tablet / autoservicio móvil)
```

---

## 5. Especificación Detallada de Módulos

El sistema cuenta con **7 módulos backend principales** complementados por el servicio de túnel remoto:

---

### Módulo 1: Autenticación y Sesiones (`/auth`)
* **Responsabilidad:** Control de acceso, emisión de credenciales y resiliencia de sesiones en puestos de trabajo compartidos.
* **Componentes clave:**
  * `POST /auth/login`: Valida contraseña mediante `bcrypt` (costo 12). Retorna JWT (2 horas) y establece cookie `HttpOnly; SameSite=Strict` para el refresh token (7 días).
  * `POST /auth/refresh`: Renueva el token de acceso de forma transparente cuando vence, rotando el refresh token.
  * `POST /auth/logout`: Invalida la sesión agregando el JWT a la lista negra en Redis.
  * `POST /auth/ws-ticket`: Emite un ticket criptográfico de un solo uso (TTL 30s) para conectar el WebSocket sin exponer el JWT en la barra de direcciones o logs de red.
  * Persistencia en `sessionStorage`: Al cerrar la pestaña del navegador en una PC compartida, la sesión se limpia automáticamente.

---

### Módulo 2: Gestión de Turnos y Cola de Atención (`/turnos`)
* **Responsabilidad:** El corazón operativo del turnero. Coordina la atención de estudiantes en ventanillas.
* **Componentes clave:**
  * `POST /turnos/llamar`: Invoca la función atómica `fn_llamar_siguiente()` en PostgreSQL. En una sola transacción finaliza el turno previo de la mesa, toma el siguiente número correlativo, registra el nuevo turno y emite la difusión por WebSocket a TV, mesa y admin.
  * `POST /turnos/:id/rellamar`: Dispara un "Segundo Aviso" en la TV con prioridad en la cola de locución, manteniendo el turno actual.
  * `POST /turnos/:id/cancelar`: Marca el turno como cancelado cuando un estudiante no se presenta, liberando la ventanilla.
  * `GET /turnos/estado`: Provee una instantánea consolidada del estado actual para alimentar pantallas que se acaban de conectar.
  * `GET /turnos/configuracion-publica`: Permite a la pantalla de TV consultar en caliente si la voz de locución está activa sin requerir credenciales de usuario.

---

### Módulo 3: Lotes de Vouchers Físicos (`/lotes`)
* **Responsabilidad:** Administrar los talonarios físicos entregados en portón para evitar reinicios accidentales de numeración.
* **Componentes clave:**
  * **Índice Parcial Único:** La base de datos garantiza mediante `CREATE UNIQUE INDEX ... WHERE estado = 'activo'` que jamás puedan existir dos lotes activos simultáneamente.
  * **Extensión en caliente:** Si se acaban los 500 vouchers impresos del día, el administrador puede cambiar `numero_hasta` a 700 desde su panel sin reiniciar el sistema ni interrumpir la atención.
  * **Ciclo multi-día:** Al finalizar el día, el lote se pausa. A la mañana siguiente se reactiva y el sistema continúa exactamente en el número siguiente (ej. 301).

---

### Módulo 4: Mesas y Ventanillas de Atención (`/mesas`)
* **Responsabilidad:** Representar las estaciones físicas de atención y sus estados operativos.
* **Componentes clave:**
  * `GET /mesas`: Retorna la lista de mesas activas con su operador actual, turno en atención y tiempos promedios.
  * `PATCH /mesas/:id/asignar`: Permite asignar o liberar operadores en caliente. Al liberar un operador, la mesa queda disponible de inmediato para que otro usuario la tome.
  * `PATCH /mesas/:id/estado`: Permite pausar la ventanilla temporalmente (mostrando pantalla de cortesía) o reactivarla.

---

### Módulo 5: Kiosko Digital, Autoservicio e Impresión (`/kiosko`)
* **Responsabilidad:** Proporcionar la alternativa digital para emisión de turnos presenciales o móviles.
* **Componentes clave:**
  * **Modalidad Asistida (Tablet de Portón):** El personal asigna el turno con un toque táctil. Muestra el comprobante con número gigante y QR por **15 segundos continuos** con conteo regresivo visible, permitiendo imprimir automáticamente en la impresora térmica LAN o volver a emitir de inmediato.
  * **Modalidad Estudiante (Autoservicio Celular):** El alumno escanea el Cartel QR, genera su turno con `Idempotency-Key` única y entra a la pantalla de seguimiento en vivo con conteo de personas en fila y alerta sonora al ser llamado.
  * **Servicio de Impresión ESC/POS (`printer.js`):** Envía comandos binarios nativos vía TCP directo al puerto 9100 de impresoras térmicas de red, imprimiendo texto, códigos QR y realizando corte de papel.

---

### Módulo 6: Panel de Administración y Supervisión (`/admin`)
* **Responsabilidad:** Centro de control global para supervisores y directores de matrícula.
* **Componentes clave:**
  * **Dashboard en tiempo real:** KPIs de turnos atendidos, cancelados, tiempo promedio de atención y semáforo visual de rendimiento por mesa.
  * **Gestión de Usuarios:** CRUD de cuentas con roles (`admin`, `operador`) y asignación rápida de ventanillas libres.
  * **Configuración modular en vivo:** Interruptores instantáneos para voz de TV, escalas visuales independientes, parámetros de kiosko, impresora de red y fondo institucional personalizado.
  * **Auditoría y Reportes:** Registro inmutable de eventos (`audit_log`) con exportación de la jornada a archivos Excel (.xls) y CSV.

---

### Módulo 7: Hub de WebSockets en Tiempo Real (`/ws`)
* **Responsabilidad:** Enrutador de mensajería Push de ultrabaja latencia.
* **Componentes clave:**
  * Canales dedicados: `tv:global` (pantallas públicas), `mesa:<id>` (canal seguro por ventanilla), `admin:all` (métricas de supervisor) y `kiosko:<token>` (seguimiento en celular).
  * Seguridad anti-IDOR: Impide que un operador escuche canales de otras ventanillas comparando el token JWT con la mesa solicitada.
  * Latido simétrico: Envía *ping* cada 30 segundos y cierra conexiones inactivas tras 60 segundos para evitar fugas de memoria.



## 6. Flujos Operativos de Trabajo

A continuación se presentan los diagramas visuales de los tres flujos de trabajo principales que componen el sistema:

---

### Flujo 1: Modalidad Tradicional con Vouchers Físicos

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
        │                            │                             │ y va a la sala
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
                                     ▼ (Transacción Atómica SQL en 3 ms)
                      ┌─────────────────────────────┐
                      │ • Bloquea Lote (FOR UPDATE) │
                      │ • Finaliza turno anterior   │
                      │ • Siguiente número: 47      │
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

### Flujo 2: Modalidad Asistida (Consola en Tablet de Portón)

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                     EMPLEADO CON TABLET EN LA ENTRADA                     │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     │ 1. Presiona botón gigante:
                                     │    "ASIGNAR SIGUIENTE TURNO"
                                     ▼
                      ┌─────────────────────────────┐
                      │    POST /kiosko/generar     │
                      │    (esTablet = true)        │
                      └──────────────┬──────────────┘
                                     │
                                     ▼ (Base de datos)
                      ┌─────────────────────────────┐
                      │ • Asigna siguiente número   │
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

### Flujo 3: Modalidad Estudiante (Autoservicio Móvil con Cartel QR)

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                       ESTUDIANTE CON SU TELÉFONO MÓVIL                    │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     │ 1. Escanea Cartel QR impreso con la cámara
                                     │    (Ingresa mediante la red Wi-Fi / LAN del campus)
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
│ • Estado: "3 personas antes de ti" (Sincronizado por WebSocket en vivo)   │
│ • Estimación de espera: "~6 minutos"                                      │
│ • No requiere recargar el navegador                                       │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     │ 4. Operador llama Turno #047 en ventanilla
                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                       ALERTA INSTANTÁNEA EN EL CELULAR                    │
│                                                                           │
│ • El teléfono VIBRA intensamente                                          │
│ • Suena campana de notificación                                           │
│ • Mensaje en verde: "¡ES TU TURNO! DIRÍGETE A LA MESA 3"                 │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Desafío 1 — Race Conditions y Asignación Atómica

### El problema
Si diez operadores en ventanillas distintas presionan el botón "Llamar Siguiente" en la misma fracción de segundo, un sistema web tradicional consultaría la base de datos, vería el mismo número actual y asignaría el mismo voucher a dos o más personas a la vez.

### La solución: Bloqueo de fila y función `fn_llamar_siguiente()`
La asignación se procesa enteramente dentro de PostgreSQL mediante una única llamada:

```sql
SELECT * FROM fn_llamar_siguiente($1, $2);
```

```text
Operador A (Mesa 1) ────┐
Operador B (Mesa 2) ────┼──► PostgreSQL (fn_llamar_siguiente)
Operador C (Mesa 3) ────┘         │
                                  ▼
                    ┌───────────────────────────┐
                    │ SELECT ... FOR UPDATE     │ ◄─── Aplica bloqueo de fila sobre el lote
                    │ sobre lote_activo         │      (Tarda ~3 milisegundos)
                    └─────────────┬─────────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
                 ▼                                 ▼
   Mesa 1 obtiene el bloqueo:        Mesas 2 y 3 quedan en cola
   • Lee contador (46)               esperando pacientemente
   • Asigna 47                       (sin consumir CPU ni fallar)
   • COMMIT: libera bloqueo
                 │
                 ▼
   Mesa 2 toma el turno:
   • Lee contador actualizado (47)
   • Asigna 48
   • COMMIT: libera bloqueo
                 │
                 ▼
   Mesa 3 toma el turno:
   • Lee contador actualizado (48)
   • Asigna 49
   • COMMIT
```

> **Garantía:** Aunque 20 mesas presionen en el mismo milisegundo exacto, reciben 20 números correlativos estrictamente consecutivos, sin duplicados ni huecos.

---

## 8. Desafío 2 — Alta Concurrencia y Pool pgBouncer

### El problema
PostgreSQL reserva un proceso independiente del sistema operativo para cada conexión que recibe, consumiendo entre 5 y 10 MB de memoria RAM por conexión, incluso si está inactiva. Con decenas de mesas, pantallas y consultas simultáneas, un servidor se quedaría sin memoria rápidamente.

### La solución: Pooler en Modo Transaccional
pgBouncer actúa como un embudo inteligente que desacopla los clientes conectados de las conexiones reales hacia la base de datos:

```text
┌──────────────────────────────────────────────┐
│  Decenas de Clientes Conectados (LAN / Web)  │
│  Mesas, Pantallas TV, Celulares, Kioskos     │
└──────────────────────┬───────────────────────┘
                       │ Hasta 100 slots de red abiertos
                       ▼
┌──────────────────────────────────────────────┐
│      pgBouncer (POOL_MODE: transaction)      │
└──────────────────────┬───────────────────────┘
                       │ Exactamente 10 conexiones físicas reales
                       ▼
┌──────────────────────────────────────────────┐
│            PostgreSQL 15 Database            │
│            Consumo de RAM mínimo (<50 MB)    │
└──────────────────────────────────────────────┘
```

* Un usuario conectado a un WebSocket **no ocupa una conexión a la base de datos**.
* La conexión real a PostgreSQL sólo se utiliza durante los **3 milisegundos** que toma ejecutar la consulta SQL. Apenas se confirma (`COMMIT`), la conexión queda libre para otra ventanilla.
* Con 10 conexiones reales, el sistema es capaz de procesar más de **3,000 llamadas por segundo**.

---

## 9. Desafío 3 — Coordinación de Turnos en Pantalla TV (Cola FIFO)

### El problema
Si tres ventanillas llaman a sus estudiantes con un segundo de diferencia, los mensajes llegarían al auditorio al unísono. Si la TV no los coordinara, el turno 48 pisaría al 47 de inmediato y las voces de locución hablarían al mismo tiempo.

### La solución: Máquina de estados con Cola FIFO
El controlador de la pantalla pública (`tv.js`) implementa una cola secuencial (*First In, First Out*):

```text
Mensaje WebSocket recibido
         │
         ▼
¿Número de secuencia (seq) repetido? ───► SI: Descartar mensaje
         │ NO
         ▼
Encolar en la cola interna: _queue[]
         │
         ▼
¿Hay un anuncio reproduciéndose actualmente?
   ├──► SI: Esperar turno en la cola de forma ordenada
   └──► NO: Procesar turno inmediatamente:
              1. Activar destello visual (resaltar ventanilla)
              2. Reproducir campana institucional
              3. Esperar finalización del tono (~850 ms)
              4. Locución verbal: "Turno 47, Mesa 3"
              5. Desplazar turno previo al historial lateral
              6. Desencolar y reproducir el siguiente turno
```

* **Tiempo garantizado:** Cada turno permanece visible como mínimo 4 segundos antes de dar paso al siguiente.
* **Segundo Aviso (Re-llamado):** Se ubica al frente de la cola con prioridad especial y muestra un badge ámbar sin alterar el historial.
* **Watchdog de seguridad:** Un temporizador de 12 segundos destraba automáticamente la pantalla si el motor de voz del navegador sufre algún retraso.

---

## 10. Desafío 4 — Resiliencia ante Caídas, Reconexión y Snapshot

### El problema: El "Efecto Manada" (Thundering Herd)
Si el servidor se reinicia o el switch de red parpadea, todas las pantallas intentan reconectarse en el mismo segundo exacto. Esto produce una avalancha de peticiones que puede volver a tumbar el servidor recién levantado.

### La solución: Backoff Exponencial con Jitter Aleatorio
El cliente de tiempo real (`ws-client.js`) aplica pausas con dispersión aleatoria:

```text
Desconexión detectada
         │
         ├─► Intento 1: Espera entre 500ms y 1.5 segundos (Aleatorio)
         ├─► Intento 2: Espera entre 500ms y 3.0 segundos (Aleatorio)
         ├─► Intento 3: Espera entre 500ms y 6.0 segundos (Aleatorio)
         └─► Intento 4+: Escala progresiva con tope de 30 segundos
```

```text
Cliente 1 (TV Auditorio):       ───[ Intento 1: 0.8s ]──► Reconectado OK
Cliente 2 (Mesa 1):             ───────[ Intento 1: 1.4s ]──► Reconectado OK
Cliente 3 (Mesa 2):             ──[ Intento 1: 0.6s ]──► Reconectado OK
Cliente 4 (Kiosko Portón):      ───────────[ Intento 1: 2.1s ]──► Reconectado OK
```

* **Resultado:** Los intentos de reconexión se dispersan suavemente en el tiempo.
* **Sincronización por Snapshot:** Al volver la conexión, el navegador **no recarga la página** (lo que resetearía el cronómetro del operador y causaría parpadeos molestos). En su lugar, solicita un snapshot en memoria que actualiza el turno actual y el historial en milisegundos.

---

## 11. Desafío 5 — Comunicación en Tiempo Real y WebSockets Push

### Canales segmentados y seguridad anti-IDOR
El hub de WebSockets divide el tráfico en canales especializados para que cada dispositivo reciba únicamente la información que le corresponde:

| Canal | Destinatarios | Eventos que transmite |
|---|---|---|
| `tv:global` | Pantallas públicas de auditorio | Turnos llamados, re-llamados, historial y reloj sincronizado. |
| `mesa:<id>` | Consola del operador de ventanilla | Turno en atención propio, avisos de pausa y métricas de mesa. |
| `admin:all` | Panel central de administración | KPIs en vivo, alertas de vouchers agotados y estados de mesas. |
| `kiosko:publico`| Consolas de Kiosko | Actualizaciones globales de modalidad y disponibilidad de cupos. |
| `kiosko:<token>`| Smartphone personal del estudiante | Posición en cola del alumno y aviso personal de llamado a ventanilla. |

* **Validación Anti-IDOR:** El backend valida que el operador pertenezca exclusivamente a la mesa que intenta escuchar mediante su token de sesión, bloqueando accesos indebidos con código `4403`.

---

## 12. Desafío 6 — Idempotencia en Ventanillas y Kiosko

### El problema
Un operador con un ratón defectuoso puede hacer doble clic involuntario al presionar "Llamar Siguiente", o un estudiante puede pulsar repetidamente la pantalla táctil por impaciencia, quemando vouchers válidos.

### La solución implementada
1. **En Ventanilla (Ventana de protección de 1.5 segundos):**  
   Si un operador hace clic nuevamente dentro de 1.5 segundos desde su último llamado, la base de datos detecta el turno en curso y devuelve el mismo turno con la bandera `es_idempotente = true`, sin avanzar el contador de vouchers ni generar llamados duplicados en TV.
2. **En Kiosko y Celulares (`Idempotency-Key`):**  
   Cada solicitud de generación de turno genera un identificador único en el dispositivo. Si la petición viaja dos veces por microcortes de red, el servidor detecta la clave en memoria y devuelve el mismo comprobante ya emitido.

---

## 13. Desafío 7 — Sistema de Audio Híbrido y Respaldo Offline

### Campana institucional con fallback Web Audio API
Para garantizar que las pantallas de TV nunca queden mudas aunque la red local falle:

```text
Evento de Turno Llamado
         │
         ▼
¿El archivo /assets/audio/bell.mp3 está en memoria?
   ├──► SI: Reproduce el archivo de audio pre-cargado (AudioBuffer en RAM)
   └──► NO (Fallo de red o archivo dañado):
              Sintetiza instantáneamente un doble tono armonizado
              (Do5 a 523.25 Hz + Mi5 a 659.25 Hz) utilizando la
              Web Audio API nativa del navegador.
         │
         ▼
Locución Verbal (Web Speech API)
"Turno 47, Mesa 3"
(Protegido contra recolección de basura con variable anclada en módulo)
```

---

## 14. Base de Datos: Modelo Relacional y Estados

### Máquina de estados del Turno

```text
MODALIDAD KIOSKO DIGITAL:
[ Inicio ] ──► esperando ──► en_atencion ──► atendido (Finalizado exitosamente)
                                      └──► cancelado (No se presentó)

MODALIDAD VOUCHER FÍSICO:
[ Inicio ] ────────────────► en_atencion ──► atendido (Finalizado exitosamente)
                                      └──► cancelado (No se presentó)
```

### Tablas centrales del sistema

```text
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│    USUARIOS     │       │      MESAS      │       │  LOTES_VOUCHER  │
├─────────────────┤       ├─────────────────┤       ├─────────────────┤
│ id (PK)         │◄──┐   │ id (PK)         │◄──┐   │ id (PK)         │◄──┐
│ username        │   └───┼ operador_id(FK) │   └───┼ lote_id (FK)    │   │
│ password_hash   │       │ numero          │       │ numero_lote     │   │
│ nombre_completo │       │ nombre          │       │ numero_desde    │   │
│ rol             │       │ estado          │       │ numero_hasta    │   │
│ activo          │       └─────────────────┘       │ ultimo_llamado  │   │
└─────────────────┘                                 │ estado          │   │
                                                    └─────────────────┘   │
                                                                          │
                                  ┌─────────────────┐                     │
                                  │     TURNOS      │                     │
                                  ├─────────────────┤                     │
                                  │ id (PK)         │                     │
                                  │ numero          │                     │
                                  │ estado          │                     │
                                  │ origen          │                     │
                                  │ mesa_id (FK)────┼─────────────────────┘
                                  │ operador_id(FK) │
                                  │ lote_id (FK)────┼─────────────────────┘
                                  │ llamado_en      │
                                  │ finalizado_en   │
                                  │ duracion_seg    │
                                  │ token_consulta  │
                                  └─────────────────┘
```

* **Trazabilidad inmutable (`audit_log`):** Cada acción administrativa y cambio de turno se guarda en una tabla de sólo inserción (`REVOKE UPDATE, DELETE ON audit_log`), garantizando que nadie pueda alterar el historial de atención.

---

## 15. Resumen de Garantías Operativas

| Desafío en Jornada Masiva | Mecanismo de Protección | Componente Responsable |
|---|---|---|
| **Dos operadores llaman el mismo número** | Bloqueo atómico a nivel de fila `SELECT FOR UPDATE` | `fn_llamar_siguiente()` en PostgreSQL |
| **Saturación de memoria con 100+ usuarios** | Pooler transaccional limitado a 10 conexiones reales | `pgBouncer` (`docker-compose.yml`) |
| **Peticiones duplicadas por doble clic** | Ventana de idempotencia temporal (1.5 segundos) | Transacción SQL en `service.js` |
| **Avalancha de pantallas tras corte de red** | Reconexión con backoff exponencial y jitter aleatorio | `ws-client.js` en frontend |
| **Pérdida de estado al reconectar pantallas** | Solicitud de Snapshot consolidado en memoria RAM | `hub.js` en backend Fastify |
| **Turnos que se pisan en la pantalla TV** | Cola FIFO secuencial con tiempo mínimo de exposición | `tv.js` en pantalla pública |
| **Pantalla muda sin salida a internet** | Generador de tonos institucional con Web Audio API | `utils.js` (Web Audio API nativa) |
| **Operación 100% autónoma en red local** | Todo el sistema (fuentes, CSS, scripts, audio) autoalojado | Servidor Fastify en LAN (`http://<ip>:3000`) |
| **Impresión rápida de tickets en recepción** | Protocolo RAW ESC/POS directo por socket TCP | `printer.js` hacia puerto 9100 |
| **Auditoría y reportes a prueba de manipulación**| Permisos revocados de UPDATE/DELETE en `audit_log` | Schema de base de datos relacional |

---

*Turnero de Matrículas 2026 — Documento de Arquitectura de Grado Institucional (v2.1)*