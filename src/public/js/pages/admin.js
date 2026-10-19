/**
 * ==============================================================================
 * ADMIN.JS — Controlador de Supervision, Lotes, Mesas, Usuarios y Configuracion
 * Sistema Turnero de Matriculas 2026 (v2.1)
 *
 * Contrato de identificadores (sincronizado con admin.html):
 *  - tab, relojHora, wsConnected, loteAgotadoAlerta
 *  - kpis.{ atendidos_hoy, espera_promedio_min, mesas_activas, vouchers_restantes }
 *  - mesas[], lotes[], loteActivo, usuarios[], config, operadoresDisponibles[]
 *  - extensionVouchers, modalLote, modalUsuario, nuevoLoteHasta, nuevoUsuario
 *  - cargarDashboard(), exportarCSV(), asignarOperador(), activarMesaAdmin()
 *  - pausarMesaAdmin(), extenderLote(), pausarLote(), activarLote(), cerrarLote()
 *  - crearLoteSubmit(), crearUsuarioSubmit(), guardarConfiguracion(), logout()
 *
 * Cumple: RF-ADM-01..09, RF-LOTE-03..09, RF-WS, RNF-DIS-01/03/06
 * ==============================================================================
 */

import { api } from '../api.js';
import { TurneroWSClient } from '../ws-client.js';
import { formatTimer } from '../utils.js';

let activeAdminInstance = null;

/**
 * Función puente unificada para mostrar notificaciones en el admin.
 * Redirige siempre al componente central superior (top-center) de adminView.
 */
export function showToast(opts, tipoFallback) {
  if (activeAdminInstance && typeof activeAdminInstance.notificar === 'function') {
    if (typeof opts === 'string') {
      activeAdminInstance.notificar({
        tipo: tipoFallback || 'info',
        titulo: '',
        mensaje: opts
      });
    } else if (opts && typeof opts === 'object') {
      const tipo = opts.type === 'danger' ? 'error' : (opts.type || 'info');
      activeAdminInstance.notificar({
        tipo,
        titulo: opts.title || opts.titulo || '',
        mensaje: opts.message || opts.mensaje || ''
      });
    }
  } else {
    console.info('[ADMIN-TOAST]', opts);
  }
}

