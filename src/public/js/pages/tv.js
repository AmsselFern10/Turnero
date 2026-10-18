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
import { playCallChime } from '../utils.js';
import { speakCall, setSpeechEnabled, initSpeech } from '../audio/speech.js';

// ── Configuración central de tiempos (ms) ────────────────────────────────────
const CFG = {
  anuncioBaseMs:     4000,
  anuncioMinMs:      2200,
  rellamadoMinMs:    2000,
  antiguedadMaxMs:  60000,
  graciaBannerMs:    3000,
  watchdogMs:       12000,
  maxCola:             50,
  maxSeqVistos:       300,
};

const STORAGE_KEY_ESCALA_PRINCIPAL  = 'turnero_tv_escala_principal';
const STORAGE_KEY_ESCALA_SECUNDARIA = 'turnero_tv_escala_secundaria';
const STORAGE_KEY_ESCALA_LEGACY     = 'turnero_tv_escala_turnos';

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

    // ── Propiedades privadas (control de máquina de estados y timers) ────────
    _ws:                null,
    _cola:              [],     // FIFO de turnos normales
    _colaRellamados:    [],     // Cola prioritaria de re-llamados
    _seqVistos:         null,   // Set de seq y evento_id procesados
    _ultimoLlamadoReal: null,   // Respaldo del último llamado oficial durante re-llamados
    _reproduciendo:     false,
    _reproduciendoTipo: null,   // 'nuevo' | 'rellamado' | null
    _lastSeqAnunciado:  0,
    _lastSeqRecibido:   0,

    // Timers y listeners
    _watchdogTimer:     null,
    _avanceTimer:       null,
    _bannerTimer:       null,
    _clockTimer:        null,
    _relativoTimer:     null,
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
      this._colaRellamados = [];

      // Aplicar escalas guardadas inmediatamente en offline/arranque
      let cachedPrincipal  = null;
      let cachedSecundaria = null;
      let cachedLegacy     = null;
      try {
        cachedPrincipal  = localStorage.getItem(STORAGE_KEY_ESCALA_PRINCIPAL);
        cachedSecundaria = localStorage.getItem(STORAGE_KEY_ESCALA_SECUNDARIA);
        cachedLegacy     = localStorage.getItem(STORAGE_KEY_ESCALA_LEGACY);
      } catch (_) {}

      const pInit = cachedPrincipal || cachedLegacy || 100;
      const sInit = cachedSecundaria || cachedLegacy || 100;
      this._aplicarEscalaPrincipal(pInit, false);
      this._aplicarEscalaSecundaria(sInit, false);

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
        }
      } catch (_) {
        // En caso de fallo de red, ya se inicializó con el último valor guardado en localStorage
      }
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

      // Vista previa instantánea enviada desde el panel de administración
      this._ws.on('preview_escala_tv', (p) => {
        if (!p) return;
        if (p.clave === 'tv_escala_principal' || p.tipo === 'principal') {
          this._aplicarEscalaPrincipal(p.valor, true);
        } else if (p.clave === 'tv_escala_secundaria' || p.tipo === 'secundaria') {
          this._aplicarEscalaSecundaria(p.valor, true);
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
        if (p.clave === 'modo_generacion_turnos') {
          this.modo = p.valor;
          this._solicitarSnapshot();
        }
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

      // ── DEDUPLICACIÓN POR NÚMERO DE TURNO ─────────────────────────
      // Los turnos rezagados se anuncian siempre (aunque su número ya se haya anunciado antes)
      if (!payload.es_rezagado) {
        if (this.ultimoLlamado && Number(this.ultimoLlamado.numero) === numVal) return;
        if (this._cola.some(c => Number(c.numero) === numVal)) return;
        if (this.historial.some(h => Number(h.numero) === numVal)) return;
      } else {
        // Para rezagados, evitar duplicar solo si el mismo evento ya está en cola
        const rezEventoId = payload.evento_id || `rezagado_${numero}_${payload.llamado_en || Date.now()}`;
        if (this._cola.some(c => c.eventoId === rezEventoId)) return;
      }

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

      // Detección de hueco en seq monotónica (solo si hay wsSeq válido)
      if (wsSeq !== null) {
        if (this._lastSeqRecibido > 0 && wsSeq > this._lastSeqRecibido + 1) {
          console.warn(`[TV] Hueco de seq detectado (esperado ${this._lastSeqRecibido + 1}, recibido ${wsSeq}). Solicitando snapshot.`);
          this._solicitarSnapshot();
        }
        this._lastSeqRecibido = Math.max(this._lastSeqRecibido, wsSeq);
      }

      // Deduplicación estricta por evento único
      if (this._seqVistos.has(eventoId)) return;
      if (wsSeq !== null && this._seqVistos.has(`ws_seq_${wsSeq}`)) return;

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

      // Inserción FIFO natural
      this._cola.push(item);

      // Control de tamaño máximo de cola
      while (this._cola.length > CFG.maxCola) {
        const descartado = this._cola.shift();
        if (descartado) {
          this._agregarAlHistorial({
            numero: descartado.numero,
            mesa_numero: descartado.mesa_numero,
            llamado_en: descartado.llamado_en
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
      const numVal = Number(numero);

      // Si ya hay un re-llamado pendiente para este mismo turno, ignorar duplicado
      if (this._colaRellamados.some(r => Number(r.numero) === numVal)) return;

      const mesa_numero = payload.mesa_numero ?? payload.mesa ?? '';
      const llamado_en  = payload.llamado_en ?? new Date().toISOString();
      const eventoId    = payload.evento_id || `rellamado_${Date.now()}_${numero}`;

      if (!this._seqVistos) this._seqVistos = new Set();
      if (this._seqVistos.has(eventoId)) return;
      this._seqVistos.add(eventoId);

      const itemRellamado = {
        tipo:        'rellamado',
        eventoId,
        numero:      Number(numero),
        mesa_numero,
        llamado_en
      };

      // Entra con prioridad máxima en la cola de re-llamados (se ejecutará tras el anuncio en curso)
      this._colaRellamados.push(itemRellamado);
      this._actualizarContadorCola();
      this._despacharReproductor();
    },

    _actualizarContadorCola() {
      this.colaPendiente = this._cola.length + this._colaRellamados.length;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // REPRODUCTOR & MÁQUINA DE ESTADOS (Una Sola Fuente de Verdad)
    // ─────────────────────────────────────────────────────────────────────────

    _despacharReproductor() {
      if (this._reproduciendo) return;
      this._reproducirSiguiente();
    },

    async _reproducirSiguiente() {
      // 1. Verificar si hay trabajo pendiente
      if (this._colaRellamados.length === 0 && this._cola.length === 0) {
        this._reproduciendo     = false;
        this._reproduciendoTipo = null;
        this.colaPendiente      = 0;
        this.glowState          = 'idle';
        if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
        return;
      }

      this._reproduciendo = true;

      // Activar Watchdog de seguridad (12 s)
      if (this._watchdogTimer) clearTimeout(this._watchdogTimer);
      this._watchdogTimer = setTimeout(() => {
        console.warn('[TV] Watchdog activado (> 12 s de anuncio sin terminar). Forzando avance seguro.');
        this._forzarAvanceWatchdog();
      }, CFG.watchdogMs);

      // 2. Prioridad a re-llamados (sin alterar la cola normal ni el historial)
      if (this._colaRellamados.length > 0) {
        const rellamado = this._colaRellamados.shift();
        this._actualizarContadorCola();
        await this._ejecutarAnuncioRellamado(rellamado);
        return;
      }

      // 3. Turno normal (FIFO por seq)
      const item = this._cola.shift();
      this._actualizarContadorCola();
      await this._ejecutarAnuncioNuevo(item);
    },

    async _ejecutarAnuncioNuevo(item) {
      this._reproduciendoTipo = 'nuevo';

      // REGLA DE ORO: El turno actual pasa al historial exactamente antes de mostrar el nuevo
      if (this.ultimoLlamado && this.ultimoLlamado.numero !== null) {
        this._agregarAlHistorial({
          numero:         this.ultimoLlamado.numero,
          mesa_numero:    this.ultimoLlamado.mesa_numero,
          llamado_en:     this.ultimoLlamado.llamado_en,
          tiempoRelativo: 'Hace un instante'
        });
      }

      // UNA SOLA FUENTE DE VERDAD: Actualizar hero y próximo
      let prox = item.proximo;
      if (prox === null) {
        if (!item.es_rezagado && this.modo !== 'kiosko_web') {
          prox = Number(item.numero) + 1;
        } else {
          prox = this.proximoNumero;
        }
      }
      this.ultimoLlamado = {
        numero:      item.numero,
        mesa_numero: item.mesa_numero,
        proximo:     prox,
        llamado_en:  item.llamado_en
      };
      this._ultimoLlamadoReal = { ...this.ultimoLlamado };
      this.proximoNumero      = prox !== null && prox !== undefined ? Number(prox) : null;
      this._lastSeqAnunciado  = Math.max(this._lastSeqAnunciado, item.seq);

      this.glowState = 'nuevo';
      this._ajustarTamanoTicket();

      // Calcular duración mínima adaptativa según saturación de cola
      const pendientes = this._cola.length + this._colaRellamados.length;
      let duracionMinima = CFG.anuncioBaseMs;
      if (pendientes >= 5) {
        duracionMinima = CFG.anuncioMinMs; // 2200 ms
      } else if (pendientes >= 2) {
        duracionMinima = 3000;
      }

      const inicio = Date.now();

      // SECUENCIA DEL ANUNCIADOR: Campana -> esperar fin -> Voz -> esperar onend
      try {
        await playCallChime();
        await speakCall({ numero: item.numero, mesa_numero: item.mesa_numero });
      } catch (err) {
        console.warn('[TV] Error en anuncio multimedia:', err);
      }

      // Garantizar que la duración sea max(duracionMinima, tiempoRealAudio)
      const transcurrido = Date.now() - inicio;
      const remanente    = Math.max(0, duracionMinima - transcurrido);

      if (this._avanceTimer) clearTimeout(this._avanceTimer);
      this._avanceTimer = setTimeout(() => {
        this._avanceTimer = null;
        this.glowState    = 'idle';
        if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
        this._reproducirSiguiente();
      }, remanente);
    },

    async _ejecutarAnuncioRellamado(item) {
      this._reproduciendoTipo = 'rellamado';

      // Respaldar el último llamado legítimo antes de tomar temporalmente el hero
      if (!this._ultimoLlamadoReal && this.ultimoLlamado.numero !== null) {
        this._ultimoLlamadoReal = { ...this.ultimoLlamado };
      }

      // Tomar el hero para el re-llamado: NO entra al historial y NO cambia el último llamado real
      this.ultimoLlamado = {
        numero:      item.numero,
        mesa_numero: item.mesa_numero,
        proximo:     this._ultimoLlamadoReal ? this._ultimoLlamadoReal.proximo : this.proximoNumero,
        llamado_en:  item.llamado_en
      };
      this.glowState = 'rellamado';
      this._ajustarTamanoTicket();

      const duracionMinima = CFG.rellamadoMinMs; // 2000 ms
      const inicio = Date.now();

      // SECUENCIA DEL ANUNCIADOR para re-llamado
      try {
        await playCallChime();
        await speakCall({ numero: item.numero, mesa_numero: item.mesa_numero });
      } catch (err) {
        console.warn('[TV] Error en anuncio de re-llamado:', err);
      }

      const transcurrido = Date.now() - inicio;
      const remanente    = Math.max(0, duracionMinima - transcurrido);

      if (this._avanceTimer) clearTimeout(this._avanceTimer);
      this._avanceTimer = setTimeout(() => {
        this._avanceTimer = null;

        // AL TERMINAR: El hero regresa al último llamado real si no hay otros turnos pendientes en cola
        if (this._cola.length === 0 && this._ultimoLlamadoReal) {
          this.ultimoLlamado = { ...this._ultimoLlamadoReal };
          this.proximoNumero = this._ultimoLlamadoReal.proximo ?? null;
        }
        this.glowState = 'idle';

        if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
        this._reproducirSiguiente();
      }, remanente);
    },

    _forzarAvanceWatchdog() {
      if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
      if (this._avanceTimer)   { clearTimeout(this._avanceTimer);   this._avanceTimer   = null; }

      // Si estábamos en re-llamado, restaurar el hero real
      if (this._reproduciendoTipo === 'rellamado' && this._ultimoLlamadoReal) {
        this.ultimoLlamado = { ...this._ultimoLlamadoReal };
        this.proximoNumero = this._ultimoLlamadoReal.proximo ?? null;
      }

      this.glowState = 'idle';
      this._reproducirSiguiente();
    },

    // ─────────────────────────────────────────────────────────────────────────
    // GESTIÓN DEL HISTORIAL (Solo turnos que ya terminaron de anunciarse)
    // ─────────────────────────────────────────────────────────────────────────

    _agregarAlHistorial({ numero, mesa_numero, llamado_en, tiempoRelativo }) {
      if (numero === null || numero === undefined) return;

      // Si el turno ya figuraba en el historial (ej: rezagado re-llamado), remover su entrada previa
      const idxExistente = this.historial.findIndex(h => Number(h.numero) === Number(numero));
      if (idxExistente !== -1) {
        this.historial.splice(idxExistente, 1);
      }

      this.historial.unshift({
        numero:         Number(numero),
        mesa_numero,
        llamado_en,
        tiempoRelativo: tiempoRelativo || this._calcTiempoRelativo(llamado_en)
      });

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

        // Historial inicial silencioso
        this.historial = [];
        for (const h of histArr) {
          if (!h) continue;
          const hKey = h.evento_id || (`snap_${h.id || h.llamado_en || ''}_${h.numero}`);
          this._seqVistos.add(hKey);
          if (h.seq) this._seqVistos.add(`ws_seq_${h.seq}`);
          this._agregarAlHistorial({
            numero:         Number(h.numero),
            mesa_numero:    h.mesa_numero,
            llamado_en:     h.llamado_en,
            tiempoRelativo: this._calcTiempoRelativo(h.llamado_en)
          });
        }
        return;
      }

      // CASO B: Reconexión con la pantalla ya activa
      // Inyectar en la cola turnos recientes (< 60 s) que no se hayan visto ni anunciado
      const ahora = Date.now();
      const pendientesSnapshot = [];

      const evaluar = (item) => {
        if (!item) return;
        const numVal = Number(item.numero);
        if (Number.isNaN(numVal)) return;

        const sKey = item.evento_id || (item.seq ? `ws_seq_${item.seq}` : `snap_${item.id || item.llamado_en}_${numVal}`);
        if (this._seqVistos.has(sKey)) return;
        this._seqVistos.add(sKey);

        // Si el turno ya está en pantalla, en la cola o en el historial, NUNCA re-anunciar
        if (this.ultimoLlamado && Number(this.ultimoLlamado.numero) === numVal) return;
        if (this._cola.some(c => Number(c.numero) === numVal)) return;
        if (this.historial.some(h => Number(h.numero) === numVal)) return;

        const edad = ahora - new Date(item.llamado_en).getTime() + this._serverTimeOffset;
        if (edad < CFG.antiguedadMaxMs) {
          pendientesSnapshot.push(item);
        }
      };

      evaluar(ultimo);
      for (const h of histArr) evaluar(h);

      // Si hay turnos recientes verdaderamente perdidos durante desconexión, encolarlos
      if (pendientesSnapshot.length > 0) {
        for (const p of pendientesSnapshot) {
          this._onNuevoLlamado(p, { seq: p.seq });
        }
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
        if (document.visibilityState !== 'visible') return;
        // Al volver a la pestaña, descartar elementos con más de 60 s para no atiborrar
        const ahora = Date.now();
        this._cola = this._cola.filter(item => {
          const edad = ahora - new Date(item.llamado_en).getTime();
          if (edad > CFG.antiguedadMaxMs) {
            this._agregarAlHistorial({
              numero: item.numero,
              mesa_numero: item.mesa_numero,
              llamado_en: item.llamado_en
            });
            return false;
          }
          return true;
        });
        this._actualizarContadorCola();
      };
      document.addEventListener('visibilitychange', this._onVisibilityHandler);
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

