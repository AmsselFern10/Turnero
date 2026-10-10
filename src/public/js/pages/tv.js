/**
 * ==============================================================================
 * TV.JS — Controlador Pantalla Pública 1080p Pasiva y Autónoma
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cumple con:
 * - RF-TV-01 a RF-TV-06: Display colosal a 5 metros, anticipación, historial FIFO
 * - RNF-DIS-03 / RF-TV-05: Resiliencia a cortes (banner ámbar, nunca pantalla en blanco)
 * - RNF-DIS-06: Audio híbrido (bell.mp3 + Web Audio API C5/E5 offline fallback)
 * ==============================================================================
 */

import { TurneroWSClient } from '../ws-client.js';
import { playCallChime } from '../utils.js';

export function tvView() {
  return {
    // Turno actualmente convocado
    ultimoLlamado: {
      numero: null,
      mesa_numero: null,
      mesa_nombre: '',
      lote_numero: null,
      llamado_en: null
    },

    // Anticipación: Siguiente en fila
    proximoNumero: null,

    // Historial dinámico FIFO (Exactamente 4 turnos precedentes)
    historial: [],

    // Estado del resplandor visual: 'idle' | 'nuevo' | 'rellamado'
    glowState: 'idle',
    glowTimer: null,

    // Resiliencia de red y banner de reconexión
    ws: null,
    wsConnected: true,
    reconnecting: false,
    reconnectMsg: 'Reconectando con el servidor central de turnos... El último llamado permanece en pantalla.',
    reconnectCountdown: '',

    // Reloj Full HD sincronizado al segundo
    relojHora: '--:--:--',
    relojFecha: '',
    relojTimer: null,
    relativoTimer: null,

    /**
     * Inicialización del display pasivo de auditorio
     */
    init() {
      // 1. Iniciar reloj digital en tiempo real
      this._initClock();

      // 2. Iniciar actualizador de tiempos relativos de historial ("Hace 2 min")
      this._initRelativeTimeUpdater();

      // 3. Listener global de interacción para desbloquear AudioContext en Smart TVs
      this._initAutoplayBypass();

      // 4. Conectar WebSocket al canal 'tv:global'
      this.initWebSocket();
    },

    /**
     * Formatea el número de turno con 3 dígitos tabulares (042)
     */
    formatTicket(num) {
      if (num === null || num === undefined || num === '' || isNaN(num)) return '--';
      return String(num).padStart(3, '0');
    },

    /**
     * Formatea el destino de ventanilla
     */
    formatMesa(llamado) {
      if (!llamado || (!llamado.mesa_numero && !llamado.mesa_nombre)) return 'MESA --';
      if (llamado.mesa_nombre && llamado.mesa_nombre.trim()) return llamado.mesa_nombre.toUpperCase();
      return `MESA ${llamado.mesa_numero}`;
    },

    /**
     * Activa el resplandor visual por exactamente 5 segundos y reproduce el chime
     * @param {'nuevo'|'rellamado'} tipo
     */
    triggerGlow(tipo = 'nuevo') {
      if (this.glowTimer) {
        clearTimeout(this.glowTimer);
      }

      this.glowState = tipo;

      // Reproducción de audio híbrido con fallback offline Web Audio API
      playCallChime();

      // Retornar suavemente al reposo tras 5 segundos exactos
      this.glowTimer = setTimeout(() => {
        this.glowState = 'idle';
      }, 5000);
    },

    /**
     * Procesa la llegada de un nuevo turno desde cualquier mesa
     */
    onNuevoLlamado(payload) {
      // 1. Si ya había un turno en el hero, desplazarlo a la posición 1 del historial (FIFO)
      if (this.ultimoLlamado && this.ultimoLlamado.numero !== null) {
        this.historial.unshift({
          numero: this.ultimoLlamado.numero,
          mesa_numero: this.ultimoLlamado.mesa_numero,
          mesa_nombre: this.ultimoLlamado.mesa_nombre,
          llamado_en: this.ultimoLlamado.llamado_en || new Date().toISOString(),
          tiempoRelativo: 'Hace un instante'
        });

        // Retener exactamente un máximo de 4 elementos en el historial
        if (this.historial.length > 4) {
          this.historial.splice(4);
        }
      }

      // 2. Establecer el nuevo turno central
      this.ultimoLlamado = {
        numero: payload.turno,
        mesa_numero: payload.mesa_numero,
        mesa_nombre: payload.mesa_nombre || `Mesa ${payload.mesa_numero}`,
        lote_numero: payload.lote_numero,
        llamado_en: new Date().toISOString()
      };

      // 3. Anticipación: actualizar próximo turno en cola
      if (payload.proximo_numero) {
        this.proximoNumero = payload.proximo_numero;
      } else {
        this.proximoNumero = payload.turno + 1;
      }

      // 4. Disparar resplandor cobalto de 5 segundos + chime institucional
      this.triggerGlow('nuevo');
    },

    /**
     * Procesa la re-insistencia de un turno en atención (2º AVISO)
     */
    onRellamado(payload) {
      this.ultimoLlamado = {
        numero: payload.turno,
        mesa_numero: payload.mesa_numero,
        mesa_nombre: payload.mesa_nombre || `Mesa ${payload.mesa_numero}`,
        lote_numero: payload.lote_numero,
        llamado_en: this.ultimoLlamado.llamado_en || new Date().toISOString()
      };

      // Disparar resplandor ámbar de insistencia + chime institucional
      this.triggerGlow('rellamado');
    },

    /**
     * Procesa el snapshot inicial de sincronización al conectar o reconectar
     */
    onSnapshot(payload) {
      if (!payload) return;

      // 1. Turno central
      if (payload.ultimo_llamado) {
        this.ultimoLlamado = {
          numero: payload.ultimo_llamado.numero,
          mesa_numero: payload.ultimo_llamado.mesa_numero,
          mesa_nombre: payload.ultimo_llamado.mesa_nombre || `Mesa ${payload.ultimo_llamado.mesa_numero}`,
          lote_numero: payload.ultimo_llamado.lote_numero,
          llamado_en: payload.ultimo_llamado.llamado_en
        };
      } else if (Array.isArray(payload.historial) && payload.historial.length > 0) {
        const primero = payload.historial[0];
        this.ultimoLlamado = {
          numero: primero.numero,
          mesa_numero: primero.mesa_numero,
          mesa_nombre: primero.mesa_nombre || `Mesa ${primero.mesa_numero}`,
          lote_numero: primero.lote_numero,
          llamado_en: primero.llamado_en
        };
      }

      // 2. Próximo en cola
      if (payload.proximo_numero) {
        this.proximoNumero = payload.proximo_numero;
      } else if (payload.lote && payload.lote.ultimo_numero_llamado !== undefined) {
        this.proximoNumero = payload.lote.ultimo_numero_llamado + 1;
      }

      // 3. Historial precedente (máximo 4)
      if (Array.isArray(payload.historial)) {
        // Descartar el turno que ya figura en el hero central para no duplicarlo
        const filtrado = payload.ultimo_llamado
          ? payload.historial.filter(h => h.numero !== payload.ultimo_llamado.numero)
          : payload.historial.slice(1);

        this.historial = filtrado.slice(0, 4).map(h => ({
          numero: h.numero,
          mesa_numero: h.mesa_numero,
          mesa_nombre: h.mesa_nombre || (h.mesa_numero ? `Mesa ${h.mesa_numero}` : '--'),
          llamado_en: h.llamado_en,
          tiempoRelativo: this._calcularTiempoRelativo(h.llamado_en)
        }));
      }
    },

    /**
     * Calcula la etiqueta de tiempo transcurrido en minutos
     */
    _calcularTiempoRelativo(isoDate) {
      if (!isoDate) return 'En espera';
      const past = new Date(isoDate).getTime();
      const diffSecs = Math.max(0, Math.floor((Date.now() - past) / 1000));
      if (diffSecs < 45) return 'Hace un instante';
      const diffMins = Math.floor(diffSecs / 60);
      if (diffMins === 1) return 'Hace 1 min';
      if (diffMins < 60) return `Hace ${diffMins} min`;
      return `Hace ${Math.floor(diffMins / 60)} h`;
    },

    /**
     * Actualiza periódicamente los textos de tiempo relativo del historial
     */
    _initRelativeTimeUpdater() {
      this.relativoTimer = setInterval(() => {
        this.historial.forEach(item => {
          item.tiempoRelativo = this._calcularTiempoRelativo(item.llamado_en);
        });
      }, 20000);
    },

    /**
     * Conexión WebSocket resiliente al canal tv:global
     */
    initWebSocket() {
      const token = typeof sessionStorage !== 'undefined' ? (sessionStorage.getItem('turnero_token') || '') : '';
      this.ws = new TurneroWSClient({
        canal: 'tv:global',
        token: token
      });

      // Manejo de estado de red (RF-TV-05: banner ámbar, nunca pantalla en blanco)
      this.ws.onStatusChange(({ status, attempt, nextDelay }) => {
        if (status === 'CONECTADO') {
          this.wsConnected = true;
          this.reconnecting = false;
        } else if (status === 'RECONECTANDO') {
          this.wsConnected = false;
          this.reconnecting = true;
          this.reconnectCountdown = `Reintento en ${Math.round(nextDelay / 1000)}s (intento #${attempt})`;
        } else {
          this.wsConnected = false;
          this.reconnecting = true;
          this.reconnectCountdown = 'Reintentando conexión automática...';
        }
      });

      // Suscripción a eventos emitidos por ventanillas
      this.ws.on('nuevo_llamado', (payload) => this.onNuevoLlamado(payload));
      this.ws.on('rellamado', (payload) => this.onRellamado(payload));
      this.ws.on('snapshot', (payload) => this.onSnapshot(payload));

      this.ws.connect();
    },

    /**
     * Reloj en vivo Full HD sincronizado al segundo
     */
    _initClock() {
      const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
      const update = () => {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        this.relojHora = `${hh}:${mm}:${ss}`;

        const dia = String(now.getDate()).padStart(2, '0');
        const mes = meses[now.getMonth()];
        const anio = now.getFullYear();
        this.relojFecha = `${dia} ${mes} ${anio}`;
      };

      update();
      this.relojTimer = setInterval(update, 1000);
    },

    /**
     * Desbloquea políticas de autoplay de audio en navegadores modernos
     */
    _initAutoplayBypass() {
      const unlock = () => {
        playCallChime().catch(() => {});
        document.removeEventListener('click', unlock);
        document.removeEventListener('keydown', unlock);
        document.removeEventListener('touchstart', unlock);
      };
      document.addEventListener('click', unlock, { once: true });
      document.addEventListener('keydown', unlock, { once: true });
      document.addEventListener('touchstart', unlock, { once: true });
    }
  };
}

// Registro global inmediato para expresiones x-data="tvView()"
if (typeof window !== 'undefined') {
  window.tvView = tvView;
}

// Registro seguro para Alpine.js x-data="tvView"
function registerTvWithAlpine() {
  if (window.Alpine) {
    window.Alpine.data('tvView', tvView);
  }
}

if (window.Alpine) {
  registerTvWithAlpine();
} else {
  document.addEventListener('alpine:init', registerTvWithAlpine);
}
