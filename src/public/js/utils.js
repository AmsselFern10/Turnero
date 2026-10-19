/**
 * ==============================================================================
 * UTILS.JS — Utilidades Compartidas y Audio Resiliente
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cumple con:
 * - RF-MESA-03: Cronómetro continuo mm:ss con números tabulares.
 * - RF-TV-03: Reloj digital sincronizado al segundo.
 * - RNF-DIS-06: Sistema de audio híbrido con síntesis Web Audio API offline.
 * ==============================================================================
 */

/**
 * Formatea una duración en segundos al estándar mm:ss para ventanilla.
 * @param {number|string} totalSeconds - Cantidad total de segundos
 * @returns {string} Texto formateado (ej: "04:12")
 */
export function formatTimer(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const minutes = Math.floor(sec / 60);
  const remainingSec = sec % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(remainingSec).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Inicializa un reloj digital en tiempo real sincronizado al segundo.
 * @param {string|HTMLElement} timeTarget - Selector o elemento DOM para la hora (HH:mm:ss)
 * @param {string|HTMLElement} [dateTarget] - Selector o elemento DOM para la fecha
 * @returns {Function} Función para detener el reloj cuando se desmonte la vista
 */
export function initLiveClock(timeTarget, dateTarget = null) {
  const timeEl = typeof timeTarget === 'string' ? document.getElementById(timeTarget) : timeTarget;
  const dateEl = typeof dateTarget === 'string' ? document.getElementById(dateTarget) : dateTarget;

  const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  function update() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    if (timeEl) {
      timeEl.textContent = `${hh}:${mm}:${ss}`;
    }

    if (dateEl) {
      const day = String(now.getDate()).padStart(2, '0');
      const month = meses[now.getMonth()];
      const year = now.getFullYear();
      dateEl.textContent = `${day} ${month} ${year}`;
    }
  }

  update();
  const timerId = setInterval(update, 1000);

  return function stopClock() {
    clearInterval(timerId);
  };
}

/**
 * ==============================================================================
 * SISTEMA DE AUDIO HÍBRIDO RESILIENTE (INC-3)
 *
 * Invariantes:
 *  - Un único AudioContext (singleton) creado de forma perezosa.
 *  - bell.mp3 se descarga y decodifica UNA sola vez; si falla (404 / red),
 *    se activa la bandera _bellFailed y nunca se reintenta la red.
 *  - Anti-solapamiento: si el chime anterior sigue sonando se omite el nuevo.
 *  - El fallback (síntesis Web Audio) usa el mismo AudioContext singleton.
 *  - Nunca bloquea ni retrasa la actualización visual.
 * ==============================================================================
 */

/** @type {AudioContext|null} Instancia única compartida */
let _audioCtx = null;

/** @type {AudioBuffer|null} Buffer decodificado de bell.mp3 */
let _bellBuffer = null;

/** @type {boolean} true si la carga de bell.mp3 falló (no reintentar red) */
let _bellFailed = false;

/** @type {Promise<void>|null} Promesa de carga en curso para evitar descargas paralelas */
let _bellLoadPromise = null;

/** @type {number} Marca de tiempo (ctx.currentTime) en que termina el chime actual */
let _chimeEndTime = 0;

/** Duración del chime en segundos (< 1.2 s, sin solapamiento) */
const CHIME_DURATION = 0.85;

/**
 * Obtiene (o crea) el AudioContext singleton.
 * Reanuda si está en estado 'suspended'.
 * @returns {AudioContext|null}
 */
function _getAudioCtx() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!_audioCtx) _audioCtx = new AC();
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}

/**
 * Carga y decodifica bell.mp3 una sola vez.
 * Si ya falló antes, resuelve inmediatamente sin tocar la red.
 * @returns {Promise<AudioBuffer|null>}
 */
async function _loadBell() {
  if (_bellFailed) return null;
  if (_bellBuffer) return _bellBuffer;
  if (_bellLoadPromise) return _bellLoadPromise;

  _bellLoadPromise = (async () => {
    try {
      const ctx = _getAudioCtx();
      if (!ctx) { _bellFailed = true; return null; }

      const resp = await fetch('/assets/audio/bell.mp3', { cache: 'force-cache' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const arrayBuffer = await resp.arrayBuffer();
      _bellBuffer = await ctx.decodeAudioData(arrayBuffer);
      return _bellBuffer;
    } catch (err) {
      console.warn('[AUDIO] bell.mp3 no disponible, usando síntesis Web Audio:', err.message);
      _bellFailed = true;
      return null;
    } finally {
      _bellLoadPromise = null;
    }
  })();

  return _bellLoadPromise;
}

/**
 * Sintetiza un doble tono institucional armonizado (C5 + E5) con envolvente suave.
 * Usa el AudioContext singleton; nunca crea uno nuevo.
 */
export function synthesizeInstitutionalChime() {
  try {
    const ctx = _getAudioCtx();
    if (!ctx) return;

    const now = ctx.currentTime;
    const freqs = [523.25, 659.25];

    freqs.forEach((freq, idx) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);

      const startTime = now + idx * 0.04;
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.28, startTime + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + CHIME_DURATION);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + CHIME_DURATION);
    });

    _chimeEndTime = ctx.currentTime + CHIME_DURATION + 0.1;
  } catch (err) {
    console.warn('[AUDIO] Síntesis Web Audio fallida:', err);
  }
}

