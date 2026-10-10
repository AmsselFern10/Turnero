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
import { formatTimer, showToast } from '../utils.js';

export function adminView() {
  return {
    tab: 'monitoreo',
    relojHora: '--:--:--',
    _clockTimer: null,

    kpis: {
      atendidos_hoy:       0,
      espera_promedio_min: '--',
      mesas_activas:       0,
      vouchers_restantes:  0
    },

    mesas:                [],
    lotes:                [],
    loteActivo:           null,
    usuarios:             [],
    operadoresDisponibles:[],

    extensionVouchers: 50,
    extensionCantidad: 50,
    modalLote:         false,
    modalExtender:     false,
    modalMesa:         false,
    modalUsuario:      false,
    nuevoLoteHasta:    500,

    nuevaMesa: {
      numero: 1,
      nombre: ''
    },

    nuevoUsuario: {
      nombre_completo: '',
      username:        '',
      password:        '',
      rol:             'operador'
    },

    config: {
      tiempo_max_atencion_min:   5,
      alerta_vouchers_restantes: 20,
      kiosko_web_activo:         false
    },
    _configSnapshot: null,

    ws:          null,
    wsConnected: false,
    loteAgotadoAlerta: false,
    _loading: false,

    // =========================================================================
    // CICLO DE VIDA
    // =========================================================================

    async init() {
      try {
        const { usuario } = await api.get('/auth/me');
        if (!usuario || (usuario.rol !== 'admin' && usuario.rol !== 'supervisor')) {
          api.clearSession(true);
          return;
        }
      } catch (_) {
        api.clearSession(true);
        return;
      }

      this._tickClock();
      this._clockTimer = setInterval(() => this._tickClock(), 1000);
      await this.cargarTodo();
      this._actualizarAlertaLote();
      this.initWebSocket();
    },

    destroy() {
      if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; }
      if (this.ws) { this.ws.disconnect(); this.ws = null; }
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
      await Promise.allSettled([this.cargarKPIs(), this.cargarMesas()]);
    },

    async cargarKPIs() {
      const data = await api.get('/admin/kpis');
      this.kpis = {
        atendidos_hoy:       data.atendidos_hoy || 0,
        espera_promedio_min: data.promedio_seg != null ? (data.promedio_seg / 60).toFixed(1) : '--',
        mesas_activas:       data.mesas_activas || 0,
        vouchers_restantes:  data.lote ? (data.lote.numero_hasta - data.lote.ultimo_numero_llamado) : 0
      };
      if (data.lote) this.loteActivo = data.lote;
    },

    async cargarMesas() {
      const res = await api.get('/mesas');
      this.mesas = res.mesas || [];
    },

    async cargarLotes() {
      const [rL, rA] = await Promise.allSettled([api.get('/lotes'), api.get('/lotes/activo')]);
      if (rL.status === 'fulfilled') this.lotes = rL.value.lotes || [];
      this.loteActivo = (rA.status === 'fulfilled' && rA.value.lote) ? rA.value.lote : null;
    },

    async cargarUsuarios() {
      const res = await api.get('/admin/usuarios');
      this.usuarios = res.usuarios || [];
      this.operadoresDisponibles = this.usuarios.filter(u => u.rol === 'operador' && u.activo);
    },

    async cargarConfiguracion() {
      const res = await api.get('/admin/configuracion');
      if (res && res.configuracion) {
        const c = res.configuracion;
        this.config.tiempo_max_atencion_min   = parseInt(c.tiempo_max_atencion_min   || '5',  10) || 0;
        this.config.alerta_vouchers_restantes = parseInt(c.alerta_vouchers_restantes || '20', 10) || 20;
        this.config.kiosko_web_activo         = c.kiosko_web_activo === 'true' || c.kiosko_web_activo === true;
      }
      this._configSnapshot = { ...this.config };
    },

    // =========================================================================
    // LOTES
    // =========================================================================

    async crearLoteSubmit() {
      const hasta = parseInt(this.nuevoLoteHasta, 10);
      if (!hasta || hasta < 1) { showToast({ message: 'Ingrese un numero valido (min. 1)', type: 'warning' }); return; }
      if (this._loading) return;
      this._loading = true;
      try {
        const res = await api.post('/lotes', { numero_desde: 1, numero_hasta: hasta });
        showToast({ message: `Lote ${res.lote.numero_lote} creado (1 al ${hasta})`, type: 'success' });
        this.modalLote = false;
        this.nuevoLoteHasta = 500;
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        showToast({ message: err.mensaje || 'No se pudo crear el lote', type: 'danger' });
      } finally { this._loading = false; }
    },

    async activarLote(loteId) {
      if (this._loading) return;
      this._loading = true;
      try {
        await api.patch(`/lotes/${loteId}/activar`);
        showToast({ message: 'Lote activado', type: 'success' });
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        showToast({ message: err.status === 409 ? 'El lote cambio. Vista actualizada.' : (err.mensaje || 'Error'), type: err.status === 409 ? 'warning' : 'danger' });
        await this.cargarLotes();
      } finally { this._loading = false; }
    },

    calcularProgresoLote() {
      if (!this.loteActivo) return 0;
      const total = (this.loteActivo.numero_hasta - this.loteActivo.numero_desde + 1);
      const llamados = (this.loteActivo.ultimo_numero_llamado - this.loteActivo.numero_desde + 1);
      if (total <= 0) return 0;
      return Math.min(100, Math.max(0, Math.round((llamados / total) * 100)));
    },

    calcularVouchersEmitidos() {
      if (!this.loteActivo) return 0;
      return Math.max(0, this.loteActivo.ultimo_numero_llamado - this.loteActivo.numero_desde + 1);
    },

    calcularVouchersRestantesLote() {
      if (!this.loteActivo) return 0;
      return Math.max(0, this.loteActivo.numero_hasta - this.loteActivo.ultimo_numero_llamado);
    },

    abrirModalExtender() {
      if (!this.loteActivo) {
        showToast({ message: 'No hay un lote activo para extender', type: 'warning' });
        return;
      }
      this.extensionCantidad = 50;
      this.modalExtender = true;
    },

    async extenderLoteSubmit() {
      if (!this.loteActivo) return;
      const cantidad = parseInt(this.extensionCantidad, 10);
      if (!cantidad || cantidad <= 0) {
        showToast({ message: 'Cantidad a adicionar inválida', type: 'warning' });
        return;
      }
      if (this._loading) return;
      this._loading = true;
      const nuevoHasta = this.loteActivo.numero_hasta + cantidad;
      try {
        const res = await api.patch(`/lotes/${this.loteActivo.id}/extender`, { nuevo_numero_hasta: nuevoHasta });
        this.loteActivo = res.lote;
        this.loteAgotadoAlerta = false;
        this.modalExtender = false;
        showToast({ message: `Lote extendido +${cantidad} vouchers (Nuevo límite: #${nuevoHasta})`, type: 'success' });
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        showToast({ message: err.status === 409 ? 'El lote cambió. Vista actualizada.' : (err.mensaje || 'Error al extender lote'), type: err.status === 409 ? 'warning' : 'danger' });
        await this.cargarLotes();
      } finally { this._loading = false; }
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

    async cerrarLote(loteId) {
      if (!this.loteActivo) return;
      if (this._loading) return;
      this._loading = true;
      try {
        await api.patch(`/lotes/${loteId}/cerrar`);
        showToast({ message: 'Lote cerrado definitivamente.', type: 'info' });
        this.loteActivo = null;
        this.loteAgotadoAlerta = false;
        await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]);
      } catch (err) {
        showToast({ message: err.status === 409 ? 'El lote cambió. Vista actualizada.' : (err.mensaje || 'Error'), type: err.status === 409 ? 'warning' : 'danger' });
        await this.cargarLotes();
      } finally { this._loading = false; }
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
        showToast({ message: 'Mesa activada', type: 'success' });
        await Promise.allSettled([this.cargarMesas(), this.cargarKPIs()]);
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al activar mesa', type: 'danger' });
        await this.cargarMesas();
      } finally { this._loading = false; }
    },

    async pausarMesaAdmin(mesaId) {
      if (this._loading) return;
      this._loading = true;
      try {
        await api.patch(`/mesas/${mesaId}/estado`, { estado: 'pausada' });
        showToast({ message: 'Mesa pausada', type: 'info' });
        await Promise.allSettled([this.cargarMesas(), this.cargarKPIs()]);
      } catch (err) {
        if (err.codigo === 'mesa_con_turno_activo') {
          showToast({ message: 'Mesa con turno activo. Finalicelo antes de pausar.', type: 'warning' });
        } else {
          showToast({ message: err.mensaje || 'Error al pausar mesa', type: 'danger' });
        }
        await this.cargarMesas();
      } finally { this._loading = false; }
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
      const num = parseInt(this.nuevaMesa.numero, 10);
      if (!num || num < 1) {
        showToast({ message: 'Número de mesa inválido (debe ser mayor a 0)', type: 'warning' });
        return;
      }
      const nombre = (this.nuevaMesa.nombre || '').trim() || `Mesa ${num}`;
      try {
        await api.post('/mesas', { numero: num, nombre });
        showToast({ message: `Mesa ${num} creada exitosamente`, type: 'success' });
        this.modalMesa = false;
        await this.cargarMesas();
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al crear mesa', type: 'danger' });
      }
    },

    crearMesa() {
      this.abrirModalMesa();
    },

    // =========================================================================
    // USUARIOS
    // =========================================================================

    async crearUsuarioSubmit() {
      const { nombre_completo, username, password, rol } = this.nuevoUsuario;
      if (!nombre_completo.trim() || !username.trim() || !password) {
        showToast({ message: 'Complete todos los campos', type: 'warning' }); return;
      }
      if (password.length < 8) {
        showToast({ message: 'Contrasena de al menos 8 caracteres', type: 'warning' }); return;
      }
      if (this._loading) return;
      this._loading = true;
      try {
        await api.post('/admin/usuarios', {
          nombre_completo: nombre_completo.trim(), username: username.trim(), password, rol
        });
        showToast({ message: `Usuario "${username}" creado`, type: 'success' });
        this.nuevoUsuario = { nombre_completo: '', username: '', password: '', rol: 'operador' };
        this.modalUsuario = false;
        await this.cargarUsuarios();
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al crear usuario', type: 'danger' });
      } finally { this._loading = false; }
    },

    // =========================================================================
    // CONFIGURACION (INC-4)
    // =========================================================================

    async guardarConfiguracion() {
      const tiempo = this.config.tiempo_max_atencion_min;
      const alerta = this.config.alerta_vouchers_restantes;

      if (tiempo !== 0 && (!Number.isInteger(tiempo) || tiempo < 0 || tiempo > 240)) {
        showToast({ message: 'Tiempo de referencia: 0 (sin umbral) o entero 1-240', type: 'warning' }); return;
      }
      if (!Number.isInteger(alerta) || alerta < 1) {
        showToast({ message: 'Alerta de vouchers debe ser entero >= 1', type: 'warning' }); return;
      }
      if (this._loading) return;
      this._loading = true;
      try {
        await Promise.all([
          api.patch('/admin/configuracion/tiempo_max_atencion_min',   { valor: String(tiempo) }),
          api.patch('/admin/configuracion/alerta_vouchers_restantes', { valor: String(alerta) }),
          api.patch('/admin/configuracion/kiosko_web_activo',         { valor: String(this.config.kiosko_web_activo) })
        ]);
        this._configSnapshot = { ...this.config };
        showToast({ message: 'Ajustes guardados', type: 'success' });
      } catch (err) {
        if (this._configSnapshot) this.config = { ...this._configSnapshot };
        showToast({ message: err.mensaje || 'Error al guardar. Valores revertidos.', type: 'danger' });
      } finally { this._loading = false; }
    },

    // =========================================================================
    // EXPORTAR CSV
    // =========================================================================

    async exportarCSV() {
      if (this._loading) return;
      this._loading = true;
      try {
        const fecha = new Date().toISOString().slice(0, 10);
        const blob  = await api.getBlob(`/admin/reporte/csv?fecha=${fecha}`);
        const url   = URL.createObjectURL(blob);
        const a     = document.createElement('a');
        a.href = url; a.download = `turnero_reporte_${fecha}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast({ message: `Reporte ${fecha} descargado`, type: 'success' });
      } catch (err) {
        showToast({ message: err.mensaje || 'Error al generar CSV', type: 'danger' });
      } finally { this._loading = false; }
    },

    // =========================================================================
    // SEMAFORO (INC-4)
    // =========================================================================

    /** Verde <= umbral; Ambar <= 1.5x; Rojo > 1.5x. 0 = sin umbral (gris). */
    semaforoClass(tiempoMin) {
      const u = this.config.tiempo_max_atencion_min || 0;
      if (!u || !tiempoMin) return 'bg-slate-300';
      if (tiempoMin <= u)       return 'bg-emerald-500';
      if (tiempoMin <= u * 1.5) return 'bg-amber-500';
      return 'bg-rose-500';
    },

    _actualizarAlertaLote() {
      if (!this.loteActivo) { this.loteAgotadoAlerta = false; return; }
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

      let _kpiPending = false;
      const recargarKPIs = async () => {
        if (_kpiPending) return;
        _kpiPending = true;
        await Promise.allSettled([this.cargarKPIs(), this.cargarMesas()]);
        _kpiPending = false;
      };

      this.ws.on('kpi_update',       recargarKPIs);
      this.ws.on('turno_llamado',    recargarKPIs);
      this.ws.on('mesa_actualizada', recargarKPIs);

      this.ws.on('lote_agotado', async () => {
        this.loteAgotadoAlerta = true;
        showToast({ message: 'Lote agotado. Extiendalo o cree uno nuevo.', type: 'danger', duration: 0 });
        await this.cargarKPIs();
      });

      this.ws.on('alerta_vouchers_restantes', (p) => {
        showToast({ message: `ALERTA: Quedan solo ${p?.vouchers_restantes ?? '?'} vouchers`, type: 'warning', duration: 7000 });
      });

      const recargarLotes = async () => { await Promise.allSettled([this.cargarLotes(), this.cargarKPIs()]); };
      this.ws.on('lote_extendido', async () => { this.loteAgotadoAlerta = false; await recargarLotes(); });
      this.ws.on('lote_pausado',   recargarLotes);
      this.ws.on('lote_activado',  recargarLotes);
      this.ws.on('lote_cerrado',   async () => { this.loteAgotadoAlerta = false; await recargarLotes(); });
      this.ws.on('config_actualizada', () => this.cargarConfiguracion());

      this.ws.connect();
    },

    // =========================================================================
    // SESION
    // =========================================================================

    async logout() {
      if (this.ws) { this.ws.disconnect(); this.ws = null; }
      await api.logout(true);
    }
  };
}

// Registro seguro para Alpine.js
function registerAdminWithAlpine() {
  if (window.Alpine) window.Alpine.data('adminView', adminView);
}

if (window.Alpine) {
  registerAdminWithAlpine();
} else {
  document.addEventListener('alpine:init', registerAdminWithAlpine);
}
