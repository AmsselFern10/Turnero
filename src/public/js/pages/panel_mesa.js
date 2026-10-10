/**
 * ==============================================================================
 * PANEL_MESA.JS — Controlador de Operador de Ventanilla
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cumple con:
 * - RF-TURN-01 a RF-TURN-05: 1 Clic Atómico (Finaliza anterior + Llama siguiente)
 * - RF-MESA-01 a RF-MESA-09: Pantalla sin scroll, cronómetro continuo y atajos
 * - RF-WS-02: Canal segmentado mesa:<id> con reconexión y snapshot
 * ==============================================================================
 */

import { api } from '../api.js';
import { TurneroWSClient } from '../ws-client.js';
import { formatTimer, showToast } from '../utils.js';

export function panelMesaView() {
  return {
    // Datos de la mesa y del operador
    mesa: {
      id: null,
      numero: null,
      nombre: ''
    },
    operador: {
      id: null,
      username: '',
      nombre_completo: '',
      rol: ''
    },

    // Estado del turno en curso
    turnoActual: null,
    cronometro: '00:00',
    cronometroTimer: null,

    // Métricas y proyección
    proximoNumero: null,
    atendidosHoy: 0,
    vouchersRestantes: 0,
    loteActivo: null,

    // Estados de pantalla y control
    mesaPausada: false,
    motivoPausa: 'Descanso programado / Almuerzo',
    loadingAction: false,

    // Estado de micro-animaciones y feedback temporal (5 segundos — Stitch)
    feedbackEstado: 'idle', // 'idle' | 'llamando' | 'rellamando' | 'ausente'
    feedbackTimer: null,
    feedbackData: {
      titulo: 'VENTANILLA DISPONIBLE',
      detalle: 'Listo para convocar al siguiente estudiante.'
    },

    // Conectividad y reloj
    ws: null,
    wsConnected: false,
    relojHora: '--:--:--',
    relojFecha: '',
    relojTimer: null,

    /**
     * Inicialización del panel de ventanilla
     */
    async init() {
      // 1. Validar autenticación
      const user = api.getUser();
      if (!user) {
        console.warn('[MESA] Sesión no válida. Redirigiendo al login...');
        api.clearSession(true);
        return;
      }
      this.operador = {
        id: user.id,
        username: user.username,
        nombre_completo: user.nombre || user.nombre_completo || user.username,
        rol: user.rol
      };

      // 2. Determinar mesa asignada (vía sessionStorage o query param)
      const urlParams = new URLSearchParams(window.location.search);
      const queryMesaId = urlParams.get('mesa_id');

      let mesaData = null;
      try {
        const raw = sessionStorage.getItem('turnero_mesa') || sessionStorage.getItem('mesa_seleccionada');
        if (raw) mesaData = JSON.parse(raw);
      } catch {}

      if (!mesaData && queryMesaId) {
        mesaData = { id: parseInt(queryMesaId, 10), numero: parseInt(queryMesaId, 10), nombre: `Mesa ${queryMesaId}` };
      }

      if (!mesaData || !mesaData.id) {
        console.warn('[MESA] No hay mesa seleccionada. Redirigiendo a selección de mesas...');
        window.location.href = '/index.html';
        return;
      }

      this.mesa = mesaData;

      // 3. Iniciar reloj digital institucional
      this._initClock();

      // 4. Iniciar atajos de teclado para ergonomía
      this._initKeyboardShortcuts();

      // 5. Cargar snapshot inicial desde el backend
      await this.cargarEstado();

      // 6. Conectar WebSocket al canal segmentado de la mesa
      this.initWebSocket();
    },

    /**
     * Restaura el estado de la mesa y el turno en curso (GET /turnos/estado?mesa_id=X)
     */
    async cargarEstado() {
      try {
        const [resEstado, resMesas] = await Promise.allSettled([
          api.get(`/turnos/estado?mesa_id=${this.mesa.id}`),
          api.get('/mesas')
        ]);

        if (resEstado.status === 'fulfilled') {
          const data = resEstado.value;
          this.turnoActual = data.turno_actual || null;
          this.atendidosHoy = data.atendidos_hoy || 0;
          this.proximoNumero = data.proximo_numero || null;
          this.loteActivo = data.lote || null;
          this.vouchersRestantes = data.lote
            ? Math.max(0, data.lote.numero_hasta - data.lote.ultimo_numero_llamado)
            : 0;

          if (this.turnoActual && this.turnoActual.llamado_en) {
            this.iniciarCronometro(this.turnoActual.llamado_en);
            const numFormatted = String(this.turnoActual.numero).padStart(3, '0');
            this.feedbackData = {
              titulo: 'LLAMADO EMITIDO CON ÉXITO',
              detalle: `Turno ${numFormatted} convocado a Mesa ${this.mesa.numero || '-'} • Sonando en pantalla TV`
            };
          } else {
            this.detenerCronometro();
            this.feedbackData = {
              titulo: 'VENTANILLA DISPONIBLE',
              detalle: 'Listo para convocar al siguiente estudiante.'
            };
          }
        }

        if (resMesas.status === 'fulfilled') {
          const todas = resMesas.value.mesas || [];
          const actual = todas.find(m => m.id === this.mesa.id);
          if (actual) {
            this.mesaPausada = actual.estado === 'pausada';
            if (actual.nombre) this.mesa.nombre = actual.nombre;
          }
        }
      } catch (err) {
        console.error('[MESA] Error al cargar estado inicial:', err);
      }
    },

    /**
     * Microinteracciones y transiciones temporales de 5 segundos (Stitch)
     */
    triggerCallNext(turno) {
      if (this.feedbackTimer) clearTimeout(this.feedbackTimer);

      this.feedbackEstado = 'llamando';
      const numFormatted = turno ? String(turno.numero).padStart(3, '0') : '--';
      this.feedbackData = {
        titulo: 'LLAMADO EMITIDO CON ÉXITO',
        detalle: `Turno ${numFormatted} convocado a Mesa ${this.mesa.numero || '-'} • Sonando en pantalla TV (hace un momento)`
      };

      this.feedbackTimer = setTimeout(() => {
        this.resetFeedbackState();
      }, 5000);
    },

    triggerRecall(turno) {
      if (this.feedbackTimer) clearTimeout(this.feedbackTimer);

      this.feedbackEstado = 'rellamando';
      const numFormatted = turno ? String(turno.numero).padStart(3, '0') : '--';
      this.feedbackData = {
        titulo: 'RE-LLAMADO EMITIDO (2º AVISO)',
        detalle: `Turno ${numFormatted} re-convocado a Mesa ${this.mesa.numero || '-'} • Sonando en pantalla TV (hace un momento)`
      };

      this.feedbackTimer = setTimeout(() => {
        this.resetFeedbackState();
      }, 5000);
    },

    triggerAbsent() {
      if (this.feedbackTimer) clearTimeout(this.feedbackTimer);

      this.feedbackEstado = 'ausente';
      this.feedbackData = {
        titulo: 'TURNO NO PRESENTADO REGISTRADO',
        detalle: 'El turno actual fue marcado como ausente (hace un momento)'
      };

      this.feedbackTimer = setTimeout(() => {
        this.resetFeedbackState();
      }, 5000);
    },

    resetFeedbackState() {
      this.feedbackEstado = 'idle';
      if (this.turnoActual) {
        const numFormatted = String(this.turnoActual.numero).padStart(3, '0');
        this.feedbackData = {
          titulo: 'LLAMADO EMITIDO CON ÉXITO',
          detalle: `Turno ${numFormatted} convocado a Mesa ${this.mesa.numero || '-'} • Sonando en pantalla TV`
        };
      } else {
        this.feedbackData = {
          titulo: 'VENTANILLA DISPONIBLE',
          detalle: 'Listo para convocar al siguiente estudiante.'
        };
      }
    },

    /**
     * Acción 1: "Llamar Siguiente" (1 Clic Atómico — POST /turnos/llamar)
     */
    async llamarSiguiente() {
      if (this.loadingAction || this.mesaPausada) return;

      this.loadingAction = true;
      try {
        const res = await api.post('/turnos/llamar', {
          mesa_id: this.mesa.id
        });

        const { turno, proximo_numero, vouchers_restantes } = res;
        this.turnoActual = turno;
        this.proximoNumero = proximo_numero;
        this.vouchersRestantes = vouchers_restantes;
        this.atendidosHoy++;

        // Iniciar cronómetro desde la marca temporal devuelta por la BD
        this.iniciarCronometro(turno.llamado_en);

        // Activar micro-animación de destello y banner en Card B de 5 segundos
        this.triggerCallNext(turno);

        showToast({
          message: `Llamando al Turno #${turno.numero} en Mesa ${this.mesa.numero}`,
          type: 'success'
        });

      } catch (err) {
        console.error('[MESA] Error al llamar siguiente:', err);
        const msg = err.message || '';
        if (msg.includes('409') || msg.toLowerCase().includes('agotado')) {
          showToast({
            message: 'ALERTA: El lote de vouchers se ha agotado. Notifique al supervisor.',
            type: 'warning',
            duration: 7000
          });
        } else {
          showToast({
            message: msg || 'No se pudo llamar al siguiente turno',
            type: 'danger'
          });
        }
      } finally {
        this.loadingAction = false;
      }
    },

    /**
     * Acción 2: Cronómetro de atención continuo (diferencia real contra llamado_en)
     */
    iniciarCronometro(llamadoEn) {
      this.detenerCronometro();
      if (!llamadoEn) {
        this.cronometro = '00:00';
        return;
      }

      const inicioTimestamp = new Date(llamadoEn).getTime();

      const tick = () => {
        const ahora = Date.now();
        const segundos = Math.max(0, Math.floor((ahora - inicioTimestamp) / 1000));
        this.cronometro = formatTimer(segundos);
      };

      tick();
      this.cronometroTimer = setInterval(tick, 1000);
    },

    detenerCronometro() {
      if (this.cronometroTimer) {
        clearInterval(this.cronometroTimer);
        this.cronometroTimer = null;
      }
      this.cronometro = '00:00';
    },

    /**
     * Acción 3: "No se presentó" (POST /turnos/:id/cancelar — Acción directa sin modal)
     */
    async cancelarTurno() {
      if (!this.turnoActual || this.loadingAction) return;

      const num = this.turnoActual.numero;
      this.loadingAction = true;
      try {
        await api.post(`/turnos/${this.turnoActual.id}/cancelar`, {
          mesa_id: this.mesa.id
        });

        showToast({
          message: `Turno #${num} marcado como No se presentó`,
          type: 'info'
        });

        this.turnoActual = null;
        this.detenerCronometro();
        this.triggerAbsent();
        await this.cargarEstado();
      } catch (err) {
        console.error('[MESA] Error al cancelar turno:', err);
        showToast({ message: err.message || 'Error al cancelar turno', type: 'danger' });
      } finally {
        this.loadingAction = false;
      }
    },

    /**
     * Acción 4: "Re-llamar Turno" (POST /turnos/:id/rellamar)
     */
    async rellamarTurno() {
      if (!this.turnoActual || this.loadingAction) return;

      this.loadingAction = true;
      try {
        await api.post(`/turnos/${this.turnoActual.id}/rellamar`, {
          mesa_id: this.mesa.id
        });

        this.triggerRecall(this.turnoActual);

        showToast({
          message: `Turno #${this.turnoActual.numero} re-llamado en pantalla TV`,
          type: 'info'
        });
      } catch (err) {
        console.error('[MESA] Error al re-llamar:', err);
        showToast({ message: err.message || 'Error al re-llamar turno', type: 'danger' });
      } finally {
        this.loadingAction = false;
      }
    },

    /**
     * Acción 5: Pausar Mesa (PATCH /mesas/:id/estado)
     */
    async pausarMesa() {
      try {
        await api.patch(`/mesas/${this.mesa.id}/estado`, {
          estado: 'pausada'
        });
        this.mesaPausada = true;
        showToast({ message: `Mesa ${this.mesa.numero} en pausa`, type: 'info' });
      } catch (err) {
        showToast({ message: err.message || 'Error al pausar mesa', type: 'danger' });
      }
    },

    /**
     * Acción 5: Reanudar Atención (PATCH /mesas/:id/estado)
     */
    async reanudarMesa() {
      try {
        await api.patch(`/mesas/${this.mesa.id}/estado`, {
          estado: 'activa'
        });
        this.mesaPausada = false;
        showToast({ message: `Mesa ${this.mesa.numero} activa para atención`, type: 'success' });
      } catch (err) {
        showToast({ message: err.message || 'Error al reanudar mesa', type: 'danger' });
      }
    },

    /**
     * Liberar mesa y volver a selección
     */
    cambiarMesa() {
      sessionStorage.removeItem('turnero_mesa');
      sessionStorage.removeItem('mesa_seleccionada');
      window.location.href = '/index.html';
    },

    /**
     * Cierre de sesión seguro del operador
     */
    async logout() {
      try {
        if (this.ws) this.ws.disconnect();
        await api.post('/auth/logout');
      } catch {}
      api.clearSession(true);
    },

    /**
     * Atajos de teclado para evitar fatiga motriz en jornadas continuas
     * - Barra Espaciadora o Enter: Llamar Siguiente
     * - Tecla R: Re-llamar a TV
     * - Tecla N o Escape: No se presentó
     * - Tecla P: Pausar o Reanudar Mesa
     */
    _initKeyboardShortcuts() {
      // Manejar keydown para disparo inmediato
      window.addEventListener('keydown', (e) => {
        // Ignorar si el usuario está escribiendo en un input, textarea o select
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
          return;
        }

        const isSpace = (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar' || e.keyCode === 32);
        const isEnter = (e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === 'Enter' || e.keyCode === 13);

        // Barra Espaciadora o Enter -> Llamar Siguiente (ambos ejecutan exclusivamente llamar siguiente)
        if (isSpace || isEnter) {
          e.preventDefault();
          e.stopPropagation();

          // Desenfocar cualquier elemento activo para evitar clicks nativos del navegador en botones enfocados
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }

          this.llamarSiguiente();
          return;
        }

        // Tecla R -> Re-llamar a TV (coincide con el botón [R])
        if (e.key === 'r' || e.key === 'R') {
          e.preventDefault();
          e.stopPropagation();
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          this.rellamarTurno();
          return;
        }

        // Tecla N o Escape -> No se presentó (coincide con el botón [N])
        if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          this.cancelarTurno();
          return;
        }

        // Tecla P -> Pausar o Reanudar Mesa
        if (e.key === 'p' || e.key === 'P') {
          e.preventDefault();
          e.stopPropagation();
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          if (this.mesaPausada) {
            this.reanudarMesa();
          } else {
            this.pausarMesa();
          }
          return;
        }
      });

      // Prevenir acción por defecto en keyup para Space/Enter (evita clicks residuales en botones del navegador)
      window.addEventListener('keyup', (e) => {
        const isSpace = (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar' || e.keyCode === 32);
        const isEnter = (e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === 'Enter' || e.keyCode === 13);
        if (isSpace || isEnter) {
          e.preventDefault();
          e.stopPropagation();
        }
      });
    },

    /**
     * Reloj en vivo sincronizado al segundo
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
     * Acción 6: Suscripción WebSocket al canal mesa:<id>
     */
    initWebSocket() {
      const token = api.getToken();
      if (!token || !this.mesa.id) return;

      this.ws = new TurneroWSClient({
        token,
        canal: `mesa:${this.mesa.id}`,
        mesaId: this.mesa.id
      });

      this.ws.onStatusChange(({ status }) => {
        this.wsConnected = status === 'CONECTADO';
      });

      // Evento de turno llamado para esta mesa (idempotente)
      this.ws.on('turno_llamado', (payload) => {
        if (payload && payload.turno) {
          if (this.turnoActual && this.turnoActual.id === payload.turno.id) {
            return; // Ya procesado
          }
          this.turnoActual = payload.turno;
          this.proximoNumero = payload.proximo_numero;
          this.vouchersRestantes = payload.vouchers_restantes;
          this.iniciarCronometro(payload.turno.llamado_en);
        }
      });

      // Evento si el administrador pausa o activa la mesa remotamente
      this.ws.on('mesa_pausada', () => {
        this.mesaPausada = true;
      });

      this.ws.on('mesa_activada', () => {
        this.mesaPausada = false;
      });

      // Snapshot tras reconexión por micro-corte
      this.ws.on('snapshot', (payload) => {
        if (payload) {
          if (payload.turno_actual) {
            this.turnoActual = payload.turno_actual;
            this.iniciarCronometro(payload.turno_actual.llamado_en);
          } else {
            this.turnoActual = null;
            this.detenerCronometro();
          }
          if (payload.atendidos_hoy !== undefined) this.atendidosHoy = payload.atendidos_hoy;
          if (payload.proximo_numero !== undefined) this.proximoNumero = payload.proximo_numero;
        }
      });

      this.ws.connect();
    }
  };
}

// Registro seguro para Alpine.js
function registerPanelMesaWithAlpine() {
  if (window.Alpine) {
    window.Alpine.data('panelMesa', panelMesaView);
    window.Alpine.data('panelMesaView', panelMesaView);
  }
}

if (window.Alpine) {
  registerPanelMesaWithAlpine();
} else {
  document.addEventListener('alpine:init', registerPanelMesaWithAlpine);
}
