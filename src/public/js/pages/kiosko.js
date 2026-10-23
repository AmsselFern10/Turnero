/**
 * ==============================================================================
 * KIOSKO.JS — Controlador de Autoservicio y Toma de Turnos Táctil
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cumple con:
 * - Numeración propia e independiente de lotes de vouchers físicos.
 * - Idempotency-Key por toque: protege contra doble clic o timeout de red.
 * - Restricción de 1 turno activo por smartphone (localStorage + deviceId).
 * - Modo Tablet (?modo=tablet) sin restricción de 1 turno por dispositivo.
 * - Seguimiento móvil en tiempo real vía canal público único 'kiosko:publico'.
 * - Sistema de audio híbrido, vibración y WakeLock para evitar pantalla apagada.
 * - Fallback accesible de código QR vectorial sin dibujos falsos.
 * ==============================================================================
 */

import { api } from '../api.js';
import { TurneroWSClient } from '../ws-client.js';
import { playCallChime, initFondoPersonalizado } from '../utils.js';
import { WebBluetoothThermalPrinter, construirVoucherESCPOS } from '../escpos-printer.js';

function generarUUID () {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export function kioskoView () {
  return {
    // Estado de la pantalla: 'welcome' | 'ticket' | 'seguimiento'
    step: 'welcome',

    // Modo operativo: true si es modalidad asistida en tablet (?modo=tablet)
    esTablet: false,

    // Modalidad configurada en el sistema ('asistido' | 'estudiante' | 'empleado')
    kioskoModoUso: 'asistido',

    // Estado del kiosko obtenido de /kiosko/estado
    kioskoActivo: true,
    topeAlcanzado: false,

    // Datos del ticket emitido
    ticketData: {
      numero: null,
      token: null,
      creado_en: null,
      posicion_en_cola: 0,
      tiempoEstimadoMin: 0,
      tracking_url: ''
    },

    // Estado del turno en seguimiento desde smartphone
    seguimientoData: {
      numero: null,
      estado: 'esperando', // 'esperando' | 'en_atencion' | 'atendido' | 'cancelado'
      posicion: 0,
      mesa: null,
      mesa_numero: null,
      llamado_en: null
    },

    // Estados de interfaz y red
    isGenerating: false,
    isPrinting: false,
    avisoImpresion: '',
    estaActualizando: false,
    errorTemporalConexion: false,
    _yaAlertadoLlamado: false,
    _reintentosFallidos: 0,
    _reintentoTimer: null,
    errorMessage: '',
    mostrarBotonReintentar: false,
    toastMessage: '',
    showToast: false,
    qrFallback: false,
    wsConectado: false,
    redLocalOk: false,
    impresionAutomatica: false,

    // Impresión Híbrida (Modo Asistido / Tablet)
    modalImpresora: false,
    canalImpresion: 'servidor', // 'servidor' | 'bluetooth' | 'sistema' | 'ninguno'
    ipTabletPersonalizada: '',
    impresoraServidorActiva: false,
    impresoraServidorIp: '',
    impresoraServidorPuerto: 9100,
    bluetoothPrinter: null,
    bluetoothConectado: false,
    bluetoothDispositivoNombre: '',
    conectandoBluetooth: false,
    probandoImpresora: false,
    mensajePrueba: '',
    errorPrueba: '',

    // Idempotencia y dispositivo
    deviceId: null,
    currentIdempotencyKey: null,

    // Temporizadores y referencias de limpieza
    autoResetTimer: null,
    cuentaRegresivaTimer: null,
    cuentaRegresiva: 0,
    ws: null,
    wakeLockSentinel: null,
    _onVisibilityHandler: null,
    tituloOriginal: typeof document !== 'undefined' ? document.title : '',

    /**
     * Propiedad calculada: texto de personas antes en ticket
     */
    get personasAntesTexto () {
      const pos = this.ticketData.posicion_en_cola ?? 0;
      if (pos === 0) return 'Próximo a pasar';
      if (pos === 1) return '1 persona antes';
      return `${pos} personas antes`;
    },

    /**
     * Propiedad calculada: texto de personas antes en seguimiento
     */
    get seguimientoPersonasAntesTexto () {
      const pos = this.seguimientoData.posicion ?? 0;
      if (pos === 0) return '¡Eres el próximo en ser llamado!';
      if (pos === 1) return '1 persona antes de ti';
      return `${pos} personas antes de ti`;
    },

    get subtituloHeader () {
      return this.esTablet
        ? 'Modalidad asistida • Emisión de turnos'
        : 'Autoservicio • Kiosko estudiantil';
    },

    get estadoConexionTexto () {
      return this.wsConectado ? 'En línea' : 'Reconectando...';
    },

    get modoUsoBadgeTexto () {
      if (this.esTablet) return 'Atención asistida • Portón';
      return this.kioskoModoUso === 'asistido' ? 'Modalidad asistida' : 'Emisión de turnos';
    },

    get tituloBienvenida () {
      return this.esTablet
        ? 'Módulo de asignación de turnos'
        : 'Bienvenido al proceso de matrícula';
    },

    get descripcionBienvenida () {
      if (this.esTablet) {
        return 'Presione el botón para asignar el siguiente turno oficial y emitir el comprobante.';
      }
      return this.kioskoModoUso === 'asistido'
        ? 'El proceso se atiende de forma presencial asistida en portería.'
        : 'Presiona el botón para tomar tu turno correlativo y asignarte a la fila oficial de hoy.';
    },

    get tituloTopePausado () {
      return this.topeAlcanzado ? 'Límite de turnos alcanzado hoy' : 'Servicio pausado';
    },

    get mensajeTopePausado () {
      return this.topeAlcanzado
        ? 'Se ha alcanzado el número máximo de turnos asignados para esta jornada.'
        : 'El servicio digital no está admitiendo turnos en este momento. Solicite su voucher físico.';
    },

    get textoBotonGenerar () {
      return this.esTablet ? 'Asignar turno' : 'Tomar mi turno';
    },

    get tiempoEstimadoTexto () {
      return `~${this.ticketData?.tiempoEstimadoMin ?? 0} min`;
    },

    get destinoLlamadoTexto () {
      const mesa = this.seguimientoData?.mesa_numero
        ? `Mesa ${this.seguimientoData.mesa_numero}`
        : (this.seguimientoData?.mesa || 'Ventanilla');
      return `Diríjase a ${mesa}`;
    },

    get estadoRedLocalTexto () {
      return this.redLocalOk ? 'Red local LAN conectada' : 'Sin conexión';
    },

    get bluetoothDisponible () {
      return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);
    },

    get tieneImpresoraHabilitada () {
      if (this.canalImpresion === 'ninguno') return false;
      if (this.canalImpresion === 'bluetooth') return this.bluetoothConectado;
      if (this.canalImpresion === 'servidor') {
        return Boolean((this.ipTabletPersonalizada || this.impresoraServidorIp).trim());
      }
      if (this.canalImpresion === 'sistema') return true;
      return false;
    },

    get badgeImpresoraTexto () {
      if (!this.esTablet) return '';
      if (this.canalImpresion === 'ninguno') return 'Sin impresora';
      if (this.canalImpresion === 'bluetooth') {
        return this.bluetoothConectado
          ? (this.bluetoothDispositivoNombre || 'Bluetooth')
          : 'BT Desconectado';
      }
      if (this.canalImpresion === 'servidor') {
        const ip = (this.ipTabletPersonalizada || this.impresoraServidorIp).trim();
        return ip ? `LAN: ${ip}` : 'LAN Sin IP';
      }
      if (this.canalImpresion === 'sistema') return 'Impresora SO';
      return 'Impresora';
    },

    get badgeImpresoraClases () {
      if (this.canalImpresion === 'ninguno') {
        return 'bg-slate-100 text-slate-500 border-slate-200';
      }
      if (this.canalImpresion === 'bluetooth') {
        return this.bluetoothConectado
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
          : 'bg-amber-50 text-amber-700 border-amber-200';
      }
      if (this.canalImpresion === 'servidor') {
        const tieneIp = Boolean((this.ipTabletPersonalizada || this.impresoraServidorIp).trim());
        return tieneIp
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
          : 'bg-amber-50 text-amber-700 border-amber-200';
      }
      if (this.canalImpresion === 'sistema') {
        return 'bg-blue-50 text-blue-700 border-blue-200';
      }
      return 'bg-slate-100 text-slate-600 border-slate-200';
    },

    get badgeImpresoraTitle () {
      return 'Configurar canal de impresión (Bluetooth, LAN o Sistema)';
    },

    /**
     * Inicialización del Kiosko
     */
    async init () {
      // 1. Detectar modo tablet exclusivamente si la URL indica ?modo=tablet
      const urlParams = new URLSearchParams(window.location.search);
      const modoParam = urlParams.get('modo');
      if (modoParam === 'tablet') {
        this.esTablet = true;
        try {
          localStorage.setItem('turnero_modo_tablet', '1');
          localStorage.removeItem('turnero_mi_turno'); // El módulo de portón no retiene turnos de estudiante
        } catch (_) {}
      } else {
        // Enlace sin ?modo=tablet o con ?modo=estudiante -> Modo autoservicio / estudiante
        this.esTablet = false;
        try {
          localStorage.removeItem('turnero_modo_tablet');
        } catch (_) {}
      }

      // Inicializar canal de impresión si es tablet
      this.inicializarImpresora();

      // 2. Obtener o generar identificador persistente del dispositivo móvil
      this.inicializarDeviceId();

      // 3. Conectar al WebSocket en canal público para avisos en vivo
      this.conectarWebSocketPublico();
      initFondoPersonalizado(this.ws);

      // 4. Sincronización al despertar pantalla del smartphone (con throttle de 10s para evitar saturación)
      this._lastSyncTime = Date.now();
      this._onVisibilityHandler = () => {
        const token = this.ticketData.token || this.seguimientoData.token;
        const now = Date.now();
        if (document.visibilityState === 'visible' && this.step === 'seguimiento' && token) {
          if (now - this._lastSyncTime >= 10000) {
            this.sincronizarSeguimiento(token);
          }
        }
      };
      document.addEventListener('visibilitychange', this._onVisibilityHandler);

      // 5. Comprobar si se ingresó directamente con ?token=64chars
      const tokenParam = urlParams.get('token');
      if (tokenParam) {
        if (tokenParam.length === 64) {
          this.step = 'seguimiento';
          await this.iniciarSeguimiento(tokenParam);
          return;
        } else {
          this.errorMessage = 'El enlace de seguimiento no es válido o está incompleto.';
          this.step = 'welcome';
          return;
        }
      }

      // 6. En celulares (no tablet): comprobar si ya tiene un turno activo en localStorage
      if (!this.esTablet) {
        const turnoLocal = this.obtenerTurnoGuardado();
        if (turnoLocal && turnoLocal.token && turnoLocal.token.length === 64) {
          this.step = 'seguimiento';
          await this.iniciarSeguimiento(turnoLocal.token);
          return;
        }
      }

      // 7. Consultar estado del kiosko para bloquear botón si está pausado o tope lleno
      this.step = 'welcome';
      await this.verificarEstadoKiosko();
    },

    /**
     * Obtiene o genera UUID de dispositivo persistente en localStorage
     */
    inicializarDeviceId () {
      try {
        let did = localStorage.getItem('turnero_device_id');
        if (!did) {
          did = generarUUID();
          localStorage.setItem('turnero_device_id', did);
        }
        this.deviceId = did;
      } catch (_) {
        this.deviceId = generarUUID();
      }
    },

    /**
     * Obtiene datos del turno activo guardado en localStorage
     */
    obtenerTurnoGuardado () {
      try {
        const raw = localStorage.getItem('turnero_mi_turno');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.token) return null;

        const hoyStr = new Date().toISOString().slice(0, 10);
        if (parsed.fecha && parsed.fecha !== hoyStr) {
          localStorage.removeItem('turnero_mi_turno');
          return null;
        }
        if (parsed.creado_en) {
          const fechaCreado = new Date(parsed.creado_en).toISOString().slice(0, 10);
          if (fechaCreado !== hoyStr) {
            localStorage.removeItem('turnero_mi_turno');
            return null;
          }
        }
        return parsed;
      } catch (_) {
        return null;
      }
    },

    /**
     * Guarda el turno activo en localStorage
     */
    guardarTurnoLocal (data) {
      try {
        const hoyStr = new Date().toISOString().slice(0, 10);
        localStorage.setItem('turnero_mi_turno', JSON.stringify({
          token: data.token,
          numero: data.numero,
          creado_en: data.creado_en,
          fecha: hoyStr
        }));
      } catch (_) {}
    },

    /**
     * Limpia el turno activo de localStorage al finalizar la atención
     */
    liberarTurnoSeguimiento () {
      try {
        localStorage.removeItem('turnero_mi_turno');
      } catch (_) {}
      this.soltarWakeLock();
      document.title = this.tituloOriginal;
      this.ticketData = { numero: null, token: null, creado_en: null, posicion_en_cola: 0, tiempoEstimadoMin: 0, tracking_url: '' };
      this.seguimientoData = { numero: null, estado: 'esperando', posicion: 0, mesa: null, llamado_en: null };
      this.step = 'welcome';
      window.history.replaceState({}, '', window.location.pathname + (this.esTablet ? '?modo=tablet' : ''));
    },

    /**
     * Consulta el estado del kiosko al abrir la pantalla
     */
    async verificarEstadoKiosko () {
      try {
        const res = await api.get('/kiosko/estado', { public: true });
        this.redLocalOk = true;
        this.kioskoActivo = res.activo === true;
        this.topeAlcanzado = res.tope_alcanzado === true;
        this.kioskoModoUso = res.modo_uso || 'asistido';
        const esModoAsistido = this.kioskoModoUso === 'asistido' || this.kioskoModoUso === 'empleado';

        // Leer ajuste de impresión automática y datos de impresora del servidor
        if (res.impresion_automatica !== undefined) {
          this.impresionAutomatica = res.impresion_automatica === true;
        }
        if (res.impresora_activa !== undefined) {
          this.impresoraServidorActiva = res.impresora_activa === true;
        }
        if (res.impresora_ip !== undefined) {
          this.impresoraServidorIp = res.impresora_ip || '';
        }
        if (res.impresora_puerto !== undefined) {
          this.impresoraServidorPuerto = parseInt(res.impresora_puerto, 10) || 9100;
        }

        if (!this.kioskoActivo) {
          this.errorMessage = 'El servicio digital de turnos no está activo actualmente. Solicite su voucher físico.';
        } else if (this.topeAlcanzado) {
          this.errorMessage = 'Se ha alcanzado el límite diario de turnos para el día de hoy.';
        } else {
          this.errorMessage = '';
        }
      } catch (err) {
        this.redLocalOk = false;
        console.warn('[Kiosko] No se pudo verificar estado del kiosko:', err);
      }
    },

    /**
     * Formatea el número de turno (#047)
     */
    formatTicket (num) {
      if (num === null || num === undefined || num === '' || isNaN(num)) return '--';
      return '#' + String(num).padStart(3, '0');
    },

    /**
     * Generación atómica de turno táctil (RF-GEN-02 con numeración propia e Idempotency-Key)
     */
    async generarTurno () {
      const esModoAsistido = this.kioskoModoUso === 'asistido' || this.kioskoModoUso === 'empleado';
      if (this.isGenerating || !this.kioskoActivo || this.topeAlcanzado || (!this.esTablet && esModoAsistido)) return;

      if (!this.wsConectado) {
        this.errorMessage = 'Sin conexión con el servidor. Emisión de turnos pausada temporalmente.';
        return;
      }

      this.isGenerating = true;
      this.errorMessage = '';
      this.mostrarBotonReintentar = false;

      // Generar Idempotency-Key única si no hay una activa de un intento previo
      if (!this.currentIdempotencyKey) {
        this.currentIdempotencyKey = generarUUID();
      }

      try {
        const headers = {
          'Idempotency-Key': this.currentIdempotencyKey,
          'X-Device-Id': this.deviceId
        };

        const body = {
          idempotency_key: this.currentIdempotencyKey,
          device_id: this.deviceId,
          modo: this.esTablet ? 'tablet' : 'celular'
        };

        const data = await api.post('/turnos/generar', body, {
          headers,
          public: true
        });

        // Éxito: limpiar idempotency key para futuros turnos
        this.currentIdempotencyKey = null;

        const posicion = data.posicion_en_cola ?? 0;
        const estimadoMin = data.tiempo_estimado_min ?? Math.max(1, Math.round((posicion * 3) / 2));

        this.ticketData = {
          numero: data.numero,
          token: data.token,
          creado_en: data.creado_en,
          posicion_en_cola: posicion,
          tiempoEstimadoMin: estimadoMin,
          tracking_url: data.tracking_url || `${window.location.origin}/kiosko.html?token=${encodeURIComponent(data.token)}`
        };

        this.seguimientoData = {
          numero: data.numero,
          estado: 'esperando',
          posicion: posicion,
          mesa: null,
          llamado_en: null
        };

        // Si es smartphone, guardar en localStorage para persistencia y pasar directo a seguimiento
        if (!this.esTablet) {
          this.guardarTurnoLocal(this.ticketData);
          this.mostrarToast(`Turno ${this.formatTicket(data.numero)} asignado exitosamente`);
          this.step = 'seguimiento';
          await this.iniciarSeguimiento(data.token);
        } else {
          // Modo tablet pública en portón: pantalla de voucher con auto-reset de 8s
          this.step = 'ticket';
          this.mostrarToast(`Turno ${this.formatTicket(data.numero)} asignado exitosamente`);

          // Renderizar el código QR vectorial (200px)
          this.$nextTick(() => {
            this.generarCodigoQR(this.ticketData.tracking_url);
          });

          this.iniciarAutoReset(15);
          this.iniciarCuentaRegresiva(15);

          // Manejo del estado de impresión automática
          if (this.impresionAutomatica && this.tieneImpresoraHabilitada) {
            if (this.canalImpresion === 'bluetooth') {
              this.imprimirTicket(false);
            } else if (this.canalImpresion === 'servidor' && this.ipTabletPersonalizada) {
              this.imprimirTicket(false);
            } else if (data.impresion) {
              if (data.impresion.ok) {
                this.avisoImpresion = 'Comprobante impreso de inmediato.';
                this.mostrarToast(`Voucher ${this.formatTicket(data.numero)} enviado a la impresora`);
              } else {
                this.avisoImpresion = `Aviso: No se pudo imprimir (${data.impresion.mensaje}). El turno está registrado y visible en pantalla.`;
                this.mostrarToast('Aviso: Impresora no disponible');
              }
            } else {
              this.imprimirTicket(false);
            }
          } else if (data.impresion && data.impresion.ok) {
            this.avisoImpresion = 'Comprobante impreso de inmediato.';
            this.mostrarToast(`Voucher ${this.formatTicket(data.numero)} enviado a la impresora`);
          } else {
            this.avisoImpresion = '';
          }
        }

      } catch (err) {
        console.error('[Kiosko] Error al generar turno:', err);
        const status = err.status || 500;
        const codigo = err.codigo || '';

        if (status === 403 || codigo === 'kiosko_desactivado' || codigo === 'modo_no_kiosko' || codigo === 'modo_asistido_activo') {
          this.errorMessage = err.message || 'El servicio digital de turnos no está activo. Solicite su voucher físico.';
          if (codigo === 'kiosko_desactivado' || codigo === 'modo_no_kiosko') {
            this.kioskoActivo = false;
          }
        } else if (status === 409 || codigo === 'tope_diario_alcanzado') {
          this.errorMessage = 'Se ha alcanzado el límite diario de turnos configurado para hoy.';
          this.topeAlcanzado = true;
        } else if (status === 429 || codigo === 'espere_antes_de_reintentar') {
          this.errorMessage = 'Por favor espere unos segundos antes de solicitar otro turno.';
        } else if (status === 503 || codigo === 'cola_llena') {
          this.errorMessage = 'El servidor está temporalmente sobrecargado. Intente en unos minutos.';
          this.mostrarBotonReintentar = true;
        } else {
          this.errorMessage = err.message || 'Error de comunicación con el nodo central. Compruebe la conexión de red.';
          this.mostrarBotonReintentar = true;
        }
      } finally {
        this.isGenerating = false;
      }
    },

    /**
     * Reintento ante fallo de red conservando la misma clave de idempotencia
     */
    async reintentar () {
      this.errorMessage = '';
      this.mostrarBotonReintentar = false;
      if (this.step === 'welcome') {
        await this.generarTurno();
      } else if (this.step === 'seguimiento' && this.ticketData.token) {
        await this.iniciarSeguimiento(this.ticketData.token);
      }
    },

    /**
     * Renderiza el código QR vectorial apuntando a la URL pública de seguimiento
     */
    generarCodigoQR (trackingUrl) {
      const container = document.getElementById('kiosko-qr-container');
      if (!container) return;

      container.innerHTML = '';
      this.qrFallback = false;

      if (window.QRCode) {
        try {
          new window.QRCode(container, {
            text: trackingUrl,
            width: 200,
            height: 200,
            colorDark: '#0F172A',
            colorLight: '#FFFFFF',
            correctLevel: window.QRCode.CorrectLevel.M
          });
        } catch (qrErr) {
          console.warn('[Kiosko] Librería QR reportó error. Activando enlace de respaldo:', qrErr);
          this.qrFallback = true;
        }
      } else {
        this.qrFallback = true;
      }
    },

    /**
     * Inicializa la configuración de impresión persistente y Bluetooth
     */
    inicializarImpresora () {
      if (!this.esTablet) return;
      try {
        const canalGuardado = localStorage.getItem('turnero_kiosko_canal_impresion');
        if (canalGuardado && ['servidor', 'bluetooth', 'sistema', 'ninguno'].includes(canalGuardado)) {
          this.canalImpresion = canalGuardado;
        }
        this.ipTabletPersonalizada = (localStorage.getItem('turnero_kiosko_impresora_ip') || '').trim();
      } catch (_) {}

      if (this.bluetoothDisponible && !this.bluetoothPrinter) {
        this.bluetoothPrinter = new WebBluetoothThermalPrinter({
          onConnected: (dev) => {
            this.bluetoothConectado = true;
            this.bluetoothDispositivoNombre = dev?.name || 'Impresora Térmica';
            this.mostrarToast(`Impresora Bluetooth conectada: ${this.bluetoothDispositivoNombre}`);
          },
          onDisconnected: () => {
            this.bluetoothConectado = false;
            this.mostrarToast('Impresora Bluetooth desconectada');
          }
        });

        if (this.canalImpresion === 'bluetooth') {
          this.bluetoothPrinter.reconectarSilencioso().catch(() => {});
        }
      }
    },

    abrirModalImpresora () {
      this.mensajePrueba = '';
      this.errorPrueba = '';
      this.modalImpresora = true;
    },

    cerrarModalImpresora () {
      this.modalImpresora = false;
    },

    guardarConfigImpresora () {
      try {
        localStorage.setItem('turnero_kiosko_canal_impresion', this.canalImpresion);
        if (this.ipTabletPersonalizada.trim()) {
          localStorage.setItem('turnero_kiosko_impresora_ip', this.ipTabletPersonalizada.trim());
        } else {
          localStorage.removeItem('turnero_kiosko_impresora_ip');
        }
        this.mostrarToast('Configuración de impresión guardada');
      } catch (_) {}
      this.cerrarModalImpresora();
    },

    async conectarBluetooth () {
      if (!this.bluetoothPrinter) {
        this.errorPrueba = 'Web Bluetooth no está disponible en este dispositivo.';
        return;
      }
      this.conectandoBluetooth = true;
      this.errorPrueba = '';
      try {
        await this.bluetoothPrinter.conectar();
        this.canalImpresion = 'bluetooth';
        try { localStorage.setItem('turnero_kiosko_canal_impresion', 'bluetooth'); } catch (_) {}
      } catch (err) {
        if (err.name !== 'NotFoundError') {
          this.errorPrueba = `Fallo al emparejar Bluetooth: ${err.message}`;
        }
      } finally {
        this.conectandoBluetooth = false;
      }
    },

    desconectarBluetooth () {
      if (this.bluetoothPrinter) {
        this.bluetoothPrinter.desconectar();
      }
    },

    async probarImpresion () {
      this.probandoImpresora = true;
      this.mensajePrueba = '';
      this.errorPrueba = '';
      const ahora = new Date();
      const ticketPrueba = {
        numero: 999,
        formato: '#999',
        modulo: 'Prueba de Impresión',
        tracking_url: window.location.origin,
        fecha: ahora.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
      };

      try {
        if (this.canalImpresion === 'bluetooth') {
          if (!this.bluetoothConectado || !this.bluetoothPrinter) {
            throw new Error('Primero vincule y conecte la impresora Bluetooth.');
          }
          const bytes = construirVoucherESCPOS(ticketPrueba);
          await this.bluetoothPrinter.imprimir(bytes);
          this.mensajePrueba = 'Comprobante de prueba enviado vía Bluetooth.';
        } else if (this.canalImpresion === 'servidor') {
          const ipDestino = (this.ipTabletPersonalizada || this.impresoraServidorIp).trim();
          if (!ipDestino) {
            throw new Error('No hay dirección IP configurada para la impresora en red.');
          }
          await api.post('/kiosko/imprimir', {
            numero: 999,
            formato: '#999',
            modulo: 'Prueba de Impresión',
            tracking_url: window.location.origin,
            ip: ipDestino,
            puerto: this.impresoraServidorPuerto
          }, { public: true });
          this.mensajePrueba = `Comprobante de prueba enviado a ${ipDestino}.`;
        } else if (this.canalImpresion === 'sistema') {
          this._abrirVentanaImpresion('#999', '999');
          this.mensajePrueba = 'Abriendo ventana de impresión del sistema.';
        } else {
          throw new Error('La impresión está desactivada.');
        }
      } catch (err) {
        this.errorPrueba = err.message || err.mensaje || 'Error desconocido al probar la impresora.';
      } finally {
        this.probandoImpresora = false;
      }
    },

    /**
     * Imprime el voucher actual mediante el canal configurado.
     * Soporta reimpresión de copia (esReimpresion=true).
     */
    async imprimirTicket (esReimpresion = false) {
      if (this.isPrinting || !this.ticketData.numero) return;
      this.isPrinting = true;
      this.reiniciarAutoReset();

      const num = this.formatTicket(this.ticketData.numero);
      const numLimpio = num.replace('#', '');
      const ahora = new Date();
      const ticketObj = {
        numero: this.ticketData.numero,
        formato: num,
        modulo: 'Módulo de Matrículas',
        tracking_url: this.ticketData.tracking_url || '',
        fecha: ahora.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
      };

      try {
        if (this.esTablet) {
          if (this.canalImpresion === 'bluetooth') {
            if (!this.bluetoothConectado || !this.bluetoothPrinter) {
              throw new Error('Impresora Bluetooth no conectada. Conéctela desde el icono de impresora en el encabezado.');
            }
            const bytes = construirVoucherESCPOS(ticketObj);
            await this.bluetoothPrinter.imprimir(bytes);
            this.avisoImpresion = esReimpresion ? 'Copia impresa vía Bluetooth.' : 'Comprobante impreso vía Bluetooth.';
            this.mostrarToast(`${esReimpresion ? 'Copia de ' : ''}${num} impresa vía Bluetooth`);
            return;
          }

          if (this.canalImpresion === 'servidor') {
            const ipDestino = (this.ipTabletPersonalizada || this.impresoraServidorIp).trim();
            const payload = {
              numero: this.ticketData.numero,
              formato: num,
              modulo: 'Módulo de Matrículas',
              tracking_url: this.ticketData.tracking_url || ''
            };
            if (ipDestino) {
              payload.ip = ipDestino;
              payload.puerto = this.impresoraServidorPuerto;
            }
            const res = await api.post('/kiosko/imprimir', payload, { public: true });
            if (res.ok) {
              this.avisoImpresion = esReimpresion ? 'Copia enviada a la impresora.' : 'Comprobante enviado a la impresora.';
              this.mostrarToast(`${esReimpresion ? 'Copia de ' : ''}${num} enviada a impresora`);
            } else {
              this.avisoImpresion = `Aviso: ${res.mensaje || 'Impresora no respondió.'}`;
              this.mostrarToast(res.mensaje || 'Error de impresora');
            }
            return;
          }

          if (this.canalImpresion === 'sistema') {
            this._abrirVentanaImpresion(num, numLimpio);
            this.avisoImpresion = 'Abriendo diálogo de impresión del sistema.';
            return;
          }

          // Si canal es 'ninguno', no hace nada
          return;
        }

        // Modo celular: siempre ventana de impresión / PDF
        this._abrirVentanaImpresion(num, numLimpio);
      } catch (err) {
        console.warn('[Kiosko] Error al imprimir voucher:', err);
        const msg = err.mensaje || err.message || 'Error al imprimir ticket.';
        this.avisoImpresion = `Aviso: ${msg} (El turno ${num} está registrado en pantalla).`;
        this.mostrarToast('No se pudo imprimir el comprobante');
      } finally {
        this.isPrinting = false;
      }
    },

    /**
     * Abre una ventana emergente con el HTML del voucher para impresión/PDF.
     * Usado como flujo principal en celular y como fallback en tablet.
     * Diseñado estrictamente para rollos térmicos continuos (58mm y 80mm) sin desborde de páginas.
     */
    _abrirVentanaImpresion (num, numLimpio) {
      const trackingUrl = this.ticketData.tracking_url || '';
      const ahora = new Date();
      const fecha = ahora.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const hora  = ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

      // Capturar QR existente como data URL
      const qrContainer = document.getElementById('kiosko-qr-container');
      const qrCanvas = qrContainer?.querySelector('canvas');
      const qrImg    = qrContainer?.querySelector('img');
      let qrHtml = '';
      if (qrCanvas) {
        try { qrHtml = `<img src="${qrCanvas.toDataURL('image/png')}" width="115" height="115" alt="QR">`; } catch (_) {}
      } else if (qrImg?.src) {
        qrHtml = `<img src="${qrImg.src}" width="115" height="115" alt="QR">`;
      }

      const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Voucher-${numLimpio}</title>
  <style>
    @page {
      margin: 0;
      size: auto;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: 100%;
      background: #FFFFFF;
      color: #000000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Courier New", monospace;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body {
      padding: 2mm 0;
      text-align: center;
    }
    .voucher {
      width: 52mm;
      max-width: 52mm;
      margin: 0 auto;
      padding: 2mm 1mm;
      text-align: center;
      page-break-inside: avoid;
      break-inside: avoid;
      page-break-after: avoid;
      break-after: avoid;
    }
    .inst {
      font-size: 8.5pt;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      line-height: 1.2;
    }
    .sub {
      font-size: 7pt;
      color: #333333;
      margin-top: 1mm;
    }
    .sep {
      border: none;
      border-top: 1px dashed #000000;
      margin: 2.5mm 0;
    }
    .numero {
      font-size: 38pt;
      font-weight: 900;
      font-family: monospace;
      line-height: 1;
      letter-spacing: -1px;
      margin: 1.5mm 0;
    }
    .modulo {
      font-size: 7.5pt;
      font-weight: 600;
      color: #222222;
      line-height: 1.2;
    }
    .qr {
      margin: 2mm auto;
      display: block;
    }
    .qr img {
      display: block;
      margin: 0 auto;
      width: 110px;
      height: 110px;
    }
    .qr-label {
      font-size: 6.5pt;
      color: #444444;
      margin-top: 1.5mm;
      line-height: 1.2;
    }
    .pie {
      font-size: 6.5pt;
      color: #444444;
      line-height: 1.3;
      margin-top: 2mm;
    }
  </style>
</head>
<body>
  <div class="voucher">
    <div class="inst">MATRÍCULAS 2026</div>
    <div class="sub">Turno Digital de Atención</div>
    <hr class="sep">
    <div class="numero">${num}</div>
    <div class="modulo">Módulo General de Matrículas</div>
    <hr class="sep">
    ${qrHtml ? `<div class="qr">${qrHtml}<div class="qr-label">Escanea para seguir tu turno</div></div>` : ''}
    <div class="pie">${fecha} • ${hora}<br>Válido solo para hoy</div>
  </div>
</body>
</html>`;

      const win = window.open('', '_blank', 'width=320,height=480,toolbar=no,menubar=no,status=no');
      if (!win) {
        this.mostrarToast('Permite las ventanas emergentes para imprimir');
        return;
      }

      win.document.open();
      win.document.write(html);
      win.document.close();

      let yaImpreso = false;
      const lanzarImpresion = () => {
        if (yaImpreso) return;
        yaImpreso = true;
        try {
          win.focus();
          win.print();
        } catch (_) {}
        setTimeout(() => {
          try { win.close(); } catch (_) {}
        }, 400);
      };

      if (win.document.readyState === 'complete') {
        setTimeout(lanzarImpresion, 150);
      } else {
        win.onload = () => setTimeout(lanzarImpresion, 150);
        setTimeout(lanzarImpresion, 600);
      }

      this.mostrarToast(`Voucher ${num} enviado al diálogo de impresión`);
      document.title = `Voucher-${numLimpio}`;
      setTimeout(() => { document.title = this.tituloOriginal; }, 2500);
    },

    /**
     * Vuelve a la pantalla inicial de bienvenida y limpia los datos de memoria
     */
    volverABienvenida () {
      if (this.autoResetTimer) {
        clearTimeout(this.autoResetTimer);
        this.autoResetTimer = null;
      }
      this.errorMessage = '';
      this.ticketData = {
        numero: null,
        token: null,
        creado_en: null,
        posicion_en_cola: 0,
        tiempoEstimadoMin: 0,
        tracking_url: ''
      };
      this.step = 'welcome';
    },

    /**
     * Inicia o reinicia el retorno automático.
     * Solo activo en Tablet pública (15s). Desactivado en smartphones personales.
     */
    iniciarAutoReset (segundos) {
      if (!this.esTablet) return; // NUNCA auto-reset en teléfonos de estudiantes
      const seg = segundos ?? 15;
      if (this.autoResetTimer) clearTimeout(this.autoResetTimer);
      this.autoResetTimer = setTimeout(() => {
        this.volverABienvenida();
      }, seg * 1000);
    },

    /**
     * Cuenta regresiva visible en pantalla (solo tablet)
     */
    iniciarCuentaRegresiva (segundos) {
      if (this.cuentaRegresivaTimer) clearInterval(this.cuentaRegresivaTimer);
      this.cuentaRegresiva = segundos;
      this.cuentaRegresivaTimer = setInterval(() => {
        this.cuentaRegresiva--;
        if (this.cuentaRegresiva <= 0) {
          clearInterval(this.cuentaRegresivaTimer);
          this.cuentaRegresivaTimer = null;
          this.cuentaRegresiva = 0;
        }
      }, 1000);
    },

    reiniciarAutoReset () {
      if (this.esTablet && this.step === 'ticket') {
        const seg = 15;
        this.iniciarAutoReset(seg);
        this.iniciarCuentaRegresiva(seg);
      }
    },

    /**
     * Tablet: asigna el siguiente turno de inmediato sin pasar por bienvenida.
     * Limpia el ticket actual y lanza generarTurno() directamente.
     */
    async asignarSiguiente () {
      if (this.autoResetTimer) { clearTimeout(this.autoResetTimer); this.autoResetTimer = null; }
      if (this.cuentaRegresivaTimer) { clearInterval(this.cuentaRegresivaTimer); this.cuentaRegresivaTimer = null; }
      this.cuentaRegresiva = 0;
      this.errorMessage = '';
      this.ticketData = { numero: null, token: null, creado_en: null, posicion_en_cola: 0, tiempoEstimadoMin: 0, tracking_url: '' };
      this.step = 'welcome';
      // Pausa breve antes de asignar siguiente turno
      await new Promise(r => setTimeout(r, 300));
      await this.generarTurno();
    },

    /**
     * Conexión WebSocket al canal público único 'kiosko:publico' (RF-WS-01)
     */
    conectarWebSocketPublico () {
      // Fix 2: guard robusto — solo evitar duplicar si el WS está en ciclo activo
      if (this.ws && (this.ws.status === 'CONECTADO' || this.ws.status === 'CONECTANDO' || this.ws.status === 'RECONECTANDO')) return;
      // Si existe pero murió silenciosamente (error sin destroy), limpiar y recrear
      if (this.ws) {
        try { this.ws.disconnect(); } catch (_) {}
        this.ws = null;
      }

      this.ws = new TurneroWSClient({
        canal: 'kiosko:publico',
        token: ''
      });

      this.ws.onStatusChange(({ status }) => {
        this.wsConectado = status === 'CONECTADO';
        this.redLocalOk = status === 'CONECTADO';
      });

      this.ws.on('snapshot', (payload) => {
        if (!payload || !this.ticketData.token) return;
        if (this.step === 'seguimiento' || this.step === 'ticket') {
          const miNum = this.seguimientoData.numero || this.ticketData.numero;
          const ult = payload.ultimo_llamado;
          if (ult && miNum && Number(ult.numero) === Number(miNum)) {
            // Fix 3: match exacto de número → sincronizar sin importar el origen
            // (cubre modo mixto voucher+kiosko donde el campo origen puede variar)
            this.sincronizarSeguimiento(this.ticketData.token);
          } else if (this.seguimientoData.estado === 'esperando' && miNum) {
            // Para posición en cola solo contar kiosko_web (los voucher_fisico no compiten)
            if (ult && ult.numero && (!ult.origen || ult.origen === 'kiosko_web')) {
              this.seguimientoData.posicion = Math.max(0, miNum - Number(ult.numero) - 1);
            } else if (payload.proximo_numero && miNum >= payload.proximo_numero) {
              this.seguimientoData.posicion = Math.max(0, miNum - Number(payload.proximo_numero));
            }
          }
        }
      });

      this.ws.on('llamados', (payload) => {
        if (payload && (this.step === 'seguimiento' || this.step === 'ticket')) {
          this.procesarAvisoLlamados(payload);
        }
      });

      this.ws.on('turno_rellamado', (payload) => {
        if (!payload) return;
        const miNumero = this.seguimientoData.numero || this.ticketData.numero;
        if (miNumero && Number(payload.numero) === Number(miNumero)) {
          // Fix 3: match exacto → notificar y sincronizar sin importar el origen del turno
          const nombreMesa = payload.mesa_numero ? `Mesa ${payload.mesa_numero}` : (payload.mesa_nombre || 'Ventanilla');
          this.seguimientoData.mesa = nombreMesa;
          this.seguimientoData.mesa_numero = payload.mesa_numero || null;
          this.seguimientoData.estado = 'en_atencion';
          this.emitirAlertaLlamado(nombreMesa);
          if (this.ticketData.token) {
            this.sincronizarSeguimiento(this.ticketData.token);
          }
        }
      });

      this.ws.on('tu_turno_llamado', (payload) => {
        if (payload && (this.step === 'seguimiento' || this.step === 'ticket')) {
          const nombreMesa = payload.mesa_numero ? `Mesa ${payload.mesa_numero}` : (payload.mesa_nombre || 'Ventanilla');
          if (payload.mesa_numero) {
            this.seguimientoData.mesa_numero = payload.mesa_numero;
            this.seguimientoData.mesa = nombreMesa;
          }
          if (payload.es_rellamado) {
            this.emitirAlertaLlamado(nombreMesa);
          }
          if (this.ticketData.token) {
            this.sincronizarSeguimiento(this.ticketData.token);
          }
        }
      });

      this.ws.on('config_actualizada', (payload) => {
        if (!payload) return;
        if (payload.clave === 'kiosko_web_activo') {
          this.kioskoActivo = String(payload.valor).toLowerCase() === 'true';
          if (!this.kioskoActivo) {
            this.errorMessage = 'El servicio digital de turnos no está activo actualmente. Solicite su voucher físico.';
          } else {
            if (!this.topeAlcanzado) this.errorMessage = '';
          }
        } else if (payload.clave === 'kiosko_modo_uso') {
          this.kioskoModoUso = payload.valor || 'asistido';
          const esModoAsistido = this.kioskoModoUso === 'asistido' || this.kioskoModoUso === 'empleado';
          if (!this.esTablet && esModoAsistido) {
            this.errorMessage = 'La emisión de turnos desde el celular no está habilitada. Por favor solicite su turno en el módulo de atención asistida.';
          } else {
            this.errorMessage = '';
          }
        } else if (payload.clave === 'kiosko_impresion_automatica') {
          this.impresionAutomatica = String(payload.valor).toLowerCase() === 'true';
        }
      });

      this.ws.connect();
    },

    /**
     * Procesa los avisos en tiempo real para el smartphone del estudiante
     */
    procesarAvisoLlamados (payload) {
      const miNumero = this.seguimientoData.numero;
      if (!miNumero) return;

      const ultimo = payload.ultimo_llamado;

      // Si el turno llamado coincide con el número del estudiante y es de origen kiosko_web,
      // consultamos al servidor para CONFIRMAR de forma fidedigna si realmente fue llamado
      if (ultimo && Number(ultimo.numero) === Number(miNumero)) {
        if (!ultimo.origen || ultimo.origen === 'kiosko_web') {
          if (this.ticketData.token) {
            this.sincronizarSeguimiento(this.ticketData.token);
          }
          return;
        }
      }

      // Si sigo en espera, actualizar la posición calculada directamente en memoria (0 consultas HTTP a BD)
      if (this.seguimientoData.estado === 'esperando') {
        if (ultimo && ultimo.numero && (!ultimo.origen || ultimo.origen === 'kiosko_web')) {
          const diferencia = Math.max(0, miNumero - Number(ultimo.numero) - 1);
          this.seguimientoData.posicion = diferencia;
        } else if (payload.proximo_numero && miNumero >= payload.proximo_numero) {
          this.seguimientoData.posicion = Math.max(0, miNumero - Number(payload.proximo_numero));
        }
      }
    },

    /**
     * Emite chime institucional, vibración y titila título de pestaña
     */
    async emitirAlertaLlamado (nombreMesa) {
      try {
        await playCallChime();
      } catch (_) {}

      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        try {
          navigator.vibrate([300, 150, 300, 150, 600]);
        } catch (_) {}
      }

      document.title = `¡TU TURNO! ${nombreMesa} — Matrículas 2026`;
      this.mostrarToast(`¡Es tu turno! Dirígete a ${nombreMesa}`);
    },

    /**
     * Modo Smartphone: Inicia seguimiento personal y bloquea pantalla apagada
     */
    async iniciarSeguimiento (token) {
      if (this.autoResetTimer) {
        clearTimeout(this.autoResetTimer);
        this.autoResetTimer = null;
      }
      if (this.cuentaRegresivaTimer) {
        clearInterval(this.cuentaRegresivaTimer);
        this.cuentaRegresivaTimer = null;
      }
      this.cuentaRegresiva = 0;

      this.ticketData.token = token;
      this.errorMessage = '';
      this.mostrarBotonReintentar = false;

      // Solicitar mantener pantalla encendida (Screen WakeLock API)
      this.solicitarWakeLock();

      await this.sincronizarSeguimiento(token);
      this.iniciarSyncPeriodico();
    },

    /**
     * Sincronización periódica de fondo con jitter aleatorio
     * Dispersa las peticiones de los smartphones en el tiempo para evitar oleadas sincronizadas.
     */
    iniciarSyncPeriodico () {
      if (this._syncPeriodicoTimer) {
        clearTimeout(this._syncPeriodicoTimer);
        this._syncPeriodicoTimer = null;
      }

      const programarSiguiente = () => {
        // Jitter: entre 30 y 45 segundos aleatorios
        const delay = 30000 + Math.floor(Math.random() * 15000);
        this._syncPeriodicoTimer = setTimeout(async () => {
          this._syncPeriodicoTimer = null;
          const token = this.ticketData.token || this.seguimientoData.token;
          if (
            token &&
            this.step === 'seguimiento' &&
            this.seguimientoData.estado === 'esperando' &&
            typeof document !== 'undefined' &&
            document.visibilityState === 'visible'
          ) {
            await this.sincronizarSeguimiento(token);
          }
          if (this.step === 'seguimiento' && this.seguimientoData.estado === 'esperando') {
            programarSiguiente();
          }
        }, delay);
      };

      programarSiguiente();
    },

    /**
     * Consulta única a /turnos/mi-turno/:token para sincronización precisa
     * Fuente de verdad absoluta: solo el servidor confirma el estado real del turno.
     */
    async sincronizarSeguimiento (token) {
      if (!token) return;
      // Fix 4: si ya hay una petición en vuelo, ignorar la concurrente (evita HTTP doble por eventos WS simultáneos)
      if (this.estaActualizando) return;
      this.estaActualizando = true;
      this._lastSyncTime = Date.now();


      try {
        const res = await api.get(`/turnos/mi-turno/${token}`, { public: true });
        this.redLocalOk = true;
        this.errorTemporalConexion = false;
        this._reintentosFallidos = 0;

        // Comprobar si el turno es de hoy o de un día anterior
        const hoyStr = new Date().toISOString().slice(0, 10);
        const fechaTurnoStr = res.fecha_turno ? new Date(res.fecha_turno).toISOString().slice(0, 10) : null;
        const esDiaAnterior = Boolean(fechaTurnoStr && fechaTurnoStr !== hoyStr);

        if (esDiaAnterior) {
          if (this._syncPeriodicoTimer) {
            clearTimeout(this._syncPeriodicoTimer);
            this._syncPeriodicoTimer = null;
          }
          this.liberarTurnoSeguimiento();
          this.errorMessage = 'Su turno de un día anterior ha caducado. Puede solicitar un nuevo turno hoy.';
          return;
        }

        if (res.estado === 'cancelado') {
          if (this._syncPeriodicoTimer) {
            clearTimeout(this._syncPeriodicoTimer);
            this._syncPeriodicoTimer = null;
          }
          this.seguimientoData = {
            numero: res.numero,
            estado: 'cancelado',
            posicion: 0,
            mesa: res.mesa_numero ? `Mesa ${res.mesa_numero}` : (res.mesa || null),
            mesa_numero: res.mesa_numero || null,
            llamado_en: res.llamado_en || null
          };
          return;
        }

        if (res.estado === 'atendido') {
          if (this._syncPeriodicoTimer) {
            clearTimeout(this._syncPeriodicoTimer);
            this._syncPeriodicoTimer = null;
          }
          this.seguimientoData = {
            numero: res.numero,
            estado: 'atendido',
            posicion: 0,
            mesa: res.mesa_numero ? `Mesa ${res.mesa_numero}` : (res.mesa || null),
            mesa_numero: res.mesa_numero || null,
            llamado_en: res.llamado_en || null
          };
          return;
        }

        if (res.estado === 'en_atencion') {
          if (this._syncPeriodicoTimer) {
            clearTimeout(this._syncPeriodicoTimer);
            this._syncPeriodicoTimer = null;
          }
          const nombreMesa = res.mesa_numero ? `Mesa ${res.mesa_numero}` : (res.mesa || 'Ventanilla');
          this.seguimientoData = {
            numero: res.numero,
            estado: 'en_atencion',
            posicion: 0,
            mesa: nombreMesa,
            mesa_numero: res.mesa_numero || null,
            llamado_en: res.llamado_en || null
          };

          // Alerta audiovisual intensiva solo una vez al pasar a en_atención
          if (!this._yaAlertadoLlamado) {
            this._yaAlertadoLlamado = true;
            this.emitirAlertaLlamado(nombreMesa);
          }
          return;
        }

        if (res.estado === 'esperando') {
          this._yaAlertadoLlamado = false;
          this.seguimientoData = {
            numero: res.numero,
            estado: 'esperando',
            posicion: res.posicion ?? 0,
            tiempo_estimado_min: res.tiempo_estimado_min ?? 0,
            mesa: null,
            mesa_numero: null,
            llamado_en: null
          };
        }

      } catch (err) {
        console.warn('[Seguimiento] Error al sincronizar mi turno:', err);
        const status = err.status || 0;
        if (status === 404) {
          this.liberarTurnoSeguimiento();
          this.errorMessage = 'El enlace no es válido o el turno ha expirado. Puede solicitar un nuevo turno.';
        } else {
          // Un error momentáneo de red NO reemplaza el estado con una pantalla de error:
          // Conserva la información del turno, muestra estado de reconexión y reintenta automáticamente.
          this.errorTemporalConexion = true;
          this._reintentosFallidos = (this._reintentosFallidos || 0) + 1;
          const delay = Math.min(1000 * Math.pow(1.5, this._reintentosFallidos), 10000);

          if (!this._reintentoTimer) {
            this._reintentoTimer = setTimeout(() => {
              this._reintentoTimer = null;
              if (this.ticketData.token && this.step === 'seguimiento') {
                this.sincronizarSeguimiento(this.ticketData.token);
              }
            }, delay);
          }
        }
      } finally {
        this.estaActualizando = false;
      }
    },

    /**
     * Solicita mantener pantalla encendida para el estudiante
     */
    async solicitarWakeLock () {
      if ('wakeLock' in navigator) {
        try {
          this.wakeLockSentinel = await navigator.wakeLock.request('screen');
        } catch (wlErr) {
          console.info('[Kiosko] WakeLock no disponible:', wlErr.message);
        }
      }
    },

    soltarWakeLock () {
      if (this.wakeLockSentinel) {
        try {
          this.wakeLockSentinel.release();
        } catch (_) {}
        this.wakeLockSentinel = null;
      }
    },

    /**
     * Despliega notificación toast no intrusiva
     */
    mostrarToast (mensaje) {
      this.toastMessage = mensaje;
      this.showToast = true;
      setTimeout(() => {
        this.showToast = false;
      }, 4000);
    },

    /**
     * Verificación diferida de impresión automática en modo tablet.
     * El servidor ya disparó la impresión vía setImmediate; este método confirma
     * con un POST /kiosko/imprimir que la impresión no haya fallado silenciosamente.
     * Si falló, muestra un aviso visible sin afectar el turno ya creado.
     */
    async _verificarImpresionAutoTablet () {
      // Pequeña pausa para que el setImmediate del servidor alcance la impresora
      await new Promise(r => setTimeout(r, 1200));
      try {
        await api.post('/kiosko/imprimir', {
          turno_id:     this.ticketData.id,
          numero:       this.ticketData.numero,
          token:        this.ticketData.token,
          tracking_url: this.ticketData.tracking_url || ''
        });
      } catch (printErr) {
        // La impresión falló — aviso no bloqueante. El turno sigue siendo válido.
        const codigo = printErr.code || '';
        let aviso = `Turno ${this.formatTicket(this.ticketData.numero)} generado. `;
        if (codigo === 'IMPRESORA_INACTIVA' || codigo === 'IP_NO_CONFIGURADA') {
          aviso += 'Impresora no configurada — entregue el número manualmente.';
        } else if (codigo === 'TIMEOUT') {
          aviso += 'La impresora no respondió — reintente desde el panel o entregue el número manualmente.';
        } else {
          aviso += 'Error de impresión — el turno ya está registrado.';
        }
        this.mostrarToast(aviso);
        console.warn('[Kiosko] Impresión automática no confirmada:', printErr.message || printErr);
      }
    },

    /**
     * Limpieza en desmontaje
     */
    destroy () {
      if (this.autoResetTimer) clearTimeout(this.autoResetTimer);
      if (this.cuentaRegresivaTimer) clearInterval(this.cuentaRegresivaTimer);
      if (this._syncPeriodicoTimer) clearTimeout(this._syncPeriodicoTimer);
      if (this._reintentoTimer) clearTimeout(this._reintentoTimer);
      if (this.ws) this.ws.disconnect();
      if (this._onVisibilityHandler) {
        document.removeEventListener('visibilitychange', this._onVisibilityHandler);
        this._onVisibilityHandler = null;
      }
      if (this.bluetoothPrinter) {
        this.bluetoothPrinter.desconectar();
        this.bluetoothPrinter = null;
      }
      this.soltarWakeLock();
      document.title = this.tituloOriginal;
    }
  };
}

// ── Registro idempotente con Alpine.js ──────────────────────────────────────
function registerKioskoWithAlpine() {
  if (typeof window !== 'undefined' && window.Alpine) {
    window.Alpine.data('kioskoView', kioskoView);
  }
}

if (typeof window !== 'undefined' && window.Alpine) {
  registerKioskoWithAlpine();
} else if (typeof document !== 'undefined') {
  document.addEventListener('alpine:init', registerKioskoWithAlpine);
}
