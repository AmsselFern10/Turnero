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
import { formatTimer, showToast, initFondoPersonalizado } from '../utils.js';

/**
 * Genera un UUID v4. Usa crypto.randomUUID() cuando esté disponible
 * (contextos seguros: HTTPS o localhost). En HTTP-LAN usa un fallback
 * basado en Math.random(), suficiente para Idempotency-Keys de corta vida.
 */
function generarUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback RFC-4122 v4 para contextos HTTP no seguros (LAN)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

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
    modo: 'voucher_fisico',

    // Estados de pantalla y control
    mesaPausada: false,
    mesaInactivada: false,
    motivoPausa: 'Descanso programado / Almuerzo',
    loadingAction: false,
    _cooldown: false,
    _llamarKey: null,

    // Rezagados (turnos cancelados/no presentados)
    totalRezagados: 0,
    listaRezagados: [],
    rezagadoSeleccionado: null,
    modalConfirmarRezagadoConTurno: false,
    modalRezagados: false,
    filtroRezagados: '',
    loadingRezagado: false,
    errorRezagado: '',
    // Fecha local al cargar — detecta cambio de día para limpiar lista automáticamente
    _fechaHoy: new Date().toDateString(),
    // Lock optimista: Set de turno_ids con solicitud HTTP en vuelo (anti race-condition UI)
    _rezagadosEnVuelo: new Set(),

    // Getters semánticos para lógica de presentación pura
    get estadoVentanillaTexto() {
      if (this.feedbackEstado === 'llamando') return 'LLAMANDO ALUMNO...';
      if (this.feedbackEstado === 'rellamando') return 'RE-LLAMANDO (2º AVISO)';
      return this.turnoActual ? 'TURNO ACTUAL • EN ATENCIÓN' : 'VENTANILLA LIBRE (DISPONIBLE)';
    },

    get proximoNumeroDisplay() {
      if (this.proximoNumero) {
        return String(this.proximoNumero).padStart(3, '0');
      }
      if (this.modo === 'kiosko_web') {
        return 'Sin espera';
      }
      if (this.vouchersRestantes === 0 || !this.loteActivo) {
        return 'Lote agotado';
      }
      return '---';
    },

    get proximoNumeroClass() {
      if (this.proximoNumero) {
        return 'text-6xl sm:text-7xl lg:text-8xl text-slate-900';
      }
      const colorClase = this.modo === 'kiosko_web' ? 'text-slate-400' : 'text-rose-600';
      return `text-2xl sm:text-3xl font-bold ${colorClase}`;
    },

    get proximoNumeroMensaje() {
      if (this.proximoNumero) {
        return this.modo === 'kiosko_web'
          ? 'Siguiente estudiante en cola de espera.'
          : 'Se llamará automáticamente a tu mesa al presionar "Llamar Siguiente".';
      }
      return this.modo === 'kiosko_web'
        ? 'No hay estudiantes esperando en este momento.'
        : 'No hay vouchers disponibles en el lote actual. Notifique al admin.';
    },

    get origenLoteDisplay() {
      if (this.modo === 'kiosko_web') return 'Modo Kiosko Web';
      return this.loteActivo ? `Lote ${this.loteActivo.numero_lote}` : 'Sin lote activo';
    },

    get cantidadRestanteDisplay() {
      if (this.modo === 'kiosko_web') {
        return `${this.vouchersRestantes} en espera`;
      }
      return `${this.vouchersRestantes} vouchers restantes`;
    },

    get rezagadosBadgeText() {
      if (this.totalRezagados > 0) {
        return `${this.totalRezagados} ${this.totalRezagados === 1 ? 'disponible' : 'disponibles'}`;
      }
      return 'Sin rezagados';
    },

    // Getter reactivo para filtrar rezagados en el modal
    get rezagadosFiltrados() {
      if (!this.filtroRezagados || !this.filtroRezagados.trim()) {
        return this.listaRezagados;
      }
      const q = this.filtroRezagados.trim().toLowerCase();
      return this.listaRezagados.filter(r => {
        const numStr = String(r.numero);
        const mesaStr = r.mesa_numero ? String(r.mesa_numero) : '';
        return numStr.includes(q) || mesaStr.includes(q);
      });
    },

    // Estado de micro-animaciones y feedback temporal (5 segundos — Stitch)
    feedbackEstado: 'idle', // 'idle' | 'llamando' | 'rellamando' | 'ausente'
    feedbackTimer: null,
    feedbackData: {
      titulo: 'VENTANILLA DISPONIBLE',
      detalle: 'Listo para convocar al siguiente estudiante.'
    },

    // Conectividad y reloj
    ws: null,
    wsConnected: true,
    relojHora: '--:--:--',
    relojFecha: '',
    relojTimer: null,

    // Modal de resolución de turno activo al cerrar sesión
    modalSalida: false,
    _salidaPending: false,

    // Referencias a listeners de atajos de teclado para limpieza en destroy()
    _boundKeyDown: null,
    _boundKeyUp: null,

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

      // Validar mesa asignada en servidor (evita quedar en mesa desfasada si cambió en BD)
      try {
        const me = await api.get('/auth/me');
        if (me?.usuario) {
          const mesaServidor = me.usuario.mesa_asignada;
          if (mesaServidor) {
            if (mesaData && Number(mesaData.id) !== Number(mesaServidor.id)) {
              console.warn(`[MESA] Discrepancia: asignada en servidor es Mesa ${mesaServidor.numero}, local tenía Mesa ${mesaData.numero}. Sincronizando...`);
              showToast({
                message: `Sitio de atención sincronizado a Mesa ${mesaServidor.numero}`,
                type: 'info',
                duration: 3500
              });
            }
            mesaData = mesaServidor;
            sessionStorage.setItem('turnero_mesa', JSON.stringify(mesaServidor));
          } else if (user.rol === 'operador') {
            console.warn('[MESA] El operador no tiene mesa asignada en el servidor. Redirigiendo a selección...');
            sessionStorage.removeItem('turnero_mesa');
            sessionStorage.removeItem('mesa_seleccionada');
            window.location.href = '/index.html';
            return;
          }
        }
      } catch (err) {
        if (err?.status === 401 || err?.status === 403) {
          api.clearSession(true);
          return;
        }
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
      initFondoPersonalizado(this.ws);
    },

    /**
     * Restaura el estado de la mesa y el turno en curso (GET /turnos/estado?mesa_id=X)
     * Una sola consulta consolidada al cargar o reconectar (presupuesto <= 2 queries).
     */
    async cargarEstado() {
      try {
        const data = await api.get(`/turnos/estado?mesa_id=${this.mesa.id}`);
        if (!data) return;

        this.turnoActual = data.turno_actual || null;
        this.atendidosHoy = data.atendidos_hoy || 0;
        this.proximoNumero = data.proximo_numero ?? null;
        this.loteActivo = data.lote || null;
        this.modo = data.modo || (data.lote ? 'voucher_fisico' : 'kiosko_web');
        this.vouchersRestantes = data.vouchers_restantes ?? (data.lote
          ? Math.max(0, data.lote.numero_hasta - data.lote.ultimo_numero_llamado)
          : 0);

        if (data.mesa) {
          this.mesaPausada = data.mesa.estado === 'pausada';
          if (data.mesa.nombre) this.mesa.nombre = data.mesa.nombre;
          if (data.mesa.numero !== undefined && data.mesa.numero !== null) {
            this.mesa.numero = data.mesa.numero;
          }
        }

        if (this.turnoActual && this.turnoActual.llamado_en) {
          this.iniciarCronometro(this.turnoActual.llamado_en);
          const numFormatted = String(this.turnoActual.numero).padStart(3, '0');
          this.feedbackData = {
            titulo: 'LLAMADO EMITIDO CON ÉXITO',
            detalle: `Turno ${numFormatted} convocado a Mesa ${this.mesa.numero || '-'}`
          };
        } else {
          this.detenerCronometro();
          this.feedbackData = {
            titulo: 'VENTANILLA DISPONIBLE',
            detalle: 'Listo para convocar al siguiente estudiante.'
          };
        }

        // Cargar lista y contador de turnos rezagados del día
        await this.cargarRezagados(true);
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
        detalle: `Turno ${numFormatted} convocado a Mesa ${this.mesa.numero || '-'}`
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
        detalle: `Turno ${numFormatted} convocado a Mesa ${this.mesa.numero || '-'}`
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
          detalle: `Turno ${numFormatted} convocado a Mesa ${this.mesa.numero || '-'}`
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
      if (this.loadingAction || this.mesaPausada || this._cooldown) return;

      // Bloquear si no hay conexión con el servidor (RF-WS-OFFLINE)
      // No guardar para enviar después: podría duplicar números al volver la red.
      if (!this.wsConnected) {
        showToast({
          message: 'Sin conexión con el servidor — no se puede llamar ahora. El sistema reconectará solo.',
          type: 'warning',
          duration: 4000
        });
        return;
      }

      // En modo Kiosko Web, si no hay estudiantes en la cola, informar amablemente
      if (this.modo === 'kiosko_web' && (!this.proximoNumero || this.vouchersRestantes === 0)) {
        showToast({
          message: 'No hay estudiantes esperando turno en este momento en el Kiosko.',
          type: 'info',
          duration: 4000
        });
        return;
      }

      this.loadingAction = true;
      let exito = false;

      // Idempotency-Key por intento: si la red falla y el usuario reintenta,
      // el mismo UUID devuelve el turno ya creado sin quemar un nuevo número.
      if (!this._llamarKey) this._llamarKey = generarUUID();
      const idempotencyKey = this._llamarKey;
      try {
        const res = await api.post('/turnos/llamar', {
          mesa_id: this.mesa.id
        }, { headers: { 'Idempotency-Key': idempotencyKey } });

        const { turno, proximo_numero, vouchers_restantes, es_idempotente } = res;
        this.turnoActual = turno;
        this.proximoNumero = proximo_numero ?? null;
        this.vouchersRestantes = vouchers_restantes ?? 0;

        if (es_idempotente) {
          // El turno ya había sido asignado en este mismo instante (reintento o coalescing de red)
          // No incrementamos contador ni relanzamos avisos sonoros redundantes
          showToast({
            message: `Turno #${turno.numero} ya activo en Mesa ${this.mesa.numero}`,
            type: 'info',
            duration: 3500
          });
        } else {
          this.atendidosHoy++;

          // Iniciar cronómetro desde la marca temporal devuelta por la BD
          this.iniciarCronometro(turno.llamado_en);

          // Activar micro-animación de destello y banner en Card B de 5 segundos
          this.triggerCallNext(turno);

          showToast({
            message: `Llamando al Turno #${turno.numero} en Mesa ${this.mesa.numero}`,
            type: 'success'
          });
        }

        exito = true;

      } catch (err) {
        console.error('[MESA] Error al llamar siguiente:', err);
        const msg = err.mensaje || err.message || '';

        if (err.status === 429 || err.status === 503 || err.codigo === 'servidor_ocupado') {
          // Servidor ocupado (under-pressure o rate-limit): esperar exactamente Retry-After
          const waitMs = err.retryAfterMs || 10000;
          const waitSeg = Math.round(waitMs / 1000);
          showToast({
            message: `Servidor ocupado. El botón se habilitará en ${waitSeg}s.`,
            type: 'warning',
            duration: waitMs
          });
          // Extender el cooldown al tiempo indicado por el servidor sin resetear la key
          this._cooldown = true;
          this.loadingAction = false;
          setTimeout(() => {
            this._cooldown = false;
          }, waitMs);
          return; // No ejecutar el finally normal
        }

        if (err.status === 409 || err.codigo === 'sin_turnos_en_espera' || msg.toLowerCase().includes('agotado') || msg.toLowerCase().includes('espera')) {
          this._llamarKey = null;
          if (this.modo === 'kiosko_web' || err.codigo === 'sin_turnos_en_espera' || msg.toLowerCase().includes('espera')) {
            showToast({
              message: 'No hay estudiantes esperando turno en este momento en el Kiosko.',
              type: 'info',
              duration: 5000
            });
          } else {
            showToast({
              message: 'ALERTA: El lote de vouchers se ha agotado. Notifique al supervisor.',
              type: 'warning',
              duration: 7000
            });
          }
        } else {
          // Error transitorio: preservamos this._llamarKey para que el reintento sea idempotente
          showToast({
            message: msg || 'No se pudo llamar al siguiente turno. Puedes reintentar.',
            type: 'danger'
          });
        }
      } finally {
        this.loadingAction = false;
        // Cooldown de 1.5s para blindar contra doble clic y ráfagas
        this._cooldown = true;
        setTimeout(() => {
          this._cooldown = false;
          // Solo si la llamada fue exitosa liberamos la key para permitir el próximo llamado
          if (exito) {
            this._llamarKey = null;
          }
        }, 1500);
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

        // Regl 30-min: turno de más de 30 min se oculta automáticamente
        if (segundos >= 30 * 60 && this.turnoActual) {
          this.turnoActual = null;
          this.detenerCronometro();
        }
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
     * Acción 3: "No se presentó" (POST /turnos/:id/cancelar — Acción directa silenciosa y sin modales)
     */
    async cancelarTurno() {
      if (!this.turnoActual || this.loadingAction || this._cooldown) return;

      if (!this.wsConnected) {
        showToast({
          message: 'Sin conexión con el servidor. No se puede registrar la ausencia en este momento.',
          type: 'warning',
          duration: 4000
        });
        return;
      }

      this.loadingAction = true;
      const turnoId = this.turnoActual.id;
      const turnoNum = this.turnoActual.numero;
      try {
        await api.post(`/turnos/${turnoId}/cancelar`, {
          mesa_id: this.mesa.id
        });

        // Actualizar estado local inmediatamente tras éxito confirmado
        this.turnoActual = null;
        this.detenerCronometro();
        this.triggerAbsent();
        // El servidor emite 'rezagados_actualizados' por WS → cargarRezagados() se dispara
        // automáticamente en el handler ws.on('rezagados_actualizados', ...). No hacemos
        // cargarEstado() para evitar 2 queries extra por cada cancelación.
      } catch (err) {
        console.error('[MESA] Error al cancelar turno:', err);
        const msg = err.mensaje || err.message || '';
        if (err.status === 404 || err.status === 409 || msg.toLowerCase().includes('no encontrado') || msg.toLowerCase().includes('no está en atención') || msg.toLowerCase().includes('no esta en atencion')) {
          // El turno ya no estaba en atención (doble clic u otra acción concurrente)
          this.turnoActual = null;
          this.detenerCronometro();
          showToast({
            message: `El turno #${turnoNum} ya no estaba en atención — puede que ya lo hayas cancelado antes.`,
            type: 'info',
            duration: 5000
          });
        } else {
          showToast({
            message: msg || 'No se pudo registrar la ausencia del turno. Intente de nuevo.',
            type: 'danger'
          });
        }
      } finally {
        this.loadingAction = false;
        this._cooldown = true;
        setTimeout(() => { this._cooldown = false; }, 500);
      }
    },

    /**
     * Acción 4: "Re-llamar Turno" (POST /turnos/:id/rellamar)
     */
    async rellamarTurno() {
      if (!this.turnoActual || this.loadingAction || this._cooldown) return;

      if (!this.wsConnected) {
        showToast({
          message: 'Sin conexión con el servidor. No se puede re-llamar el turno en este momento.',
          type: 'warning',
          duration: 4000
        });
        return;
      }

      // Guardia de tiempo mínimo: no permitir re-llamar si el turno acaba de ser llamado
      // y probablemente aún no ha aparecido en la TV (la TV puede tener varios turnos en cola)
      const MIN_SEGUNDOS_RELLAMADO = 8;
      if (this.turnoActual.llamado_en) {
        const segsDesdeCallado = (Date.now() - new Date(this.turnoActual.llamado_en).getTime()) / 1000;
        if (segsDesdeCallado < MIN_SEGUNDOS_RELLAMADO) {
          const restantes = Math.ceil(MIN_SEGUNDOS_RELLAMADO - segsDesdeCallado);
          showToast({
            message: `El turno #${this.turnoActual.numero} aún no ha aparecido en la TV. Espera ${restantes}s antes de re-llamar.`,
            type: 'warning',
            duration: 4000
          });
          return;
        }
      }

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
        const msg = err.mensaje || err.message || '';
        if (err.status === 404 || err.status === 409 || msg.toLowerCase().includes('no hay turno en atención') || msg.toLowerCase().includes('no hay turno en atencion')) {
          this.turnoActual = null;
          this.detenerCronometro();
          await this.cargarEstado();
        }
        showToast({ message: msg || 'Error al re-llamar turno', type: 'danger' });
      } finally {
        this.loadingAction = false;
        this._cooldown = true;
        setTimeout(() => { this._cooldown = false; }, 500);
      }
    },


    /**
     * Consulta y refresca la lista de turnos rezagados (cancelados) de hoy
     */
    async cargarRezagados(silencioso = false) {
      try {
        const res = await api.get('/turnos/rezagados');
        if (res && res.turnos) {
          this.listaRezagados = res.turnos;
          this.totalRezagados = res.total ?? res.turnos.length;

          // Si había un rezagado seleccionado y ya no está en la lista (lo tomó otra mesa), deseleccionar
          if (this.rezagadoSeleccionado) {
            const sigueDisponible = this.listaRezagados.some(r => Number(r.id) === Number(this.rezagadoSeleccionado.id));
            if (!sigueDisponible) {
              const numDescartado = this.rezagadoSeleccionado.numero;
              this.rezagadoSeleccionado = null;
              if (this.modalRezagados && !silencioso) {
                this.errorRezagado = `El turno #${numDescartado} ya fue atendido o no está disponible.`;
              }
            }
          }
        }
      } catch (err) {
        if (!silencioso) {
          console.error('[MESA] Error al cargar rezagados:', err);
        }
      }
    },

    /**
     * Apertura del flujo para atender rezagado con validaciones de tolerancia a fallos
     */
    async abrirFlujoRezagados() {
      if (this.loadingAction || this.mesaPausada) return;

      if (!this.wsConnected) {
        showToast({
          message: 'Sin conexión con el servidor — no se puede consultar ni atender rezagados. Esperando reconexión.',
          type: 'warning',
          duration: 4000
        });
        return;
      }

      // Cargar lista actualizada antes de decidir
      await this.cargarRezagados();

      // Si no hay ninguno, el botón lo indica y no abre un modal vacío
      if (this.totalRezagados === 0) {
        showToast({
          message: 'No hay turnos rezagados o cancelados pendientes en la jornada de hoy.',
          type: 'info',
          duration: 4000
        });
        return;
      }

      // Si la mesa ya tiene un turno en atención, confirmar primero
      if (this.turnoActual !== null) {
        this.modalConfirmarRezagadoConTurno = true;
      } else {
        this.abrirModalSeleccionRezagados();
      }
    },

    /**
     * Operador confirma que ya atendió el turno actual y pasa a elegir rezagado
     */
    confirmarContinuarARezagados() {
      this.modalConfirmarRezagadoConTurno = false;
      this.abrirModalSeleccionRezagados();
    },

    /**
     * Despliega el modal de selección de turnos rezagados
     */
    abrirModalSeleccionRezagados() {
      this.errorRezagado = '';
      this.rezagadoSeleccionado = null;
      this.filtroRezagados = '';
      this.modalRezagados = true;
    },

    /**
     * Cierra el modal de selección
     */
    cerrarModalRezagados() {
      this.modalRezagados = false;
      this.rezagadoSeleccionado = null;
      this.errorRezagado = '';
      this.filtroRezagados = '';
    },

    /**
     * Selección de un turno específico en el modal
     */
    seleccionarRezagado(r) {
      this.rezagadoSeleccionado = r;
      this.errorRezagado = '';
    },

    /**
     * Helper para mostrar hace cuánto se canceló el turno
     */
    formatearTiempoCancelado(fechaStr) {
      if (!fechaStr) return 'Hace un momento';
      const d = new Date(fechaStr);
      if (isNaN(d.getTime())) return 'Hace un momento';
      const segs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
      if (segs < 60) return 'Hace menos de 1 min';
      const mins = Math.floor(segs / 60);
      if (mins < 60) return `Hace ${mins} min`;
      const hrs = Math.floor(mins / 60);
      return `Hace ${hrs} h ${mins % 60} min`;
    },

    /**
     * Confirmar la atención del rezagado (atómico, idempotente)
     */
    async confirmarAtenderRezagado() {
      if (!this.rezagadoSeleccionado || this.loadingRezagado || this.mesaPausada) return;

      if (!this.wsConnected) {
        this.errorRezagado = 'Sin conexión con el servidor — no se puede confirmar la atención hasta restablecer la red.';
        return;
      }

      // Lock optimista por turno_id: bloquea doble-clic simultáneo desde otro operador
      // que aún no recibió el WS de actualización. La BD ya garantiza atomicidad con FOR UPDATE;
      // este lock evita enviar la segunda solicitud HTTP si ya hay una en vuelo para el mismo turno.
      const turnoId = this.rezagadoSeleccionado.id;
      if (this._rezagadosEnVuelo.has(turnoId)) {
        this.errorRezagado = 'Este turno ya está siendo procesado. Espera un momento.';
        return;
      }
      this._rezagadosEnVuelo.add(turnoId);

      this.loadingRezagado = true;
      this.errorRezagado = '';
      const iKey = generarUUID();

      try {
        const res = await api.post('/turnos/atender-rezagado', {
          turno_id: turnoId,
          mesa_id: this.mesa.id
        }, { headers: { 'Idempotency-Key': iKey } });

        const { turno, proximo_numero, vouchers_restantes } = res;
        this.turnoActual = turno;
        if (proximo_numero !== undefined && proximo_numero !== null) {
          this.proximoNumero = proximo_numero;
        }
        if (vouchers_restantes !== undefined) {
          this.vouchersRestantes = vouchers_restantes;
        }
        this.atendidosHoy++;

        // Iniciar cronómetro desde este momento (duración cuenta desde aquí)
        this.iniciarCronometro(turno.llamado_en);

        // Feedback visual en pantalla
        this.triggerCallNext(turno);

        this.cerrarModalRezagados();
        await this.cargarRezagados(true);

        showToast({
          message: `Atendiendo turno rezagado #${turno.numero} en Mesa ${this.mesa.numero}`,
          type: 'success'
        });

      } catch (err) {
        console.error('[MESA] Error al atender rezagado:', err);
        const msg = err.mensaje || err.message || '';
        if (err.status === 409 || err.codigo === 'turno_no_disponible' || msg.includes('ya fue atendido')) {
          this.errorRezagado = msg || 'El turno ya fue atendido por otra ventanilla o ya no está disponible.';
          await this.cargarRezagados(true);
          this.rezagadoSeleccionado = null;
        } else {
          this.errorRezagado = msg || 'No se pudo atender el turno rezagado.';
        }
      } finally {
        this._rezagadosEnVuelo.delete(turnoId);
        this.loadingRezagado = false;
      }
    },

    /**
     * Acción 5: Pausar Mesa (PATCH /mesas/:id/estado)
     */
    async pausarMesa() {
      if (!this.wsConnected) {
        showToast({
          message: 'Sin conexión con el servidor. No se puede pausar la mesa.',
          type: 'warning',
          duration: 4000
        });
        return;
      }
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
      if (!this.wsConnected) {
        showToast({
          message: 'Sin conexión con el servidor. No se puede reanudar la atención.',
          type: 'warning',
          duration: 4000
        });
        return;
      }
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
     * Limpiar estado y volver a inicio cuando el admin inactiva la mesa
     */
    salirMesaInactivada() {
      sessionStorage.removeItem('turnero_mesa');
      sessionStorage.removeItem('mesa_seleccionada');
      sessionStorage.removeItem('mesa_id');
      sessionStorage.removeItem('mesa_numero');
      sessionStorage.removeItem('mesa_nombre');
      window.location.href = '/index.html';
    },

    /**
     * Cierre de sesión seguro del operador.
     * Si hay un turno en atención, muestra modal de confirmación antes de cerrar.
     */
    async logout() {
      if (this.turnoActual) {
        this.modalSalida = true;
        return;
      }
      await this._ejecutarLogout();
    },

    /**
     * Resolver turno activo al salir: 'atendido' o 'cancelado' (no se presentó)
     */
    async resolverSalida(resolucion) {
      if (this._salidaPending) return;
      this._salidaPending = true;
      try {
        if (this.turnoActual && this.turnoActual.id) {
          if (resolucion === 'atendido') {
            await api.post(`/turnos/${this.turnoActual.id}/finalizar`, {
              mesa_id: this.mesa.id
            });
          } else if (resolucion === 'cancelado') {
            await api.post(`/turnos/${this.turnoActual.id}/cancelar`, {
              mesa_id: this.mesa.id
            });
          }
        }
      } catch (err) {
        console.warn('[MESA] Error al resolver turno antes de salir:', err);
      } finally {
        this.modalSalida = false;
        this.turnoActual = null;
        this._salidaPending = false;
        await this._ejecutarLogout();
      }
    },

    /**
     * Cancelar la salida — permanecer en la consola atendiendo.
     */
    cancelarSalida() {
      this.modalSalida = false;
    },

    /**
     * Ejecución interna de logout: desconecta WS, libera mesa y limpia sesión.
     */
    async _ejecutarLogout() {
      try {
        if (this.ws) this.ws.disconnect();
        await api.post('/auth/liberar-mesa');
      } catch (_) {}
      try {
        await api.post('/auth/logout');
      } catch (_) {}
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
      this._boundKeyDown = (e) => {
        // Ignorar si el usuario está escribiendo en un input, textarea o select
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
          return;
        }

        const isSpace = (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar' || e.keyCode === 32);
        const isEnter = (e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === 'Enter' || e.keyCode === 13);

        // Barra Espaciadora o Enter -> Llamar Siguiente
        // e.repeat === true cuando la tecla está MANTENIDA: ignorar para evitar N llamados
        if ((isSpace || isEnter) && !e.repeat) {
          e.preventDefault();
          e.stopPropagation();

          if (this.loadingAction || this.mesaPausada || this._cooldown) {
            return;
          }

          // Desenfocar cualquier elemento activo para evitar clicks nativos del navegador en botones enfocados
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }

          this.llamarSiguiente();
          return;
        } else if ((isSpace || isEnter) && e.repeat) {
          // Absorber el evento sin llamar, para no hacer scroll ni activar botones enfocados
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        // Tecla R -> Re-llamar a TV (coincide con el botón [R])
        if ((e.key === 'r' || e.key === 'R') && !e.repeat) {
          e.preventDefault();
          e.stopPropagation();
          if (this.loadingAction || this._cooldown) return;
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          this.rellamarTurno();
          return;
        }

        // Tecla N o Escape -> No se presentó (coincide con el botón [N])
        if ((e.key === 'n' || e.key === 'N' || e.key === 'Escape') && !e.repeat) {
          e.preventDefault();
          e.stopPropagation();
          if (this.loadingAction || this._cooldown) return;
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          this.cancelarTurno();
          return;
        }

        // Tecla P -> Pausar o Reanudar Mesa
        if ((e.key === 'p' || e.key === 'P') && !e.repeat) {
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
      };

      // Prevenir acción por defecto en keyup para Space/Enter (evita clicks residuales en botones del navegador)
      this._boundKeyUp = (e) => {
        const isSpace = (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar' || e.keyCode === 32);
        const isEnter = (e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === 'Enter' || e.keyCode === 13);
        if (isSpace || isEnter) {
          e.preventDefault();
          e.stopPropagation();
        }
      };

      window.addEventListener('keydown', this._boundKeyDown);
      window.addEventListener('keyup', this._boundKeyUp);
    },

    /**
     * Limpieza de recursos y desmontaje de listeners/timers
     */
    destroy() {
      if (this.relojTimer) {
        clearInterval(this.relojTimer);
        this.relojTimer = null;
      }
      if (this.cronometroTimer) {
        clearInterval(this.cronometroTimer);
        this.cronometroTimer = null;
      }
      if (this.feedbackTimer) {
        clearTimeout(this.feedbackTimer);
        this.feedbackTimer = null;
      }
      if (this._boundKeyDown) {
        window.removeEventListener('keydown', this._boundKeyDown);
        this._boundKeyDown = null;
      }
      if (this._boundKeyUp) {
        window.removeEventListener('keyup', this._boundKeyUp);
        this._boundKeyUp = null;
      }
      if (this.ws) {
        try {
          this.ws.disconnect();
        } catch (_) {}
        this.ws = null;
      }
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

        // Detectar cambio de día: limpiar lista de rezagados al cruzar medianoche
        // La BD ya filtra por fn_fecha_hoy(), pero los datos en memoria quedan del día anterior.
        const fechaActual = now.toDateString();
        if (fechaActual !== this._fechaHoy) {
          this._fechaHoy = fechaActual;
          this.listaRezagados = [];
          this.totalRezagados = 0;
          this.rezagadoSeleccionado = null;
          if (this.modalRezagados) {
            this.cerrarModalRezagados();
          }
          // Recargar desde el servidor con la fecha nueva
          this.cargarRezagados(true);
        }
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

      if (this.ws) {
        try { this.ws.disconnect(); } catch (_) {}
      }

      this.ws = new TurneroWSClient({
        token,
        canal: `mesa:${this.mesa.id}`,
        mesaId: this.mesa.id
      });

      this.ws.onStatusChange(({ status }) => {
        this.wsConnected = status === 'CONECTADO';
      });

      // Si el servidor rechaza el canal por discrepancia de mesa, resincronizar
      this.ws.on('auth_error', async ({ code, reason }) => {
        console.warn('[MESA] WebSocket error de autorización:', code, reason);
        try {
          const me = await api.get('/auth/me');
          if (me?.usuario?.mesa_asignada) {
            const nuevaMesa = me.usuario.mesa_asignada;
            if (Number(nuevaMesa.id) !== Number(this.mesa.id)) {
              showToast({
                message: `Sitio asignado actualizado a Mesa ${nuevaMesa.numero}. Reconectando...`,
                type: 'info',
                duration: 4000
              });
              this.mesa = nuevaMesa;
              sessionStorage.setItem('turnero_mesa', JSON.stringify(nuevaMesa));
              this.initWebSocket();
              await this.cargarEstado();
              return;
            }
          } else if (me?.usuario?.rol === 'operador' && !me.usuario.mesa_asignada) {
            showToast({
              message: 'Tu ventanilla fue liberada o desactivada. Redirigiendo a selección...',
              type: 'warning',
              duration: 3500
            });
            setTimeout(() => {
              window.location.href = '/index.html';
            }, 1200);
            return;
          }
        } catch (_) {}
      });

      // Evento de turno llamado para esta mesa (idempotente)
      this.ws.on('turno_llamado', (payload) => {
        if (payload && payload.turno) {
          if (this.turnoActual && Number(this.turnoActual.id) === Number(payload.turno.id)) {
            return; // Ya procesado
          }
          this.turnoActual = payload.turno;
          this.proximoNumero = payload.proximo_numero ?? null;
          this.vouchersRestantes = payload.vouchers_restantes ?? 0;
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

      this.ws.on('mesa_activa', () => {
        this.mesaPausada = false;
      });

      // El admin inactivó esta mesa: avisar al operador y redirigir a selección de mesa
      this.ws.on('mesa_inactivada', () => {
        this.mesaInactivada = true;
        // Limpiar la sesión de mesa para que el login muestre la grilla
        sessionStorage.removeItem('mesa_id');
        sessionStorage.removeItem('mesa_numero');
        sessionStorage.removeItem('mesa_nombre');
        // Redirigir tras 4 segundos para que el operador vea el aviso
        setTimeout(() => { window.location.href = '/'; }, 4000);
      });

      // Actualización en caliente del próximo turno cuando CUALQUIER mesa llama o el lote avanza (RF-TURN-09)
      // Recibido a través del canal lote:activo al que todos los operarios están suscritos.
      this.ws.on('proximo_actualizado', (payload) => {
        if (!payload) return;
        this.proximoNumero = payload.proximo_numero ?? null;
        if (payload.vouchers_restantes !== undefined) {
          this.vouchersRestantes = payload.vouchers_restantes;
        }
        if (payload.lote && this.loteActivo) {
          this.loteActivo.numero_lote = payload.lote;
        }
        if (payload.modo) {
          this.modo = payload.modo;
        }
      });

      // Sincronización en tiempo real de turnos rezagados entre ventanillas
      this.ws.on('rezagados_actualizados', async (payload) => {
        await this.cargarRezagados(true);

        if (!this.modalRezagados || !this.rezagadoSeleccionado) return;

        // Caso A: el evento anuncia exactamente el turno seleccionado como atendido
        if (payload && payload.accion === 'atendido' &&
            Number(this.rezagadoSeleccionado.id) === Number(payload.turno_id)) {
          const numAtendido = payload.turno_numero || this.rezagadoSeleccionado.numero;
          this.rezagadoSeleccionado = null;
          this.errorRezagado = `El turno #${numAtendido} acaba de ser atendido por Mesa ${payload.mesa_numero || '-'}.`;
          return;
        }

        // Caso B: el turno seleccionado ya no aparece en la lista actualizada
        // (otra mesa lo tomó pero por un evento diferente, o se canceló por cambio de día)
        const sigueEnLista = this.listaRezagados.some(
          r => Number(r.id) === Number(this.rezagadoSeleccionado.id)
        );
        if (!sigueEnLista) {
          const numDescartado = this.rezagadoSeleccionado.numero;
          this.rezagadoSeleccionado = null;
          this.errorRezagado = `El turno #${numDescartado} ya no está disponible — puede que otra ventanilla lo haya atendido.`;
        }
      });

      // Actualización en caliente si cambia la configuración de modo
      this.ws.on('config_actualizada', async (p) => {
        if (p && (p.clave === 'modo_generacion_turnos' || p.clave === 'kiosko_web_activo')) {
          await this.cargarEstado();
        }
      });

      // F-1: Actualización del nombre/número de la mesa en vivo (admin edita la mesa)
      this.ws.on('mesa_actualizada', (payload) => {
        if (!payload || !payload.mesa) return;
        const m = payload.mesa;
        // Verificar que el evento corresponde a esta mesa
        if (Number(m.id) !== Number(this.mesa.id)) return;
        if (m.numero !== undefined) this.mesa.numero = m.numero;
        if (m.nombre !== undefined) this.mesa.nombre = m.nombre;
      });

      // F-6: Lote pausado — el operador ya no puede llamar más turnos
      this.ws.on('lote_pausado', (payload) => {
        this.vouchersRestantes = 0;
        this.proximoNumero = null;
        if (payload && payload.lote) {
          if (this.loteActivo) this.loteActivo = { ...this.loteActivo, ...payload.lote };
        }
        showToast({
          message: 'El lote de vouchers fue pausado por el administrador. No hay más turnos disponibles por ahora.',
          type: 'warning',
          duration: 6000
        });
      });

      // F-7: Lote cerrado — igual que pausado pero definitivo
      this.ws.on('lote_cerrado', (payload) => {
        this.vouchersRestantes = 0;
        this.proximoNumero = null;
        if (payload && payload.lote) {
          if (this.loteActivo) this.loteActivo = null;
        }
        showToast({
          message: 'El lote de vouchers fue cerrado definitivamente. El admin debe crear uno nuevo.',
          type: 'warning',
          duration: 6000
        });
      });

      // F-8: Ajuste del contador del lote (admin corrige el número manualmente)
      this.ws.on('lote_contador_ajustado', (payload) => {
        if (!payload || !payload.lote) return;
        const lote = payload.lote;
        if (this.loteActivo) {
          this.loteActivo = { ...this.loteActivo, ultimo_numero_llamado: lote.ultimo_numero_llamado };
        }
        const restantes = Math.max(0, (lote.numero_hasta ?? this.loteActivo?.numero_hasta ?? 0) - lote.ultimo_numero_llamado);
        this.vouchersRestantes = restantes;
        this.proximoNumero = restantes > 0 ? lote.ultimo_numero_llamado + 1 : null;
      });

      // Snapshot tras reconexión por micro-corte (RF-WS-05)
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
          this.proximoNumero = payload.proximo_numero ?? null;
          if (payload.lote) {
            this.loteActivo = payload.lote;
            this.vouchersRestantes = Math.max(0, payload.lote.numero_hasta - payload.lote.ultimo_numero_llamado);
          } else if (payload.vouchers_restantes !== undefined) {
            this.vouchersRestantes = payload.vouchers_restantes;
          }
          if (payload.modo) {
            this.modo = payload.modo;
          }
          this.cargarRezagados(true);
        }
      });

      this.ws.connect();
    }
  };
}

// Registro limpio en Alpine.js (sin contaminar el objeto window)
function registerPanelMesaWithAlpine() {
  if (typeof window !== 'undefined' && window.Alpine) {
    window.Alpine.data('panelMesa', panelMesaView);
    window.Alpine.data('panelMesaView', panelMesaView);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('alpine:init', registerPanelMesaWithAlpine);
  if (typeof window !== 'undefined' && window.Alpine) {
    registerPanelMesaWithAlpine();
  }
}

