# Turnero de Matriculas 2026

Sistema digital de gestion de turnos en tiempo real para procesos masivos de atencion presencial — matriculas, pagos, inscripciones y validacion de documentos.

---

## Que problemas resuelve

En jornadas masivas de atencion presencial, cientos de personas acuden simultaneamente y multiples mesas de atencion trabajan en paralelo. Se encontraron los siguientes desafios tecnicos criticos:

---

### 1. Dos operadores llaman el mismo numero (Race Condition)

**El problema:** Si 10 operadores presionan "Llamar Siguiente" en la misma fraccion de segundo, todos podrian leer el mismo contador en la base de datos y asignar el mismo voucher a distintos estudiantes.

**Como lo resuelve el Turnero:**
Toda la operacion de llamado se ejecuta en **1 sola transaccion atomica** en PostgreSQL mediante la funcion almacenada `fn_llamar_siguiente()`:
1. Aplica un bloqueo exclusivo a nivel de fila (`SELECT ... FOR UPDATE`) sobre el lote activo de vouchers.
2. Mientras la Mesa 1 tiene el bloqueo (tarda menos de 4 ms), las demas mesas esperan en cola en la base de datos.
3. Lee el contador, le suma 1, actualiza `lotes_voucher`, finaliza el turno anterior de la mesa (`atendido`) e inserta el nuevo turno en `turnos` en estado `en_atencion`.
4. Libera el bloqueo. La Ventanilla 2 entra inmediatamente y lee el contador ya incrementado.

> **Garantia:** Aunque 20 mesas presionen en el mismo milisegundo, obtienen 20 numeros consecutivos, sin saltos ni duplicados.

---

### 2. El sistema se cae con muchas consultas simultaneas (Pool pgBouncer)

**El problema:** PostgreSQL asigna un proceso independiente del sistema operativo a cada conexion (consumiendo 5 a 10 MB de RAM por conexion). Si 20 mesas, 4 TVs, el panel de admin y decenas de celulares consultan la base de datos al mismo tiempo, el servidor se satura rapidamente, agota la memoria RAM y comienza a rechazar peticiones.

**Como lo resuelve el Turnero:**
Se interpone un pooler de conexiones llamado **pgBouncer** entre Fastify y PostgreSQL, configurado en modo transaccional (`POOL_MODE: transaction`):

```
Decenas de mesas + TVs + Dispositivos
                 ↓
     Fastify (Node.js 20 LTS)
                 ↓
   pgBouncer (Pool de conexiones)
                 ↓
  PostgreSQL 15 ← Maximo 10 conexiones reales
```

- Los clientes (mesas, TV, admin, kioscos) se comunican con Fastify a traves de hasta 100 conexiones ligeras.
- Fastify solo toma una de las **10 conexiones reales** de PostgreSQL durante los milisegundos que dura la transaccion activa.
- Apenas ocurre el `COMMIT`, la conexion real regresa al pool para la siguiente consulta. La base de datos opera relajada con consumo minimo de memoria.

---

### 3. Varios turnos queriendo mostrarse en la TV al mismo tiempo (Cola FIFO)

**El problema:** Si 3 ventanillas llaman a sus respectivos estudiantes en el mismo segundo, los eventos llegan a la pantalla casi al unisono. Si se procesaran sin control, el turno 48 pisaria al 47 antes de que nadie pudiera leerlo o escucharlo.

**Como lo resuelve el Turnero:**
La pantalla publica (`tv.js`) implementa una **maquina de estados con Cola FIFO (First In, First Out)** secuencial:
1. Cada turno recibido por WebSocket trae un numero de secuencia incremental (`seq`).
2. Si la TV esta anunciando un turno, los nuevos llamados entrantes se guardan en la cola interna sin perderse ni sobreescribirse.
3. Cada turno en pantalla respeta un tiempo minimo de exposicion visual y locucion por voz antes de dar paso al siguiente.
4. Si un operador realiza un **Re-llamado ("Segundo Aviso")**, este tiene prioridad especial sin alterar el orden del historial ni el contador principal.
5. Cuenta con un **watchdog de seguridad (12s)**: si el navegador experimenta algun retraso de audio, el temporizador destraba la cola automaticamente.

