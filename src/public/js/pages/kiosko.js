/**
 * ==============================================================================
 * KIOSKO.JS — Controlador de Autoservicio y Toma de Turnos Táctil
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cumple con:
 * - RF-GEN-01 a RF-GEN-05: Toma de turno sin login, token efímero y consulta de cola
 * - Pantalla táctil de 2 estados: 'welcome' (solicitud) y 'ticket' (voucher + QR)
 * - Renderizado de código QR vectorial para seguimiento en smartphone
 * - RNF-DIS-06: Operación local en LAN sin dependencias externas
 * ==============================================================================
 */

import { api } from '../api.js';
import { TurneroWSClient } from '../ws-client.js';

export function kioskoView() {
  return {
    // Estado de la pantalla: 'welcome' | 'ticket' | 'seguimiento'
    step: 'welcome',

    // Datos del turno generado
    ticketData: {
      numero: null,
      token: null,
      creado_en: null,
      lote_numero: null,
      posicion_en_cola: 0,
      tiempoEstimadoMin: 0
    },

    // Estado del turno en seguimiento desde smartphone
    seguimientoData: {
      numero: null,
      estado: 'esperando', // 'esperando' | 'en_atencion' | 'atendido' | 'cancelado'
      posicion: 0,
      mesa: null,
      llamado_en: null
    },

    // Estados de carga e interacción
    isGenerating: false,
    isPrinting: false,
    errorMessage: '',
    toastMessage: '',
    showToast: false,

    // Temporizador de retorno automático a welcome (para tablets compartidas en portón)
    autoResetTimer: null,
    pollingTimer: null,

    /**
     * Inicialización del Kiosko
     */
    init() {
      // 1. Verificar si viene con parámetro ?token= en la URL (escaneo desde smartphone)
      const urlParams = new URLSearchParams(window.location.search);
      const tokenParam = urlParams.get('token');

      if (tokenParam && tokenParam.length === 64) {
        this.step = 'seguimiento';
        this.iniciarSeguimiento(tokenParam);
        return;
      }

      // 2. Modo tablet/kiosko presencial
      this.step = 'welcome';
    },

    /**
     * Formatea el número de turno con 3 dígitos (#047)
     */
    formatTicket(num) {
      if (num === null || num === undefined || num === '' || isNaN(num)) return '--';
      return '#' + String(num).padStart(3, '0');
    },

    /**
     * Generación correlativa de turno táctil (RF-GEN-02)
     * Consume: POST /turnos/generar
     */
    async generarTurno() {
      if (this.isGenerating) return;

      this.isGenerating = true;
      this.errorMessage = '';

      try {
        const data = await api.post('/turnos/generar');

        // Calcular estimado de espera (aprox 3 minutos por persona delante)
        const posicion = data.posicion_en_cola || 1;
        const estimadoMin = Math.max(2, posicion * 3);

        this.ticketData = {
          numero: data.numero,
          token: data.token,
          creado_en: data.creado_en,
          lote_numero: data.lote_numero,
          posicion_en_cola: posicion,
          tiempoEstimadoMin: estimadoMin
        };

        // Cambiar a pantalla de ticket / voucher
        this.step = 'ticket';
        this.mostrarToast(`Turno ${this.formatTicket(data.numero)} asignado correctamente`);

        // Renderizar el código QR vectorial en el siguiente ciclo del DOM
        this.$nextTick(() => {
          this.generarCodigoQR(data.token);
        });

        // Configurar retorno automático a bienvenida tras 45 segundos de inactividad
        this.iniciarAutoReset(45);

      } catch (err) {
        console.error('[Kiosko] Error al generar turno:', err);
        if (err.status === 409) {
          this.errorMessage = err.message || 'No hay un lote de turnos activo en este momento. Por favor contacte al supervisor.';
        } else if (err.status === 503) {
          this.errorMessage = 'El módulo de kiosko no está activo actualmente. Por favor solicite su voucher en el portón.';
        } else {
          this.errorMessage = err.message || 'Error de comunicación con el nodo central. Intente nuevamente.';
        }
      } finally {
        this.isGenerating = false;
      }
    },

    /**
     * Renderiza el código QR vectorial apuntando a la URL de seguimiento
     */
    generarCodigoQR(token) {
      const container = document.getElementById('kiosko-qr-container');
      if (!container) return;

      container.innerHTML = '';

      const trackingUrl = `${window.location.origin}/kiosko.html?token=${encodeURIComponent(token)}`;

      if (window.QRCode) {
        try {
          new window.QRCode(container, {
            text: trackingUrl,
            width: 130,
            height: 130,
            colorDark: '#0F172A',
            colorLight: '#FFFFFF',
            correctLevel: window.QRCode.CorrectLevel.M
          });
        } catch (qrErr) {
          console.warn('[Kiosko] Error generando QR con librería:', qrErr);
          this._renderQRFallbackSVG(container);
        }
      } else {
        this._renderQRFallbackSVG(container);
      }
    },

    /**
     * Fallback vectorial SVG en caso de ausencia de librería
     */
    _renderQRFallbackSVG(container) {
      container.innerHTML = `
        <svg class="w-32 h-32 text-slate-900" fill="currentColor" viewBox="0 0 120 120">
          <rect x="10" y="10" width="30" height="30" fill="none" stroke="currentColor" stroke-width="6"></rect>
          <rect x="20" y="20" width="10" height="10"></rect>
          <rect x="80" y="10" width="30" height="30" fill="none" stroke="currentColor" stroke-width="6"></rect>
          <rect x="90" y="20" width="10" height="10"></rect>
          <rect x="10" y="80" width="30" height="30" fill="none" stroke="currentColor" stroke-width="6"></rect>
          <rect x="20" y="90" width="10" height="10"></rect>
          <rect x="48" y="12" width="6" height="6"></rect>
          <rect x="68" y="12" width="6" height="6"></rect>
          <rect x="48" y="28" width="6" height="6"></rect>
          <rect x="62" y="28" width="6" height="6"></rect>
          <rect x="48" y="48" width="8" height="8"></rect>
          <rect x="66" y="62" width="8" height="8"></rect>
          <rect x="86" y="82" width="8" height="8"></rect>
        </svg>
      `;
    },

    /**
     * Imprime el comprobante utilizando la impresora térmica o de tickets del sistema
     */
    imprimirTicket() {
      this.isPrinting = true;
      try {
        window.print();
        this.mostrarToast('Enviado a impresora');
      } catch (err) {
        console.error('[Kiosko] Error al imprimir:', err);
      } finally {
        this.isPrinting = false;
      }
    },

    /**
     * Vuelve a la pantalla inicial de bienvenida
     */
    volverABienvenida() {
      if (this.autoResetTimer) {
        clearTimeout(this.autoResetTimer);
        this.autoResetTimer = null;
      }
      this.errorMessage = '';
      this.step = 'welcome';
    },

    /**
     * Inicia el temporizador de retorno automático a bienvenida
     */
    iniciarAutoReset(segundos = 45) {
      if (this.autoResetTimer) {
        clearTimeout(this.autoResetTimer);
      }
      this.autoResetTimer = setTimeout(() => {
        this.volverABienvenida();
      }, segundos * 1000);
    },

    /**
     * Modo Smartphone: Inicia seguimiento en tiempo real vía WebSocket (RF-WS-01: Cero polling)
     */
    async iniciarSeguimiento(token) {
      // 1. Consulta inicial para renderizar estado de inmediato
      try {
        const res = await api.get(`/turnos/mi-turno/${token}`);
        this.seguimientoData = {
          numero: res.numero,
          estado: res.estado,
          posicion: res.posicion || 0,
          mesa: res.mesa || null,
          llamado_en: res.llamado_en || null
        };
      } catch (err) {
        console.error('[Seguimiento] Error consultando mi turno:', err);
        this.errorMessage = 'No se encontró el turno solicitado o el enlace ha caducado.';
        return;
      }

      // 2. Conexión WebSocket push al canal dedicado kiosko:<token>
      this.ws = new TurneroWSClient({
        canal: `kiosko:${token}`,
        token: ''
      });

      this.ws.on('turno_actualizado', (payload) => {
        if (payload) {
          this.seguimientoData = {
            numero: payload.numero,
            estado: payload.estado,
            posicion: payload.posicion || 0,
            mesa: payload.mesa || null,
            llamado_en: payload.llamado_en || null
          };

          // Si ya fue llamado a ventanilla, vibrar y alertar al estudiante
          if (payload.estado === 'en_atencion' && typeof navigator !== 'undefined' && navigator.vibrate) {
            navigator.vibrate([200, 100, 200]);
          }
        }
      });

      this.ws.connect();
    },

    /**
     * Despliega notificación toast no intrusiva
     */
    mostrarToast(mensaje) {
      this.toastMessage = mensaje;
      this.showToast = true;
      setTimeout(() => {
        this.showToast = false;
      }, 3500);
    }
  };
}

// Registro seguro para Alpine.js x-data="kioskoView"
function registerKioskoWithAlpine() {
  if (window.Alpine) {
    window.Alpine.data('kioskoView', kioskoView);
  }
}

if (window.Alpine) {
  registerKioskoWithAlpine();
} else {
  document.addEventListener('alpine:init', registerKioskoWithAlpine);
}