/**
 * Sistema de audio híbrido: bell.mp3 (cargado una vez) → síntesis Web Audio.
 * Anti-solapamiento: si el chime anterior sigue sonando, se omite.
 * Nunca bloquea ni retrasa la actualización visual.
 * @returns {Promise<void>}
 */
export async function playCallChime() {
  try {
    const ctx = _getAudioCtx();
    if (!ctx) return;

    // Anti-solapamiento: si el chime anterior todavía suena, omitir
    if (ctx.currentTime < _chimeEndTime) {
      const restante = Math.max(0, (_chimeEndTime - ctx.currentTime) * 1000);
      await new Promise(r => setTimeout(r, restante));
      return;
    }

    // Intentar bell.mp3 (solo UNA descarga de red; si falló antes, usa síntesis)
    const buffer = await _loadBell();

    if (buffer) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
      const durMs = Math.min(Math.round(buffer.duration * 1000), 1000);
      _chimeEndTime = ctx.currentTime + buffer.duration + 0.05;
      await new Promise(r => setTimeout(r, durMs));
    } else {
      // Fallback: síntesis sin red
      synthesizeInstitutionalChime();
      await new Promise(r => setTimeout(r, Math.round(CHIME_DURATION * 1000)));
    }
  } catch (err) {
    console.warn('[AUDIO] Error al reproducir chime:', err);
    synthesizeInstitutionalChime();
    await new Promise(r => setTimeout(r, Math.round(CHIME_DURATION * 1000)));
  }
}

/**
 * Notificación Toast no intrusiva con clases aceleradas por hardware (.animate-toast-slide)
 * @param {Object} options
 * @param {string} options.message - Texto a mostrar
 * @param {'info'|'success'|'warning'|'danger'} [options.type='info'] - Variante de color
 * @param {number} [options.duration=3500] - Tiempo visible en ms
 */
export function showToast({ message, type = 'info', duration = 3500 }) {
  if (typeof document === 'undefined') return;

  let container = document.getElementById('global-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'global-toast-container';
    container.className = 'fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none select-none';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');

  const colorStyles = {
    info: 'bg-white border-slate-300 text-slate-800',
    success: 'bg-emerald-50 border-emerald-300 text-emerald-900',
    warning: 'bg-amber-50 border-amber-300 text-amber-900',
    danger: 'bg-rose-50 border-rose-300 text-rose-900'
  };

  toast.className = `flex items-center gap-2.5 px-4 py-2.5 rounded-xl border shadow-md text-xs font-medium animate-toast-slide pointer-events-auto ${colorStyles[type] || colorStyles.info}`;
  toast.innerHTML = `<span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('animate-toast-slide');
    toast.classList.add('animate-toast-leave');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 220);
  }, duration);
}

/**
 * Aplica o remueve la imagen de fondo personalizada al elemento body.
 * Modifica exclusivamente el fondo del lienzo general (--bg-app)
 * preservando intactas las tarjetas blancas (.card), controles, header y footer.
 * @param {string} url - URL de la imagen
 * @param {boolean|string} activo - Si está activado o no
 */
export function aplicarFondoPersonalizado(url, activo) {
  if (typeof document === 'undefined') return;
  const body = document.body;
  if (!body) return;

  const urlValida = typeof url === 'string' && url.trim().length > 0;
  const estaActivo = (activo === true || activo === 'true' || activo === 1 || activo === '1');

  if (estaActivo && urlValida) {
    const cleanUrl = url.trim().replace(/"/g, '\\"');
    body.style.setProperty('--bg-custom-image', `url("${cleanUrl}")`);
    body.classList.add('has-custom-bg');
  } else {
    body.style.removeProperty('--bg-custom-image');
    body.classList.remove('has-custom-bg');
  }
}

/**
 * Consulta la configuración pública y aplica el fondo institucional si está activo.
 * Se suscribe opcionalmente al cliente WebSocket para sincronización en caliente.
 * @param {Object} [wsClient] - Cliente WebSocket opcional para escuchar 'config_actualizada'
 */
export async function initFondoPersonalizado(wsClient = null) {
  if (typeof window === 'undefined') return;

  async function actualizar() {
    try {
      const resp = await fetch('/turnos/configuracion-publica');
      if (resp.ok) {
        const data = await resp.json();
        aplicarFondoPersonalizado(data.fondo_imagen_url, data.fondo_imagen_activa);
      }
    } catch (_) {}
  }

  // Carga inicial
  await actualizar();

  // Escucha en tiempo real si se provee cliente WS
  if (wsClient && typeof wsClient.on === 'function') {
    wsClient.on('config_actualizada', (payload) => {
      if (!payload) return;
      if (payload.clave === 'fondo_imagen_url' || payload.clave === 'fondo_imagen_activa') {
        actualizar();
      }
    });
  }
}

