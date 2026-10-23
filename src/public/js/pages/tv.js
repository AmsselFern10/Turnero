/**
 * ==============================================================================
 * TV.JS - Controlador Pantalla Publica 1080p Pasiva y Autonoma (v2.1)
 * Ubicación: src/public/js/pages/tv.js
 *
 * Arquitectura: Máquina de estados estricta con Cola FIFO por 'seq' y Anunciador secuencial.
 *
 * Invariantes Fundamentales:
 *  1. Una sola fuente de verdad:
 *     - 'ultimoLlamado' (hero) = turno actual en reproducción.
 *     - 'proximoNumero' = hero.proximo (derivado exclusivamente del hero activo).
 *     - 'historial' = turnos YA anunciados, ordenados por seq DESC, sin incluir el hero.
 *     - Ningún evento externo ni snapshot escribe en 'historial' ni 'ultimoLlamado'
 *       mientras el reproductor está activo.
 *  2. Orden estricto FIFO por seq:
 *     - Múltiples llamados simultáneos se encolan ordenados por seq.
 *     - Ninguno se salta ni se descarta en silencio.
 *  3. Anunciador secuencial:
 *     - Campana institucional -> esperar fin -> voz -> esperar onend/onerror.
 *     - Duración = max(duracionMinima, fin real de la voz). La voz NUNCA se corta.
 *  4. Re-llamado (SEGUNDO AVISO):
 *     - Entra con prioridad tras el anuncio en curso y antes de pendientes.
 *     - Toma el hero por max(2 s, fin de voz) con estilo ámbar "SEGUNDO AVISO".
 *     - NO entra al historial y NO modifica el último llamado real.
 *     - Al terminar, el hero regresa al último llamado real y la cola continúa.
 *  5. Watchdog de seguridad (> 12 s):
 *     - Previene congelamiento de la cola ante cualquier fallo de síntesis de voz.
 * ==============================================================================
 */

import { TurneroWSClient } from '../ws-client.js';
import { playCallChime, aplicarFondoPersonalizado } from '../utils.js';
import { speakCall, setSpeechEnabled, initSpeech, isSpeechBlocked } from '../audio/speech.js';

// ── Configuración central de tiempos (ms) ────────────────────────────────────
const CFG = {
  // Tiempo FIJO de visualización de cada tarjeta en pantalla.
  // Independiente del audio: la tarjeta siempre dura exactamente estos ms.
  // Garantiza sincronía entre múltiples pantallas y evita tarjetas que "vuelan".
  tiempoVisualizacionMs: 4000,
  // Duración mínima heredada (ahora alias de tiempoVisualizacionMs, no se usa para acortar).
  anuncioBaseMs:    4000,
  antiguedadMaxMs: 60000,
  graciaBannerMs:   3000,
  // Watchdog: 15 s cubre tiempoVisualizacionMs (4 s) + speakCall timeout (3.5 s) + margen.
  watchdogMs:      15000,
  maxCola:            50,
  maxSeqVistos:      300,
  staleCheckMs:    30000,
};

const STORAGE_KEY_ESCALA_PRINCIPAL    = 'turnero_tv_escala_principal';
const STORAGE_KEY_ESCALA_SECUNDARIA   = 'turnero_tv_escala_secundaria';
const STORAGE_KEY_ESCALA_LEGACY       = 'turnero_tv_escala_turnos';
const STORAGE_KEY_OPACIDAD_PRINCIPAL  = 'turnero_tv_opacidad_principal';
const STORAGE_KEY_OPACIDAD_SECUNDARIA = 'turnero_tv_opacidad_secundaria';