---

### 4. Caida o desconexion del sistema (Reconexion + Backoff con Jitter + Snapshot)

**El problema:** Si el cable de red se desconecta, se reinicia el router o el servidor se reinicia, 50 pantallas intentaran reconectarse al mismo segundo exacto. Esto produce el llamado *"Efecto Manada"* (Thundering Herd), saturando y botando el servidor en cuanto intenta levantarse.

**Como lo resuelve el Turnero:**
El cliente de tiempo real (`ws-client.js`) implementa un protocolo de recuperacion autonoma de grado industrial:
1. **Backoff Exponencial con Full Jitter:** Cada intento fallido duplica el tiempo de espera base, pero anade un factor aleatorio (`delay = random(500, min(maxDelay, base * 2^intentos))`). Esto dispersa los intentos en el tiempo y evita que los clientes golpeen al servidor a la vez.
2. **Latido Simetrico (Heartbeat):** Envia un ping/pong cada 30 segundos. Si pasan 60 segundos sin actividad en la red (corte silencioso sin error formal de socket), el cliente reinicia la conexion proactivamente.
3. **Snapshot de Sincronizacion:** Al reconectar, la pantalla no recarga el navegador (lo que causaria parpadeos o perdida de estado del operador). En su lugar, solicita un `snapshot` en memoria que actualiza inmediatamente el turno actual y el historial reciente.

---

### 5. Comunicacion en tiempo real (WebSockets + Broadcast vs. Polling)

**El problema:** El enfoque tradicional de consultar la API cada 2 segundos (*HTTP Polling*) desde 30 dispositivos genera cientos de peticiones por minuto innecesarias, saturando el ancho de banda de la red local y consumiendo ciclos de CPU en el servidor.

**Como lo resuelve el Turnero:**
Se utiliza comunicacion bidireccional basada en **WebSockets (`@fastify/websocket`)** con arquitectura Push:
- La conexion se mantiene abierta con sobrecarga minima (un solo handshake TCP inicial).
- Cuando un operador presiona "Llamar Siguiente", el servidor difunde el mensaje en menos de 10 milisegundos directamente a los clientes suscritos.
- **Canales segmentados y seguros:**
  * `tv:global`: Transmision publica para las pantallas de auditorio.
  * `mesa:<id>`: Canal privado de cada mesa (con proteccion anti-IDOR: un operador no puede espiar otra mesa).
  * `admin:all`: Canal de supervision con KPIs en tiempo real y alertas de lote bajo.
  * `kiosko:<token>`: Canal privado de seguimiento para el celular del estudiante.
- Internamente, Fastify se apoya en **Redis 7 Pub/Sub**, permitiendo escalar horizontalmente a multiples servidores si fuera necesario sin perder la sincronizacion.

---

### 6. Doble clic y peticiones repetidas (Idempotencia en Ventanilla y Kiosko)

**El problema:** Un operador ansioso puede presionar dos veces rapidamente el boton "Llamar Siguiente", o un estudiante en una pantalla tactil puede pulsar dos veces "Tomar Turno", provocando que se salten numeros o se impriman vouchers gemelos por error.

**Como lo resuelve el Turnero:**
El sistema implementa garantias de **Idempotencia** en los dos puntos criticos:
1. **En Mesa de Atencion (Ventana de 1.5 segundos):** Si el operador presiona el boton en un intervalo menor a 1.5 segundos desde su ultimo llamado, la funcion de base de datos detecta el turno en curso y devuelve exactamente el mismo registro sin avanzar el contador de vouchers y sin registrar un nuevo llamado (retorna la bandera `es_idempotente: true`).
2. **En Kiosko y Celulares (`Idempotency-Key`):** Cada solicitud de generacion de turno incluye una clave unica generada en el dispositivo. Si la peticion se envia dos veces debido a una reconexion de red o un doble toque, el servidor detecta la clave y responde con el turno ya generado, evitando generar duplicados.

---

### 7. Anuncio audiovisual coordinado (Voz sintetica + Campana con fallback offline)

