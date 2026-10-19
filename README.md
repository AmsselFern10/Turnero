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

## Flujo operativo del sistema

### Flujo general de una jornada típica

```text
ANTES DE ABRIR
  Admin crea el lote del día (ej: vouchers 1-500) y activa las mesas de atención

LLEGADA DE ESTUDIANTES (Según la modalidad configurada):
  • Modo Físico: Personal de recepción entrega papel preimpreso numerado.
  • Modo Asistido: Empleado en portón con tablet asigna el turno e imprime el ticket al instante.
  • Modo Estudiante: El estudiante escanea el Cartel QR con su celular y toma su turno digital.

EN VENTANILLAS DE ATENCIÓN
  Operador presiona "LLAMAR SIGUIENTE"
    → Transacción atómica: finaliza el turno previo e incrementa el contador de vouchers.
    → La TV del auditorio muestra "Turno 47 → Mesa 3" con voz sintetizada y campana en < 20ms.
    → El estudiante con celular recibe alerta sonora y vibración indicándole su ventanilla.

  Si el estudiante no se presenta:
    Operador presiona "No se presentó" → el turno se cancela y se pasa al siguiente de inmediato.

AL FINALIZAR LA JORNADA
  Admin pausa el lote si continuará mañana (conservando el correlativo).
  O cierra el lote definitivamente para comenzar uno nuevo desde el número 1.
```

---

### Flujos detallados del Kiosko Digital

El Kiosko Digital opera bajo dos modalidades exclusivas configurables desde **Admin → Configuración → Modalidad de Uso**:

#### 1. Modalidad Asistida (Consola de Recepción / Tablet de Portería)
Diseñada para que un empleado o guardia en la entrada emita turnos para los estudiantes:
1. **Acceso directo:** Al abrir el enlace `/kiosko.html` (local o ngrok), la tablet se identifica como consola de emisión con un botón prominente: **"ASIGNAR SIGUIENTE TURNO"**.
2. **Emisión en 1 solo clic:** Un toque asigna el siguiente voucher correlativo sin fricciones.
3. **Comprobante en pantalla durante 15 segundos:** Muestra el número asignado en tipografía gigante (ej. `#047`), código QR de seguimiento para el estudiante y una cuenta regresiva visual (`Vuelve a inicio en 15s`).
4. **Impresión térmica automática ESC/POS:** Si hay una impresora de red activa y configurada (`impresora_activa = true`), el comprobante físico se imprime de inmediato sin tocar nada más. Si la impresora está inactiva o apagada, la pantalla no se traba: muestra un aviso informativo y permite imprimir con el cuadro nativo del navegador como respaldo.
5. **Cadencia rápida:** El operador puede pulsar **"ASIGNAR SIGUIENTE"** en cualquier instante sin esperar a que terminen los 15 segundos.
6. **Seguridad:** Incluye un botón discreto **"Salir a Login"** en la cabecera para regresar a la pantalla de acceso del sistema cuando termine el turno del operador.

#### 2. Modalidad Estudiante (Autoservicio Móvil con Cartel QR)
Diseñada para que cada estudiante use su propio teléfono inteligente:
1. **Escaneo del Cartel QR:** El estudiante apunta la cámara de su celular al código QR exhibido en carteles impresos en el recinto (o ingresa al enlace público de ngrok).
2. **Toma de turno:** Presiona el botón táctil **"TOMAR MI TURNO"** desde su navegador móvil.
3. **Seguimiento en vivo (Push WebSocket):** Su pantalla pasa automáticamente a la vista de seguimiento personal sin recargar la página.
4. **Información continua:** Observa cuántas personas están antes que él (*"3 personas antes de ti"*), su posición exacta en cola y el tiempo estimado de espera.
5. **Alerta de atención inmediata:** Cuando un operador en ventanilla llama su turno, el celular vibra y reproduce un chime sonoro institucional indicándole: *"¡Es tu turno! Dirígete a la Mesa X"*.

---

## Guía de instalación y puesta en marcha

Puedes poner en marcha el sistema mediante cualquiera de las siguientes opciones:

### Opción A: Instalación Automática (Recomendada — 1 Clic)

El sistema incluye instaladores automatizados que verifican el entorno, preparan el archivo `.env` de forma segura (preservando valores existentes), compilan estilos, levantan Docker y ejecutan las migraciones y seed inicial:

* **En Windows (PowerShell):**
  ```powershell
  powershell -ExecutionPolicy Bypass -File install.ps1
  ```
  *(O ejecuta directamente haciendo doble clic sobre `install.bat` en el explorador).*

* **En Linux / macOS:**
  ```bash
  bash install.sh
  ```

---

### Opción B: Despliegue Manual con Docker Compose

