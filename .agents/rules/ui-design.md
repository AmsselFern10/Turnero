---
trigger: always_on
---

# 🎨 Guía de Diseño y UI/UX — Turnero de Matrículas 2026 (v2.1)
> **Tipo:** Regla de Desarrollo Frontend & Sistema de Diseño  
> **Ámbito:** `src/public/`, plantillas HTML, componentes UI y vistas del sistema  
> **Alineación:** Complementa `general.md`, `modules.md` y `requirements.md` (RF-MESA, RF-TV, RF-ADM, RF-USA-01..07, RNF-USA, RNF-DIS-03)

---

## 1. Stack Tecnológico Frontend y Herramientas Autorizadas

Todas las pantallas deben implementarse siguiendo el estándar oficial de arquitectura ligera (sin pasos de compilación pesados, servibles de forma estática y resilientes en redes locales):

| Herramienta | Rol / Propósito | Estándar de Implementación |
|---|---|---|
| **HTML5 Semántico** | Estructura de documentos | `<header>`, `<main>`, `<section>`, `<nav>`, `<footer>`, `<dialog>` |
| **Tailwind CSS 3** | Motor de estilos y utilidades | CDN o compilación local con plugins `@tailwindcss/forms` y `@tailwindcss/container-queries` |
| **Alpine.js v3** | Reactividad liviana de UI | Para manejo de estado local, toggles, modales y tabs sin SPA pesadas |
| **Google Fonts** | Tipografía institucional | `Inter` (sans-serif para UI) y `JetBrains Mono` (monospace para turnos y datos) |
| **Iconografía Vectorial** | Iconos y símbolos | **SVG Inline o Lucide Icons** puros con trazo `stroke-width="1.5"` a `2` |
| **WebSockets Client** | Tiempo real reactivo | `ws-client.js` con indicador de conexión y backoff exponencial con jitter |

---

## 2. 🚫 Regla Estricta: Prohibición Total de Emojis

Conforme a la norma **RF-USA-04** del proyecto:
- **PROHIBIDO TERMINANTEMENTE EL USO DE EMOJIS** en elementos funcionales, de navegación, botones, badges, modales o títulos (ej: ❌ ⚙️, 📊, 🪑, 📺, 🚪, ⏱️, 👤, 🔔).
- **Sustitución Obligatoria:** Todo icono debe ser un **SVG vectorial nítido** (ej. Lucide Icons / Heroicons), con trazo armonizado (`stroke-[1.5]` a `stroke-[2]`), `stroke-linecap="round"`, `stroke-linejoin="round"` y color adaptativo vía `currentColor` o clases de Tailwind (`text-slate-400`, `text-blue-600`, etc.).

---

## 3. Paleta Cromática y Tokens Visuales Oficiales

### 3.1 Fondos de Pantalla (Canvas Background)
- **Fondo Global del Sistema:** `#EEF2F6` (`bg-[#EEF2F6]`)  
  *Justificación:* Tonalidad Slate Blue grisácea suave de alto contraste institucional que reduce la fatiga visual de operadores en jornadas continuas de 8 horas y evita el deslumbramiento blanco artificial.
- **Fondo Secundario / Áreas Suaves:** `bg-slate-50` o `bg-slate-100`.

### 3.2 Cards y Contenedores
- **Fondo:** Blanco absoluto `bg-white`.
- **Bordes:** `border border-[#CBD5E1]` (slate-300) o `border-slate-200/90`. Cero bordes negros o sombras excesivamente oscuras.
- **Radios de Esquina:**
  * Tarjetas y paneles principales: `rounded-2xl` (16px).
  * Sub-tarjetas, modales y campos: `rounded-xl` (12px).
  * Pills de estado y badges: `rounded-full` o `rounded-lg`.
- **Sombras:** Sombras sutiles y elegantes: `shadow-sm` o `shadow-xs`.

### 3.3 Jerarquía Tipográfica y Colores de Texto
- **Texto Principal / Títulos / Datos Clave:** `text-slate-900` (`font-bold` o `font-semibold`).
- **Texto Secundario / Labels de Campos:** `text-slate-700` (`font-medium`).
- **Texto de Soporte / Metadatos / Cronómetros neutros:** `text-slate-500` o `text-slate-400`.
- **Familias Tipográficas:**
  * **Inter (`font-sans`):** Para toda la interfaz de usuario, etiquetas, menús, modales y botones.
  * **JetBrains Mono (`font-mono`):** Obligatorio para **números de turno**, **identificadores de mesa**, **relojes**, **cronómetros** y **código/IDs**.

