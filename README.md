# Turnero de Matrículas 2026 (v2.1)

Sistema digital de gestión de turnos en tiempo real de alta concurrencia, diseñado para procesos masivos de atención estudiantil y ciudadana (matrículas, inscripciones, cobros y validación de expedientes). 

Opera de forma 100% autónoma en redes locales (LAN / Wi-Fi de campus) sin depender de internet ni de servicios en la nube, garantizando tiempos de respuesta menores a 20 ms mediante transacciones atómicas en PostgreSQL, difusión push por WebSockets y control de conexiones con pgBouncer.

---

## Índice

1. [Problemas Críticos que Resuelve](#-problemas-críticos-que-resuelve)
2. [Arquitectura del Sistema](#-arquitectura-del-sistema)
3. [Módulos del Sistema](#-módulos-del-sistema)
4. [Flujo Operativo: Las 3 Modalidades de Emisión](#-flujo-operativo-las-3-modalidades-de-emisión)
5. [Guía de Instalación y Despliegue](#-guía-de-instalación-y-despliegue)
   - [A. Servidor de Producción / Linux](#a-servidor-de-producción--linux-recomendado-con-docker)
   - [B. Servidor Central en Windows (Paso a Paso con IP Fija y LAN)](#b-servidor-central-en-windows-guía-paso-a-paso-para-red-local)
   - [C. Modo Desarrollo (Hot-Reload)](#c-modo-desarrollo-hot-reload-con-iniciar_devbat)
6. [Configuración desde el Panel de Administración (24 Parámetros)](#-configuración-desde-el-panel-de-administración)
7. [Referencia de Comandos y Ejecutables](#-referencia-de-comandos-y-ejecutables)

---

## ⚡ Problemas Críticos que Resuelve

### 1. Dos operadores llaman al mismo número (Race Condition)
- **Problema:** Si 10 operadores presionan *"Llamar Siguiente"* en el mismo milisegundo, una consulta común leería el mismo contador de base de datos y asignaría el mismo voucher a varios estudiantes.
- **Solución:** Función transaccional atómica en PostgreSQL (`fn_llamar_siguiente`) con bloqueo exclusivo a nivel de fila (`SELECT ... FOR UPDATE`) sobre el lote activo. La primera ventanilla toma el bloqueo (< 4 ms), incrementa el contador, finaliza el turno previo como `atendido`, crea el nuevo registro en `en_atencion` y libera el bloqueo. Las demás mesas esperan su turno ordenadamente.
- **Garantía:** Cero números duplicados y cero saltos de correlativo bajo cualquier nivel de concurrencia.

### 2. Saturación de memoria por conexiones simultáneas (pgBouncer)
- **Problema:** PostgreSQL crea un proceso del sistema operativo por cada conexión cliente (~10 MB RAM por conexión). Decenas de pantallas y celulares colapsarían la base de datos rápidamente.
- **Solución:** Se interpone **pgBouncer** en modo transaccional (`POOL_MODE: transaction`) entre Fastify y PostgreSQL. Cientos de clientes se comunican con Fastify, pero Fastify comparte un pool estricto de **máximo 10 conexiones reales** a PostgreSQL únicamente durante los milisegundos que dura la transacción activa.

### 3. Varios llamados simultáneos en la TV de auditorio (Cola FIFO)
- **Problema:** Si 3 ventanillas llaman al mismo tiempo, los anuncios colisionarían en pantalla y la locución por voz se pisaría haciéndose ininteligible.
- **Solución:** La pantalla de TV (`tv.js`) implementa una **Cola FIFO (First In, First Out)** con secuencia monótona (`seq`). Cada turno se exhibe con un tiempo mínimo garantizado de exposición y locución antes de avanzar al siguiente. Los **re-llamados** reciben prioridad visual inmediata sin alterar el historial, respaldados por un *watchdog* de seguridad de 12 segundos para evitar bloqueos de audio.

### 4. Caídas de red y reconexión masiva (Backoff con Jitter + Snapshot)
- **Problema:** Si el router se reinicia o se corta un cable, 50 pantallas intentarían reconectar en el mismo segundo exacto, botando el servidor mediante el efecto *Thundering Herd* (avalancha).
- **Solución:** El cliente WebSocket institucional (`ws-client.js`) utiliza **Backoff Exponencial con Full Jitter**:
  $$\text{delay} = \min\left(30000, \text{base} \times 2^{\text{intentos}} + \text{random}(0, 1000)\right)$$
  Al reconectar, solicita un snapshot de sincronización en memoria para ponerse al día sin recargar la página del navegador.

### 5. Doble clic y peticiones repetidas (Idempotencia en Ventanilla y Kiosko)
- **En Mesa:** Si un operador presiona rápidamente dos veces "Llamar Siguiente", una ventana de protección de 1.5 segundos detecta el turno en curso y devuelve el mismo registro sin avanzar el lote (`es_idempotente: true`).
- **En Kiosko:** Cada solicitud de turno digital incluye una clave única generada por el cliente (`Idempotency-Key`), evitando generar turnos dobles por toques repetidos o microcortes de red.

### 6. Operación 100% Offline (Sin Internet)
- Los estilos de Tailwind CSS están precompilados en local.
- Alpine.js y las tipografías (*Inter* y *JetBrains Mono*) están autoalojadas en WOFF2.
- **Audio híbrido:** Intenta reproducir el archivo institucional `bell.mp3`. Si falla, la **Web Audio API** del navegador sintetiza en vivo un doble tono senoidal institucional (523.25 Hz Do5 + 659.25 Hz Mi5), seguido de locución con la **Web Speech API** del sistema operativo.

---

## 🏛 Arquitectura del Sistema

El sistema está estructurado en 4 capas desacopladas con comunicación push en tiempo real:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   CAPA 1: CLIENTES Y PANTALLAS (LAN)                   │
│   Operador (panel_mesa) · Pantalla TV (tv) · Admin (admin) · Kiosko    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP REST / WebSocket Push (< 10 ms)
┌───────────────────────────────────▼────────────────────────────────────┐
│              CAPA 2: SERVIDOR DE APLICACIÓN (FASTIFY 4 LTS)            │
│   • Router modular (auth, mesas, lotes, turnos, kiosko, admin)         │
│   • WebSocket Hub segmentado con Heartbeat 30s                         │
│   • Autenticación JWT (2h) + Refresh Token HttpOnly (7d)               │
│   • Control de sesión única por usuario y mitigación de fuerza bruta   │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │                                 │
┌──────────────────▼───────────────┐ ┌───────────────▼───────────────────┐
│       CAPA 3: CACHÉ Y PUBSUB     │ │      CAPA 4: POOL Y PERSISTENCIA  │
│          Redis 7 (In-Memory)     │ │        pgBouncer (Transaction)    │
│   • Pub/Sub entre instancias     │ │                  │                │
│   • Blacklist de JWTs revocados  │ │                  ▼                │
│   • Rate limit por IP            │ │         PostgreSQL 15+            │
│   • Bloqueos distribuidos        │ │   • Bloqueos FOR UPDATE           │
│                                  │ │   • Auditoría inmutable (SHA-256) │
│                                  │ │   • Triggers de cálculo temporal  │
└──────────────────────────────────┘ └───────────────────────────────────┘
```

---

## 🧩 Módulos del Sistema

| Módulo | Ruta Backend | Pantalla Frontend | Responsabilidad Principal |
|---|---|---|---|
| **Autenticación** | `/auth` | `/index.html` | Login con hash bcrypt (costo 12), selección de ventanilla dinámica, emisión de JWT (2 horas), refresh token en cookie HttpOnly y revocación por sesión única (si una cuenta inicia en otra máquina, se desconectan las pestañas anteriores). |
| **Mesas** | `/mesas` | `/panel_mesa.html` | Estado de ventanillas (`activa`, `inactiva`, `pausada`), asignación de operadores, indicador de conexión WebSocket en vivo y conmutación de pausas. |
| **Turnos** | `/turnos` | `/panel_mesa.html` | Consola del operador: botón único *"Llamar Siguiente"*, cronómetro de atención en vivo, re-llamado (*"Segundo Aviso"*), descarte (*"No se presentó"*) y atención de turnos rezagados. |
| **Lotes de Vouchers** | `/lotes` | `/admin.html` | Control multi-día de correlativos de papel. Permite crear nuevos lotes, pausar al cierre de jornada, cerrar definitivamente y **extender el número hasta en caliente** sin interrumpir la atención. |
| **Pantalla TV** | `/ws` (Canal `tv:global`) | `/tv.html` | Display pasivo 1080p para auditorio. Exhibe el último llamado en tamaño colosal (legible a más de 5 metros), historial de últimos 4 llamados, reloj sincronizado, campana y síntesis de voz. Banner animado ante pérdida de señal (nunca pantalla en blanco). |
| **Administración** | `/admin` | `/admin.html` | Dashboard con KPIs en tiempo real (turnos atendidos, tiempo medio, mesas activas, vouchers restantes), tabla de rendimiento con semáforo de eficiencia, CRUD de usuarios, ajuste de parámetros y exportación de reportes CSV. |
| **Kiosko Digital** | `/kiosko` | `/kiosko.html` | Emisión táctil asistida en tablet o autoservicio móvil mediante escaneo de Cartel QR, con estimación de espera, seguimiento en vivo e impresión térmica de red ESC/POS. |
| **WebSocket Hub** | `/ws` | `ws-client.js` | Conexión bidireccional push con canales aislados (`tv:global`, `mesa:<id>`, `admin:all`, `kiosko:<token>`), latidos ping/pong cada 30 segundos y control de desconexión silenciosa. |

---

## 🎟 Flujo Operativo: Las 3 Modalidades de Emisión

Desde **Admin → Configuración → Flujo de Emisión de Turnos**, el sistema permite alternar entre 3 modalidades institucionales según la infraestructura de la sede:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   MODALIDADES DE EMISIÓN DE TURNOS                     │
├───────────────────────┬───────────────────────┬────────────────────────┤
│  1. FÍSICO / TALONARIO │  2. ASISTIDO (TABLET) │ 3. ESTUDIANTIL (MÓVIL) │
│     (Predeterminado)  │    (Pulsador Entrada) │    (Autoservicio QR)   │
└───────────────────────┴───────────────────────┴────────────────────────┘
```

### Modalidad 1: Físico / Talonario (Predeterminado)
- **Cómo opera:** En el portón de acceso, el personal entrega al estudiante un **voucher de papel preimpreso** con un número correlativo (ej. Lote del 1 al 500). El sistema no emite tickets digitales.
- **En ventanillas:** El operador pulsa *"Llamar Siguiente"*. El sistema avanza el contador del lote activo de vouchers y la TV de auditorio anuncia el número para que el estudiante pase a la ventanilla correspondiente.
- **Fin de jornada:** El admin pausa el lote. Al día siguiente se reactiva continuando exactamente en el número siguiente (ej. 301).

### Modalidad 2: Asistido (Tablet / Pulsador en Recepción)
- **Cómo opera:** En la entrada se ubica un empleado o guardia con una tablet conectada a la red Wi-Fi del campus abierta en `/kiosko.html`.
- **Emisión en 1 toque:** Al presionar **"ASIGNAR SIGUIENTE TURNO"**, el sistema genera el turno digital correlativo.
- **Comprobante en pantalla e impresión térmica:** Muestra el comprobante con número gigante y código QR durante 15 segundos. Si hay una impresora térmica ESC/POS configurada en red, expulsa el ticket físico al instante.

### Modalidad 3: Estudiantil (Móvil / Autoservicio vía QR)
- **Cómo opera:** Se colocan carteles impresos en los pasillos con el código QR institucional (descargable desde el panel admin en 1 clic).
- **Toma de turno desde el celular:** El estudiante escanea el QR con la cámara de su teléfono inteligente y entra a `/kiosko.html` en la red local.
- **Seguimiento en vivo:** Al pulsar *"Tomar mi Turno"*, la pantalla del celular se transforma en un monitor personal de espera que indica: *"Tu turno es el #47 — 3 personas antes de ti — Espera estimada: 12 min"*.
- **Alerta vibratoria y sonora:** Cuando la ventanilla lo llama, el celular del estudiante emite un chime sonoro y vibra indicándole la ventanilla exacta a la que debe acudir.

---

## 🚀 Guía de Instalación y Despliegue

### A. Servidor de Producción / Linux (Recomendado con Docker)

#### Requisitos previos:
- Servidor Linux (Ubuntu 20.04+, Debian 11+, Rocky Linux) o VPS.
- Docker y Docker Compose instalados.

#### Pasos:
1. Clonar el repositorio:
   ```bash
   git clone https://github.com/AmsselFern10/Turnero.git
   cd Turnero
   ```
2. Ejecutar el instalador automatizado para Linux:
   ```bash
   bash install.sh
   ```
   *(El script prepara `.env`, genera secretos JWT seguros, levanta los contenedores con Docker Compose, espera a PostgreSQL, corre migraciones y seed inicial).*

3. Acceder al sistema en: `http://<IP-DEL-SERVIDOR>:3000`

---

### B. Servidor Central en Windows (Guía Paso a Paso para Red Local)

Esta guía permite usar una computadora común con Windows 10 u 11 como servidor central para todo el edificio o sede.

#### Paso 1: Asignar una IP Fija en Windows
Para evitar que el router cambie la dirección de la máquina al reiniciar:
1. Presiona `Win + R`, escribe `ncpa.cpl` y pulsa Enter (Conexiones de red).
2. Clic derecho en tu adaptador de red (**Ethernet** o **Wi-Fi**) → **Propiedades**.
3. Selecciona **Protocolo de Internet versión 4 (TCP/IPv4)** → **Propiedades**.
4. Selecciona *"Usar la siguiente dirección IP"* e ingresa una IP estática dentro del rango de tu red universitaria (ejemplo):
   - **Dirección IP:** `192.168.1.50`
   - **Máscara de subred:** `255.255.255.0`
   - **Puerta de enlace predeterminada:** `192.168.1.1`
   - **Servidor DNS:** `1.1.1.1` (o los DNS de la institución).
5. Guarda los cambios. Comprueba abriendo PowerShell y ejecutando `ipconfig`.

#### Paso 2: Configurar la IP LAN en el archivo `.env`
1. Abre el archivo `.env` del proyecto con el Bloc de Notas.
2. Localiza la variable `HOST_IP` y asigna la IP fija que configuraste:
   ```env
   HOST_IP=192.168.1.50
   ```
   *(Esto permite que los códigos QR y los celulares de los estudiantes apunten a la máquina correcta y no a localhost).*

#### Paso 3: Abrir el Puerto 3000 en el Firewall de Windows
Para que las demás PCs, tablets y teléfonos conectados al Wi-Fi puedan abrir las páginas:
1. Abre **PowerShell como Administrador** y ejecuta este comando de una sola línea:
   ```powershell
   New-NetFirewallRule -DisplayName "Turnero 2026 HTTP" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
   ```
   *(O hazlo manualmente en el Panel de Control → Firewall de Windows Defender → Reglas de Entrada → Nueva Regla → Puerto TCP 3000 → Permitir la conexión).*

#### Paso 4: Ejecutar el Instalador Automático
En PowerShell, ejecuta:
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```
El instalador:
- Configurará `.env` con claves criptográficas.
- Levantará los contenedores de Docker (o preparará Node.js nativo si no tienes Docker).
- Ejecutará las migraciones de base de datos y el seed inicial.
- **Configura auto-arranque:** El sistema se encenderá automáticamente ante reinicios de la PC.

#### Paso 5: Puntos de Acceso desde cualquier equipo de la red:
Reemplazando `192.168.1.50` por la IP fija de tu servidor:
- **Pantalla de TV (Auditorio):** `http://192.168.1.50:3000/tv.html`
- **Operadores de Ventanilla:** `http://192.168.1.50:3000/panel_mesa.html`
- **Panel Administrador:** `http://192.168.1.50:3000/admin.html`
- **Kiosko / Celular Estudiante:** `http://192.168.1.50:3000/kiosko.html`

---

### C. Modo Desarrollo (Hot-Reload con `iniciar_dev.bat`)

Si vas a programar o modificar archivos de `src/`:

1. Haz doble clic en **[`iniciar_dev.bat`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/iniciar_dev.bat)**.
2. El script levantará automáticamente PostgreSQL, Redis y pgBouncer en Docker en segundo plano, esperará a que respondan y arrancará **Nodemon** en tu terminal local.
3. Al editar cualquier archivo en `src/`, el servidor se reiniciará en caliente automáticamente.
4. Para apagar la base de datos y Redis al terminar, haz doble clic en **`detener_sistema.bat`**.

---

## ⚙️ Configuración desde el Panel de Administración

El sistema almacena 24 parámetros en la tabla `configuracion` de PostgreSQL, editables en caliente sin reiniciar el servidor desde **Admin → Configuración**:

| # | Clave de Configuración | Valor Predeterminado | Qué Hace y Cómo Afecta al Sistema |
|:---:|---|:---:|---|
| **1** | `modo_generacion_turnos` | `voucher_fisico` | Define la modalidad general del sistema: `voucher_fisico` (talonario de papel tradicional) o `kiosko_web` (emisión digital por tablet/celular). |
| **2** | `kiosko_web_activo` | `false` | Habilita o bloquea el acceso a la toma de turnos digitales desde `/kiosko.html`. Si está en `false`, el Kiosko muestra aviso de fuera de servicio. |
| **3** | `kiosko_modo_uso` | `asistido` | Alterna el comportamiento de `/kiosko.html`: `asistido` (pantalla táctil para empleado con botón de emisión rápida) o `estudiante` (vista para escaneo de cartel QR en celular). |
| **4** | `alerta_vouchers_restantes` | `20` | Umbral de aviso: cuando en el lote activo queden menos de esta cantidad de vouchers, se emite una alerta roja por WebSocket en la consola de administración. |
| **5** | `kiosko_tope_diario` | `0` | Límite diario de turnos digitales emitibles por el Kiosko (`0` = ilimitado). Evita sobre-emisión si hay cupos restringidos de atención. |
| **6** | `mostrar_estimado_espera` | `true` | Muestra u oculta el cálculo de tiempo estimado de espera en la pantalla de TV y en el seguimiento móvil del estudiante. |
| **7** | `zona_horaria` | `America/Tegucigalpa` | Zona horaria oficial para el registro de auditoría, cronómetros y cortes diarios de atención. |
| **8** | `kiosko_url_base` | *(vacío)* | Dirección IP/URL de la red local para el Cartel QR. Si se deja vacía, el servidor la detecta automáticamente usando la IP del host. |
| **9** | `kiosko_url_publica` | *(vacío)* | URL pública opcional (ej. túnel Cloudflare o VPS) si se permite que estudiantes consulten su turno fuera del campus. |
| **10** | `kiosko_impresion_automatica`| `false` | Si es `true`, al emitir un turno en modo tablet asistido envía la orden de impresión térmica a la impresora LAN de inmediato. |
| **11** | `voz_anuncio_activa` | `true` | Activa la síntesis de voz en la pantalla de TV del auditorio para pronunciar: *"Turno X, Mesa Y"*. |
| **12** | `impresora_activa` | `false` | Activa la conexión de impresión física con impresoras térmicas de tickets. |
| **13** | `impresora_ip` | *(vacío)* | Dirección IP de la impresora térmica en la red local (ej. `192.168.1.200`). |
| **14** | `impresora_puerto` | `9100` | Puerto TCP estándar para impresoras térmicas de red mediante protocolo RAW/ESC-POS. |
| **15** | `impresora_canal` | `directa` | Canal de impresión: `directa` (conexión TCP directa por socket), `sistema` (cuadro de impresión del navegador) o `bluetooth`. |
| **16** | `impresora_ancho_papel` | `58` | Ancho de la bobina de papel térmico: `58` mm (32 columnas) o `80` mm (48 columnas). |
| **17** | `tv_escala_turnos` | `100` | Escala porcentual global para ajustar tipografías en televisores de distintos tamaños (75% a 140%). |
| **18** | `tv_escala_principal` | `100` | Tamaño específico del número de turno principal llamado en pantalla TV (permite agrandarlo para auditorios gigantes). |
| **19** | `tv_escala_secundaria` | `100` | Tamaño de las 4 tarjetas del historial lateral de llamados previos en la TV. |
| **20** | `tv_opacidad_principal` | `100` | Nivel de opacidad (20 a 100%) del contenedor del turno actual en TV para permitir que luzca la imagen de fondo institucional. |
| **21** | `tv_opacidad_secundaria` | `100` | Nivel de opacidad (20 a 100%) de las tarjetas del historial en la TV. |
| **22** | `fondo_imagen_activa` | `false` | Activa o desactiva la visualización de una imagen de fondo institucional en las pantallas. |
| **23** | `fondo_imagen_url` | *(vacío)* | Ruta relativa o URL web de la fotografía o diseño institucional de fondo. |
| **24** | `fondo_imagen_escala` | `100` | Nivel de zoom/escala de la imagen de fondo en la TV (50% a 200%). |

---

## 🛠 Referencia de Comandos y Ejecutables

### 1. Archivos `.bat` (Scripts de Control para Windows)

Ejecutables con doble clic desde el Explorador de Archivos de Windows:

- **[`iniciar_sistema.bat`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/iniciar_sistema.bat):**  
  Inicio rápido de producción. Levanta todos los contenedores Docker en segundo plano con política de auto-reinicio, espera hasta 60s a que el endpoint `/health` responda HTTP 200 y presenta los enlaces de acceso listos para uso.
- **[`iniciar_dev.bat`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/iniciar_dev.bat):**  
  Inicio para programadores. Levanta solo PostgreSQL, Redis y pgBouncer en Docker y lanza **Nodemon** en la terminal con recarga en vivo de código.
- **[`detener_sistema.bat`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/detener_sistema.bat):**  
  Apagado total seguro. Detiene contenedores Docker (`docker compose down`), procesos PM2, libera forzosamente el puerto 3000, finaliza procesos `node.exe` residuales y elimina accesos de auto-arranque en Windows.
- **[`actualizar_sistema.bat`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/actualizar_sistema.bat):**  
  Actualizador de versiones. Ejecuta `git stash` preventivo si hay cambios locales, descarga la última versión con `git pull origin main`, detiene la versión vieja, reconstruye imágenes (`docker compose up -d --build`), verifica `/health` y deja el sistema actualizado en línea.

---

### 2. Scripts PowerShell `.ps1` (Automatización Windows)

Ejecutar desde PowerShell (`powershell -ExecutionPolicy Bypass -File <script>`):

- **[`install.ps1`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/install.ps1):** Instalador autónomo completo para Windows con tolerancia total a fallos y fallback automático a Node.js nativo si Docker no está instalado.
- **[`scripts/backup.ps1`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/scripts/backup.ps1):** Genera un respaldo SQL completo de la base de datos con estructura, datos y sentencias `DROP IF EXISTS` en la carpeta `backups/`.
- **[`scripts/restore.ps1 <archivo.sql>`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/scripts/restore.ps1):** Restaura un respaldo SQL limpiando previamente el schema public para evitar colisiones de llaves primarias o triggers.
- **[`scripts/reset.ps1 -Force`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/scripts/reset.ps1):** Limpia y reinicia la base de datos al estado inicial de fábrica (elimina turnos de prueba y recarga el seed).

---

### 3. Scripts Bash `.sh` (Servidores Linux / macOS / WSL)

Ejecutar desde la terminal Bash (`bash <script>`):

- **[`install.sh`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/install.sh):** Instalador para servidores Linux. Configura variables, Docker, base de datos y verifica salud del servicio.
- **[`scripts/backup.sh`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/scripts/backup.sh):** Realiza un volcado `pg_dump` con compresión limpia en `backups/`.
- **[`scripts/restore.sh <archivo.sql>`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/scripts/restore.sh):** Restaura un volcado SQL en PostgreSQL.
- **[`scripts/reset.sh --yes`](file:///c:/Users/windows%2010%20pro/Downloads/Turnero/scripts/reset.sh):** Reseteo rápido de datos de prueba a estado de fábrica.

---

### 4. Comandos `npm` (Gestión del Proyecto)

- `npm run dev`: Inicia el servidor con Nodemon (vigila cambios en `src/` y reinicia al guardar).
- `npm start`: Inicia el servidor Node.js en modo producción directo.
- `npm run build:css`: Precompila el CSS de Tailwind optimizado y minificado en `src/public/css/tailwind.css`.
- `npm run watch:css`: Compila Tailwind en modo escucha para desarrollo frontend.
- `npm run test:suite`: Ejecuta la suite completa de 27 pruebas de integración del sistema.
- `npm run test:bd`: Ejecuta las pruebas de base de datos e invariantes SQL (7 suites).
- `npm run test:rt`: Ejecuta las pruebas de tiempo real, WebSockets, pgBouncer y sesiones (4 suites críticas).

---

### 5. Scripts de Utilidad Node.js (`scripts/`)

- `node scripts/seed.js`: Puebla la base de datos con usuarios administradores (`admin` / `soporte`, `admin2`), 5 operadores de ventanilla (`op1` a `op5`), 10 mesas iniciales y el Lote 1 de vouchers (1 a 500).
- `node scripts/init_config.js`: Sincroniza y repara las 24 claves de configuración en PostgreSQL sin alterar las existentes.
- `node scripts/recrear_desde_cero.js`: Reconstruye el schema completo de PostgreSQL aplicando las migraciones versionadas `001` a `004` en orden estricto.
- `node scripts/run_migration.js <archivo.sql>`: Aplica una migración SQL individual y muestra el resultado en consola.
- `node scripts/reset.js`: Trunca las tablas operativas de turnos conservando usuarios y configuración intactos.

---

## 🔒 Credenciales de Acceso Iniciales (Seed)

| Rol | Usuario | Contraseña | Permisos |
|---|---|---|---|
| **Administrador 1** | `admin` | `soporte` | Acceso total: KPIs, lotes, mesas, usuarios, configuración y auditoría. |
| **Administrador 2** | `admin2` | `soporte` | Administrador secundario de respaldo. |
| **Operadores** | `op1` a `op5` | `Operador2026!` | Acceso a consola de ventanilla para llamar, atender y pausar su mesa. |

---

*Turnero de Matrículas 2026 · Versión 2.1 Institucional · Código modular, desacoplado y resiliente.*