Si prefieres realizar el proceso paso a paso:

1. **Clona el repositorio y entra a la carpeta:**
   ```bash
   git clone <url-del-repo>
   cd Turnero
   ```

2. **Crea el archivo de variables de entorno:**
   ```bash
   cp .env.example .env
   # Revisa las variables en .env (DB_PASSWORD, JWT_SECRET, etc.)
   ```

3. **Construye y levanta los servicios en segundo plano:**
   ```bash
   docker compose up -d --build
   ```
   *Esto levanta automáticamente: PostgreSQL 15, Redis 7, pgBouncer y la aplicación Fastify. La base de datos aplica automáticamente las migraciones versionadas de `./migrations`.*

4. **Poblar datos iniciales y usuario administrador (solo la primera vez):**
   ```bash
   docker compose exec app node scripts/seed.js
   ```

5. **Abre el sistema en el navegador:**
   ```text
   http://localhost:3000
   ```

#### Comandos útiles de Docker:
```bash
docker compose logs -f app      # Ver logs en vivo del servidor
docker compose down             # Detener contenedores (los datos se conservan intactos)
docker compose down -v          # Detener y borrar base de datos (irreversible)
```

---

### Opción C: Modo Desarrollo Rápido (Node.js local + BD en Docker)

Para desarrolladores que deseen modificar el código con recarga en vivo (hot-reload) sin empaquetar la app en Docker:

1. **Levanta únicamente los servicios de base de datos:**
   ```bash
   docker compose up -d db redis pgbouncer
   ```

2. **Instala dependencias locales:**
   ```bash
   npm install
   ```

3. **Compila los estilos CSS de Tailwind:**
   ```bash
   npm run build:css
   ```

4. **Inicia el servidor en modo desarrollo:**
   ```bash
   npm run dev
   ```

---

## Despliegue en red local (LAN) y configuración en Windows

Para instalar el Turnero en una PC con Windows que actúe como servidor central de la sede universitaria:

### 1. Asignar IP fija en Windows
Para que todas las ventanillas y pantallas siempre ubiquen al servidor en la misma dirección IP:
1. Abre **Configuración → Red e Internet → Wi-Fi** (o Ethernet).
2. Haz clic en la red conectada → **Propiedades**.
3. En **Configuración de IP**, cambia a **Manual (IPv4)** e ingresa los datos de tu red (ejemplo: `192.168.1.50`, máscara `255.255.255.0`, puerta de enlace `192.168.1.1`).
4. Abre una terminal `cmd` y comprueba con `ipconfig` que aparezca la IP configurada.

### 2. Abrir el puerto 3000 en el Firewall de Windows
Para que las demás PCs puedan conectarse:
1. Busca **"Firewall de Windows Defender con seguridad avanzada"**.
2. Selecciona **Reglas de entrada → Nueva regla**.
3. Tipo: **Puerto** → Protocolo: **TCP** → Puerto específico: **3000**.
4. Acción: **Permitir la conexión** → Perfiles: **Dominio** y **Privado**.
5. Nombre: `Turnero App` → Finalizar.

### 3. URLs de acceso desde cualquier equipo en la misma red Wi-Fi:

Reemplazando `192.168.1.50` por la IP fija de tu servidor:

| Dispositivo / Puesto | URL de acceso | Función |
|---|---|---|
| **Ventanilla / Operador** | `http://192.168.1.50:3000` | Acceso con usuario y selección de mesa |
| **TV del Auditorio** | `http://192.168.1.50:3000/tv.html` | Pantalla pública con reloj, historial y voz |
| **Tablet de Recepción** | `http://192.168.1.50:3000/kiosko.html` | Consola de asignación táctil asistida |
| **Celular del Estudiante** | `http://192.168.1.50:3000/kiosko.html` | Autoservicio y seguimiento en vivo de turno |
| **Panel de Administración** | `http://192.168.1.50:3000/admin.html` | Supervisión, lotes, métricas y reportes |

---

## Acceso remoto seguro y servicio Ngrok permanente

Para que los estudiantes puedan tomar y seguir su turno desde sus teléfonos usando datos móviles 4G/5G (sin estar conectados a la red Wi-Fi universitaria), el sistema integra un túnel seguro con dominio SSL reservado mediante **ngrok**.

### 1. Instalación de Ngrok como Servicio Nativo de Windows (Auto-arranque)
Para que el túnel esté **siempre activo**, arranque automáticamente cuando la computadora se encienda y se recupere solo ante caídas de internet sin ventanas de consola abiertas:

1. Ubica el archivo en la raíz del proyecto:
   ```text
   instalar_servicio_ngrok.bat
   ```
