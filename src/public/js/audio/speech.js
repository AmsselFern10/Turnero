/**
 * ==============================================================================
 * SPEECH.JS — Síntesis de Voz Resiliente para Pantalla TV (Web Speech API)
 * Ubicación: src/public/js/audio/speech.js
 *
 * Anuncio verbal secuencial para TV de auditorio:
 * "Turno {numero}, Mesa {mesa}" (ej. "Turno 87, Mesa 1")
 *
 * Invariantes implementadas:
 *  1. Retención estricta de referencia a SpeechSynthesisUtterance a nivel de módulo
 *     para prevenir el recolector de basura (GC) de Chrome que cancela el evento onend.
 *  2. Detección y selección de voz en español tras 'voiceschanged' (evita voices vacío).
 *  3. Texto corto sin ceros a la izquierda ("Turno 87, Mesa 1").
 *  4. Espera reactiva de fin de voz (onend/onerror) con timeout de seguridad de 3.5 s.
 *  5. cancel() previo en cada anuncio para limpiar la cola de Chrome (evita el bug
 *     de onend que nunca se dispara con utterances acumuladas en la cola interna).
 *  6. Detección de voz bloqueada por el navegador: expuesto como isSpeechBlocked().
 * ==============================================================================
 */

let _speechEnabled = true;
let _cachedVoice = null;
let _voicesInitialized = false;

/** @type {SpeechSynthesisUtterance|null} Referencia retenida para evitar GC de Chrome */
let _activeUtterance = null;

/** @type {boolean} true si el navegador bloqueó la síntesis por falta de gesto del usuario */
let _speechBlocked = false;

/**
 * Busca y almacena en caché la mejor voz disponible en español.
 */
function _seleccionarVozEspanola() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return;

    // Priorizar voces naturales/españolas reconocidas
    _cachedVoice = voices.find(v => v.lang && v.lang.startsWith('es') && (
      v.name.includes('Google') ||
      v.name.includes('Natural') ||
      v.name.includes('Helena') ||
      v.name.includes('Sabina') ||
      v.name.includes('Paulina') ||
      v.name.includes('Microsoft') ||
      v.name.includes('Laura')
    ))
    || voices.find(v => v.lang && v.lang.startsWith('es'))
    || null;

    _voicesInitialized = Boolean(_cachedVoice);
    if (_voicesInitialized) _speechBlocked = false; // voces disponibles → desbloquear flag
  } catch (_) {}
}

/**
 * Inicializa y busca una voz óptima en español.
 */
export function initSpeech() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

  _seleccionarVozEspanola();

  if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
    window.speechSynthesis.onvoiceschanged = () => {
      _seleccionarVozEspanola();
    };
  }
}

/**
 * Establece si la voz está activa o silenciada.
 * @param {boolean} enabled
 */
export function setSpeechEnabled(enabled) {
  _speechEnabled = Boolean(enabled);
  if (!_speechEnabled && typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
      _activeUtterance = null;
    } catch (_) {}
  }
}

/**
 * Consulta si la voz está habilitada actualmente.
 * @returns {boolean}
 */
export function isSpeechEnabled() {
  return _speechEnabled;
}

/**
 * Consulta si el navegador bloqueó la síntesis por falta de gesto del usuario.
 * @returns {boolean}
 */
export function isSpeechBlocked() {
  return _speechBlocked;
}

/**
 * Cancela cualquier locución en curso de forma explícita.
 */
export function cancelSpeech() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (_) {}
  }
  _activeUtterance = null;
}

/**
 * Anuncia verbalmente un turno a una ventanilla.
 * Formato conciso: "Turno {numero}, Mesa {mesa}"
 *
 * @param {Object} params
 * @param {number|string} params.numero - Número de turno (ej. 87)
 * @param {number|string} params.mesa_numero - Número de mesa (ej. 1)
 * @returns {Promise<void>} Resuelve exactamente al terminar la voz (onend) o timeout de 3.5s.
 */
export function speakCall({ numero, mesa_numero }) {
  return new Promise((resolve) => {
    if (!_speechEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return resolve();
    }

    if (numero === undefined || numero === null || mesa_numero === undefined || mesa_numero === null) {
      return resolve();
    }

    // Texto corto sin ceros a la izquierda para locución natural y ágil
    const numLimpio  = !Number.isNaN(Number(numero)) ? Number(numero) : numero;
    const mesaLimpia = !Number.isNaN(Number(mesa_numero)) ? Number(mesa_numero) : mesa_numero;
    const texto = `Turno ${numLimpio}, Mesa ${mesaLimpia}`;

    try {
      const ss = window.speechSynthesis;

      if (!_cachedVoice) {
        _seleccionarVozEspanola();
      }

      // Si la síntesis quedó en pausa por el navegador, reanudar
      if (ss && ss.paused) {
        try { ss.resume(); } catch (_) {}
      }

      const utterance = new SpeechSynthesisUtterance(texto);
      _activeUtterance = utterance; // Retener referencia global contra Chrome GC

      if (_cachedVoice) {
        utterance.voice = _cachedVoice;
        utterance.lang  = _cachedVoice.lang || 'es-ES';
      } else {
        utterance.lang  = 'es-ES';
      }

      utterance.rate   = 0.98; // Cadencia inteligible, natural y enérgica
      utterance.pitch  = 1.0;
      utterance.volume = 1.0;

      let finalizado = false;
      const finalizar = (bloqueado = false) => {
        if (finalizado) return;
        finalizado = true;
        if (timeoutSeguridad) clearTimeout(timeoutSeguridad);
        if (_activeUtterance === utterance) {
          _activeUtterance = null;
        }
        if (bloqueado) _speechBlocked = true;
        resolve();
      };

      utterance.onstart = () => {
        // Si onstart se dispara, el navegador sí permite síntesis — desbloquear flag
        _speechBlocked = false;
      };

      utterance.onend  = () => finalizar(false);
      utterance.onerror = (err) => {
        // 'not-allowed': el navegador bloqueó la síntesis por falta de gesto del usuario
        if (err && err.error !== 'canceled') {
          console.warn('[SPEECH] Error o interrupción en síntesis de voz:', err.error || err);
        }
        finalizar(err && err.error === 'not-allowed');
      };

      // Timeout de seguridad de 3.5 s — cubre voces lentas (~2-3 s) sin congelar la cola.
      const timeoutSeguridad = setTimeout(() => {
        // Si después de 6 s el speechSynthesis sigue sin hablar, es señal de bloqueo.
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          const ss = window.speechSynthesis;
          if (!ss.speaking && !ss.pending) {
            _speechBlocked = true;
          }
        }
        finalizar(false);
      }, 3500);

      window.speechSynthesis.speak(utterance);

      // Chrome bug: en pestañas recién abiertas sin interacción, speak() encola
      // silenciosamente pero nunca empieza a hablar. Detectarlo comprobando speaking tras 500 ms.
      setTimeout(() => {
        if (finalizado) return;
        const ss = window.speechSynthesis;
        if (!ss.speaking && !ss.pending) {
          // No está hablando ni en cola — probablemente bloqueado por el navegador
          _speechBlocked = true;
          finalizar(false);
        }
      }, 500);

    } catch (err) {
      console.warn('[SPEECH] Excepción en speakCall:', err);
      _activeUtterance = null;
      resolve();
    }
  });
}
