---
trigger: always_on
description: Arquitectura Frontend y Organización Modular de src/public/
---

---
trigger: always_on
description: Arquitectura Frontend y Organización Modular de src/public/
---

# 🏛️ Arquitectura Frontend y Organización Modular — Turnero 2026 (v2.1)
> **Tipo:** Regla de Desarrollo Frontend & Estructura de Directorios  
> **Ámbito:** `src/public/`, capas de presentación, lógica y recursos estáticos  
> **Alineación:** Complementa `general.md`, `modules.md`, `requirements.md` y `ui-design.md`

---

## 1. Estructura Oficial de Directorios (`src/public/`)

Para garantizar código desacoplado, mantenible y de alto rendimiento en redes locales universitarias (LAN), todo el frontend debe organizarse bajo la siguiente jerarquía estricta:

```text
src/public/
│
├── css/                           ──► CAPA DE ESTILOS Y TOKENS VISUALES
│   ├── base.css                   (Tokens visuales, fondo #EEF2F6, variables CSS, fuentes Inter y JetBrains Mono)
│   └── animations.css             (Keyframes de pulsos, glow de atención, transiciones y badges de estado)
│
├── js/                            ──► CAPA DE LÓGICA Y TIEMPO REAL
│   ├── api.js                     (Cliente HTTP fetch centralizado: interceptor JWT, refresh token y manejo de errores)
│   ├── ws-client.js               (Cliente WebSocket con backoff exponencial, jitter, suscripciones y heartbeat)
│   ├── utils.js                   (Helpers compartidos: formateo de cronómetro mm:ss, reloj en vivo, chime Web Audio API)
│   │
│   └── pages/                     ──► CONTROLADORES ESPECÍFICOS POR VISTA (Cero JS inline en los archivos HTML)
│       ├── login.js               (Controlador de acceso: login, selección de mesas y persistencia en sessionStorage)
│       ├── panel_mesa.js          (Controlador de operario: "Llamar Siguiente", cronómetro, "No se presentó", pausas)
│       ├── tv.js                  (Controlador pantalla pública: display pasivo 1080p, banner de reconexión, audio)
│       ├── admin.js               (Controlador de administración: KPIs en vivo, gestión de lotes, mesas, usuarios)
│       └── kiosko.js              (Controlador de autoservicio: toma de turno táctil, QR dinámico, vista de voucher)
│
├── assets/                        ──► RECURSOS ESTÁTICOS Y VECTORIALES
│   ├── audio/
│   │   └── bell.mp3               (Tono institucional discreto para anuncio de llamado en TV)
│   └── icons/                     (Iconografía vectorial SVG reusable con trazo fino 1.5px/2.0px)
│
│  ──► VISTAS LIMPIAS (Solo estructura HTML5 semántica y declarativa, sin lógica JS ni estilos inline)
├── index.html                     (Pantalla de Login + Grilla Dinámica de Mesas)
├── panel_mesa.html                (Consola de Trabajo del Operador de Ventanilla)
├── tv.html                        (Pantalla Pública para TV de Auditorio 1080p)
├── admin.html                     (Panel de Administración, Lotes, Mesas y Ajustes)
└── kiosko.html                    (Kiosko Web para tablet de portón o smartphone del estudiante)
```

---

## 2. Principios y Reglas de Implementación

### 2.1 Pureza Estructural en Vistas HTML (Cero Lógica Embebida)
- **Prohibido:** Colocar bloques `<script>` con lógica de negocio, funciones auxiliares, manipulación de estado, bloques `<style>` o atributos `style="..."` embebidos en los archivos `.html`.
- **Aclaración sobre el tamaño de los HTML:** El estándar de vistas limpias no impone un límite numérico rígido (ej. 200 líneas) sobre interfaces que requieren modales, estados vacíos y accesibilidad completa; lo que exige estrictamente es que **el 100% de las líneas del archivo pertenezcan a estructura HTML5 semántica y directivas declarativas**. Toda lógica de negocio, control de flujo complejo, llamadas a APIs, WebSockets y cálculos temporales residen exclusivamente en su controlador modular en `src/public/js/pages/<nombre_vista>.js`.

### 2.2 Módulos ES6 Nativos (`type="module"`)
- Cada controlador de página se importa en su HTML como módulo estándar:
  ```html
  <script type="module" src="/js/pages/panel_mesa.js"></script>
  ```
- **Prohibido contaminar el objeto global `window.*`**. La comunicación entre capas se realiza mediante `import` y `export` limpios:
  ```javascript
  import { api } from '../api.js';
  import { TurneroWSClient } from '../ws-client.js';
  import { formatTimer, playChime } from '../utils.js';
  ```

