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
 *  4. Espera reactiva de fin de voz (onend/onerror) con timeout de seguridad de 8 s.
 *  5. Cero llamadas a speechSynthesis.cancel() automáticas en cada anuncio.
 * ==============================================================================
 */

let _speechEnabled = true;
let _cachedVoice = null;
let _voicesInitialized = false;

/** @type {SpeechSynthesisUtterance|null} Referencia retenida para evitar GC de Chrome */
let _activeUtterance = null;

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
 * @returns {Promise<void>} Resuelve exactamente al terminar la voz (onend) o timeout de 8s.
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
      if (!_cachedVoice) {
        _seleccionarVozEspanola();
      }

      const utterance = new SpeechSynthesisUtterance(texto);
      _activeUtterance = utterance; // Retener referencia global contra Chrome GC

      if (_cachedVoice) {
        utterance.voice = _cachedVoice;
        utterance.lang  = _cachedVoice.lang || 'es-ES';
      } else {
        utterance.lang  = 'es-ES';
      }

      utterance.rate   = 0.96; // Cadencia inteligible y enérgica
      utterance.pitch  = 1.0;
      utterance.volume = 1.0;

      let finalizado = false;
      const finalizar = () => {
        if (finalizado) return;
        finalizado = true;
        if (timeoutSeguridad) clearTimeout(timeoutSeguridad);
        if (_activeUtterance === utterance) {
          _activeUtterance = null;
        }
        resolve();
      };

      utterance.onend  = finalizar;
      utterance.onerror = (err) => {
        console.warn('[SPEECH] Error en síntesis de voz:', err);
        finalizar();
      };

      // Timeout de seguridad de 8 s por si Chrome suspende o nunca dispara onend
      const timeoutSeguridad = setTimeout(() => {
        finalizar();
      }, 8000);

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.warn('[SPEECH] Excepción en speakCall:', err);
      _activeUtterance = null;
      resolve();
    }
  });
}