### 3.4 Paleta Semántica de Estados y Acciones
| Estado / Propósito | Fondo Pill/Alert | Borde | Texto / Icono | Color de Acción (Botones) |
|---|---|---|---|---|
| **Institucional / Primario** | `bg-blue-50` | `border-blue-200` | `text-[#1D4ED8]` | `bg-[#1D4ED8]` hover: `bg-blue-800` |
| **En Atención / Conectado** | `bg-emerald-50` | `border-emerald-200` | `text-emerald-700` | `bg-emerald-600` hover: `bg-emerald-700` |
| **En Espera / Próximo / Alerta** | `bg-amber-50` | `border-amber-300` | `text-amber-800` | `bg-amber-500` hover: `bg-amber-600` |
| **Peligro / Cancelado / Error** | `bg-rose-50` | `border-rose-200` | `text-rose-700` | `bg-rose-600` hover: `bg-rose-700` |
| **Neutro / Pausado** | `bg-slate-100` | `border-slate-200` | `text-slate-600` | `bg-slate-200` hover: `bg-slate-300` |

---

## 4. Botones y Microinteracciones

### 4.1 Tipos de Botones y Estilos
1. **Botón de Acción Primaria ("LLAMAR SIGUIENTE"):**
   - Altura prominente (`h-14` a `h-16`), tipografía fuerte (`text-lg font-bold`), ancho completo en su contenedor.
   - Clases clave: `bg-[#1D4ED8] text-white rounded-xl shadow-sm hover:bg-blue-800 active:scale-[0.98] transition-all cursor-pointer font-bold tracking-wide`.
2. **Botón Secundario / Destructivo ("No se presentó" / Cancelar):**
   - Altura estándar (`h-11` a `h-12`), fondo claro de alerta:
   - Clases clave: `bg-rose-50 border border-rose-200 text-rose-700 hover:bg-rose-100 active:scale-[0.98] rounded-xl font-semibold transition-colors cursor-pointer`.
3. **Botón Neutro / Ghost (Pausar Mesa / Reanudar / Tabs / Cerrar Sesión):**
   - Clases clave: `bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 active:scale-[0.98] rounded-xl font-medium transition-colors shadow-2xs cursor-pointer`.

### 4.2 Estados y Micro-animaciones
- Todo botón interactivo debe contar con `cursor-pointer`, `select-none` y feedback al clic con `active:scale-[0.98]`.
- Botones en llamada activa o en espera pueden incluir pulso sutil de atención: `animate-pulse-call`.
- Estados de foco accesibles: `focus:outline-none focus:ring-2 focus:ring-blue-600/25`.

---

## 5. Arquitectura de Pantalla y Aprovechamiento de Espacios

### 5.1 Pantallas Operativas (Operador y TV) — `h-screen overflow-hidden`
- **Regla Fundamental:** Las pantallas de ventanilla (`panel_mesa.html`) y pantalla pública (`tv.html`) deben estar contenidas exactamente en el alto del viewport (`h-screen max-h-screen overflow-hidden`).
- **Cero Scroll Innecesario:** Ni el operador ni la pantalla de TV deben hacer scroll vertical u horizontal bajo condiciones normales. Todos los controles y lecturas deben estar visibles a golpe de vista.

### 5.2 Estructura del Header (Encabezado)
- **Altura Compacta:** `py-3` a `py-3.5`, `px-6` a `px-8` (`flex-shrink-0`), para no quitarle espacio a las tarjetas centrales.
- **Distribución en 2 Extremos (`justify-between`):**
  * **Izquierda:** Badge de Mesa destacado (`bg-[#1D4ED8] text-white font-mono font-bold`), nombre del operador y **Pill de Conexión WebSocket** (punto verde pulsante `bg-emerald-500 animate-pulse` + "En línea").
  * **Derecha:** Reloj digital en vivo (`JetBrains Mono`, sincronizado al segundo) + Fecha + Acciones auxiliares de sesión (Pausar mesa, Cerrar sesión, Enlace a TV).
- **Separador:** Borde inferior limpio `border-b border-[#CBD5E1]`.

### 5.3 Estructura del Canvas Central (`main`)
- **Proporción de Dos Columnas (Asimétrica Ergonómica):**
  * **Columna Hero (~65% del ancho):** Dedicada al **Turno Actual en Atención** (panel operador) o **Último Llamado** (pantalla TV).
  * **Columna Lateral (~35% del ancho):** Dedicada al **Próximo en Fila**, métricas rápidas de la mesa (turnos atendidos hoy) o historial reciente de llamados.