export function adminView() {
  return {
    tab: 'monitoreo',
    relojHora: '--:--:--',
    currentUser: null,
    _clockTimer: null,
    _pollTimer:  null,

    kpis: {
      atendidos_hoy:       0,
      espera_promedio_min: '--',
      mesas_activas:       0,
      vouchers_restantes:  0,
      turnos_en_espera:    0
    },

    mesas:                [],
    lotes:                [],
    loteActivo:           null,
    usuarios:             [],
    operadoresDisponibles:[],

    toasts:               [],
    loteAExtender:        null,
    extensionVouchers:    null,
    extensionCantidad:    null,

    erroresValidacion: {
      extensionCantidad:    '',
      nuevoLoteHasta:       '',
      nuevaMesaNumero:      '',
      nuevaMesaNombre:      '',
      editMesaNumero:       '',
      editMesaNombre:       '',
      nuevoUsrNombre:       '',
      nuevoUsrUsername:     '',
      nuevoUsrPassword:     '',
      editUsrNombre:        '',
      editUsrUsername:      '',
      editUsrPassword:      '',
      ajusteContadorNumero: '',
      ajusteContadorMotivo: '',
      cfgAlertaVouchers:    '',
      cfgZonaHoraria:       '',
      cfgKioskoTope:        '',
      cfgKioskoUrlBase:     '',
      cfgKioskoUrlPublica:  '',
      cfgImpresoraPuerto:   '',
      cfgFondoUrl:          ''
    },

    subTabConfig: 'todos',
    _guardandoSeccion: {
      kiosko: false,
      impresora: false,
      sistema: false,
      fondo: false
    },
    _savingKeys: {},

    filtroMesasDashboard: 'todas',
    filtroLotes:          'todos',
    filtroMesas:          'todas',
    filtroUsuarios:       'todos',

    modalLote:             false,
    modalExtender:         false,
    modalMesa:             false,
    modalEditarMesa:       false,
    modalUsuario:          false,
    modalEditarUsuario:    false,
    modalCambioLote:       false,
    modalConfirmarKiosko:  false,
    modalConfigKiosko:     false,
    modalCartelQR:         false,
    modalLoteAgotado:      false,   // Modal cuando un lote se agota
    loteAgotadoInfo:       null,    // Info del lote agotado para mostrar en modal
    kioskoConfigEditMode:  false,
    lotePendienteActivar:  null,
    lotePausado:           null,
    nuevoLoteHasta:        500,

    archivoFondoSeleccionado: null,
    _subiendoFondo:           false,
    _togglingFondo:           false,
    _imprimiendoPrueba:       false,

    modalAjustarContador:  false,
    ajusteContador: {
      nuevoUltimo:          null,
      motivo:               '',
      confirmarRetroceso:   false,
      cargando:             false
    },

    nuevaMesa: {
      numero: 1,
      nombre: ''
    },

    mesaEditando: {
      id: null,
      numero: 1,
      nombre: ''
    },

    nuevoUsuario: {
      nombre_completo: '',
      username:        '',
      password:        '',
      rol:             'operador'
    },

    usuarioEditando: {
      id: null,
      nombre_completo: '',
      username:        '',
      password:        '',
      rol:             'operador',
      activo:          true
    },

    config: {
      alerta_vouchers_restantes:    20,
      kiosko_web_activo:            false,
      modo_generacion_turnos:       'voucher_fisico',
      voz_anuncio_activa:           true,
      mostrar_estimado_espera:      true,
      kiosko_tope_diario:           0,
      kiosko_modo_uso:              'asistido',
      kiosko_url_base:              '',
      kiosko_url_publica:           '',
      kiosko_impresion_automatica:  false,
      impresora_ip:                 '',
      impresora_puerto:             9100,
      impresora_activa:             false,
      tv_escala_principal:          100,
      tv_escala_secundaria:         100,
      tv_escala_turnos:             100,
      zona_horaria:                 'America/Tegucigalpa',
      fondo_imagen_url:             '',
      fondo_imagen_activa:          false
    },
    avisoGuardadoPrincipal:  false,
    avisoGuardadoSecundaria: false,
    _debounceEscalaPrincipal: null,
    _debounceEscalaSecundaria: null,
    _debounceEscalaTv: null,
    kioskoForm: {
      tope_diario:      0,
      modo_uso:         'asistido',
      impresora_activa: false,
      impresora_ip:     '',
      impresora_puerto: 9100
    },
    _configSnapshot: null,

    filtroReporte: {
      fecha:       new Date().toISOString().slice(0, 10),
      mesa_id:     '',
      operador_id: '',
      estado:      'todos'
    },
    reporteData: {
      kpis: {
        total_atendidos:       0,
        total_cancelados:      0,
        total_turnos:          0,
        promedio_atencion_seg: 0,
        promedio_espera_seg:   0,
        mesas_activas:         0
      },
      mesas_resumen: [],
      turnos:        []
    },
    cargandoReporte: false,
    cargandoDashboard: false,

    ws:          null,
    wsConnected: false,
    loteAgotadoAlerta: false,
    _loading: false,

    // Modal de confirmación propio (reemplaza confirm() nativo del navegador)
    _confirmModal: {
      visible: false,
      titulo:  '',
      mensaje: '',
      accion:  null,
      botonTexto: 'Confirmar',
      botonClase: 'btn-danger btn-sm',
      tipo: 'peligro'
    },

    _pedirConfirmacion({ titulo, mensaje, accion, botonTexto = 'Confirmar', botonClase = 'btn-danger btn-sm', tipo = 'peligro' }) {
      this._confirmModal = { visible: true, titulo, mensaje, accion, botonTexto, botonClase, tipo };
    },

    formatearFechaLote(fechaStr) {
      if (!fechaStr) return '-';
      try {
        const partes = String(fechaStr).split('T')[0].split('-');
        if (partes.length === 3) {
          return `${partes[2]}/${partes[1]}/${partes[0]}`;
        }
        return String(fechaStr).slice(0, 10);
      } catch (_) {
        return String(fechaStr || '-');
      }
    },

    // =========================================================================
    // GETTERS DE VALIDACIÓN REACTIVA
    // =========================================================================

    get extensionValida() {
      const raw = this.extensionCantidad;
      if (raw === null || raw === '' || raw === undefined) return false;
      const str = String(raw).trim();
      if (str === '' || isNaN(Number(str)) || str.includes('.') || str.includes(',')) return false;
      const val = Number(str);
      return Number.isInteger(val) && val >= 1 && val <= 5000;
    },

    get nuevoLoteValido() {
      const raw = this.nuevoLoteHasta;
      if (raw === null || raw === '' || raw === undefined) return false;
      const str = String(raw).trim();
      if (str === '' || isNaN(Number(str)) || str.includes('.') || str.includes(',')) return false;
      const val = Number(str);
      return Number.isInteger(val) && val >= 1 && val <= 100000;
    },

    get nuevaMesaValida() {
      const num = this.nuevaMesa?.numero;
      const nom = (this.nuevaMesa?.nombre || '').trim();
      if (num === null || num === '' || num === undefined || isNaN(Number(num))) return false;
      const n = Number(num);
      if (!Number.isInteger(n) || n < 1 || n > 99) return false;
      if (!nom) return false;
      return true;
    },

    get editarMesaValida() {
      const num = this.mesaEditando?.numero;
      const nom = (this.mesaEditando?.nombre || '').trim();
      if (num === null || num === '' || num === undefined || isNaN(Number(num))) return false;
      const n = Number(num);
      if (!Number.isInteger(n) || n < 1 || n > 99) return false;
      if (!nom) return false;
      return true;
    },

    get nuevoUsuarioValido() {
      const nom = (this.nuevoUsuario?.nombre_completo || '').trim();
      const usr = (this.nuevoUsuario?.username || '').trim();
      const pwd = this.nuevoUsuario?.password || '';
      if (!nom || !usr || usr.length < 3 || usr.includes(' ')) return false;
      if (!pwd || pwd.length < 4) return false;
      return true;
    },

    get editarUsuarioValido() {
      const nom = (this.usuarioEditando?.nombre_completo || '').trim();
      const usr = (this.usuarioEditando?.username || '').trim();
      const pwd = this.usuarioEditando?.password || '';
      if (!nom || !usr || usr.length < 3) return false;
      if (pwd && pwd.length < 4) return false;
      return true;
    },

    get ajusteContadorValido() {
      const loteRef = this.loteActivo || this.lotePausado;
      if (!loteRef) return false;
      const num = this.ajusteContador?.nuevoUltimo;
      const mot = (this.ajusteContador?.motivo || '').trim();
      if (num === null || num === undefined || isNaN(Number(num))) return false;
      const minVal = (loteRef.numero_desde ?? 0);
      const maxVal = (loteRef.numero_hasta ?? 99999);
      if (num < minVal || num > maxVal) return false;
      if (mot.length < 5) return false;
      const esRetroceso = num < (loteRef.ultimo_numero_llamado ?? 0);
      if (esRetroceso && !this.ajusteContador.confirmarRetroceso) return false;
      return true;
    },

    get cfgAlertaValida() {
      const val = this.config?.alerta_vouchers_restantes;
      if (val === null || val === undefined || isNaN(Number(val))) return false;
      const n = Number(val);
      return Number.isInteger(n) && n >= 1 && n <= 500;
    },

    get kioskoHref() {
      const modo = this.config?.kiosko_modo_uso;
      return (modo === 'asistido' || modo === 'empleado') ? '/kiosko.html?modo=tablet' : '/kiosko.html';
    },

    get urlTabletPorton() {
      const base = (this.config?.kiosko_url_base || this.config?.kiosko_url_publica || '').trim();
      if (base) {
        const urlLimpia = base.replace(/\/+$/, '');
        const sinKiosko = urlLimpia.endsWith('/kiosko.html') ? urlLimpia : `${urlLimpia}/kiosko.html`;
        return `${sinKiosko}?modo=tablet`;
      }
      return typeof window !== 'undefined' ? `${window.location.origin}/kiosko.html?modo=tablet` : '/kiosko.html?modo=tablet';
    },

    get urlEstudianteQR() {
      const base = (this.config?.kiosko_url_base || this.config?.kiosko_url_publica || '').trim();
      if (base) {
        const urlLimpia = base.replace(/\/+$/, '');
        const sinKiosko = urlLimpia.endsWith('/kiosko.html') ? urlLimpia : `${urlLimpia}/kiosko.html`;
        return `${sinKiosko}?modo=estudiante`;
      }
      return typeof window !== 'undefined' ? `${window.location.origin}/kiosko.html?modo=estudiante` : '/kiosko.html?modo=estudiante';
    },

    copiarAlPortapapeles(texto, label = 'Enlace') {
      if (!texto) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto).then(() => {
          showToast(`${label} copiado al portapapeles`, 'success');
        }).catch(() => {
          showToast(`${label} copiado`, 'success');
        });
      } else {
        const temp = document.createElement('textarea');
        temp.value = texto;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        showToast(`${label} copiado al portapapeles`, 'success');
      }
    },

    get cfgKioskoValida() {
      const tope = Number(this.config?.kiosko_tope_diario);
      if (isNaN(tope) || !Number.isInteger(tope) || tope < 0 || tope > 99999) return false;
      const modo = this.config?.kiosko_modo_uso;
      if (modo !== 'estudiante' && modo !== 'empleado' && modo !== 'asistido') return false;
      if (this.erroresValidacion.cfgKioskoUrlBase || this.erroresValidacion.cfgKioskoUrlPublica) return false;
      return true;
    },

    get cfgImpresoraValida() {
      const p = Number(this.config?.impresora_puerto);
      return Number.isInteger(p) && p >= 1 && p <= 65535;
    },

    get cfgSistemaValida() {
      return this.cfgAlertaValida && !!(this.config?.zona_horaria || '').trim();
    },

    get kioskoHasChanges() {
      if (!this._configSnapshot) return false;
      const modoActual = this.config?.kiosko_modo_uso || 'asistido';
      const modoSnap = this._configSnapshot?.kiosko_modo_uso || 'asistido';
      const topeActual = Number(this.config?.kiosko_tope_diario) || 0;
      const topeSnap = Number(this._configSnapshot?.kiosko_tope_diario) || 0;
      const urlBaseActual = (this.config?.kiosko_url_base || '').trim();
      const urlBaseSnap = (this._configSnapshot?.kiosko_url_base || '').trim();
      const urlPubActual = (this.config?.kiosko_url_publica || '').trim();
      const urlPubSnap = (this._configSnapshot?.kiosko_url_publica || '').trim();

      return (
        modoActual !== modoSnap ||
        topeActual !== topeSnap ||
        urlBaseActual !== urlBaseSnap ||
        urlPubActual !== urlPubSnap
      );
    },

    get impresoraHasChanges() {
      if (!this._configSnapshot) return false;
      const ipActual = (this.config?.impresora_ip || '').trim();
      const ipSnap = (this._configSnapshot?.impresora_ip || '').trim();
      const puertoActual = Number(this.config?.impresora_puerto) || 9100;
      const puertoSnap = Number(this._configSnapshot?.impresora_puerto) || 9100;

      return ipActual !== ipSnap || puertoActual !== puertoSnap;
    },

    get fondoHasChanges() {
      if (!this._configSnapshot) return false;
      const urlActual = (this.config?.fondo_imagen_url || '').trim();
      const urlSnap = (this._configSnapshot?.fondo_imagen_url || '').trim();
      return urlActual !== urlSnap;
    },

    get sistemaHasChanges() {
      if (!this._configSnapshot) return false;
      const alertaActual = Number(this.config?.alerta_vouchers_restantes) || 20;
      const alertaSnap = Number(this._configSnapshot?.alerta_vouchers_restantes) || 20;
      const zonaActual = (this.config?.zona_horaria || '').trim();
      const zonaSnap = (this._configSnapshot?.zona_horaria || '').trim();

      return alertaActual !== alertaSnap || zonaActual !== zonaSnap;
    },

    // =========================================================================
    // MÉTODOS DE VALIDACIÓN INDIVIDUAL (MENSAJES EN ESPAÑOL DEBAJO DEL CAMPO)
    // =========================================================================

    validarExtensionCantidad() {
      const raw = this.extensionCantidad;
      if (raw === null || raw === '' || raw === undefined) {
        this.erroresValidacion.extensionCantidad = '';
        return false;
      }
      const str = String(raw).trim();
      if (str === '' || isNaN(Number(str))) {
        this.erroresValidacion.extensionCantidad = 'Escribe un número válido.';
        return false;
      }
      if (str.includes('.') || str.includes(',')) {
        this.erroresValidacion.extensionCantidad = 'Escribe un número entero, sin decimales.';
        return false;
      }
      const val = Number(str);
      if (!Number.isInteger(val) || val <= 0) {
        this.erroresValidacion.extensionCantidad = 'Escribe un número entero mayor que 0.';
        return false;
      }
      if (val > 5000) {
        this.erroresValidacion.extensionCantidad = 'La cantidad máxima a adicionar es 5,000 turnos.';
        return false;
      }
      this.erroresValidacion.extensionCantidad = '';
      return true;
    },

    validarNuevoLoteHasta() {
      const raw = this.nuevoLoteHasta;
      if (raw === null || raw === '' || raw === undefined) {
        this.erroresValidacion.nuevoLoteHasta = 'Escribe el número límite del lote.';
        return false;
      }
      const str = String(raw).trim();
      if (str === '' || isNaN(Number(str)) || str.includes('.') || str.includes(',')) {
        this.erroresValidacion.nuevoLoteHasta = 'Escribe un número entero, sin decimales.';
        return false;
      }
      const val = Number(str);
      if (!Number.isInteger(val) || val < 1) {
        this.erroresValidacion.nuevoLoteHasta = 'Escribe un número entero mayor que 0.';
        return false;
      }
      if (val > 100000) {
        this.erroresValidacion.nuevoLoteHasta = 'El límite máximo permitido es 100,000 turnos.';
        return false;
      }
      this.erroresValidacion.nuevoLoteHasta = '';
      return true;
    },

    validarNuevaMesaNumero() {
      const val = this.nuevaMesa?.numero;
      if (val === null || val === '' || val === undefined || isNaN(Number(val))) {
        this.erroresValidacion.nuevaMesaNumero = 'Escribe un número de ventanilla.';
        return false;
      }
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 99) {
        this.erroresValidacion.nuevaMesaNumero = 'El número de ventanilla debe ser un entero entre 1 y 99.';
        return false;
      }
      this.erroresValidacion.nuevaMesaNumero = '';
      return true;
    },

    validarNuevaMesaNombre() {
      const nom = (this.nuevaMesa?.nombre || '').trim();
      if (!nom) {
        this.erroresValidacion.nuevaMesaNombre = 'El nombre o identificador de ventanilla es requerido.';
        return false;
      }
      this.erroresValidacion.nuevaMesaNombre = '';
      return true;
    },

    validarEditMesaNumero() {
      const val = this.mesaEditando?.numero;
      if (val === null || val === '' || val === undefined || isNaN(Number(val))) {
        this.erroresValidacion.editMesaNumero = 'Escribe un número de ventanilla.';
        return false;
      }
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 99) {
        this.erroresValidacion.editMesaNumero = 'El número de ventanilla debe ser un entero entre 1 y 99.';
        return false;
      }
      this.erroresValidacion.editMesaNumero = '';
      return true;
    },

    validarEditMesaNombre() {
      const nom = (this.mesaEditando?.nombre || '').trim();
      if (!nom) {
        this.erroresValidacion.editMesaNombre = 'El nombre o identificador de ventanilla es requerido.';
        return false;
      }
      this.erroresValidacion.editMesaNombre = '';
      return true;
    },

    validarNuevoUsrNombre() {
      const nom = (this.nuevoUsuario?.nombre_completo || '').trim();
      if (!nom) {
        this.erroresValidacion.nuevoUsrNombre = 'El nombre completo es requerido.';
        return false;
      }
      this.erroresValidacion.nuevoUsrNombre = '';
      return true;
    },

    validarNuevoUsrUsername() {
      const usr = (this.nuevoUsuario?.username || '').trim();
      if (!usr) {
        this.erroresValidacion.nuevoUsrUsername = 'El usuario es requerido.';
        return false;
      }
      if (usr.length < 3) {
        this.erroresValidacion.nuevoUsrUsername = 'El usuario debe tener al menos 3 caracteres.';
        return false;
      }
      if (usr.includes(' ')) {
        this.erroresValidacion.nuevoUsrUsername = 'El usuario no puede contener espacios.';
        return false;
      }
      this.erroresValidacion.nuevoUsrUsername = '';
      return true;
    },

    validarNuevoUsrPassword() {
      const pwd = this.nuevoUsuario?.password || '';
      if (!pwd) {
        this.erroresValidacion.nuevoUsrPassword = 'La contraseña es requerida.';
        return false;
      }
      if (pwd.length < 4) {
        this.erroresValidacion.nuevoUsrPassword = 'La contraseña debe tener al menos 4 caracteres.';
        return false;
      }
      this.erroresValidacion.nuevoUsrPassword = '';
      return true;
    },

    validarEditUsrNombre() {
      const nom = (this.usuarioEditando?.nombre_completo || '').trim();
      if (!nom) {
        this.erroresValidacion.editUsrNombre = 'El nombre completo es requerido.';
        return false;
      }
      this.erroresValidacion.editUsrNombre = '';
      return true;
    },

    validarEditUsrUsername() {
      const usr = (this.usuarioEditando?.username || '').trim();
      if (!usr) {
        this.erroresValidacion.editUsrUsername = 'El usuario es requerido.';
        return false;
      }
      if (usr.length < 3) {
        this.erroresValidacion.editUsrUsername = 'El usuario debe tener al menos 3 caracteres.';
        return false;
      }
      this.erroresValidacion.editUsrUsername = '';
      return true;
    },

    validarEditUsrPassword() {
      const pwd = this.usuarioEditando?.password || '';
      if (pwd && pwd.length < 4) {
        this.erroresValidacion.editUsrPassword = 'La nueva contraseña debe tener al menos 4 caracteres.';
        return false;
      }
      this.erroresValidacion.editUsrPassword = '';
      return true;
    },

    validarAjusteNumero() {
      const loteRef = this.loteActivo || this.lotePausado;
      const num = this.ajusteContador?.nuevoUltimo;
      if (num === null || num === undefined || isNaN(Number(num))) {
        this.erroresValidacion.ajusteContadorNumero = 'Ingrese un número válido.';
        return false;
      }
      const minVal = (loteRef?.numero_desde ?? 0);
      const maxVal = (loteRef?.numero_hasta ?? 99999);
      if (num < minVal || num > maxVal) {
        this.erroresValidacion.ajusteContadorNumero = `El número debe estar entre ${minVal} y ${maxVal}.`;
        return false;
      }
      this.erroresValidacion.ajusteContadorNumero = '';
      return true;
    },

    validarAjusteMotivo() {
      const mot = (this.ajusteContador?.motivo || '').trim();
      if (mot.length < 5) {
        this.erroresValidacion.ajusteContadorMotivo = 'El motivo debe tener al menos 5 caracteres descriptivos.';
        return false;
      }
      this.erroresValidacion.ajusteContadorMotivo = '';
      return true;
    },

    validarCfgAlerta() {
      const val = this.config?.alerta_vouchers_restantes;
      if (val === null || val === undefined || isNaN(Number(val))) {
        this.erroresValidacion.cfgAlertaVouchers = 'Ingrese un número entero válido.';
        return false;
      }
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        this.erroresValidacion.cfgAlertaVouchers = 'El umbral de alerta debe ser un entero entre 1 y 500.';
        return false;
      }
      this.erroresValidacion.cfgAlertaVouchers = '';
      return true;
    },

    validarKioskoTope() {
      const val = this.config?.kiosko_tope_diario;
      if (val === null || val === undefined || isNaN(Number(val))) {
        this.erroresValidacion.cfgKioskoTope = 'Ingrese un número válido (0 = sin límite).';
        return false;
      }
      const n = Number(val);
      if (!Number.isInteger(n) || n < 0 || n > 99999) {
        this.erroresValidacion.cfgKioskoTope = 'El límite diario debe ser un entero >= 0.';
        return false;
      }
      this.erroresValidacion.cfgKioskoTope = '';
      return true;
    },

    validarUrlKiosko(url) {
      if (!url || !url.trim()) return '';
      const u = url.trim();
      if (!/^https?:\/\//i.test(u)) {
        return 'Debe comenzar con http:// o https:// (ej: http://192.168.1.100:3000)';
      }
      try {
        const parsed = new URL(u);
        const host = parsed.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
          return 'No use localhost ni 127.0.0.1: solo funcionan dentro de esta PC. Otros dispositivos no podrán conectarse.';
        }
      } catch (_) {
        return 'La URL ingresada no tiene un formato válido.';
      }
      return '';
    },

    validarKioskoUrlBase() {
      this.erroresValidacion.cfgKioskoUrlBase = this.validarUrlKiosko(this.config?.kiosko_url_base);
      return !this.erroresValidacion.cfgKioskoUrlBase;
    },

    validarKioskoUrlPublica() {
      this.erroresValidacion.cfgKioskoUrlPublica = this.validarUrlKiosko(this.config?.kiosko_url_publica);
      return !this.erroresValidacion.cfgKioskoUrlPublica;
    },

    validarImpresoraPuerto() {
      const val = this.config?.impresora_puerto;
      if (val === null || val === undefined || isNaN(Number(val))) {
        this.erroresValidacion.cfgImpresoraPuerto = 'Ingrese un puerto válido (1 a 65535).';
        return false;
      }
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        this.erroresValidacion.cfgImpresoraPuerto = 'El puerto debe estar entre 1 y 65535.';
        return false;
      }
      this.erroresValidacion.cfgImpresoraPuerto = '';
      return true;
    },

    validarZonaHoraria() {
      const val = (this.config?.zona_horaria || '').trim();
      if (!val) {
        this.erroresValidacion.cfgZonaHoraria = 'Seleccione una zona horaria válida.';
        return false;
      }
      this.erroresValidacion.cfgZonaHoraria = '';
      return true;
    },

    // =========================================================================
    // COMPONENTE CENTRAL DE NOTIFICACIONES (TOP-CENTER)
    // =========================================================================

    _defaultTituloToast(tipo) {
      switch (tipo) {
        case 'success': return 'Operación Exitosa';
        case 'error':   return 'Error';
        case 'warning': return 'Advertencia';
        case 'info':    return 'Información';
        default:        return 'Notificación';
      }
    },

    notificar({ tipo = 'info', titulo = '', mensaje = '' }) {
      const tipoNorm = tipo === 'danger' ? 'error' : (['success', 'error', 'warning', 'info'].includes(tipo) ? tipo : 'info');
      // Tiempos especificados: éxito e info 4s, advertencia 6s, error 8s
      const duracion = tipoNorm === 'error' ? 8000 : (tipoNorm === 'warning' ? 6000 : 4000);

      // Máximo 3 notificaciones apiladas sin pisarse: descartar la más antigua
      while (this.toasts.length >= 3) {
        const oldest = this.toasts.shift();
        if (oldest && oldest._timer) clearTimeout(oldest._timer);
      }

      const id = Date.now() + Math.random();
      const nuevoToast = {
        id,
        tipo: tipoNorm,
        titulo: titulo || this._defaultTituloToast(tipoNorm),
        mensaje: mensaje || '',
        duracion,
        tiempoRestante: duracion,
        iniciadoEn: Date.now(),
        pausado: false,
        _timer: null
      };

      nuevoToast._timer = setTimeout(() => {
        this.cerrarToast(id);
      }, duracion);

      this.toasts.push(nuevoToast);
    },

    pausarToast(id) {
      const t = this.toasts.find(item => item.id === id);
      if (!t || t.pausado) return;
      if (t._timer) {
        clearTimeout(t._timer);
        t._timer = null;
      }
      const transcurrido = Date.now() - t.iniciadoEn;
      t.tiempoRestante = Math.max(1000, t.tiempoRestante - transcurrido);
      t.pausado = true;
    },

    reanudarToast(id) {
      const t = this.toasts.find(item => item.id === id);
      if (!t || !t.pausado) return;
      t.pausado = false;
      t.iniciadoEn = Date.now();
      t._timer = setTimeout(() => {
        this.cerrarToast(id);
      }, t.tiempoRestante);
    },

    cerrarToast(id) {
      const idx = this.toasts.findIndex(item => item.id === id);
      if (idx !== -1) {
        const t = this.toasts[idx];
        if (t._timer) clearTimeout(t._timer);
        this.toasts.splice(idx, 1);
      }
    },

    // =========================================================================
    // CICLO DE VIDA
    // =========================================================================

    async init() {
      activeAdminInstance = this;
      this.toasts = [];

      try {
        const { usuario } = await api.get('/auth/me');
        if (!usuario || (usuario.rol !== 'admin' && usuario.rol !== 'admin')) {
          api.clearSession(true);
          return;
        }
        this.currentUser = usuario;
      } catch (_) {
        api.clearSession(true);
        return;
      }

      this._tickClock();
      this._clockTimer = setInterval(() => this._tickClock(), 1000);
      await this.cargarTodo();
      this._actualizarAlertaLote();
      this.initWebSocket();

      // Sincronización pasiva en segundo plano cada 5 minutos (resiliencia óptima)
      this._pollTimer = setInterval(async () => {
        await Promise.allSettled([this.cargarDashboard(), this.cargarLotes()]);
        this._actualizarAlertaLote();
      }, 5 * 60 * 1000);
    },

    destroy() {
      if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; }
      if (this._pollTimer)  { clearInterval(this._pollTimer);  this._pollTimer = null; }
      if (this.ws) { this.ws.disconnect(); this.ws = null; }
      if (activeAdminInstance === this) activeAdminInstance = null;
    },

    _tickClock() {
      this.relojHora = new Date().toLocaleTimeString('es-MX', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
    },

    // =========================================================================
    // CARGA DE DATOS
    // =========================================================================

    async cargarTodo() {
      const r = await Promise.allSettled([
        this.cargarKPIs(), this.cargarMesas(), this.cargarLotes(),
        this.cargarUsuarios(), this.cargarConfiguracion()
      ]);
      ['KPIs','Mesas','Lotes','Usuarios','Config'].forEach((n, i) => {
        if (r[i].status === 'rejected') console.warn(`[ADMIN] Fallo ${n}:`, r[i].reason);
      });
    },

    async cargarDashboard() {
      this.cargandoDashboard = true;
      try {
        await Promise.allSettled([this.cargarKPIs(), this.cargarMesas(), this.cargarLotes()]);
        // Sin toast invasivo en actualizaciones periódicas o manuales de dashboard
      } catch (err) {
        console.error('[ADMIN] Error actualizando dashboard:', err);
      } finally {
        this.cargandoDashboard = false;
      }
    },

    async cargarKPIs() {
      const data = await api.get('/admin/kpis');
      const lote = data.lote || null;
      const hasta = lote ? (parseInt(lote.numero_hasta, 10) || 0) : 0;
      const llamados = lote ? (parseInt(lote.ultimo_numero_llamado, 10) || 0) : 0;
      this.kpis = {
        atendidos_hoy:       parseInt(data.atendidos_hoy, 10) || 0,
        espera_promedio_min: data.promedio_seg != null ? (data.promedio_seg / 60).toFixed(1) : '--',
        mesas_activas:       parseInt(data.mesas_activas, 10) || 0,
        vouchers_restantes:  lote ? Math.max(0, hasta - llamados) : 0,
        turnos_en_espera:    parseInt(data.turnos_en_espera, 10) || 0
      };
      if (lote) {
        if (!lote.numero_desde) lote.numero_desde = 1;
        this.loteActivo = lote;
      }
    },

    async cargarMesas() {
      const res = await api.get('/mesas');
      this.mesas = (res.mesas || []).map(m => ({
        ...m,
        tiempo_promedio_min: m.tiempo_promedio_seg ? +(m.tiempo_promedio_seg / 60).toFixed(1) : 0
      }));
      if (this.currentUser) {
        const mesaMio = this.mesas.find(m => Number(m.operador_id) === Number(this.currentUser.id));
        this.currentUser.mesa_asignada = mesaMio ? { id: mesaMio.id, numero: mesaMio.numero, nombre: mesaMio.nombre, estado: mesaMio.estado } : null;
      }
    },

    async cargarLotes() {
      const [rL, rA] = await Promise.allSettled([api.get('/lotes'), api.get('/lotes/activo')]);
      if (rL.status === 'fulfilled') {
        this.lotes = rL.value.lotes || [];
        // Mantener referencia al primer lote pausado (para Plan B — Ajustar Contador)
        this.lotePausado = this.lotes.find(l => l.estado === 'pausado') || null;
      }
      if (rA.status === 'fulfilled' && rA.value.lote) {
        const la = rA.value.lote;
        if (!la.numero_desde) la.numero_desde = 1;
        this.loteActivo = la;
      } else if (rA.status === 'fulfilled' && !rA.value.lote) {
        this.loteActivo = null;
      }
    },


    async cargarUsuarios() {
      const res = await api.get('/admin/usuarios');
      this.usuarios = res.usuarios || [];
      this.operadoresDisponibles = this.usuarios.filter(u => (u.rol === 'operador' || u.rol === 'admin') && u.activo);
    },

    async cargarConfiguracion() {
      const res = await api.get('/admin/configuracion');
      if (res && res.configuracion) {
        const c = res.configuracion;
        this.config.alerta_vouchers_restantes = parseInt(c.alerta_vouchers_restantes || '20', 10) || 20;
        this.config.kiosko_web_activo         = c.kiosko_web_activo === 'true' || c.kiosko_web_activo === true;
        this.config.modo_generacion_turnos    = c.modo_generacion_turnos || (this.config.kiosko_web_activo ? 'kiosko_web' : 'voucher_fisico');
        this.config.voz_anuncio_activa        = c.voz_anuncio_activa !== 'false';
        this.config.mostrar_estimado_espera   = c.mostrar_estimado_espera !== 'false';
        this.config.kiosko_tope_diario        = parseInt(c.kiosko_tope_diario || '0', 10) || 0;
        this.config.kiosko_modo_uso           = c.kiosko_modo_uso || 'asistido';
        this.config.kiosko_url_base           = c.kiosko_url_base || '';
        this.config.kiosko_url_publica        = c.kiosko_url_publica || '';
        this.config.impresora_ip              = c.impresora_ip     || '';
        this.config.impresora_puerto          = parseInt(c.impresora_puerto || '9100', 10) || 9100;
        this.config.impresora_activa          = c.impresora_activa === 'true' || c.impresora_activa === true;
        this.config.kiosko_impresion_automatica = c.kiosko_impresion_automatica === 'true' || c.kiosko_impresion_automatica === true;
        const escalaBase = parseInt(c.tv_escala_turnos || '100', 10) || 100;
        this.config.tv_escala_principal       = parseInt(c.tv_escala_principal || String(escalaBase), 10) || 100;
        this.config.tv_escala_secundaria      = parseInt(c.tv_escala_secundaria || String(escalaBase), 10) || 100;
        this.config.tv_escala_turnos          = this.config.tv_escala_principal;
        this.config.zona_horaria              = c.zona_horaria || 'America/Tegucigalpa';
        this.config.fondo_imagen_url          = c.fondo_imagen_url || '';
        this.config.fondo_imagen_activa       = c.fondo_imagen_activa === 'true' || c.fondo_imagen_activa === true;
      }
      this.validarFondoUrl();
      this._configSnapshot = { ...this.config };
    },

    // =========================================================================
    // LOTES
    // =========================================================================

    async crearLoteSubmit() {
      if (!this.validarNuevoLoteHasta() || !this.nuevoLoteValido) {
        if (!this.nuevoLoteHasta) {
          this.erroresValidacion.nuevoLoteHasta = 'Escribe el número límite del lote.';
        }
        return;
      }
      if (this._loading) return;
      this._loading = true;
      const hasta = parseInt(this.nuevoLoteHasta, 10);
      try {
        const res = await api.post('/lotes', { numero_desde: 1, numero_hasta: hasta });
        // El backend indica si el lote fue activado automáticamente o quedó preparado
        this.notificar({
          tipo: res.activado ? 'success' : 'info',
          titulo: res.activado ? 'Lote creado y activado' : 'Lote creado',
          mensaje: res.mensaje || `Lote ${res.lote.numero_lote} creado (1 al #${hasta})`
        });
        this.modalLote = false;
        this.nuevoLoteHasta = 500;
        this.erroresValidacion.nuevoLoteHasta = '';
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al crear lote',
          mensaje: err.mensaje || err.message || 'No se pudo crear el lote'
        });
      } finally { this._loading = false; }
    },

    async activarLote(loteId) {
      const loteObjetivo = this.lotes.find(l => l.id === loteId) || { id: loteId, numero_lote: loteId };
      // Si ya hay un lote activo distinto al que se quiere activar, abrir modal de confirmación
      if (this.loteActivo && this.loteActivo.id !== loteId && this.loteActivo.estado === 'activo') {
        this.lotePendienteActivar = loteObjetivo;
        this.modalCambioLote = true;
        return;
      }
      await this._ejecutarActivacion(loteId);
    },

    async _ejecutarActivacion(loteId) {
      if (this._loading) return;
      this._loading = true;
      try {
        await api.patch(`/lotes/${loteId}/activar`);
        showToast({ message: 'Lote activado en sala', type: 'success' });
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        showToast({ message: err.status === 409 ? 'El lote cambió. Vista actualizada.' : (err.mensaje || 'Error al activar lote'), type: err.status === 409 ? 'warning' : 'danger' });
        await this.cargarLotes();
      } finally { this._loading = false; }
    },

    async pausarYActivarNuevo() {
      if (!this.loteActivo || !this.lotePendienteActivar) return;
      if (this._loading) return;
      this._loading = true;
      const idActivo = this.loteActivo.id;
      const numActivo = this.loteActivo.numero_lote;
      const idNuevo = this.lotePendienteActivar.id;
      const numNuevo = this.lotePendienteActivar.numero_lote;

      try {
        await api.patch(`/lotes/${idActivo}/pausar`);
        await api.patch(`/lotes/${idNuevo}/activar`);
        showToast({ message: `Lote ${numActivo} pausado y Lote ${numNuevo} activado en sala`, type: 'success' });
        this.modalCambioLote = false;
        this.lotePendienteActivar = null;
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al cambiar de lote', type: 'danger' });
        await this.cargarLotes();
      } finally {
        this._loading = false;
      }
    },

    async cerrarYActivarNuevo() {
      if (!this.loteActivo || !this.lotePendienteActivar) return;
      if (this._loading) return;
      this._loading = true;
      const idActivo = this.loteActivo.id;
      const numActivo = this.loteActivo.numero_lote;
      const idNuevo = this.lotePendienteActivar.id;
      const numNuevo = this.lotePendienteActivar.numero_lote;

      try {
        await api.patch(`/lotes/${idActivo}/cerrar`);
        await api.patch(`/lotes/${idNuevo}/activar`);
        showToast({ message: `Lote ${numActivo} cerrado definitivamente y Lote ${numNuevo} activado en sala`, type: 'success' });
        this.modalCambioLote = false;
        this.lotePendienteActivar = null;
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al cambiar de lote', type: 'danger' });
        await this.cargarLotes();
      } finally {
        this._loading = false;
      }
    },

    // ── Activar el lote siguiente preparado desde el modal de lote agotado ──
    async activarSiguienteLotePreparado() {
      if (!this.loteAgotadoInfo || !this.loteAgotadoInfo.loteSiguiente) return;
      const idSiguiente = this.loteAgotadoInfo.loteSiguiente.id;
      const numSiguiente = this.loteAgotadoInfo.loteSiguiente.numero_lote;
      if (this._loading) return;
      this._loading = true;
      try {
        await api.patch(`/lotes/${idSiguiente}/activar`);
        showToast({ message: `Lote ${numSiguiente} activado en sala`, type: 'success' });
        this.modalLoteAgotado = false;
        this.loteAgotadoAlerta = false;
        this.loteAgotadoInfo = null;
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al activar lote siguiente', type: 'danger' });
        await this.cargarLotes();
      } finally { this._loading = false; }
    },

    // ── Abrir modal de crear lote desde el modal de lote agotado ──
    crearLoteDesdeModal() {
      this.modalLoteAgotado = false;
      this.modalLote = true;
    },



    calcularProgresoLote() {
      if (!this.loteActivo) return 0;
      const hasta = parseInt(this.loteActivo.numero_hasta, 10);
      const desde = parseInt(this.loteActivo.numero_desde, 10) || 1;
      const llamados = parseInt(this.loteActivo.ultimo_numero_llamado, 10) || 0;
      if (isNaN(hasta) || hasta <= 0) return 0;
      const total = hasta - desde + 1;
      if (total <= 0) return 0;
      const emitidos = Math.max(0, llamados >= desde ? (llamados - desde + 1) : 0);
      const pct = Math.round((emitidos / total) * 100);
      return isNaN(pct) ? 0 : Math.min(100, Math.max(0, pct));
    },

    calcularTurnosEmitidos() {
      if (!this.loteActivo) return 0;
      const desde = parseInt(this.loteActivo.numero_desde, 10) || 1;
      const llamados = parseInt(this.loteActivo.ultimo_numero_llamado, 10) || 0;
      if (llamados < desde) return 0;
      const emitidos = llamados - desde + 1;
      return isNaN(emitidos) ? 0 : Math.max(0, emitidos);
    },

    calcularVouchersEmitidos() {
      return this.calcularTurnosEmitidos();
    },

    calcularTurnosRestantesLote() {
      if (!this.loteActivo) return 0;
      const hasta = parseInt(this.loteActivo.numero_hasta, 10) || 0;
      const llamados = parseInt(this.loteActivo.ultimo_numero_llamado, 10) || 0;
      const rest = hasta - llamados;
      return isNaN(rest) ? 0 : Math.max(0, rest);
    },

    calcularVouchersRestantesLote() {
      return this.calcularTurnosRestantesLote();
    },

    abrirModalExtender(lote = null) {
      const l = lote || this.loteActivo;
      if (!l) {
        this.notificar({ tipo: 'warning', titulo: 'Sin Lote', mensaje: 'No hay un lote activo o agotado para extender.' });
        return;
      }
      if (l.estado === 'cerrado') {
        this.notificar({ tipo: 'warning', titulo: 'Lote Cerrado', mensaje: 'El lote está cerrado definitivamente y no puede extenderse.' });
        return;
      }
      this.loteAExtender = l;
      this.extensionCantidad = null;
      this.erroresValidacion.extensionCantidad = '';
      this.modalExtender = true;
    },

    async extenderLoteSubmit() {
      if (!this.validarExtensionCantidad() || !this.extensionValida) {
        if (this.extensionCantidad === null || this.extensionCantidad === '') {
          this.erroresValidacion.extensionCantidad = 'Escribe un número entero mayor que 0.';
        }
        return;
      }
      const loteTarget = this.loteAExtender || this.loteActivo;
      if (!loteTarget) return;

      if (this._loading) return;
      this._loading = true;

      const cantidad = parseInt(this.extensionCantidad, 10);
      const nuevoHasta = (parseInt(loteTarget.numero_hasta, 10) || 0) + cantidad;
      try {
        const res = await api.patch(`/lotes/${loteTarget.id}/extender`, { nuevo_numero_hasta: nuevoHasta });
        this.loteActivo = res.lote;
        this.loteAgotadoAlerta = false;
        this.modalExtender = false;
        this.modalLoteAgotado = false;
        this.notificar({
          tipo: 'success',
          titulo: 'Lote extendido',
          mensaje: `Lote ${res.lote.numero_lote} extendido: ahora llega hasta #${nuevoHasta}`
        });
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        this.notificar({
          tipo: err.status === 409 ? 'warning' : 'error',
          titulo: err.status === 409 ? 'Lote modificado' : 'Error al extender lote',
          mensaje: err.status === 409 ? 'El lote cambió en otra sesión. Vista actualizada.' : (err.mensaje || err.message || 'Error al extender lote')
        });
        await this.cargarLotes();
      } finally {
        this._loading = false;
      }
    },

    async pausarLote(loteId) {
      if (!this.loteActivo) return;
      if (this._loading) return;
      this._loading = true;
      try {
        await api.patch(`/lotes/${loteId}/pausar`);
        showToast({ message: 'Lote pausado.', type: 'info' });
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al pausar lote', type: 'danger' });
        await this.cargarLotes();
      } finally { this._loading = false; }
    },

    async extenderLote(loteId) {
      this.abrirModalExtender();
    },

    async cerrarLote(loteId, numeroLote = null) {
      const num = numeroLote || (this.lotes.find(l => l.id === loteId)?.numero_lote) || (this.loteActivo?.numero_lote) || loteId;
      this._pedirConfirmacion({
        titulo: `Cerrar Lote ${num}`,
        mensaje: `¿Está seguro de cerrar definitivamente el Lote ${num}? Una vez cerrado no podrá ser reactivado.`,
        botonTexto: 'Cerrar Lote',
        botonClase: 'btn-warning btn-sm',
        tipo: 'aviso',
        accion: async () => {
          if (this._loading) return;
          this._loading = true;
          try {
            await api.patch(`/lotes/${loteId}/cerrar`);
            this.notificar({ tipo: 'info', titulo: 'Lote cerrado', mensaje: `Lote ${num} cerrado definitivamente.` });
            if (this.loteActivo && String(this.loteActivo.id) === String(loteId)) {
              this.loteActivo = null;
              this.loteAgotadoAlerta = false;
            }
            await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
          } catch (err) {
            this.notificar({ tipo: 'error', titulo: 'Error al cerrar lote', mensaje: err.status === 409 ? 'El lote cambió. Vista actualizada.' : (err.mensaje || err.message || 'Error') });
            await this.cargarLotes();
          } finally {
            this._loading = false;
          }
        }
      });
    },

    async eliminarLote(loteId, numeroLote) {
      this._pedirConfirmacion({
        titulo:  `Eliminar Lote ${numeroLote}`,
        mensaje: '¿Está seguro de eliminar este lote? Esta acción no se puede deshacer.',
        botonTexto: 'Eliminar',
        botonClase: 'btn-danger btn-sm',
        tipo: 'peligro',
        accion: async () => {
          if (this._loading) return;
          this._loading = true;
          try {
            await api.delete(`/lotes/${loteId}`);
            this.notificar({ tipo: 'info', titulo: 'Lote eliminado', mensaje: `Lote ${numeroLote} eliminado correctamente.` });
            await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
          } catch (err) {
            this.notificar({ tipo: 'error', titulo: 'Error al eliminar', mensaje: err.mensaje || err.message || 'No se pudo eliminar el lote.' });
          } finally {
            this._loading = false;
          }
        }
      });
    },

    // =========================================================================
    // MESAS
    // =========================================================================

    async asignarOperador(mesaId, operadorIdStr) {
      const operadorId = operadorIdStr ? parseInt(operadorIdStr, 10) : null;
      try {
        await api.patch(`/mesas/${mesaId}/asignar`, { operador_id: operadorId });
        showToast({ message: 'Asignacion actualizada', type: 'success' });
        await Promise.allSettled([this.cargarMesas(), this.cargarUsuarios()]);
      } catch (err) {
        showToast({ message: err.mensaje || 'Error en asignacion', type: err.status === 409 ? 'warning' : 'danger' });
        await this.cargarMesas();
      }
    },

    async activarMesaAdmin(mesaId) {
      if (this._loading) return;
      this._loading = true;
      try {
        await api.patch(`/mesas/${mesaId}/estado`, { estado: 'activa' });
        this.notificar({ tipo: 'success', titulo: 'Mesa activada', mensaje: 'La mesa quedó activa y disponible para operar.' });
        await Promise.allSettled([this.cargarMesas(), this.cargarKPIs()]);
      } catch (err) {
        this.notificar({ tipo: 'error', titulo: 'Error al activar mesa', mensaje: err.mensaje || err.message || 'No se pudo activar la mesa.' });
        await this.cargarMesas();
      } finally { this._loading = false; }
    },

    async pausarMesaAdmin(mesaId) {
      if (this._loading) return;
      this._loading = true;
      try {
        await api.patch(`/mesas/${mesaId}/estado`, { estado: 'pausada' });
        this.notificar({ tipo: 'info', titulo: 'Mesa pausada', mensaje: 'La mesa quedó en pausa. El operador sigue asignado.' });
        await Promise.allSettled([this.cargarMesas(), this.cargarKPIs()]);
      } catch (err) {
        this.notificar({
          tipo: err.status === 409 ? 'warning' : 'error',
          titulo: 'No se puede pausar',
          mensaje: err.mensaje || err.message || 'Error al pausar la mesa.'
        });
        await this.cargarMesas();
      } finally { this._loading = false; }
    },

    async inactivarMesaAdmin(mesaId) {
      const mesa = this.mesas.find(m => m.id === mesaId);
      const label = mesa ? `Mesa ${mesa.numero}` : 'la mesa';
      this._pedirConfirmacion({
        titulo: `Inactivar ${label}`,
        mensaje: 'La mesa quedará inactiva y su operador será liberado. Esta acción no afecta el historial de turnos.',
        accion: async () => {
          if (this._loading) return;
          this._loading = true;
          try {
            await api.patch(`/mesas/${mesaId}/estado`, { estado: 'inactiva' });
            this.notificar({
              tipo: 'warning',
              titulo: 'Mesa inactivada',
              mensaje: `${label} inactivada. El operador fue liberado.`
            });
            await Promise.allSettled([this.cargarMesas(), this.cargarKPIs()]);
          } catch (err) {
            this.notificar({
              tipo: err.status === 409 ? 'warning' : 'error',
              titulo: 'No se puede inactivar',
              mensaje: err.mensaje || err.message || 'Error al inactivar la mesa.'
            });
            await this.cargarMesas();
          } finally { this._loading = false; }
        }
      });
    },

    abrirModalMesa() {
      const maxNum = this.mesas.reduce((max, m) => Math.max(max, parseInt(m.numero, 10) || 0), 0);
      this.nuevaMesa = {
        numero: maxNum + 1,
        nombre: `Mesa ${maxNum + 1}`
      };
      this.modalMesa = true;
    },

    async crearMesaSubmit() {
      const numOk = this.validarNuevaMesaNumero();
      const nomOk = this.validarNuevaMesaNombre();
      if (!numOk || !nomOk || !this.nuevaMesaValida) return;
      if (this._loading) return;
      this._loading = true;
      const num = parseInt(this.nuevaMesa.numero, 10);
      const nombre = (this.nuevaMesa.nombre || '').trim() || `Mesa ${num}`;
      try {
        await api.post('/mesas', { numero: num, nombre });
        this.notificar({
          tipo: 'success',
          titulo: 'Ventanilla creada',
          mensaje: `Mesa ${num} creada exitosamente`
        });
        this.modalMesa = false;
        await this.cargarMesas();
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al crear mesa',
          mensaje: err.mensaje || err.message || 'Error al crear mesa'
        });
      } finally {
        this._loading = false;
      }
    },

    crearMesa() {
      this.abrirModalMesa();
    },

    abrirEditarMesa(mesa) {
      this.mesaEditando = {
        id: mesa.id,
        numero: mesa.numero,
        nombre: mesa.nombre || ''
      };
      this.erroresValidacion.editMesaNumero = '';
      this.erroresValidacion.editMesaNombre = '';
      this.modalEditarMesa = true;
    },

    async editarMesaSubmit() {
      if (!this.mesaEditando.id) return;
      const numOk = this.validarEditMesaNumero();
      const nomOk = this.validarEditMesaNombre();
      if (!numOk || !nomOk || !this.editarMesaValida) return;
      if (this._loading) return;
      this._loading = true;
      const num = parseInt(this.mesaEditando.numero, 10);
      try {
        await api.patch(`/mesas/${this.mesaEditando.id}`, {
          numero: num,
          nombre: (this.mesaEditando.nombre || '').trim() || `Mesa ${num}`
        });
        this.notificar({
          tipo: 'success',
          titulo: 'Ventanilla actualizada',
          mensaje: `Mesa ${num} actualizada correctamente`
        });
        this.modalEditarMesa = false;
        await Promise.allSettled([this.cargarMesas(), this.cargarKPIs()]);
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al actualizar mesa',
          mensaje: err.mensaje || err.message || 'Error al actualizar mesa'
        });
      } finally {
        this._loading = false;
      }
    },

    async eliminarMesa(mesaId, mesaNumero) {
      this._pedirConfirmacion({
        titulo:  `Eliminar Mesa ${mesaNumero}`,
        mensaje: '¿Está seguro de eliminar esta ventanilla? Esta acción la ocultará del sistema y liberará su número.',
        botonTexto: 'Eliminar',
        botonClase: 'btn-danger btn-sm',
        tipo: 'peligro',
        accion: async () => {
          if (this._loading) return;
          this._loading = true;
          try {
            await api.delete(`/mesas/${mesaId}`);
            this.notificar({ tipo: 'info', titulo: 'Mesa eliminada', mensaje: `Mesa ${mesaNumero} eliminada correctamente.` });
            await Promise.allSettled([this.cargarMesas(), this.cargarKPIs()]);
          } catch (err) {
            this.notificar({ tipo: 'error', titulo: 'No se puede eliminar', mensaje: err.mensaje || err.message || 'No se pudo eliminar la mesa.' });
            await this.cargarMesas();
          } finally {
            this._loading = false;
          }
        }
      });
    },

    // =========================================================================
    // FILTROS
    // =========================================================================

    getMesasFiltradasDashboard() {
      if (this.filtroMesasDashboard === 'todas') return this.mesas;
      return this.mesas.filter(m => m.estado === this.filtroMesasDashboard);
    },

    getLotesFiltrados() {
      if (this.filtroLotes === 'todos') return this.lotes;
      return this.lotes.filter(l => l.estado === this.filtroLotes);
    },

    getMesasFiltradasConfig() {
      if (this.filtroMesas === 'todas') return this.mesas;
      if (this.filtroMesas === 'con_operador') return this.mesas.filter(m => m.operador_id);
      if (this.filtroMesas === 'sin_operador') return this.mesas.filter(m => !m.operador_id);
      return this.mesas.filter(m => m.estado === this.filtroMesas);
    },

    getUsuariosFiltrados() {
      if (this.filtroUsuarios === 'todos') return this.usuarios;
      if (this.filtroUsuarios === 'activos') return this.usuarios.filter(u => u.activo);
      if (this.filtroUsuarios === 'inactivos') return this.usuarios.filter(u => !u.activo);
      return this.usuarios.filter(u => u.rol === this.filtroUsuarios);
    },

    // =========================================================================
    // USUARIOS
    // =========================================================================

    async crearUsuarioSubmit() {
      const nomOk = this.validarNuevoUsrNombre();
      const usrOk = this.validarNuevoUsrUsername();
      const pwdOk = this.validarNuevoUsrPassword();
      if (!nomOk || !usrOk || !pwdOk || !this.nuevoUsuarioValido) return;
      if (this._loading) return;
      this._loading = true;
      const { nombre_completo, username, password, rol } = this.nuevoUsuario;
      try {
        await api.post('/admin/usuarios', {
          nombre_completo: nombre_completo.trim(), username: username.trim(), password, rol
        });
        this.notificar({
          tipo: 'success',
          titulo: 'Usuario creado',
          mensaje: `Usuario "${username}" creado exitosamente`
        });
        this.nuevoUsuario = { nombre_completo: '', username: '', password: '', rol: 'operador' };
        this.erroresValidacion.nuevoUsrNombre = '';
        this.erroresValidacion.nuevoUsrUsername = '';
        this.erroresValidacion.nuevoUsrPassword = '';
        this.modalUsuario = false;
        await this.cargarUsuarios();
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al crear usuario',
          mensaje: err.mensaje || err.message || 'Error al crear usuario'
        });
      } finally { this._loading = false; }
    },

    abrirEditarUsuario(usr) {
      this.usuarioEditando = {
        id: usr.id,
        nombre_completo: usr.nombre_completo || '',
        username: usr.username || '',
        rol: usr.rol || 'operador',
        password: '',
        activo: Boolean(usr.activo)
      };
      this.erroresValidacion.editUsrNombre = '';
      this.erroresValidacion.editUsrUsername = '';
      this.erroresValidacion.editUsrPassword = '';
      this.modalEditarUsuario = true;
    },

    async editarUsuarioSubmit() {
      if (!this.usuarioEditando.id) return;
      const nomOk = this.validarEditUsrNombre();
      const usrOk = this.validarEditUsrUsername();
      const pwdOk = this.validarEditUsrPassword();
      if (!nomOk || !usrOk || !pwdOk || !this.editarUsuarioValido) return;
      if (this._loading) return;
      this._loading = true;
      try {
        const payload = {
          nombre_completo: this.usuarioEditando.nombre_completo.trim(),
          username:        this.usuarioEditando.username.trim(),
          rol:             this.usuarioEditando.rol,
          activo:          this.usuarioEditando.activo
        };
        if (this.usuarioEditando.password && this.usuarioEditando.password.length >= 4) {
          payload.password = this.usuarioEditando.password;
        }
        await api.patch(`/admin/usuarios/${this.usuarioEditando.id}`, payload);
        this.notificar({
          tipo: 'success',
          titulo: 'Usuario actualizado',
          mensaje: `Usuario "${this.usuarioEditando.username}" actualizado correctamente`
        });
        this.modalEditarUsuario = false;
        await Promise.allSettled([this.cargarUsuarios(), this.cargarMesas()]);
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al actualizar usuario',
          mensaje: err.mensaje || err.message || 'Error al actualizar usuario'
        });
      } finally {
        this._loading = false;
      }
    },

    async toggleActivoUsuario(usr) {
      if (this._loading) return;
      this._loading = true;
      const nuevoEstado = !usr.activo;
      try {
        await api.patch(`/admin/usuarios/${usr.id}`, { activo: nuevoEstado });
        this.notificar({
          tipo: nuevoEstado ? 'success' : 'warning',
          titulo: nuevoEstado ? 'Usuario activado' : 'Usuario desactivado',
          mensaje: `${usr.username} fue ${nuevoEstado ? 'activado' : 'desactivado'} correctamente.`
        });
        await Promise.allSettled([this.cargarUsuarios(), this.cargarMesas()]);
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al cambiar estado',
          mensaje: err.mensaje || err.message || 'No se pudo cambiar el estado del usuario.'
        });
      } finally {
        this._loading = false;
      }
    },

    /**
     * asignarMesaAUsuario — Asigna o libera una mesa desde la pestaña Usuarios.
     * Reutiliza el endpoint PATCH /mesas/:id/asignar que ya existe y que emite
     * broadcast WS a admin:all y tv:global. No duplica lógica de negocio.
     *
     * @param {number|null} mesaId - ID de la mesa a asignar. null = liberar mesa actual.
     * @param {number}      usrId  - ID del usuario al que se asigna.
     * @param {string}      username - Nombre de usuario para los mensajes.
     */
    async asignarMesaAUsuario(mesaId, usrId, username) {
      if (this._loading) return;
      this._loading = true;
      try {
        if (mesaId) {
          // Asignar: llamar al endpoint existente de mesas
          await api.patch(`/mesas/${mesaId}/asignar`, { operador_id: usrId });
          const mesa = this.mesas.find(m => m.id === mesaId);
          this.notificar({
            tipo: 'success',
            titulo: 'Mesa asignada',
            mensaje: `Mesa ${mesa ? mesa.numero : mesaId} asignada a ${username}.`
          });
        } else {
          // Liberar: encontrar la mesa actual del usuario y llamar con operador_id null
          const usrObj = this.usuarios.find(u => u.id === usrId || String(u.id) === String(usrId));
          const mesaActual = this.mesas.find(m => 
            m.operador_id === usrId || 
            String(m.operador_id) === String(usrId) || 
            Number(m.operador_id) === Number(usrId) ||
            (usrObj && usrObj.mesa_id && (m.id === usrObj.mesa_id || String(m.id) === String(usrObj.mesa_id)))
          );
          if (!mesaActual) {
            // Nada que liberar
            return;
          }
          await api.patch(`/mesas/${mesaActual.id}/asignar`, { operador_id: null });
          this.notificar({
            tipo: 'info',
            titulo: 'Mesa liberada',
            mensaje: `Mesa ${mesaActual.numero} liberada de ${username}.`
          });
        }
        // Recargar mesas y usuarios para reflejar el cambio
        await Promise.allSettled([this.cargarMesas(), this.cargarUsuarios()]);
      } catch (err) {
        const msg = err.mensaje || err.message || 'No se pudo asignar la mesa.';
        this.notificar({
          tipo: 'error',
          titulo: 'Error al asignar mesa',
          mensaje: msg
        });
        // Recargar de todos modos para mostrar el estado real
        await Promise.allSettled([this.cargarMesas(), this.cargarUsuarios()]);
      } finally {
        this._loading = false;
      }
    },

    async eliminarUsuario(usrId, username) {
      this._pedirConfirmacion({
        titulo:  `Eliminar usuario ${username}`,
        mensaje: '¿Está seguro de eliminar este usuario? Esta acción no se puede deshacer.',
        accion: async () => {
          if (this._loading) return;
          this._loading = true;
          try {
            await api.delete(`/admin/usuarios/${usrId}`);
            this.notificar({ tipo: 'info', titulo: 'Usuario eliminado', mensaje: `Usuario ${username} eliminado correctamente.` });
            await Promise.allSettled([this.cargarUsuarios(), this.cargarMesas()]);
          } catch (err) {
            this.notificar({ tipo: 'error', titulo: 'Error al eliminar', mensaje: err.mensaje || err.message || 'No se pudo eliminar el usuario.' });
          } finally {
            this._loading = false;
          }
        }
      });
    },

    // =========================================================================
    // CONFIGURACION Y GESTIÓN DE KIOSKO (INC-4)
    // =========================================================================

    /**
     * Alternar un interruptor booleano con guardado inmediato en el servidor
     */
    async alternarSwitchConfig(clave, nombreLegible) {
      if (!this.wsConnected) {
        this.notificar({
          tipo: 'error',
          titulo: 'Sin conexión',
          mensaje: 'Sin conexión con el servidor. No se pueden guardar cambios hasta restablecer la red.'
        });
        return;
      }
      if (this._savingKeys[clave]) return;
      this._savingKeys[clave] = true;

      const valorPrevio = this.config[clave];
      const nuevoValor = !valorPrevio;
      this.config[clave] = nuevoValor;

      try {
        await api.patch(`/admin/configuracion/${clave}`, { valor: String(nuevoValor) });
        if (this._configSnapshot) {
          this._configSnapshot[clave] = nuevoValor;
        }
        this.notificar({
          tipo: 'success',
          titulo: 'Ajuste actualizado',
          mensaje: `${nombreLegible}: ${nuevoValor ? 'Activado' : 'Desactivado'}`
        });
      } catch (err) {
        this.config[clave] = valorPrevio;
        this.notificar({
          tipo: 'error',
          titulo: 'Error al actualizar',
          mensaje: err.mensaje || err.message || 'No se pudo actualizar el ajuste'
        });
      } finally {
        delete this._savingKeys[clave];
      }
    },

    /**
     * Alternar el modo Kiosko Digital (interruptor único y sin duplicados)
     */
    async alternarModoKiosko() {
      if (!this.wsConnected) {
        this.notificar({
          tipo: 'error',
          titulo: 'Sin conexión',
          mensaje: 'Sin conexión con el servidor. No se pueden guardar cambios hasta restablecer la red.'
        });
        return;
      }
      if (this._savingKeys.kiosko_web_activo) return;
      this._savingKeys.kiosko_web_activo = true;

      const valorPrevio = this.config.kiosko_web_activo;
      const nuevoValor = !valorPrevio;
      this.config.kiosko_web_activo = nuevoValor;

      try {
        await api.patch('/admin/configuracion/kiosko_web_activo', { valor: String(nuevoValor) });
        this.config.modo_generacion_turnos = nuevoValor ? 'kiosko_web' : 'voucher_fisico';
        this._configSnapshot = { ...this.config };
        this.notificar({
          tipo: 'success',
          titulo: nuevoValor ? 'Kiosko Digital Activado' : 'Modo Vouchers Físicos Activado',
          mensaje: nuevoValor
            ? 'El sistema ahora opera en modo digital para recepción o autoservicio estudiantil.'
            : 'El sistema ha vuelto al modo tradicional de vouchers impresos.'
        });
      } catch (err) {
        this.config.kiosko_web_activo = valorPrevio;
        this.notificar({
          tipo: 'error',
          titulo: 'Error al cambiar modo de kiosko',
          mensaje: err.mensaje || err.message || 'No se pudo cambiar el modo de kiosko'
        });
      } finally {
        delete this._savingKeys.kiosko_web_activo;
      }
    },

    /**
     * Guardar parámetros de emisión del Kiosko Digital
     */
    async guardarKioskoParams() {
      if (!this.wsConnected) {
        this.notificar({
          tipo: 'error',
          titulo: 'Sin conexión',
          mensaje: 'Sin conexión con el servidor. No se pueden guardar cambios hasta restablecer la red.'
        });
        return;
      }
      this.validarKioskoUrlBase();
      this.validarKioskoUrlPublica();
      if (!this.validarKioskoTope() || !this.cfgKioskoValida) return;

      if (this._guardandoSeccion.kiosko) return;
      this._guardandoSeccion.kiosko = true;

      const tope = parseInt(this.config.kiosko_tope_diario, 10);
      const modo = this.config.kiosko_modo_uso;
      const urlBase = (this.config.kiosko_url_base || '').trim();
      const urlPublica = (this.config.kiosko_url_publica || '').trim();
      const impresionAuto = this.config.kiosko_impresion_automatica ? 'true' : 'false';

      try {
        await Promise.all([
          api.patch('/admin/configuracion/kiosko_tope_diario',           { valor: String(tope) }),
          api.patch('/admin/configuracion/kiosko_modo_uso',              { valor: modo }),
          api.patch('/admin/configuracion/kiosko_url_base',              { valor: urlBase }),
          api.patch('/admin/configuracion/kiosko_url_publica',           { valor: urlPublica }),
          api.patch('/admin/configuracion/kiosko_impresion_automatica',  { valor: impresionAuto })
        ]);
        this._configSnapshot = { ...this.config };
        this.notificar({
          tipo: 'success',
          titulo: 'Ajustes de Kiosko Guardados',
          mensaje: 'Modalidad de uso, límite diario, URLs de acceso e impresión automática actualizados correctamente.'
        });
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al guardar kiosko',
          mensaje: err.mensaje || err.message || 'No se pudieron guardar los parámetros de kiosko'
        });
      } finally {
        this._guardandoSeccion.kiosko = false;
      }
    },

    /**
     * Muestra el modal con el código QR grande para estudiantes
     */
    abrirCartelQR() {
      this.modalCartelQR = true;
      this.$nextTick(() => {
        this.renderizarQrEstudiante();
      });
    },

    /**
     * Renderiza el código QR en alta resolución para proyección o impresión
     */
    renderizarQrEstudiante() {
      const container = document.getElementById('cartel-qr-code');
      if (!container) return;
      container.innerHTML = '';
      if (typeof window.QRCode !== 'undefined') {
        new window.QRCode(container, {
          text: this.urlEstudianteQR,
          width: 280,
          height: 280,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel.H
        });
      }
    },

    /**
     * Dispara la impresión aislada del cartel en exactamente 1 sola página con QR en gran formato
     */
    imprimirCartel() {
      const container = document.getElementById('cartel-qr-code');
      const imgEl = container ? container.querySelector('img') : null;
      const canvasEl = container ? container.querySelector('canvas') : null;
      let qrDataUrl = '';

      if (imgEl && imgEl.src && imgEl.src.startsWith('data:image')) {
        qrDataUrl = imgEl.src;
      } else if (canvasEl && canvasEl.toDataURL) {
        qrDataUrl = canvasEl.toDataURL('image/png');
      }

      const urlTexto = this.urlEstudianteQR;

      let printFrame = document.getElementById('print-cartel-iframe');
      if (printFrame) {
        printFrame.remove();
      }

      printFrame = document.createElement('iframe');
      printFrame.id = 'print-cartel-iframe';
      printFrame.style.position = 'fixed';
      printFrame.style.right = '0';
      printFrame.style.bottom = '0';
      printFrame.style.width = '0';
      printFrame.style.height = '0';
      printFrame.style.border = '0';
      document.body.appendChild(printFrame);

      const doc = printFrame.contentWindow.document;
      doc.open();
      doc.write(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="utf-8">
          <title>Cartel QR - Matrículas 2026</title>
          <style>
            @page {
              size: portrait;
              margin: 12mm 15mm;
            }
            * {
              box-sizing: border-box;
              margin: 0;
              padding: 0;
            }
            html, body {
              width: 100%;
              height: 100%;
              background: #ffffff;
              color: #0f172a;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              overflow: hidden;
            }
            .cartel-sheet {
              width: 100%;
              max-width: 620px;
              margin: 0 auto;
              height: 100%;
              max-height: 255mm;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: space-between;
              text-align: center;
              padding: 16mm 14mm;
              border: 3.5px solid #0f172a;
              border-radius: 28px;
              page-break-inside: avoid;
              break-inside: avoid;
            }
            .pill-header {
              display: inline-block;
              padding: 8px 22px;
              background: #eff6ff;
              border: 2px solid #bfdbfe;
              border-radius: 9999px;
              color: #1d4ed8;
              font-size: 14px;
              font-weight: 800;
              letter-spacing: 1.5px;
              text-transform: uppercase;
            }
            .title {
              font-size: 32px;
              font-weight: 900;
              color: #0f172a;
              line-height: 1.15;
              letter-spacing: -0.5px;
              margin-top: 14px;
            }
            .subtitle {
              font-size: 15px;
              color: #475569;
              font-weight: 500;
              margin-top: 6px;
              max-width: 460px;
              line-height: 1.35;
            }
            .qr-wrapper {
              margin: 16px 0;
              padding: 18px;
              background: #ffffff;
              border: 3px solid #0f172a;
              border-radius: 22px;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              box-shadow: 0 4px 10px rgba(0,0,0,0.06);
            }
            .qr-wrapper img {
              width: 320px !important;
              height: 320px !important;
              display: block;
              image-rendering: -webkit-optimize-contrast;
              image-rendering: crisp-edges;
            }
            .url-container {
              width: 100%;
              max-width: 500px;
              background: #f8fafc;
              border: 1.5px dashed #cbd5e1;
              border-radius: 12px;
              padding: 10px 14px;
            }
            .url-label {
              font-size: 10px;
              text-transform: uppercase;
              font-weight: 700;
              color: #64748b;
              letter-spacing: 1px;
              margin-bottom: 2px;
            }
            .url-text {
              font-family: monospace;
              font-size: 14px;
              font-weight: 700;
              color: #1d4ed8;
              word-break: break-all;
            }
            .instructions-box {
              width: 100%;
              max-width: 500px;
              background: #f0fdf4;
              border: 1.5px solid #bbf7d0;
              border-radius: 14px;
              padding: 12px 18px;
              text-align: left;
              margin-top: 12px;
            }
            .instructions-title {
              font-size: 12px;
              font-weight: 800;
              color: #166534;
              margin-bottom: 4px;
              text-transform: uppercase;
              letter-spacing: 0.5px;
            }
            .instructions-list {
              font-size: 12px;
              color: #15803d;
              font-weight: 600;
              line-height: 1.45;
              padding-left: 18px;
            }
            .instructions-list li {
              margin-bottom: 2px;
            }
            .footer-note {
              font-size: 11px;
              color: #94a3b8;
              font-weight: 600;
              margin-top: 8px;
            }
          </style>
        </head>
        <body>
          <div class="cartel-sheet">
            <div>
              <div class="pill-header">Proceso de Matrículas 2026</div>
              <h1 class="title">Toma tu turno desde el celular</h1>
              <p class="subtitle">Apunta con la cámara de tu teléfono al código QR para ingresar al autoservicio y seguir tu turno en vivo.</p>
            </div>

            <div class="qr-wrapper">
              <img src="${qrDataUrl}" alt="Código QR de Acceso">
            </div>

            <div class="url-container">
              <div class="url-label">Enlace Directo:</div>
              <div class="url-text">${urlTexto}</div>
            </div>

            <div class="instructions-box">
              <div class="instructions-title">Instrucciones para el postulante:</div>
              <ol class="instructions-list">
                <li>Conéctate al Wi-Fi del campus o usa tus datos móviles.</li>
                <li>Abre la cámara de tu celular y escanea este código.</li>
                <li>Presiona &ldquo;Tomar mi turno&rdquo; y mantén la pantalla encendida.</li>
              </ol>
            </div>

            <div class="footer-note">
              Sistema Institucional de Gestión de Turnos • Turnero 2026
            </div>
          </div>
        </body>
        </html>
      `);
      doc.close();

      setTimeout(() => {
        printFrame.contentWindow.focus();
        printFrame.contentWindow.print();
        setTimeout(() => {
          printFrame.remove();
        }, 5000);
      }, 350);
    },

    /**
     * Envía un ticket de prueba (#000) con QR a la impresora térmica LAN
     */
    async imprimirTicketPrueba() {
      if (this._imprimiendoPrueba) return;
      if (!this.wsConnected) {
        this.notificar({
          tipo: 'error',
          titulo: 'Sin conexión',
          mensaje: 'Sin conexión con el servidor. No se puede enviar la orden de impresión.'
        });
        return;
      }

      const ip = (this.config.impresora_ip || '').trim();
      const puerto = this.config.impresora_puerto || 9100;

      if (!ip) {
        this.notificar({
          tipo: 'warning',
          titulo: 'IP requerida',
          mensaje: 'Ingrese la dirección IP de la impresora antes de imprimir la prueba.'
        });
        return;
      }

      this._imprimiendoPrueba = true;
      try {
        const res = await api.post('/admin/impresora/probar', { ip, puerto });
        this.notificar({
          tipo: 'success',
          titulo: 'Ticket de Prueba Enviado',
          mensaje: res.mensaje || 'Se envió el ticket #000 a la impresora térmica LAN.'
        });
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Fallo al Imprimir Prueba',
          mensaje: err.mensaje || err.message || 'No se pudo comunicar con la impresora térmica en red.'
        });
      } finally {
        this._imprimiendoPrueba = false;
      }
    },

    /**
     * Guardar configuración de la impresora de tickets LAN
     */
    async guardarImpresoraParams() {
      if (!this.wsConnected) {
        this.notificar({
          tipo: 'error',
          titulo: 'Sin conexión',
          mensaje: 'Sin conexión con el servidor. No se pueden guardar cambios hasta restablecer la red.'
        });
        return;
      }
      if (!this.validarImpresoraPuerto() || !this.cfgImpresoraValida) return;

      if (this._guardandoSeccion.impresora) return;
      this._guardandoSeccion.impresora = true;

      const puerto = parseInt(this.config.impresora_puerto, 10);
      const ip = (this.config.impresora_ip || '').trim();

      try {
        await Promise.all([
          api.patch('/admin/configuracion/impresora_ip',     { valor: ip }),
          api.patch('/admin/configuracion/impresora_puerto', { valor: String(puerto) })
        ]);
        this._configSnapshot = { ...this.config };
        this.notificar({
          tipo: 'success',
          titulo: 'Impresora Guardada',
          mensaje: 'Dirección IP y puerto de la impresora térmica actualizados correctamente.'
        });
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al guardar impresora',
          mensaje: err.mensaje || err.message || 'No se pudo guardar la configuración de impresora'
        });
      } finally {
        this._guardandoSeccion.impresora = false;
      }
    },

    /**
     * Guardar parámetros operativos del sistema (Alerta de lote y Zona horaria)
     */
    async guardarSistemaParams() {
      if (!this.wsConnected) {
        this.notificar({
          tipo: 'error',
          titulo: 'Sin conexión',
          mensaje: 'Sin conexión con el servidor. No se pueden guardar cambios hasta restablecer la red.'
        });
        return;
      }
      if (!this.validarCfgAlerta() || !this.cfgAlertaValida) return;
      if (!this.validarZonaHoraria() || !this.cfgSistemaValida) return;

      if (this._guardandoSeccion.sistema) return;
      this._guardandoSeccion.sistema = true;

      const alerta = parseInt(this.config.alerta_vouchers_restantes, 10);
      const zona = (this.config.zona_horaria || '').trim();

      try {
        await Promise.all([
          api.patch('/admin/configuracion/alerta_vouchers_restantes', { valor: String(alerta) }),
          api.patch('/admin/configuracion/zona_horaria',              { valor: zona })
        ]);
        this._configSnapshot = { ...this.config };
        this._actualizarAlertaLote();
        this.notificar({
          tipo: 'success',
          titulo: 'Parámetros del Sistema Guardados',
          mensaje: 'Umbral de alerta y zona horaria guardados correctamente.'
        });
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al guardar parámetros',
          mensaje: err.mensaje || err.message || 'No se pudieron guardar los parámetros'
        });
      } finally {
        this._guardandoSeccion.sistema = false;
      }
    },

    validarFondoUrl() {
      const url = (this.config.fondo_imagen_url || '').trim();
      this.erroresValidacion.cfgFondoUrl = '';
      if (url.length > 1000) {
        this.erroresValidacion.cfgFondoUrl = 'La dirección no debe superar los 1000 caracteres. Para imágenes de su equipo, use el botón Examinar... para subirlas automáticamente al servidor.';
        return false;
      }
      if (url.length > 0) {
        if (!/^https?:\/\//i.test(url) && !url.startsWith('/') && !url.startsWith('data:image/')) {
          this.erroresValidacion.cfgFondoUrl = 'Ingrese una URL válida (http://, https:// o ruta local /assets/...).';
          return false;
        }
      }
      return true;
    },

    async toggleFondoActivo() {
      if (this._togglingFondo) return;
      if (!this.wsConnected) {
        this.notificar({
          tipo: 'error',
          titulo: 'Sin conexión',
          mensaje: 'Sin conexión con el servidor. No se puede cambiar la configuración hasta restablecer la red.'
        });
        return;
      }
      const nuevoEstado = !this.config.fondo_imagen_activa;
      this.config.fondo_imagen_activa = nuevoEstado;
      this._togglingFondo = true;
      try {
        await api.patch('/admin/configuracion/fondo_imagen_activa', { valor: nuevoEstado ? 'true' : 'false' });
        if (this._configSnapshot) {
          this._configSnapshot.fondo_imagen_activa = nuevoEstado;
        }
        this.notificar({
          tipo: 'success',
          titulo: nuevoEstado ? 'Fondo de Pantalla Activado' : 'Fondo de Pantalla Desactivado',
          mensaje: nuevoEstado 
            ? 'El fondo institucional se activó en vivo en todas las pantallas.' 
            : 'El fondo institucional se desactivó en vivo (las pantallas vuelven al fondo estándar).'
        });
      } catch (err) {
        this.config.fondo_imagen_activa = !nuevoEstado;
        this.notificar({
          tipo: 'error',
          titulo: 'Error al cambiar fondo',
          mensaje: err.mensaje || err.message || 'No se pudo actualizar el estado del fondo en el servidor.'
        });
      } finally {
        this._togglingFondo = false;
      }
    },

    async guardarFondoUrlDirecto() {
      if (!this.validarFondoUrl()) return;
      if (!this.wsConnected) {
        this.notificar({
          tipo: 'error',
          titulo: 'Sin conexión',
          mensaje: 'Sin conexión con el servidor. No se pueden guardar cambios hasta restablecer la red.'
        });
        return;
      }

      const url = (this.config.fondo_imagen_url || '').trim();
      const activa = this.config.fondo_imagen_activa ? 'true' : 'false';

      try {
        await Promise.all([
          api.patch('/admin/configuracion/fondo_imagen_url',    { valor: url }),
          api.patch('/admin/configuracion/fondo_imagen_activa', { valor: activa })
        ]);
        if (this._configSnapshot) {
          this._configSnapshot.fondo_imagen_url = url;
          this._configSnapshot.fondo_imagen_activa = this.config.fondo_imagen_activa;
        }
        this.notificar({
          tipo: 'success',
          titulo: 'Fondo Actualizado',
          mensaje: url ? 'La URL del fondo se sincronizó con todas las pantallas.' : 'Fondo restablecido en el servidor.'
        });
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al guardar fondo',
          mensaje: err.mensaje || err.message || 'No se pudieron guardar los parámetros de fondo.'
        });
      }
    },

    async quitarFondo() {
      this.config.fondo_imagen_url = '';
      this.archivoFondoSeleccionado = null;
      const input = document.getElementById('input-archivo-fondo');
      if (input) input.value = '';
      await this.guardarFondoUrlDirecto();
    },

    async guardarFondoParams() {
      return this.guardarFondoUrlDirecto();
    },

    async seleccionarArchivoFondo(event) {
      const file = event?.target?.files?.[0];
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        this.notificar({
          tipo: 'error',
          titulo: 'Archivo no válido',
          mensaje: 'El archivo seleccionado debe ser una imagen válida (JPG, PNG, WebP o SVG).'
        });
        if (event.target) event.target.value = '';
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        this.notificar({
          tipo: 'error',
          titulo: 'Archivo muy grande',
          mensaje: 'La imagen no debe superar los 10 MB de tamaño.'
        });
        if (event.target) event.target.value = '';
        return;
      }

      if (!this.wsConnected) {
        this.notificar({
          tipo: 'error',
          titulo: 'Sin conexión',
          mensaje: 'Sin conexión con el servidor. No se puede subir el archivo hasta restablecer la red.'
        });
        if (event.target) event.target.value = '';
        return;
      }

      this._subiendoFondo = true;
      this.erroresValidacion.cfgFondoUrl = '';

      const reader = new FileReader();
      reader.onerror = () => {
        this._subiendoFondo = false;
        this.notificar({
          tipo: 'error',
          titulo: 'Error de lectura',
          mensaje: 'No se pudo leer el archivo seleccionado de su equipo.'
        });
      };
      reader.onload = async (e) => {
        try {
          const res = await api.post('/admin/configuracion/subir-fondo', {
            data: e.target.result,
            nombre: file.name,
            activar: true
          });

          if (res && res.url) {
            this.config.fondo_imagen_url = res.url;
            this.config.fondo_imagen_activa = true;
            if (this._configSnapshot) {
              this._configSnapshot.fondo_imagen_url = res.url;
              this._configSnapshot.fondo_imagen_activa = true;
            }
            this.erroresValidacion.cfgFondoUrl = '';
            this.validarFondoUrl();
            const tamanoKB = Math.round(file.size / 1024);
            const tamanoTexto = tamanoKB > 1024 ? `${(tamanoKB / 1024).toFixed(1)} MB` : `${tamanoKB} KB`;
            this.archivoFondoSeleccionado = {
              nombre: file.name,
              url: res.url,
              tamanoTexto
            };

            this.notificar({
              tipo: 'success',
              titulo: 'Fondo Guardado y Activado',
              mensaje: `La imagen "${file.name}" se guardó en el servidor y ya está activa en todas las pantallas.`
            });
          }
        } catch (err) {
          this.notificar({
            tipo: 'error',
            titulo: 'Error al subir imagen',
            mensaje: err.mensaje || err.message || 'No se pudo guardar la imagen en el servidor.'
          });
        } finally {
          this._subiendoFondo = false;
          if (event.target) event.target.value = '';
        }
      };
      reader.readAsDataURL(file);
    },

    cancelarArchivoFondo() {
      this.archivoFondoSeleccionado = null;
      const el = document.getElementById('input-archivo-fondo');
      if (el) el.value = '';
      this.config.fondo_imagen_url = this._configSnapshot?.fondo_imagen_url || '';
    },

    async subirArchivoFondo() {
      // Método de compatibilidad auxiliar
      if (this.archivoFondoSeleccionado?.file) {
        await this.seleccionarArchivoFondo({ target: { files: [this.archivoFondoSeleccionado.file] } });
      }
    },

    /**
     * Guardado general de respaldo para compatibilidad
     */
    async guardarConfiguracion() {
      await this.guardarSistemaParams();
    },

    async cambiarEscalaPrincipal(delta) {
      const actual = parseInt(this.config.tv_escala_principal, 10) || 100;
      const nuevo = Math.min(140, Math.max(75, actual + delta));
      if (nuevo !== this.config.tv_escala_principal) {
        this.config.tv_escala_principal = nuevo;
        this.onInputEscalaPrincipal();
        await this._guardarEscalaPrincipalInmediata(nuevo);
      }
    },

    async restablecerEscalaPrincipal() {
      if (this.config.tv_escala_principal !== 100) {
        this.config.tv_escala_principal = 100;
        this.onInputEscalaPrincipal();
        await this._guardarEscalaPrincipalInmediata(100);
      }
    },

    onInputEscalaPrincipal() {
      const val = parseInt(this.config.tv_escala_principal, 10) || 100;
      this.config.tv_escala_principal = Math.min(140, Math.max(75, val));
      try {
        localStorage.setItem('turnero_tv_escala_principal', String(this.config.tv_escala_principal));
      } catch (_) {}
      this._emitirEscalaEnVivo('tv_escala_principal', this.config.tv_escala_principal);
    },

    async _guardarEscalaPrincipalInmediata(val) {
      if (!this.wsConnected) {
        showToast({ message: 'Sin conexión con el servidor. No se puede guardar la escala.', type: 'danger' });
        return;
      }
      try {
        localStorage.setItem('turnero_tv_escala_principal', String(val));
      } catch (_) {}
      try {
        await api.patch('/admin/configuracion/tv_escala_principal', { valor: String(val) });
        showToast({ message: `Tamaño de turno principal guardado (${val}%)`, type: 'info' });
        this.avisoGuardadoPrincipal = true;
        setTimeout(() => { this.avisoGuardadoPrincipal = false; }, 2500);
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al guardar escala del turno principal', type: 'danger' });
      }
    },

    async cambiarEscalaSecundaria(delta) {
      const actual = parseInt(this.config.tv_escala_secundaria, 10) || 100;
      const nuevo = Math.min(140, Math.max(75, actual + delta));
      if (nuevo !== this.config.tv_escala_secundaria) {
        this.config.tv_escala_secundaria = nuevo;
        this.onInputEscalaSecundaria();
        await this._guardarEscalaSecundariaInmediata(nuevo);
      }
    },

    async restablecerEscalaSecundaria() {
      if (this.config.tv_escala_secundaria !== 100) {
        this.config.tv_escala_secundaria = 100;
        this.onInputEscalaSecundaria();
        await this._guardarEscalaSecundariaInmediata(100);
      }
    },

    onInputEscalaSecundaria() {
      const val = parseInt(this.config.tv_escala_secundaria, 10) || 100;
      this.config.tv_escala_secundaria = Math.min(140, Math.max(75, val));
      try {
        localStorage.setItem('turnero_tv_escala_secundaria', String(this.config.tv_escala_secundaria));
      } catch (_) {}
      this._emitirEscalaEnVivo('tv_escala_secundaria', this.config.tv_escala_secundaria);
    },

    async _guardarEscalaSecundariaInmediata(val) {
      if (!this.wsConnected) {
        showToast({ message: 'Sin conexión con el servidor. No se puede guardar la escala.', type: 'danger' });
        return;
      }
      try {
        localStorage.setItem('turnero_tv_escala_secundaria', String(val));
      } catch (_) {}
      try {
        await api.patch('/admin/configuracion/tv_escala_secundaria', { valor: String(val) });
        showToast({ message: `Tamaño de turnos anteriores guardado (${val}%)`, type: 'info' });
        this.avisoGuardadoSecundaria = true;
        setTimeout(() => { this.avisoGuardadoSecundaria = false; }, 2500);
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al guardar escala de turnos anteriores', type: 'danger' });
      }
    },

    _emitirEscalaEnVivo(clave, valor) {
      if (this._ws && typeof this._ws.send === 'function') {
        try {
          this._ws.send('preview_escala_tv', {
            clave,
            tipo: clave === 'tv_escala_principal' ? 'principal' : 'secundaria',
            valor
          });
        } catch (_) {}
      }
    },

    // Métodos de retrocompatibilidad
    async cambiarEscalaTv(delta) {
      await this.cambiarEscalaPrincipal(delta);
    },

    async restablecerEscalaTv() {
      await this.restablecerEscalaPrincipal();
      await this.restablecerEscalaSecundaria();
    },

    onInputEscalaTv() {
      this.onInputEscalaPrincipal();
    },

    async _guardarEscalaTvInmediata(val) {
      await this._guardarEscalaPrincipalInmediata(val);
    },

    // =========================================================================
    // REPORTES Y EXPORTACIÓN XLS
    // =========================================================================

    cambiarTab(nuevoTab) {
      this.tab = nuevoTab;
      if (nuevoTab === 'reportes') {
        this.cargarReporte();
      }
      if (nuevoTab === 'usuarios') {
        this.cargarUsuarios();
      }
    },

    async cargarReporte() {
      this.cargandoReporte = true;
      try {
        const query = new URLSearchParams();
        if (this.filtroReporte.fecha)       query.set('fecha', this.filtroReporte.fecha);
        if (this.filtroReporte.mesa_id)     query.set('mesa_id', this.filtroReporte.mesa_id);
        if (this.filtroReporte.operador_id) query.set('operador_id', this.filtroReporte.operador_id);
        if (this.filtroReporte.estado && this.filtroReporte.estado !== 'todos')
          query.set('estado', this.filtroReporte.estado);

        const res = await api.get(`/admin/reportes/datos?${query.toString()}`);
        if (res) {
          this.reporteData = {
            kpis:          res.kpis          || this.reporteData.kpis,
            mesas_resumen: res.mesas_resumen || [],
            turnos:        res.turnos        || []
          };
        }
        // Retorna la promesa resuelta para que el HTML pueda encadenar .then()/.catch()
      } catch (err) {
        const msg = err.mensaje || err.message || 'Error al cargar el reporte. Verifique la conexión.';
        this.notificar({ tipo: 'error', titulo: 'Error en Reportes', mensaje: msg });
        throw err;  // Re-lanza para que el .catch() del HTML active _errorReporte
      } finally {
        this.cargandoReporte = false;
      }
    },

    async exportarReporteXLS() {
      if (this._loading) return;
      this._loading = true;
      try {
        const query = new URLSearchParams();
        const fecha = this.filtroReporte.fecha || new Date().toISOString().slice(0, 10);
        query.set('fecha', fecha);
        if (this.filtroReporte.mesa_id)     query.set('mesa_id', this.filtroReporte.mesa_id);
        if (this.filtroReporte.operador_id) query.set('operador_id', this.filtroReporte.operador_id);
        if (this.filtroReporte.estado)      query.set('estado', this.filtroReporte.estado);

        const blob = await api.getBlob(`/admin/reportes/exportar-xls?${query.toString()}`);
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `reporte_turnero_${fecha}.xls`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast({ message: `Reporte Excel descargado (${fecha}.xls)`, type: 'success' });
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al exportar XLS', type: 'danger' });
      } finally {
        this._loading = false;
      }
    },

    // =========================================================================
    // SEMAFORO
    // =========================================================================

    /** Verde <= 5 min; Ambar <= 8 min; Rojo > 8 min. */
    semaforoClass(tiempoMin) {
      if (!tiempoMin) return 'bg-slate-300';
      if (tiempoMin <= 5) return 'bg-emerald-500';
      if (tiempoMin <= 8) return 'bg-amber-500';
      return 'bg-rose-500';
    },

    formatSegMin(seg) {
      // null/undefined o <= 0 → '--' (sin datos de atención reales)
      if (seg === null || seg === undefined) return '--';
      const n = Number(seg);
      if (!isFinite(n) || n <= 0) return '--';
      const m = Math.floor(n / 60);
      const s = Math.round(n % 60);
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },

    formatHora(iso) {
      if (!iso) return '--';
      const d = new Date(iso);
      return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    _actualizarAlertaLote() {
      if (this.config.modo_generacion_turnos === 'kiosko_web' || !this.loteActivo) {
        this.loteAgotadoAlerta = false;
        return;
      }
      const r = this.loteActivo.numero_hasta - (this.loteActivo.ultimo_numero_llamado || 0);
      this.loteAgotadoAlerta = r <= 0 || this.loteActivo.estado === 'agotado';
    },

    // =========================================================================
    // WEBSOCKET
    // =========================================================================

    initWebSocket() {
      const token = api.getToken();
      if (!token) return;

      this.ws = new TurneroWSClient({ token, canal: 'admin:all' });
      this.ws.onStatusChange(({ status }) => { this.wsConnected = status === 'CONECTADO'; });

      this.ws.on('snapshot', async () => { await this.cargarTodo(); this._actualizarAlertaLote(); });

      let _syncPending = false;
      let _syncAgain = false;
      const recargarEnVivo = async () => {
        if (_syncPending) {
          _syncAgain = true;
          return;
        }
        _syncPending = true;
        _syncAgain = false;
        try {
          await Promise.allSettled([this.cargarKPIs(), this.cargarMesas(), this.cargarLotes()]);
          this._actualizarAlertaLote();
        } finally {
          _syncPending = false;
          if (_syncAgain) {
            _syncAgain = false;
            recargarEnVivo();
          }
        }
      };

      this.ws.on('kpi_update',              recargarEnVivo);
      this.ws.on('turno_llamado',           recargarEnVivo);
      this.ws.on('turno_cancelado',         recargarEnVivo);
      this.ws.on('kiosko_turno_generado',   recargarEnVivo);
      this.ws.on('proximo_actualizado',     recargarEnVivo);
      // mesa_actualizada también recarga usuarios para mantener la columna Mesa sincronizada
      this.ws.on('mesa_actualizada', async () => {
        await recargarEnVivo();
        await this.cargarUsuarios();
      });
      this.ws.on('usuario_eliminado', async () => {
        await this.cargarUsuarios();
        await this.cargarMesas();
      });
      this.ws.on('lote_actualizado', recargarEnVivo);

      this.ws.on('lote_agotado', async (p) => {
        if (this.config.modo_generacion_turnos === 'kiosko_web') return;
        this.loteAgotadoAlerta = true;
        // Recargar lotes para tener la lista actualizada
        await recargarEnVivo();
        // Buscar el siguiente lote preparado
        const siguiente = this.lotes.find(l => l.estado === 'preparado');
        this.loteAgotadoInfo = {
          loteAgotado:    p || {},
          loteSiguiente:  siguiente || null
        };
        this.modalLoteAgotado = true;
      });

      this.ws.on('alerta_vouchers_restantes', (p) => {
        if (this.config.modo_generacion_turnos === 'kiosko_web') return;
        showToast({ message: `ALERTA: Quedan solo ${p?.vouchers_restantes ?? '?'} turnos`, type: 'warning', duration: 7000 });
      });

      this.ws.on('lote_extendido', async () => { this.loteAgotadoAlerta = false; await recargarEnVivo(); });
      this.ws.on('lote_pausado',   recargarEnVivo);
      this.ws.on('lote_activado',  recargarEnVivo);
      this.ws.on('lote_cerrado',   async () => { this.loteAgotadoAlerta = false; await recargarEnVivo(); });
      this.ws.on('config_actualizada', async () => {
        await this.cargarConfiguracion();
        await recargarEnVivo();
      });

      this.ws.connect();
    },

    // =========================================================================
    // AJUSTAR CONTADOR DEL LOTE (Plan B — caida del sistema)
    // =========================================================================

    abrirModalAjustarContador() {
      const loteRef = this.loteActivo || this.lotePausado;
      if (!loteRef) return;
      this.ajusteContador = {
        nuevoUltimo:        loteRef.ultimo_numero_llamado ?? 0,
        motivo:             '',
        confirmarRetroceso: false,
        cargando:           false
      };
      this.modalAjustarContador = true;
    },

    cerrarModalAjustarContador() {
      this.modalAjustarContador = false;
    },

    async submitAjustarContador() {
      const loteRef = this.loteActivo || this.lotePausado;
      if (!loteRef || this.ajusteContador.cargando) return;
      const numOk = this.validarAjusteNumero();
      const motOk = this.validarAjusteMotivo();
      if (!numOk || !motOk || !this.ajusteContadorValido) return;

      const esRetroceso = this.ajusteContador.nuevoUltimo < (loteRef.ultimo_numero_llamado ?? 0);
      if (esRetroceso && !this.ajusteContador.confirmarRetroceso) return;

      this.ajusteContador.cargando = true;
      try {
        const res = await api.patch(`/lotes/${loteRef.id}/ajustar-contador`, {
          nuevo_ultimo_llamado:   this.ajusteContador.nuevoUltimo,
          motivo:                 this.ajusteContador.motivo.trim(),
          confirmacion_retroceso: this.ajusteContador.confirmarRetroceso
        });

        // Actualizar el lote en el estado local
        const loteActualizado = res.lote;
        if (this.loteActivo && this.loteActivo.id === loteActualizado.id) {
          this.loteActivo = { ...this.loteActivo, ...loteActualizado };
        }
        if (this.lotePausado && this.lotePausado.id === loteActualizado.id) {
          this.lotePausado = { ...this.lotePausado, ...loteActualizado };
        }
        // Actualizar tambien en el array de lotes
        const idx = this.lotes.findIndex(l => l.id === loteActualizado.id);
        if (idx !== -1) this.lotes[idx] = { ...this.lotes[idx], ...loteActualizado };

        this.notificar({
          tipo: 'success',
          titulo: 'Contador ajustado',
          mensaje: res.message || 'Contador del lote ajustado correctamente'
        });
        this.cerrarModalAjustarContador();
      } catch (err) {
        this.notificar({
          tipo: 'error',
          titulo: 'Error al ajustar contador',
          mensaje: err.mensaje || err.message || 'No se pudo ajustar el contador'
        });
      } finally {
        this.ajusteContador.cargando = false;
      }
    },

    // =========================================================================
    // SESION Y NAVEGACION
    // =========================================================================

    async irAPanelMesa() {
      try {
        const res = await api.get('/auth/me');
        const usuario = res?.usuario || this.currentUser;
        if (usuario?.mesa_asignada) {
          this.currentUser = usuario;
          sessionStorage.setItem('turnero_mesa', JSON.stringify(usuario.mesa_asignada));
          sessionStorage.setItem('turnero_user', JSON.stringify(usuario));
          window.location.href = '/panel_mesa.html';
        } else {
          sessionStorage.removeItem('turnero_mesa');
          window.location.href = '/index.html?seleccionar_mesa=1';
        }
      } catch (_) {
        if (this.currentUser?.mesa_asignada) {
          sessionStorage.setItem('turnero_mesa', JSON.stringify(this.currentUser.mesa_asignada));
          window.location.href = '/panel_mesa.html';
        } else {
          sessionStorage.removeItem('turnero_mesa');
          window.location.href = '/index.html?seleccionar_mesa=1';
        }
      }
    },

    async logout() {
      if (this.ws) { this.ws.disconnect(); this.ws = null; }
      await api.logout(true);
    }
  };
}

// Registro limpio en Alpine.js (sin contaminar el objeto window)
function registerAdminWithAlpine() {
  if (typeof window !== 'undefined' && window.Alpine) {
    window.Alpine.data('adminView', adminView);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('alpine:init', registerAdminWithAlpine);
  if (typeof window !== 'undefined' && window.Alpine) {
    registerAdminWithAlpine();
  }
}