2. Haz **clic derecho** sobre él y elige **"Ejecutar como administrador"**.
3. El script registrará e iniciará el servicio nativo de Windows:
   ```cmd
   ngrok service install --config "%~dp0ngrok.yml"
   ngrok service start
   ```
   *El servicio queda registrado en `services.msc` con inicio automático (`Automatic`). Aunque se cierre la consola, se reinicie la app o se reinicie la PC, el enlace público permanece 100% disponible.*

### 2. Aviso de bienvenida gratuito de Ngrok (Visit Site)
En cuentas gratuitas de ngrok (`*.ngrok-free.dev`), la primera vez que un celular abre el enlace se muestra una pantalla preventiva de bienvenida (*"You are about to visit..."*):
- **Ocurre solo una vez por teléfono:** El alumno pulsa el botón azul **"Visit Site"** una sola vez. Safari/Chrome guardará una cookie en ese celular y nunca más la volverá a mostrar.
- **Sincronización API transparente:** El cliente frontend `api.js` del sistema envía automáticamente la cabecera `ngrok-skip-browser-warning: true` en todas las consultas en segundo plano y WebSockets, garantizando que el seguimiento en vivo funcione de inmediato sin interrupciones.

---

## Configuración desde el Panel de Administración

Toda la operativa del sistema se configura en vivo desde **Admin → Configuración**:

- **Pantalla TV y Anuncios:** Activar/desactivar locución de voz y ajustar de forma independiente los tamaños del turno principal y del historial de turnos.
- **Kiosko Digital y Autoservicio:** Activar/desactivar emisión digital, alternar entre Modalidad Asistida y Modalidad Estudiante, definir límite diario y generar el Cartel QR en alta resolución para impresión en 1 sola página.
- **Impresora Térmica LAN (ESC/POS):** Habilitar/deshabilitar envío de comprobantes por red, configurar IP/puerto (9100) y realizar impresiones de prueba (#000).
- **Fondo Institucional:** Personalizar el fondo de pantalla en vivo mediante URL o subiendo imágenes directamente desde la PC.
- **Plan B (Contingencia):** Ajustar en caliente el contador del lote o los tiempos promedio si ocurre un cambio operativo no planificado.

---

## Estructura del proyecto

```text
src/
├── modules/         Lógica de negocio del servidor (Fastify)
│   ├── auth/        Autenticación JWT, cookies HttpOnly, roles y sesiones
│   ├── turnos/      Llamar siguiente, finalizar, cancelar, historial y métricas
│   ├── lotes/       Gestión de lotes de vouchers (crear, pausar, extender, cerrar)
│   ├── mesas/       Gestión de ventanillas y asignación dinámica de operadores
│   ├── admin/       KPIs en tiempo real, gestión de usuarios, auditoría y reportes Excel
│   ├── kiosko/      Emisión digital, seguimiento, impresión LAN ESC/POS y carteles QR
│   └── ws/          Hub de WebSockets con canales segmentados y latidos ping/pong
│
└── public/          Frontend desacoplado (HTML5 + Tailwind CSS + Alpine.js)
    ├── index.html        Pantalla de acceso y selección de mesa
    ├── panel_mesa.html   Consola ergonómica de ventanilla del operador
    ├── tv.html           Pantalla pública para auditorio Full HD 1080p
    ├── admin.html        Panel central de administración y supervisión
    └── kiosko.html       Kiosko táctil (asistido para tablet / autoservicio para smartphone)
```

---

## Stack tecnológico

| Capa | Tecnología | Propósito |
|---|---|---|
| **Servidor backend** | Node.js 20 LTS + Fastify 4.x | Alto rendimiento (~70,000 req/s) con overhead mínimo |
| **Tiempo real** | WebSocket (`@fastify/websocket`) | Comunicación bidireccional push de baja latencia (< 10ms) |
| **Base de datos** | PostgreSQL 15 | Transacciones ACID atómicas con bloqueos de fila (`FOR UPDATE`) |
| **Pool de conexiones** | pgBouncer | Límite estricto de conexiones reales para evitar saturación de RAM |
| **Caché y mensajería** | Redis 7 | Caché en RAM < 1ms y difusión Pub/Sub entre instancias |
| **Frontend** | HTML5 Semántico + Tailwind CSS 3 + Alpine.js v3 | Interfaz reactiva ultraligera (< 40KB) sin build steps pesados |
| **Acceso Remoto / Túnel** | **ngrok** (Servicio Nativo Windows) | Enlace seguro SSL con auto-arranque para celulares y tablets remotas |
| **Contenedores** | Docker Compose | Despliegue reproducible con un solo comando en cualquier OS |

---

Turnero de Matrículas 2026 · v2.1