### 2.3 Integración con Alpine.js (`Alpine.data`)
- Cuando una vista requiera reactividad ligera con Alpine.js, el controlador de página debe registrar el componente durante el evento `alpine:init`:
  ```javascript
  // src/public/js/pages/panel_mesa.js
  import { api } from '../api.js';
  import { TurneroWSClient } from '../ws-client.js';

  document.addEventListener('alpine:init', () => {
    Alpine.data('panelMesa', () => ({
      turnoActual: null,
      cronometro: '00:00',
      async llamarSiguiente() {
        // Lógica de consumo de API y notificación WS
      }
    }));
  });
  ```
- En el HTML correspondiente, el contenedor principal simplemente declara: `<main x-data="panelMesa">`.

---

## 3. Especificación de Módulos Centrales (`js/`)

### 3.1 `js/api.js` — Cliente HTTP Centralizado
- **Responsabilidades:**
  1. Inyección automática del header `Authorization: Bearer <jwt>` desde `sessionStorage`.
  2. Detección de error HTTP `401 Unauthorized` e intento de refresco transparente mediante `POST /auth/refresh` con cookies `HttpOnly`.
  3. Redirección automática a `/index.html` si el token expira y el refresh falla.
  4. Métodos simplificados tipados: `api.get(url)`, `api.post(url, data)`, `api.patch(url, data)`.
  5. Manejo unificado de errores con emisión de eventos o notificaciones toast.

### 3.2 `js/ws-client.js` — Cliente WebSocket Institucional
- **Responsabilidades:**
  1. Handshake seguro con JWT vía query param o ticket efímero.
  2. **Reconexión con backoff exponencial y jitter:** `delay = Math.min(base * 2^intentos + random(0, 1000), 30000)`.
  3. Heartbeat cada 30 segundos (ping/pong) con detección de corte silencioso.
  4. Suscripción y enrutamiento por canales: `tv:global`, `mesa:<id>`, `admin:all`.
  5. Solicitud automática de snapshot de sincronización tras reconectar.
  6. Callbacks de estado de conexión (`onOpen`, `onClose`, `onReconnecting`, `onError`) para actualizar pills de red.

### 3.3 `js/utils.js` — Utilidades y Audio Resiliente
- **Responsabilidades:**
  1. Formateadores de fecha y hora sincronizados con el nodo central.
  2. Cronómetro de atención continuo `formatTimer(segundos)` (`mm:ss`).
  3. **Sistema de Audio Híbrido Resiliente (Chime):**
     * Intenta reproducir el archivo de audio institucional `/assets/audio/bell.mp3`.
     * **Fallback Offline:** Si el archivo no carga o falla la red, sintetiza automáticamente un doble tono institucional armonizado (523.25 Hz C5 + 659.25 Hz E5 con envolvente suave) utilizando la **Web Audio API** nativa del navegador.

---

## 4. Reglas de Estilo y CSS (`css/`)

### 4.1 `css/base.css`
- Define los tokens visuales del sistema como variables CSS nativas (`:root`):
  * `--bg-app: #EEF2F6;`
  * `--card-bg: #FFFFFF;`
  * `--border-subtle: #CBD5E1;`
  * `--primary-cobalt: #1D4ED8;`
  * `--primary-hover: #1E40AF;`
- Configura las tipografías globales: `font-family: 'Inter', sans-serif;` y la clase obligatoria `.font-mono-num` con `'JetBrains Mono', monospace` y `font-feature-settings: "tnum" 1;`.
- Regla de contención de pantallas operativas: `h-screen overflow-hidden` para TV y Operador.

### 4.2 `css/animations.css`
- Clases de microinteracciones de alto rendimiento aceleradas por hardware (`will-change: transform, opacity`):
  * `.animate-pulse-subtle`: Indicadores de sincronización de red.
  * `.animate-glow-cobalt`: Destello visual transitorio (5 segundos) al anunciar un nuevo turno.
  * `.animate-toast-slide`: Entrada y salida suave de notificaciones flotantes.

---

## 5. Checklist de Calidad para Cada Pantalla

Antes de dar por finalizada una vista o refactorización:
- [ ] ¿El archivo HTML es puramente estructural (cero JavaScript inline, cero estilos inline o bloques `<style>`)?
- [ ] ¿El controlador está modularizado en `src/public/js/pages/<vista>.js` con `type="module"`?
- [ ] ¿Las peticiones HTTP utilizan exclusivamente el cliente centralizado `api.js`?
- [ ] ¿Las llamadas en tiempo real utilizan `ws-client.js` con manejo visual de reconexión?
- [ ] ¿Se respeta estrictamente la prohibición total de emojis (iconos SVG vectoriales puros)?
- [ ] ¿El fondo general es `#EEF2F6` y las tarjetas usan blanco `#FFFFFF` con borde `#CBD5E1`?
- [ ] ¿Las fuentes numéricas (turnos, reloj, cronómetro) emplean `JetBrains Mono` con números tabulares?