- **Escala de Legibilidad a Distancia (Requisitos Obligatorios):**
  * **Panel Operador:** Turno actual en JetBrains Mono ≥ 96px (recomendado `text-[128px]` a `text-[148px]`), visible claramente sin esfuerzo desde 1 metro de distancia.
  * **Pantalla Pública TV:** Turno colosal ≥ 200px (recomendado `text-[220px]` a `text-[260px]`), Mesa asignada ≥ 72px (`text-7xl`), legible a más de 5 metros de distancia en televisores de 40" o más.

### 5.4 Estructura del Footer (Pie de Página)
- **Altura Mínima:** `py-2` a `py-2.5`, discreto y funcional.
- **Contenido Informativo:**
  * Identificación de versión (`Turnero v2.1 • 2026`).
  * Estado del lote activo (`Lote 2 • Vouchers restantes: 153`).
  * Indicador de latencia o atajo de teclado (`Espacio: Llamar Siguiente`).
- Nunca debe sobrecargar ni competir con las tarjetas de trabajo.

---

## 6. Especificaciones Particulares por Pantalla

### 6.1 Pantalla de Acceso (`login.html`)
- Tarjeta centralizada única (`max-w-md`), perfectamente centrada vertical y horizontalmente.
- Formulario directo: usuario y contraseña con iconos SVG en inputs.
- Post-login: reemplazo suave con grilla de selección de mesas activas (`GET /mesas`), mostrando mesas libres (`hover:border-blue-500`) y mesas ocupadas claramente deshabilitadas con badge de operador actual.

### 6.2 Pantalla del Operador (`panel_mesa.html`)
- Cumple el principio de **1 Acción / 1 Clic** (RF-TURN-01 / RF-USA-01):
  * Clic en "LLAMAR SIGUIENTE" finaliza el turno en curso, toma el siguiente voucher atómicamente y actualiza la pantalla.
- Cronómetro de atención en vivo (`font-mono`, minutos:segundos) que arranca desde `llamado_en`.
- Pantalla de cortesía ("Mesa en Pausa") que reemplaza temporalmente el panel cuando el operador activa la pausa.

### 6.3 Pantalla Pública TV (`tv.html`)
- Display pasivo 100% autónomo (sin ratón, sin recarga de página).
- **Banner de Reconexión Animado:** Ante desconexión WebSocket, despliega banner superior de advertencia en color ámbar sin limpiar los turnos en pantalla (RNF-DIS-03 / RF-TV-05: *nunca pantalla en blanco*).
- Historial lateral con los últimos 4 turnos llamados (número + mesa + animación suave al actualizarse).
- Reloj digital Full HD sincronizado en esquina superior.

### 6.4 Pantalla de Administración (`admin.html`)
- Navegación por tabs limpios con Alpine.js o JavaScript vanilla (Dashboard, Lotes, Mesas, Usuarios, Ajustes).
- Dashboard con tarjetas KPI compactas y semáforo visual de eficiencia por mesa (verde < 4 min, amarillo 4-7 min, rojo > 7 min).
- Tablas con cabeceras `text-xs font-semibold text-slate-500 uppercase tracking-wider` y filas contrastadas.
- Modal de confirmación estilizado para acciones críticas (cerrar lote, extender número).

### 6.5 Pantalla Kiosko Web (`/kiosko`)
- Orientada a dispositivos móviles / tablets / pantallas táctiles.
- Interfaz centrada de toque único: botón gigante "TOMAR MI TURNO".
- Visualización de confirmación: `#47`, código de seguimiento y tiempo estimado de espera.

---

## 7. Checklist de Aprobación de Diseño (UI Review)

Antes de considerar una pantalla completada, verificar:
- [ ] ¿Cero emojis presentes en toda la pantalla?
- [ ] ¿El fondo general es `#EEF2F6` y las tarjetas son blancas con borde `#CBD5E1` / `slate-200`?
- [ ] ¿Los números de turnos, mesas, reloj y cronómetro usan `JetBrains Mono`?
- [ ] ¿El botón "LLAMAR SIGUIENTE" es el elemento de mayor jerarquía visual en el panel operativo?
- [ ] ¿La pantalla de operador y TV caben exactamente en el viewport sin scroll (`h-screen overflow-hidden`)?
- [ ] ¿El header y footer son compactos y no roban espacio de atención?
- [ ] ¿Todos los iconos son SVGs con trazos proporcionados?
- [ ] ¿Hay feedback visual ante desconexión o reconexión de red?