**El problema:** Los navegadores en redes locales sin salida a internet no pueden usar servicios de voz en la nube (Google Cloud TTS, AWS Polly), y si el archivo de audio institucional no carga, la pantalla quedaria muda. Ademas, si dos turnos suenan a la vez, las voces se superpondrian haciendose ininteligibles.

**Como lo resuelve el Turnero:**
La pantalla cuenta con un motor de audio hibrido que opera 100% desconectado de internet:
1. **Campana Institucional (Chime):** Intenta reproducir `/assets/audio/bell.mp3`. Si el archivo no estuviera disponible, utiliza la **Web Audio API** nativa del navegador para sintetizar en vivo un doble tono armonizado institucional (Do5 a 523.25 Hz + Mi5 a 659.25 Hz) mediante osciladores senoidales puros.
2. **Sintesis de Voz Local (Web Speech API):** Al terminar la campana, el navegador pronuncia verbalmente `"Turno 47, Mesa 3"` utilizando las voces locales en espanol instaladas en el sistema operativo.
3. **Prevencion de Garbage Collection:** Mantiene una referencia en memoria global (`_activeUtterance`) para evitar un error conocido en el motor V8 de Google Chrome, donde la voz se cancelaba abruptamente a mitad de la frase al ser limpiada por el recolector de basura.

---

> 📘 **Documentacion Tecnica Detallada:**  
> ¿Deseas profundizar en las consultas SQL exactas, la explicacion linea por linea de `fn_llamar_siguiente`, el funcionamiento interno de pgBouncer y por que se eligio cada tecnologia?  
> Consulta la guia completa explicada paso a paso: **[ARQUITECTURA_TECNICA.md](ARQUITECTURA_TECNICA.md)**.

---

## Modulos principales

| Modulo | Que hace |
|---|---|
| **Panel del Operador** (`/panel_mesa`) | El operador presiona un solo boton: "LLAMAR SIGUIENTE". El sistema finaliza el turno anterior, asigna el proximo numero y lo transmite a todas las pantallas en menos de 20ms. |
| **Pantalla TV** (`/tv`) | Display pasivo para TV de auditorio. Muestra el turno llamado en texto gigante (legible a 5 metros), historial de los ultimos 4 llamados y reloj en vivo. Nunca queda en blanco — si pierde conexion muestra un banner de "Reconectando" sin borrar los datos. |
| **Panel Admin** (`/admin`) | Dashboard con metricas en tiempo real: turnos atendidos, tiempo promedio, mesas activas, vouchers restantes. Gestiona lotes de vouchers, mesas, usuarios y configuracion del sistema. |
| **Kiosko Digital** (`/kiosko`) | Opcional. Permite que personal de recepcion asigne turnos desde una tablet, o que la persona tome su turno desde su celular escaneando un QR. Incluye seguimiento en vivo de posicion en cola. |
| **Lotes de Vouchers** | El admin crea un lote (ej: 1 al 500) antes de abrir. Los operadores van llamando en orden. El admin puede extender el lote en caliente si se acaban los vouchers fisicos, sin reiniciar ni perder el progreso. |

---

## Flujo principal de un dia tipico

```
ANTES DE ABRIR
  Admin crea el lote del dia (ej: vouchers 1-500) y activa las mesas

LLEGADA DE PERSONAS
  Personal de recepcion entrega vouchers fisicos numerados en papel

EN MESAS DE ATENCION
  Operador presiona "LLAMAR SIGUIENTE"
    → El sistema asigna el proximo numero de forma atomica
    → La TV muestra "Turno 47 → Mesa 3" en menos de 1 segundo
    → El estudiante con el celular recibe el aviso

  Si el estudiante no llega:
    Operador presiona "No se presento" → se cancela y pasa al siguiente

AL FINALIZAR EL DIA
  Admin pausa el lote si continuara al dia siguiente
  O cierra el lote y crea uno nuevo para la proxima jornada
```

---

## Instalacion y puesta en marcha

### Requisitos

- Docker Desktop (Windows/Mac) o Docker + Docker Compose (Linux)
- Node.js 20+ (solo si vas a desarrollar sin Docker)

