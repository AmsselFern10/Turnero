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
 * Instancia compartida de AudioContext para síntesis Web Audio API offline.
 * @type {AudioContext|null}
 */
let sharedAudioCtx = null;

/**
 * Obtiene o inicializa de forma segura el AudioContext del navegador.
 * Maneja políticas de autoplay activándolo con el primer clic del operador.
 * @returns {AudioContext|null}
 */
function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtxClass) return null;

  if (!sharedAudioCtx) {
    sharedAudioCtx = new AudioCtxClass();
  }

  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }

  return sharedAudioCtx;
}

/**
 * Sintetiza un doble tono institucional armonizado (523.25 Hz C5 + 659.25 Hz E5)
 * con envolvente suave utilizando la Web Audio API nativa.
 * Fallback resiliente garantizado cuando no hay Internet o falla bell.mp3.
 */
export function synthesizeInstitutionalChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const duration = 0.75; // Duración total del chime (segundos)

    // Frecuencias institucionales armonizadas (Do5 y Mi5)
    const tones = [523.25, 659.25];

    tones.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);

      // Desfase sutil de 40ms para sensación de campanilla acústica
      const startTime = now + idx * 0.04;

      // Envolvente acústica: Ataque suave -> Decaimiento natural exponencial
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.28, startTime + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + duration);
    });
  } catch (err) {
    console.warn('[AUDIO] No se pudo sintetizar tono con Web Audio API:', err);
  }
}

/**
 * Sistema de Audio Híbrido Resiliente para anuncio de turno:
 * 1. Intenta reproducir el archivo de audio institucional /assets/audio/bell.mp3.
 * 2. Si el archivo no carga, la red falla o está en modo offline, sintetiza
 *    automáticamente el chime institucional con la Web Audio API nativa.
 * @returns {Promise<void>}
 */
export async function playCallChime() {
  try {
    const audio = new Audio('/assets/audio/bell.mp3');
    audio.preload = 'auto';

    // Manejo de promesa play()
    await audio.play();
  } catch (err) {
    // Fallback Offline inmediato con Web Audio API
    synthesizeInstitutionalChime();
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

// Exposición global para compatibilidad con vistas sin módulos ES6
if (typeof window !== 'undefined') {
  window.formatTimer = formatTimer;
  window.initLiveClock = initLiveClock;
  window.playCallChime = playCallChime;
  window.showToast = showToast;
}