export function tvView() {
  return {
    // ── Estado reactivo público para Alpine ──────────────────────────────────
    ultimoLlamado: { numero: null, mesa_numero: null, proximo: null, llamado_en: null },
    proximoNumero: null,
    historial:     [],
    glowState:     'idle', // 'idle' | 'nuevo' | 'rellamado'
    colaPendiente: 0,
    escalaPrincipal:   100,
    escalaSecundaria:  100,
    escalaTurnos:      100, // Retrocompatibilidad
    opacidadPrincipal:   100,
    opacidadSecundaria:  100,
    mostrarHistorial:  true,
    modo:              'voucher_fisico', // 'voucher_fisico' | 'kiosko_web' | 'mixto'

    // Estado de conexión WebSocket
    wsConnected:       false,
    reconnecting:      false,
    reconnectMsg:      'Reconectando con el servidor central...',
    reconnectCountdown: '',

    // Reloj digital Full HD
    relojHora:  '--:--:--',
    relojFecha: '--',

    // Audio y configuración de voz
    audioSuspended: false,
    vozActiva:      true,
    vozBloqueada:   false, // true si el navegador bloqueó la síntesis de voz

    // ── Getters de presentación desacoplados de la vista HTML ─────────────────
    get estilosRootVariables() {
      const pScale = (this.escalaPrincipal / 100).toFixed(2);
      const sScale = (this.escalaSecundaria / 100).toFixed(2);
      return {
        '--tv-escala-principal': pScale,
        '--tv-escala-secundaria': sScale,
        '--tv-num-scale': pScale
      };
    },

    get estiloFondoPrincipal() {
      const alpha = (this.opacidadPrincipal / 100).toFixed(2);
      return { backgroundColor: `rgba(255, 255, 255, ${alpha})` };
    },

    get estiloFondoSecundario() {
      const alpha = (this.opacidadSecundaria / 100).toFixed(2);
      return { backgroundColor: `rgba(255, 255, 255, ${alpha})` };
    },

    // ── Propiedades privadas (control de máquina de estados y timers) ────────
    _ws:               null,
    _cola:             [],    // Cola FIFO única — llamados, re-llamados y rezagados en orden de llegada
    _seqVistos:        null,  // Set de seq y evento_id procesados (deduplicación)
    _reproduciendo:    false,
    _lastSeqAnunciado: 0,
    _lastSeqRecibido:  0,

    // Último turno LEGÍTIMO convocado (no re-llamados).
    // Se usa para restaurar el hero tras un re-llamado transitorio.
    _ultimoLlamadoReal: null,

    // Timers y listeners
    _watchdogTimer:     null,
    _avanceTimer:       null,
    _bannerTimer:       null,
    _clockTimer:        null,
    _relativoTimer:     null,
    _staleCheckTimer:   null, // Verificación anti-stale periódica
    _onResizeHandler:      null,
    _onStorageHandler:     null,
    _onVisibilityHandler:  null,
    _serverTimeOffset:     0,

    // ─────────────────────────────────────────────────────────────────────────
    // CICLO DE VIDA
    // ─────────────────────────────────────────────────────────────────────────

    init() {
      // Idempotencia: un solo WebSocket por instancia (evita duplicación)
      if (this._ws) return;

      this._seqVistos = new Set();
      this._cola = [];

      // Aplicar escalas y opacidades guardadas inmediatamente en offline/arranque
      let cachedPrincipal  = null;
      let cachedSecundaria = null;
      let cachedLegacy     = null;
      let cachedOpPrincipal  = null;
      let cachedOpSecundaria = null;
      try {
        cachedPrincipal    = localStorage.getItem(STORAGE_KEY_ESCALA_PRINCIPAL);
        cachedSecundaria   = localStorage.getItem(STORAGE_KEY_ESCALA_SECUNDARIA);
        cachedLegacy       = localStorage.getItem(STORAGE_KEY_ESCALA_LEGACY);
        cachedOpPrincipal  = localStorage.getItem(STORAGE_KEY_OPACIDAD_PRINCIPAL);
        cachedOpSecundaria = localStorage.getItem(STORAGE_KEY_OPACIDAD_SECUNDARIA);
      } catch (_) {}

      const pInit  = cachedPrincipal  || cachedLegacy || 100;
      const sInit  = cachedSecundaria || cachedLegacy || 100;
      const opInit = cachedOpPrincipal  || 100;
      const osInit = cachedOpSecundaria || 100;
      this._aplicarEscalaPrincipal(pInit, false);
      this._aplicarEscalaSecundaria(sInit, false);
      this._aplicarOpacidadPrincipal(opInit, false);
      this._aplicarOpacidadSecundaria(osInit, false);

      // Cargar preferencia de visibilidad del historial
      let cachedHist = null;
      try { cachedHist = localStorage.getItem('turnero_tv_mostrar_historial'); } catch (_) {}
      if (cachedHist !== null) {
        this.mostrarHistorial = cachedHist === 'true';
      }

      this._onResizeHandler = () => this._ajustarTamanoTicket();
      window.addEventListener('resize', this._onResizeHandler);

      // Sincronización instantánea de pestañas en el mismo navegador (Storage Event)
      this._onStorageHandler = (e) => {
        if (e.key === STORAGE_KEY_ESCALA_PRINCIPAL && e.newValue) {
          this._aplicarEscalaPrincipal(e.newValue, false);
        }
        if (e.key === STORAGE_KEY_ESCALA_SECUNDARIA && e.newValue) {
          this._aplicarEscalaSecundaria(e.newValue, false);
        }
        if (e.key === STORAGE_KEY_ESCALA_LEGACY && e.newValue) {
          if (!localStorage.getItem(STORAGE_KEY_ESCALA_PRINCIPAL)) {
            this._aplicarEscalaPrincipal(e.newValue, false);
          }
          if (!localStorage.getItem(STORAGE_KEY_ESCALA_SECUNDARIA)) {
            this._aplicarEscalaSecundaria(e.newValue, false);
          }
        }
        if (e.key === STORAGE_KEY_OPACIDAD_PRINCIPAL && e.newValue) {
          this._aplicarOpacidadPrincipal(e.newValue, false);
        }
        if (e.key === STORAGE_KEY_OPACIDAD_SECUNDARIA && e.newValue) {
          this._aplicarOpacidadSecundaria(e.newValue, false);
        }
        if (e.key === 'turnero_tv_mostrar_historial' && e.newValue !== null) {
          this.mostrarHistorial = e.newValue === 'true';
          this.$nextTick(() => {
            this._ajustarTamanoTicket();
            setTimeout(() => this._ajustarTamanoTicket(), 150);
          });
        }
      };
      window.addEventListener('storage', this._onStorageHandler);

      this._tickClock();
      this._clockTimer    = setInterval(() => this._tickClock(), 1000);
      this._relativoTimer = setInterval(() => this._refrescarTiemposRelativos(), 20000);

      // Anti-stale: verifica cada 30 s si la TV tiene datos frescos mientras está visible.
      // Si el WS está vivo pero la sesión de alguna forma perdió eventos, re-sincroniza.
      this._staleCheckTimer = setInterval(() => this._verificarFrescura(), CFG.staleCheckMs);

      initSpeech();
      this._cargarConfiguracionPublica();
      this._initAutoplay();
      this._initVisibilityChange();
      this._connectWS();
    },

    async _cargarConfiguracionPublica() {
      try {
        const resp = await fetch('/turnos/configuracion-publica');
        if (resp.ok) {
          const data = await resp.json();
          if (typeof data.voz_anuncio_activa === 'boolean') {
            this.vozActiva = data.voz_anuncio_activa;
            setSpeechEnabled(this.vozActiva);
          }
          if (data.tv_escala_principal !== undefined) {
            this._aplicarEscalaPrincipal(data.tv_escala_principal, true);
          } else if (data.tv_escala_turnos !== undefined) {
            this._aplicarEscalaPrincipal(data.tv_escala_turnos, true);
          }
          if (data.tv_escala_secundaria !== undefined) {
            this._aplicarEscalaSecundaria(data.tv_escala_secundaria, true);
          } else if (data.tv_escala_turnos !== undefined) {
            this._aplicarEscalaSecundaria(data.tv_escala_turnos, true);
          }
          if (data.tv_opacidad_principal !== undefined) {
            this._aplicarOpacidadPrincipal(data.tv_opacidad_principal, true);
          }
          if (data.tv_opacidad_secundaria !== undefined) {
            this._aplicarOpacidadSecundaria(data.tv_opacidad_secundaria, true);
          }
          if (data.fondo_imagen_url !== undefined && data.fondo_imagen_activa !== undefined) {
            aplicarFondoPersonalizado(data.fondo_imagen_url, data.fondo_imagen_activa);
          }
        }
      } catch (_) {
        // En caso de fallo de red, ya se inicializó con el último valor guardado en localStorage
      }
    },

    desbloquearAudio() {
      this.audioSuspended = false;
      initSpeech();
    },

    toggleVoz() {
      this.vozActiva = !this.vozActiva;
      setSpeechEnabled(this.vozActiva);
    },

    toggleHistorial() {
      this.mostrarHistorial = !this.mostrarHistorial;
      try {
        localStorage.setItem('turnero_tv_mostrar_historial', String(this.mostrarHistorial));
      } catch (_) {}
      this.$nextTick(() => {
        this._ajustarTamanoTicket();
        setTimeout(() => this._ajustarTamanoTicket(), 150);
      });
    },

    destroy() {
      if (this._clockTimer)    { clearInterval(this._clockTimer);    this._clockTimer    = null; }
      if (this._relativoTimer) { clearInterval(this._relativoTimer); this._relativoTimer = null; }
      if (this._watchdogTimer) { clearTimeout(this._watchdogTimer);  this._watchdogTimer = null; }
      if (this._avanceTimer)   { clearTimeout(this._avanceTimer);    this._avanceTimer   = null; }
      if (this._bannerTimer)   { clearTimeout(this._bannerTimer);    this._bannerTimer   = null; }
      if (this._onResizeHandler) {
        window.removeEventListener('resize', this._onResizeHandler);
        this._onResizeHandler = null;
      }
      if (this._onStorageHandler) {
        window.removeEventListener('storage', this._onStorageHandler);
        this._onStorageHandler = null;
      }
      if (this._onVisibilityHandler) {
        document.removeEventListener('visibilitychange', this._onVisibilityHandler);
        this._onVisibilityHandler = null;
      }
      if (this._ws)            { this._ws.disconnect();              this._ws            = null; }
      if (this._staleCheckTimer) { clearInterval(this._staleCheckTimer); this._staleCheckTimer = null; }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // FORMATEADORES (Contrato semántico con tv.html)
    // ─────────────────────────────────────────────────────────────────────────

    formatTicket(num) {
      if (num === null || num === undefined || num === '' || Number.isNaN(+num)) return '--';
      return String(+num).padStart(3, '0');
    },

    formatMesa(llamado) {
      if (!llamado) return 'MESA --';
      if (typeof llamado === 'string' || typeof llamado === 'number') {
        const str = String(llamado).trim();
        return str.toUpperCase().startsWith('MESA') ? str.toUpperCase() : `MESA ${str}`;
      }
      const num = llamado.mesa_numero !== null && llamado.mesa_numero !== undefined ? llamado.mesa_numero : '';
      if (num !== '') return `MESA ${num}`;
      const nombre = (llamado.mesa_nombre || '').trim();
      const match = nombre.match(/mesa\s*(\d+)/i);
      if (match) return `MESA ${match[1]}`;
      return 'MESA --';
    },

    // ─────────────────────────────────────────────────────────────────────────
    // ESCALAS DINÁMICAS INDEPENDIENTES Y PROTECCIÓN ANTI-DESBORDE (v2.1)
    // ─────────────────────────────────────────────────────────────────────────

    _aplicarEscalaPrincipal(val, guardarCache = true) {
      const num = parseInt(val, 10);
      if (Number.isNaN(num) || num < 75 || num > 140) return;
      this.escalaPrincipal = num;
      this.escalaTurnos = num;
      if (guardarCache) {
        try {
          localStorage.setItem(STORAGE_KEY_ESCALA_PRINCIPAL, String(num));
          localStorage.setItem(STORAGE_KEY_ESCALA_LEGACY, String(num));
        } catch (_) {}
      }
      const factor = (num / 100).toFixed(2);
      document.documentElement.style.setProperty('--tv-escala-principal', factor);
      if (document.body) document.body.style.setProperty('--tv-escala-principal', factor);
      const rootEl = document.getElementById('tv-root');
      if (rootEl) {
        rootEl.style.setProperty('--tv-escala-principal', factor);
        rootEl.style.setProperty('--tv-num-scale', factor);
      }
      this._ajustarTamanoTicket();
    },

    _aplicarEscalaSecundaria(val, guardarCache = true) {
      const num = parseInt(val, 10);
      if (Number.isNaN(num) || num < 75 || num > 140) return;
      this.escalaSecundaria = num;
      if (guardarCache) {
        try {
          localStorage.setItem(STORAGE_KEY_ESCALA_SECUNDARIA, String(num));
        } catch (_) {}
      }
      const factor = (num / 100).toFixed(2);
      document.documentElement.style.setProperty('--tv-escala-secundaria', factor);
      if (document.body) document.body.style.setProperty('--tv-escala-secundaria', factor);
      const rootEl = document.getElementById('tv-root');
      if (rootEl) rootEl.style.setProperty('--tv-escala-secundaria', factor);
      this._ajustarTamanoTicket();
    },

    _aplicarEscalaTurnos(val, guardarCache = true) {
      this._aplicarEscalaPrincipal(val, guardarCache);
      this._aplicarEscalaSecundaria(val, guardarCache);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // OPACIDAD DE TARJETAS TV (Fondo con transparencia)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Aplica la opacidad del fondo de la tarjeta principal (hero).
     * Escribe la variable CSS --tv-opacidad-principal (valor 0.0 a 1.0)
     * tanto en :root como en #tv-root para máxima compatibilidad.
     * @param {number|string} val - Porcentaje entero de 20 a 100
     * @param {boolean} guardarCache - Si guardar en localStorage
     */
    _aplicarOpacidadPrincipal(val, guardarCache = true) {
      const num = parseInt(val, 10);
      if (Number.isNaN(num) || num < 20 || num > 100) return;
      this.opacidadPrincipal = num;
      if (guardarCache) {
        try {
          localStorage.setItem(STORAGE_KEY_OPACIDAD_PRINCIPAL, String(num));
        } catch (_) {}
      }
      const factor = (num / 100).toFixed(2);
      document.documentElement.style.setProperty('--tv-opacidad-principal', factor);
      if (document.body) document.body.style.setProperty('--tv-opacidad-principal', factor);
      const rootEl = document.getElementById('tv-root');
      if (rootEl) rootEl.style.setProperty('--tv-opacidad-principal', factor);
    },

    /**
     * Aplica la opacidad del fondo de las tarjetas de turnos anteriores.
     * @param {number|string} val - Porcentaje entero de 20 a 100
     * @param {boolean} guardarCache - Si guardar en localStorage
     */
    _aplicarOpacidadSecundaria(val, guardarCache = true) {
      const num = parseInt(val, 10);
      if (Number.isNaN(num) || num < 20 || num > 100) return;
      this.opacidadSecundaria = num;
      if (guardarCache) {
        try {
          localStorage.setItem(STORAGE_KEY_OPACIDAD_SECUNDARIA, String(num));
        } catch (_) {}
      }
      const factor = (num / 100).toFixed(2);
      document.documentElement.style.setProperty('--tv-opacidad-secundaria', factor);
      if (document.body) document.body.style.setProperty('--tv-opacidad-secundaria', factor);
      const rootEl = document.getElementById('tv-root');
      if (rootEl) rootEl.style.setProperty('--tv-opacidad-secundaria', factor);
    },

    _ajustarTamanoTicket() {
      // Usar requestAnimationFrame para garantizar medición tras render de layout
      requestAnimationFrame(() => {
        const ticketEl = document.querySelector('.tv-ticket');
        if (!ticketEl || !ticketEl.parentElement) return;
        const parent = ticketEl.parentElement;
        const maxW = parent.clientWidth * 0.95;

        // Reset temporal forzando reflow para medir el ancho natural del número
        ticketEl.style.setProperty('--tv-ticket-fit', '1');
        void ticketEl.offsetWidth;

        const currentW = ticketEl.scrollWidth;

        // Solo ajustar si hay desborde horizontal (ej: números de 4+ cifras o pantallas ultra-angostas)
        // El alto ya está acotado fluidamente por CSS con unidades vh
        if (maxW > 50 && currentW > maxW) {
          const ratioW = Math.max(0.60, Math.min(1.0, maxW / currentW));
          ticketEl.style.setProperty('--tv-ticket-fit', ratioW.toFixed(3));
        } else {
          ticketEl.style.setProperty('--tv-ticket-fit', '1');
        }
      });
    },

    // ─────────────────────────────────────────────────────────────────────────
    // WEBSOCKET HUB & CANAL TV:GLOBAL
    // ─────────────────────────────────────────────────────────────────────────

    _connectWS() {
      if (this._ws) {
        this._ws.connect();
        return;
      }
      this._ws = new TurneroWSClient({ canal: 'tv:global' });

      this._ws.onStatusChange(({ status, attempt, nextDelay }) => {
        if (status === 'CONECTADO') {
          this.wsConnected = true;
          if (this._bannerTimer) { clearTimeout(this._bannerTimer); this._bannerTimer = null; }
          this.reconnecting = false;
        } else if (status === 'RECONECTANDO' || status === 'DESCONECTADO') {
          this.wsConnected = false;
          const seg = Math.round((nextDelay || 0) / 1000);
          this.reconnectMsg       = attempt ? `Reintento #${attempt} en ${seg}s...` : 'Reconectando con el servidor central...';
          this.reconnectCountdown = this.reconnectMsg;
          if (!this._bannerTimer) {
            this._bannerTimer = setTimeout(() => {
              this.reconnecting = true;
              this._bannerTimer = null;
            }, CFG.graciaBannerMs);
          }
        }
      });

      // Manejadores de eventos de la TV
      this._ws.on('nuevo_llamado', (p, ts, raw) => this._onNuevoLlamado(p, raw));
      this._ws.on('turno_rellamado', (p, ts, raw) => this._onRellamado(p, raw));
      this._ws.on('rellamado', (p, ts, raw) => this._onRellamado(p, raw)); // Alias retrocompatible
      this._ws.on('snapshot', (p) => this._onSnapshot(p));
      // Registrar la secuencia monotónica más alta de cualquier mensaje del canal
      this._ws.on('*', (rawMsg) => {
        if (rawMsg && typeof rawMsg.seq === 'number') {
          this._lastSeqRecibido = Math.max(this._lastSeqRecibido, rawMsg.seq);
        }
      });

      // Vista previa instantánea enviada desde el panel de administración
      this._ws.on('preview_escala_tv', (p) => {
        if (!p) return;
        if (p.clave === 'tv_escala_principal' || p.tipo === 'principal') {
          this._aplicarEscalaPrincipal(p.valor, true);
        } else if (p.clave === 'tv_escala_secundaria' || p.tipo === 'secundaria') {
          this._aplicarEscalaSecundaria(p.valor, true);
        }
      });

      // Vista previa de opacidad enviada desde el panel de administración
      this._ws.on('preview_opacidad_tv', (p) => {
        if (!p) return;
        if (p.tipo === 'principal') {
          this._aplicarOpacidadPrincipal(p.valor, true);
        } else if (p.tipo === 'secundaria') {
          this._aplicarOpacidadSecundaria(p.valor, true);
        }
      });

      this._ws.on('config_actualizada', (p) => {
        if (!p) return;
        if (p.clave === 'voz_anuncio_activa') {
          const activa = String(p.valor).toLowerCase() === 'true';
          this.vozActiva = activa;
          setSpeechEnabled(activa);
        }
        if (p.clave === 'tv_escala_principal') {
          this._aplicarEscalaPrincipal(p.valor, true);
        }
        if (p.clave === 'tv_escala_secundaria') {
          this._aplicarEscalaSecundaria(p.valor, true);
        }
        if (p.clave === 'tv_escala_turnos') {
          this._aplicarEscalaTurnos(p.valor, true);
        }
        if (p.clave === 'tv_opacidad_principal') {
          this._aplicarOpacidadPrincipal(p.valor, true);
        }
        if (p.clave === 'tv_opacidad_secundaria') {
          this._aplicarOpacidadSecundaria(p.valor, true);
        }
        if (p.clave === 'modo_generacion_turnos') {
          this.modo = p.valor;
          this._solicitarSnapshot();
        }
        // F-9: kiosko_web_activo también cambia el modo de la TV
        if (p.clave === 'kiosko_web_activo') {
          this.modo = p.valor === 'true' ? 'kiosko_web' : 'voucher_fisico';
        }
        if (p.clave === 'fondo_imagen_url' || p.clave === 'fondo_imagen_activa') {
          this._cargarConfiguracionPublica();
        }
      });

      // F-5: Nuevo lote activado — solicitar snapshot para sincronizar próximo número y modo
      this._ws.on('lote_activado', () => {
        this._solicitarSnapshot();
      });

      // F-6/F-7: Lote pausado o cerrado — la TV es display pasivo, no llama turnos.
      // Solo sincronizar estado vía snapshot para que el próximo número quede en null.
      this._ws.on('lote_pausado', () => {
        this.proximoNumero = null;
      });
      this._ws.on('lote_cerrado', () => {
        this.proximoNumero = null;
      });

      // Extensión en caliente del lote activo — actualizar próximo número visible en pantalla
      this._ws.on('lote_extendido', (p) => {
        if (!p) return;
        if (p.proximo_numero !== undefined) {
          this.proximoNumero = p.proximo_numero;
        }
      });

      // Contador Kiosko reiniciado por el Administrador
      this._ws.on('contador_kiosko_reiniciado', () => {
        this.proximoNumero = null;
        this._cola = [];
        this._colaRellamados = [];
        this._actualizarContadorCola();
        this._solicitarSnapshot();
      });

      this._ws.connect();
    },

    _solicitarSnapshot() {
      if (this._ws && this.wsConnected) {
        this._ws.send('solicitar_snapshot', {});
      }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // ENTRADA DE EVENTOS A LA COLA
    // ─────────────────────────────────────────────────────────────────────────

    _onNuevoLlamado(payload, rawMsg) {
      if (!payload) return;

      const numero = payload.numero ?? payload.turno;
      if (numero === undefined || numero === null || Number.isNaN(+numero)) return;
      const numVal = Number(numero);

      const mesa_numero = payload.mesa_numero ?? payload.mesa ?? '';
      let proximo       = payload.proximo ?? payload.proximo_numero ?? null;
      if (proximo === null) {
        if (!payload.es_rezagado && this.modo !== 'kiosko_web') {
          proximo = numVal + 1;
        } else {
          proximo = this.proximoNumero;
        }
      }
      const llamado_en  = payload.llamado_en ?? new Date().toISOString();

      // Normalizar seq de WebSocket y unicidad por evento
      const wsSeq = (rawMsg && typeof rawMsg.seq === 'number') ? rawMsg.seq : (typeof payload.seq === 'number' ? payload.seq : null);
      const eventoId = payload.evento_id || (wsSeq !== null ? `ws_${wsSeq}` : `llamado_${payload.origen || 't'}_${numero}_${llamado_en}`);

      if (!this._seqVistos) this._seqVistos = new Set();

      // Registro de secuencia monotónica del canal WebSocket (sin falsas alertas de hueco:
      // TCP garantiza orden y entrega en vivo; reconexiones y snapshots son gestionados por ws-client).
      if (wsSeq !== null) {
        this._lastSeqRecibido = Math.max(this._lastSeqRecibido, wsSeq);
      }

      // ── DEDUPLICACIÓN ESTRICTA POR EVENTO ÚNICO ─────────────────────────
      // Previene duplicados de red sin descartar llamadas a números legítimos (ej: tras reset de kiosko o lotes nuevos)
      if (this._seqVistos.has(eventoId)) return;
      if (wsSeq !== null && this._seqVistos.has(`ws_seq_${wsSeq}`)) return;
      if (this._cola.some(c => c.eventoId === eventoId)) return;
      if (this.ultimoLlamado && this.ultimoLlamado.eventoId === eventoId) return;

      this._seqVistos.add(eventoId);
      if (wsSeq !== null) this._seqVistos.add(`ws_seq_${wsSeq}`);

      // Limitar tamaño del set de deduplicación
      if (this._seqVistos.size > CFG.maxSeqVistos) {
        const oldest = [...this._seqVistos].slice(0, 50);
        oldest.forEach(s => this._seqVistos.delete(s));
      }

      // Preparar ítem para la cola
      const item = {
        tipo:        'nuevo',
        eventoId,
        seq:         wsSeq ?? Date.now(),
        numero:      Number(numero),
        mesa_numero,
        proximo:     proximo !== null && proximo !== undefined ? Number(proximo) : null,
        llamado_en,
        es_rezagado: !!payload.es_rezagado
      };

      // Deduplicación estricta (10s): si el turno es idéntico al del Hero o ya fue reproducido
      // en los últimos 10 segundos, o si ya existe un turno idéntico para la misma mesa esperando en cola,
      // descartar duplicado sin importar si llegó por evento en vivo o por snapshot.
      const claveTurno = `${item.numero}_${item.mesa_numero}`;
      this._turnosHabladosRecientes = this._turnosHabladosRecientes || new Map();
      const ultimoHabladoTs = this._turnosHabladosRecientes.get(claveTurno) || 0;
      const fueHabladoReciente = (Date.now() - ultimoHabladoTs < 10000);

      const esDuplicadoEnHero = this.ultimoLlamado &&
        Number(this.ultimoLlamado.numero) === item.numero &&
        String(this.ultimoLlamado.mesa_numero) === String(item.mesa_numero) &&
        (Date.now() - new Date(this.ultimoLlamado.llamado_en).getTime() < 10000);

      const esDuplicadoEnCola = this._cola.length > 0 &&
        this._cola.some(c => c.numero === item.numero && String(c.mesa_numero) === String(item.mesa_numero));

      if (esDuplicadoEnHero || esDuplicadoEnCola || fueHabladoReciente) {
        return;
      }

      // Deduplicación para rezagados: si el operador presiona dos veces o el servidor reenvía,
      // limitar a 1 rezagado/re-llamado pendiente por número de turno en la cola activa.
      if (item.es_rezagado && this._cola.some(c => (c.es_rezagado || c.tipo === 'rellamado') && c.numero === item.numero)) {
        return;
      }

      // Si la llamada es extremadamente antigua (> 60s), se añade en silencio al historial
      const edad = Date.now() - new Date(llamado_en).getTime() + this._serverTimeOffset;
      if (edad > CFG.antiguedadMaxMs && !this._reproduciendo && this.ultimoLlamado.numero !== null) {
        this._agregarAlHistorial({
          numero: item.numero,
          mesa_numero: item.mesa_numero,
          llamado_en: item.llamado_en
        });
        return;
      }

      // Cola FIFO única: todo entra al final en el orden en que el servidor lo emitió.
      // Llamado normal, re-llamado y rezagado son exactamente lo mismo aquí.
      this._cola.push(item);

      // Control de tamaño máximo de cola
      while (this._cola.length > CFG.maxCola) {
        const descartado = this._cola.shift();
        if (descartado) {
          this._agregarAlHistorial({
            numero:      descartado.numero,
            mesa_numero: descartado.mesa_numero,
            llamado_en:  descartado.llamado_en
          });
        }
      }

      this._actualizarContadorCola();
      this._despacharReproductor();
    },

    _onRellamado(payload, rawMsg) {
      if (!payload) return;

      const numero = payload.numero ?? payload.turno;
      if (numero === undefined || numero === null || Number.isNaN(+numero)) return;

      const mesa_numero = payload.mesa_numero ?? payload.mesa ?? '';
      const llamado_en  = payload.llamado_en ?? new Date().toISOString();
      const eventoId    = payload.evento_id || `rellamado_${Date.now()}_${numero}`;

      // Actualizar el contador de secuencia WS también aquí (no solo en _onNuevoLlamado)
      const wsSeq = (rawMsg && typeof rawMsg.seq === 'number') ? rawMsg.seq : null;
      if (wsSeq !== null) {
        this._lastSeqRecibido = Math.max(this._lastSeqRecibido, wsSeq);
      }

      if (!this._seqVistos) this._seqVistos = new Set();
      if (this._seqVistos.has(eventoId)) return;

      // Deduplicación de re-llamados en cola:
      // Limitar a 1 re-llamado/rezagado pendiente por número de turno en la cola activa.
      // (Después de reproducirse, se puede volver a re-llamar sin restricción.)
      if (this._cola.some(c => (c.tipo === 'rellamado' || c.es_rezagado) && c.numero === Number(numero))) {
        return;
      }

      // Si el hero actual ya está reproduciendo el re-llamado de este turno, descartar emisión duplicada
      if (this.ultimoLlamado && this.glowState === 'rellamado' && Number(this.ultimoLlamado.numero) === Number(numero)) {
        return;
      }

      this._seqVistos.add(eventoId);

      // El re-llamado entra al final de la cola única, en el orden en que llegó.
      this._cola.push({
        tipo:        'rellamado',
        eventoId,
        seq:         wsSeq ?? Date.now(),
        numero:      Number(numero),
        mesa_numero,
        llamado_en
      });

      this._actualizarContadorCola();
      this._despacharReproductor();
    },

    _actualizarContadorCola() {
      this.colaPendiente = this._cola.length;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // REPRODUCTOR & MÁQUINA DE ESTADOS (Una Sola Fuente de Verdad)
    // ─────────────────────────────────────────────────────────────────────────

    _despacharReproductor() {
      // Guard de re-entrada: si ya hay un ciclo de reproducción activo, no arrancar otro.
      // _reproduciendo cubre el caso normal; este guard cubre el instante entre que
      // _avanceTimer y el watchdog disparan casi al mismo tiempo.
      if (this._reproduciendo) return;
      this._reproducirSiguiente();
    },

    async _reproducirSiguiente() {
      // Cola vacía: máquina de estados en reposo
      if (this._cola.length === 0) {
        this._reproduciendo = false;
        this.colaPendiente  = 0;
        this.glowState      = 'idle';
        if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
        return;
      }

      this._reproduciendo = true;

      // Watchdog de seguridad: si speakCall nunca resuelve (bug del navegador),
      // el watchdog avanza la cola tras 12 s para que no quede congelada.
      if (this._watchdogTimer) clearTimeout(this._watchdogTimer);
      this._watchdogTimer = setTimeout(() => {
        console.warn('[TV] Watchdog activado (> 15 s sin terminar). Forzando avance.');
        this._forzarAvanceWatchdog();
      }, CFG.watchdogMs);

      // FIFO estricto: el primero en llegar es el primero en anunciarse, siempre
      const item = this._cola.shift();
      this._actualizarContadorCola();
      await this._ejecutarAnuncio(item);
    },

    _ejecutarAnuncio(item) {
      // Devuelve una Promise que resuelve solo cuando el temporizador FIJO de visualización
      // expira. El audio (campana + voz) se reproduce en paralelo; si termina antes del
      // tiempo fijo, la tarjeta sigue visible hasta completar CFG.tiempoVisualizacionMs.
      // Esto garantiza:
      //   1. Tiempo de exhibición uniforme en TODAS las pantallas TV.
      //   2. La tarjeta nunca pasa volando si el audio fue rápido o falló.
      //   3. El audio nunca se corta (la Promise de speakCall sigue en vuelo aunque
      //      el temporizador de exhibición ya terminó).
      return new Promise((resolve) => {
        const esRellamado = item.tipo === 'rellamado';

        if (esRellamado) {
          // ── RE-LLAMADO (SEGUNDO AVISO) ────────────────────────────────────
          // Comportamiento esperado:
          //  · Muestra el turno en el Hero con estilo ámbar transitoriamente.
          //  · NO expulsa el último turno legítimo (_ultimoLlamadoReal) al historial.
          //  · NO entra al historial al terminar.
          //  · Al terminar: si la cola queda vacía, restaura _ultimoLlamadoReal en el Hero.
          this.ultimoLlamado = {
            eventoId:    item.eventoId,
            numero:      item.numero,
            mesa_numero: item.mesa_numero,
            // El proximo sigue siendo el del último turno legítimo (no del re-llamado)
            proximo:     this._ultimoLlamadoReal ? this._ultimoLlamadoReal.proximo : this.proximoNumero,
            llamado_en:  item.llamado_en
          };
          this.glowState = 'rellamado';
        } else {
          // ── TURNO NORMAL O REZAGADO ───────────────────────────────────────
          // El hero anterior (legítimo) pasa al historial solo en turnos no-rellamado.
          const heroAnterior = (this.ultimoLlamado && this.ultimoLlamado.numero !== null)
            ? { ...this.ultimoLlamado }
            : null;

          let prox = item.proximo ?? null;
          if (prox === null) {
            if (!item.es_rezagado && this.modo !== 'kiosko_web') {
              prox = Number(item.numero) + 1;
            } else {
              prox = this.proximoNumero;
            }
          }

          this.ultimoLlamado = {
            eventoId:    item.eventoId,
            numero:      item.numero,
            mesa_numero: item.mesa_numero,
            proximo:     prox,
            llamado_en:  item.llamado_en
          };

          // Guardar como último turno legítimo (no re-llamados)
          this._ultimoLlamadoReal = { ...this.ultimoLlamado };
          this.proximoNumero = prox !== null && prox !== undefined ? Number(prox) : null;

          // El turno del hero nunca aparece en el historial
          this.historial = this.historial.filter(h => Number(h.numero) !== Number(item.numero));

          // El hero anterior legítimo pasa al historial
          if (heroAnterior && Number(heroAnterior.numero) !== Number(item.numero)) {
            this._agregarAlHistorial({
              numero:         heroAnterior.numero,
              mesa_numero:    heroAnterior.mesa_numero,
              llamado_en:     heroAnterior.llamado_en,
              tiempoRelativo: 'Hace un instante'
            });
          }

          this.glowState = 'nuevo';
        }

        this._lastSeqAnunciado = Math.max(this._lastSeqAnunciado, item.seq ?? 0);
        this._ajustarTamanoTicket();

        // Registrar timestamp de locución para blindaje anti-duplicación (10s)
        if (!this._turnosHabladosRecientes) this._turnosHabladosRecientes = new Map();
        this._turnosHabladosRecientes.set(`${item.numero}_${item.mesa_numero}`, Date.now());

        // ── AUDIO (campana + voz) en paralelo al temporizador de exhibición ──
        // Se lanzan sin await: el temporizador fijo es la única señal de avance.
        playCallChime()
          .then(() => speakCall({ numero: item.numero, mesa_numero: item.mesa_numero }))
          .catch(err => console.warn('[TV] Error en anuncio multimedia:', err));

        // ── TEMPORIZADOR FIJO DE EXHIBICIÓN ──────────────────────────────────
        // La tarjeta dura exactamente CFG.tiempoVisualizacionMs en pantalla,
        // sin importar cuánto tardó el audio.
        if (this._avanceTimer) clearTimeout(this._avanceTimer);
        this._avanceTimer = setTimeout(() => {
          this._avanceTimer = null;
          if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }

          // Si era un re-llamado y la cola ya quedó vacía, restaurar el hero legítimo
          if (esRellamado && this._cola.length === 0 && this._ultimoLlamadoReal) {
            this.ultimoLlamado = { ...this._ultimoLlamadoReal };
            this.proximoNumero = this._ultimoLlamadoReal.proximo ?? null;
          }

          this.glowState = 'idle';
          resolve();
          this._reproducirSiguiente();
        }, CFG.tiempoVisualizacionMs);
      });
    },

    _forzarAvanceWatchdog() {
      if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
      if (this._avanceTimer)   { clearTimeout(this._avanceTimer);   this._avanceTimer   = null; }
      this.glowState = 'idle';
      this._reproducirSiguiente();
    },

    // ─────────────────────────────────────────────────────────────────────────
    // GESTIÓN DEL HISTORIAL (Solo turnos que ya terminaron de anunciarse)
    // ─────────────────────────────────────────────────────────────────────────

    _agregarAlHistorial({ numero, mesa_numero, llamado_en, tiempoRelativo }) {
      if (numero === null || numero === undefined) return;

      const numVal = Number(numero);

      // INVARIANTE ABSOLUTA: El turno del Hero NUNCA entra al historial
      if (this.ultimoLlamado && Number(this.ultimoLlamado.numero) === numVal) {
        return;
      }

      // Si el turno ya figuraba en el historial (ej: rezagado re-llamado), remover su entrada previa
      const idxExistente = this.historial.findIndex(h => Number(h.numero) === numVal);
      if (idxExistente !== -1) {
        this.historial.splice(idxExistente, 1);
      }

      this.historial.unshift({
        numero:         numVal,
        mesa_numero,
        llamado_en,
        tiempoRelativo: tiempoRelativo || this._calcTiempoRelativo(llamado_en)
      });

      // Garantizar que ningún turno del historial coincida con el hero activo
      if (this.ultimoLlamado && this.ultimoLlamado.numero !== null) {
        this.historial = this.historial.filter(h => Number(h.numero) !== Number(this.ultimoLlamado.numero));
      }

      // Máximo 4 turnos históricos (RF-TV-02)
      if (this.historial.length > 4) {
        this.historial.splice(4);
      }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // SNAPSHOT (Hidratación inicial o recuperación de desconexión)
    // ─────────────────────────────────────────────────────────────────────────

    _onSnapshot(payload) {
      if (!payload) return;

      if (!this._seqVistos) this._seqVistos = new Set();

      if (payload.server_time) {
        this._serverTimeOffset = Date.now() - new Date(payload.server_time).getTime();
      }

      const ultimo  = payload.ultimo_llamado ?? (Array.isArray(payload.historial) ? payload.historial[0] : null);
      const histArr = Array.isArray(payload.historial) ? payload.historial : [];
      let proximo   = payload.proximo_numero ?? null;
      if (proximo === null && payload.modo !== 'kiosko_web' && ultimo && ultimo.numero) {
        proximo = Number(ultimo.numero) + 1;
      }

      if (payload.modo) {
        this.modo = payload.modo;
      }
      if (!this._reproduciendo) {
        this.proximoNumero = proximo !== null ? Number(proximo) : null;
      }

      // CASO A: Hidratación inicial en frío (pantalla vacía sin turnos ni actividad)
      if (this.ultimoLlamado.numero === null && !this._reproduciendo && this._cola.length === 0) {
        if (ultimo) {
          const uKey = ultimo.evento_id || (`snap_${ultimo.id || ultimo.llamado_en || ''}_${ultimo.numero}`);
          this.ultimoLlamado = {
            eventoId:    uKey,
            numero:      Number(ultimo.numero),
            mesa_numero: ultimo.mesa_numero,
            mesa_nombre: ultimo.mesa_nombre,
            proximo:     proximo !== null ? Number(proximo) : null,
            llamado_en:  ultimo.llamado_en
          };
          this._ultimoLlamadoReal = { ...this.ultimoLlamado };
          this.proximoNumero      = proximo !== null ? Number(proximo) : null;
          this.glowState          = 'idle';
          this._ajustarTamanoTicket();

          this._seqVistos.add(uKey);
          if (ultimo.seq) this._seqVistos.add(`ws_seq_${ultimo.seq}`);
        }

        // Historial inicial silencioso (garantizando que nunca incluya el hero)
        const heroNum = this.ultimoLlamado && this.ultimoLlamado.numero !== null ? Number(this.ultimoLlamado.numero) : null;
        this.historial = histArr
          .filter(h => h && h.numero !== null && Number(h.numero) !== heroNum)
          .slice(0, 4)
          .map(h => ({
            numero:         Number(h.numero),
            mesa_numero:    h.mesa_numero,
            llamado_en:     h.llamado_en,
            tiempoRelativo: this._calcTiempoRelativo(h.llamado_en)
          }));
        return;
      }

      // CASO B: Sincronización o recuperación de snapshot con la pantalla activa
      // Si el reproductor no está en medio de una locución, sincronizar directamente
      if (!this._reproduciendo && this._cola.length === 0) {
        if (ultimo) {
          const uKey = ultimo.evento_id || (`snap_${ultimo.id || ultimo.llamado_en || ''}_${ultimo.numero}`);
          this.ultimoLlamado = {
            eventoId:    uKey,
            numero:      Number(ultimo.numero),
            mesa_numero: ultimo.mesa_numero,
            mesa_nombre: ultimo.mesa_nombre,
            proximo:     proximo !== null ? Number(proximo) : null,
            llamado_en:  ultimo.llamado_en
          };
          this._ultimoLlamadoReal = { ...this.ultimoLlamado };
          this.proximoNumero      = proximo !== null ? Number(proximo) : null;
          this._ajustarTamanoTicket();
        }

        // Sincronizar historial directamente de la base de datos sin incluir el hero
        const heroNum = this.ultimoLlamado && this.ultimoLlamado.numero !== null ? Number(this.ultimoLlamado.numero) : null;
        this.historial = histArr
          .filter(h => h && h.numero !== null && Number(h.numero) !== heroNum)
          .slice(0, 4)
          .map(h => ({
            numero:         Number(h.numero),
            mesa_numero:    h.mesa_numero,
            llamado_en:     h.llamado_en,
            tiempoRelativo: this._calcTiempoRelativo(h.llamado_en)
          }));
      }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // RELOJ DIGITAL & TIEMPOS RELATIVOS
    // ─────────────────────────────────────────────────────────────────────────

    _tickClock() {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      this.relojHora  = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
      this.relojFecha = `${pad(now.getDate())} ${meses[now.getMonth()]} ${now.getFullYear()}`;
    },

    _calcTiempoRelativo(isoDate) {
      if (!isoDate) return 'En espera';
      const diffSecs = Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime() + this._serverTimeOffset) / 1000));
      if (diffSecs < 45) return 'Hace un instante';
      const m = Math.floor(diffSecs / 60);
      if (m === 1) return 'Hace 1 min';
      if (m < 60)  return `Hace ${m} min`;
      return `Hace ${Math.floor(m / 60)} h`;
    },

    _refrescarTiemposRelativos() {
      this.historial = this.historial.map(h => ({
        ...h,
        tiempoRelativo: this._calcTiempoRelativo(h.llamado_en)
      }));
    },

    // ─────────────────────────────────────────────────────────────────────────
    // AUTOPLAY AUDIO & CONTROL DE VISIBILIDAD
    // ─────────────────────────────────────────────────────────────────────────

    _initAutoplay() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          const testCtx = new AC();
          this.audioSuspended = testCtx.state === 'suspended';
          testCtx.close().catch(() => {});
        }
      } catch (_) {}

      const unlock = () => {
        playCallChime().then(() => { this.audioSuspended = false; }).catch(() => {});
      };
      document.addEventListener('click',      unlock, { once: true });
      document.addEventListener('keydown',    unlock, { once: true });
      document.addEventListener('touchstart', unlock, { once: true, passive: true });
    },

    _initVisibilityChange() {
      this._onVisibilityHandler = () => {
        if (document.visibilityState !== 'visible') {
          // Al ir a background: no hacer nada — la cola se preserva íntegra.
          return;
        }

        // ── Al volver a estar visible ─────────────────────────────────────────

        // 1. Si Chrome pausó la síntesis en background (pestaña oculta), reanudarla.
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          try {
            const ss = window.speechSynthesis;
            if (ss.paused) ss.resume();
          } catch (_) {}
        }

        // 2. INVARIANTE: NUNCA purgar la cola ni resetear _reproduciendo aquí.
        // El reproductor puede estar procesando en background. Si se fuerza
        // _reproduciendo = false, se generaría una segunda instancia concurrente
        // del reproductor. La cola FIFO debe preservarse completa y continuar
        // desde donde estaba. Solo se despacha si el reproductor quedó en reposo.
        if (!this._reproduciendo) {
          if (this._cola.length > 0) {
            // Hay turnos esperando que no se pudieron procesar → despachar ahora
            this._despacharReproductor();
          } else {
            // Cola vacía: pedir snapshot al volver visible para sincronizar estado
            this._solicitarSnapshot();
            this._verificarFrescura();
          }
        }
        // Si _reproduciendo === true: el reproductor ya está corriendo y terminará
        // naturalmente. No hay que hacer nada más.
      };
      document.addEventListener('visibilitychange', this._onVisibilityHandler);
    },

    /**
     * Verifica y corrige el estado de la TV cada CFG.staleCheckMs (30 s).
     * Estrategia sin HTTP protegido:
     *  - Si el WS está vivo: pide snapshot (actor más eficiente).
     *  - Si el WS está caído: activa reconexión (el ws-client ya tiene backoff).
     * En ambos casos actualiza vozBloqueada.
     * Solo actúa si la pestaña está visible.
     */
    _verificarFrescura() {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

      if (this.wsConnected) {
        // WS activo: pedir snapshot; la respuesta actualiza hero + historial + config
        this._solicitarSnapshot();
      } else if (this._ws) {
        // WS caído silenciosamente: intentar reconectar
        // (ws-client maneja el backoff exponencial internamente)
        this._ws.connect();
      }

      // Actualizar indicador de voz bloqueada
      if (this.vozActiva) {
        this.vozBloqueada = isSpeechBlocked();
      } else {
        this.vozBloqueada = false;
      }
    }
  };
}

// ── Registro idempotente con Alpine.js ──────────────────────────────────────
function registerTvWithAlpine() {
  if (typeof window !== 'undefined' && window.Alpine) {
    window.Alpine.data('tvView', tvView);
  }
}

if (typeof window !== 'undefined' && window.Alpine) {
  registerTvWithAlpine();
} else if (typeof document !== 'undefined') {
  document.addEventListener('alpine:init', registerTvWithAlpine);
}