### Levantar el sistema

#### Opcion 1: Instalacion automatica (Recomendado)

El sistema incluye instaladores automatizados que verifican el entorno, crean el archivo `.env` de forma segura (omitiendolo si ya existe para preservar configuraciones previas), aplican las migraciones de base de datos, compilan estilos y levantan todos los servicios:

**En Linux / macOS:**
```bash
bash install.sh
```

**En Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

---

#### Opcion 2: Despliegue manual con Docker Compose

**1. Clona el repositorio y entra a la carpeta**
```bash
git clone <url-del-repo>
cd Turnero
```

**2. Crea el archivo de variables de entorno**
```bash
# Solo si no existe ya un .env configurado:
cp .env.example .env
# Edita .env y cambia las contrasenas (DB_PASSWORD, JWT_SECRET, etc.)
```

**3. Levanta todos los servicios con un solo comando**
```bash
docker compose up -d --build
```

Esto levanta automaticamente: PostgreSQL, Redis, pgBouncer y la aplicacion Node.js.
La base de datos se inicializa sola ejecutando secuencialmente las migraciones de `./migrations` (001 a 007).

**4. Poblar datos iniciales y usuario administrador**
```bash
docker compose exec app node scripts/seed.js
```

**5. Abre el navegador**
```
http://localhost:3000
```


### Detener el sistema

```bash
docker compose down          # Detiene los contenedores (los datos se conservan)
docker compose down -v       # Detiene Y borra la base de datos (irreversible)
```

---

## Despliegue en Windows — dejar corriendo y accesible en la red

Esta seccion es para instalar el sistema en un equipo Windows que servira como servidor durante la jornada de matricula, de modo que todos los dispositivos conectados al mismo WiFi puedan acceder.

### Paso 1 — Asignar IP fija al servidor en Windows

Para que los demas dispositivos siempre encuentren el servidor en la misma direccion:

1. Abre **Configuracion → Red e Internet → Wi-Fi** (o Ethernet si usas cable).
2. Haz clic en la red conectada → **Propiedades**.
3. Edita **Configuracion de IP** y cambia de "Automatico (DHCP)" a **Manual**.
4. Ingresa una IP libre en tu red, por ejemplo:
   - Direccion IP: `192.168.1.50`
   - Longitud de prefijo: `24`
   - Puerta de enlace: `192.168.1.1` (la IP de tu router)
   - DNS preferido: `8.8.8.8`
5. Guarda. Verifica abriendo `cmd` y ejecutando `ipconfig` — debe aparecer la IP que elegiste.

### Paso 2 — Abrir el puerto en el Firewall de Windows

Por defecto Windows bloquea conexiones entrantes. Abre el puerto 3000:

1. Busca "Firewall de Windows Defender" en el menu de inicio.
2. Haz clic en **Configuracion avanzada → Reglas de entrada → Nueva regla**.
3. Tipo: **Puerto** → TCP → Puerto especifico: `3000`.
4. Accion: **Permitir la conexion**.
5. Perfil: marca **Dominio** y **Privado**.
6. Nombre: `Turnero App`.
7. Finalizar.

### Paso 3 — Configurar Docker para arrancar automaticamente

1. Abre **Docker Desktop**.
2. Ve a **Settings (engranaje) → General**.
3. Activa **"Start Docker Desktop when you log in"**.
4. Aplica y reinicia Docker.

Con esto, cada vez que el equipo se encienda, Docker arrancara solo — y como el `docker-compose.yml` tiene `restart: unless-stopped`, todos los contenedores (base de datos, Redis, app) levantaran automaticamente sin que nadie tenga que hacer nada.

### Paso 4 — Iniciar el sistema

Tienes dos formas de hacerlo:

#### Si usas el instalador automático (Recomendado):
En PowerShell ejecuta:
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```
> **Nota:** ¡Listo! Si ejecutas este comando, **no tienes que hacer nada más**. El script crea el `.env` de forma segura (omitiéndolo si ya existe), compila, levanta Docker y ejecuta el `seed` por ti.

#### Si prefieres hacerlo de forma manual:
Abre PowerShell o CMD en la carpeta del proyecto y ejecuta:
```bash
docker compose up -d --build
docker compose exec app node scripts/seed.js   # Solo la primera vez — crea el usuario admin
```

De ahí en adelante, el sistema arranca solo al encender el equipo.

### Paso 5 — Conectar los demas dispositivos

Desde cualquier dispositivo en la misma red WiFi, ingresa en el navegador:

```
http://192.168.1.50:3000
```

(reemplaza `192.168.1.50` con la IP fija que asignaste en el Paso 1)

| Dispositivo | URL de acceso | Que abre |
|---|---|---|
| PC operador | `http://192.168.1.50:3000` | Login → seleccion de mesa |
| TV auditorio | `http://192.168.1.50:3000/tv.html` | Pantalla publica |
| Tablet recepcion | `http://192.168.1.50:3000/kiosko.html?modo=tablet` | Kiosko digital |
| Celular estudiante | `http://192.168.1.50:3000/kiosko.html` | Seguimiento de turno |
| Panel admin | `http://192.168.1.50:3000/admin.html` | Administracion |

> Si el WiFi del campus asigna IPs automaticas, el router suele tener una opcion de "reserva de IP por MAC" — puedes pedirle al area de TI que asigne siempre la misma IP al servidor sin necesidad de configurarla manualmente en Windows.


Si prefieres correr la app directamente en tu maquina mientras Docker gestiona la BD:

```bash
# Levanta solo la base de datos y Redis
docker compose up -d db redis pgbouncer

# Instala dependencias de Node
npm install

# Compila el CSS de Tailwind
npm run build:css

# Arranca el servidor con hot-reload
npm run dev
```

---

## Produccion

En un servidor Linux, el sistema arranca automaticamente al encender la maquina porque Docker tiene configurado `restart: unless-stopped`. Solo necesitas:

```bash
docker compose up -d
```

Para configurar arranque automatico de Docker al iniciar el servidor:
```bash
sudo systemctl enable docker
```

---

## Configuracion desde el panel admin

Una vez corriendo, toda la configuracion operativa se maneja desde **Admin → Configuracion**:

- **Alerta de lote bajo**: cuantos vouchers restantes antes de notificar al admin
- **Voz de anuncio en TV**: activa o desactiva la voz sintetica al llamar un turno
- **Kiosko Digital**: toggle unico que activa el modo de turnos digitales e incluye:
  - Limite diario de turnos
  - Modo de uso (personal de recepcion vs. autoservicio desde dispositivo propio)
  - IP y puerto de la impresora termica de tickets en la red local

---

## Estructura del proyecto

```
src/
├── modules/         Logica del servidor (rutas, servicios, autenticacion)
│   ├── auth/        Login, JWT, refresh token
│   ├── turnos/      Llamar siguiente, cancelar, historial
│   ├── lotes/       Crear, activar, pausar, extender lotes de vouchers
│   ├── mesas/       Gestion de mesas de atencion
│   ├── admin/       KPIs, usuarios, configuracion, reportes CSV
│   ├── kiosko/      Turnos digitales, impresion ESC/POS, seguimiento por QR
│   └── ws/          WebSocket hub — transmision en tiempo real
│
└── public/          Interfaces web (HTML + JS + CSS)
    ├── index.html        Login y seleccion de mesa
    ├── panel_mesa.html   Consola del operador
    ├── tv.html           Pantalla publica de auditorio
    ├── admin.html        Panel de administracion
    └── kiosko.html       Kiosko digital / autoservicio
```

---

## Stack tecnologico

| Capa | Tecnologia |
|---|---|
| Servidor | Node.js 20 + Fastify 4 |
| Base de datos | PostgreSQL 15 |
| Pool de conexiones | pgBouncer |
| Cache y mensajeria | Redis 7 |
| Tiempo real | WebSocket (`@fastify/websocket`) |
| Frontend | HTML5 + Tailwind CSS 3 + Alpine.js v3 |
| Contenedores | Docker Compose |

---

Turnero de Matriculas 2026 · v2.1
