/**
 * ==============================================================================
 * ADMIN.JS — Controlador de Supervisión, Lotes, Mesas y Ajustes
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cumple con:
 * - RF-ADM-01 a RF-ADM-09: KPIs, Lotes, Mesas, Usuarios, Configuración y CSV
 * - RF-WS-02: Suscripción a canal 'admin:all' con actualización push en vivo
 * ==============================================================================
 */

import { api } from '../api.js';
import { TurneroWSClient } from '../ws-client.js';
import { formatTimer, showToast } from '../utils.js';

export function adminView() {
  return {
    // Pestaña activa: 'monitoreo' | 'lotes' | 'mesas' | 'configuracion'
    tab: 'monitoreo',

    // Estado de KPIs y métricas
    kpis: {
      atendidos_hoy: 0,
      cancelados_hoy: 0,
      en_atencion_ahora: 0,
      promedio_seg: null,
      mesas_activas: 0,
      mesas_pausadas: 0,
      vouchers_restantes: 0
    },

    // Datos maestros
    mesas: [],
    loteActivo: null,
    lotesHistorial: [],
    usuarios: [],

    // Formularios y controles
    extensionCantidad: 100,
    loadingAction: false,

    // Modales
    showNewLotModal: false,
    showNewUserModal: false,
    showEditUserModal: false,
    showNewMesaModal: false,

    nuevoLote: {
      cantidad: 500
    },

    nuevoUsuario: {
      username: '',
      nombre_completo: '',
      password: '',
      rol: 'operador'
    },

    usuarioAEditar: {
      id: null,
      username: '',
      nombre_completo: '',
      password: '',
      rol: 'operador'
    },

    nuevaMesa: {
      numero: '',
      nombre: ''
    },

    // Ajustes del sistema
    config: {
      kiosko_web_activo: false,
      voz_habilitada: true,
      alerta_vouchers_restantes: 20,
      tiempo_max_atencion_min: 5
    },

    // Conexión WebSocket
    ws: null,
    wsConnected: false,

    /**
     * Inicialización del controlador
     */
    async init() {
      // 1. Validar autenticación y rol
      const user = api.getUser();
      if (!user || (user.rol !== 'admin' && user.rol !== 'supervisor')) {
        console.warn('[ADMIN] Acceso no autorizado. Redirigiendo...');
        api.clearSession(true);
        return;
      }

      // 2. Carga inicial de datos
      await this.cargarTodo();

      // 3. Conectar a WebSocket en canal 'admin:all'
      this.initWebSocket();
    },

    /**
     * Carga todos los datos necesarios para las pestañas
     */
    async cargarTodo() {
      await Promise.all([
        this.cargarKPIs(),
        this.cargarMesas(),
        this.cargarLotes(),
        this.cargarUsuarios(),
        this.cargarConfiguracion()
      ]);
    },

    /**
     * Pestaña 1: Carga los KPIs de la jornada (GET /admin/kpis)
     */
    async cargarKPIs() {
      try {
        const data = await api.get('/admin/kpis');
        this.kpis = {
          atendidos_hoy: data.atendidos_hoy || 0,
          cancelados_hoy: data.cancelados_hoy || 0,
          en_atencion_ahora: data.en_atencion_ahora || 0,
          promedio_seg: data.promedio_seg,
          mesas_activas: data.mesas_activas || 0,
          mesas_pausadas: data.mesas_pausadas || 0,
          vouchers_restantes: data.lote ? data.lote.vouchers_restantes : 0
        };
        if (data.lote) {
          this.loteActivo = data.lote;
        }
      } catch (err) {
        console.error('[ADMIN] Error al cargar KPIs:', err);
      }
    },

    /**
     * Pestaña 1 y 3: Carga el listado de mesas (GET /mesas)
     */
    async cargarMesas() {
      try {
        const res = await api.get('/mesas');
        this.mesas = res.mesas || [];
      } catch (err) {
        console.error('[ADMIN] Error al cargar mesas:', err);
      }
    },

    /**
     * Pestaña 2: Carga los lotes de vouchers (GET /lotes y GET /lotes/activo)
     */
    async cargarLotes() {
      try {
        const [resLotes, resActivo] = await Promise.allSettled([
          api.get('/lotes'),
          api.get('/lotes/activo')
        ]);

        if (resLotes.status === 'fulfilled') {
          this.lotesHistorial = resLotes.value.lotes || [];
        }

        if (resActivo.status === 'fulfilled' && resActivo.value.lote) {
          this.loteActivo = resActivo.value.lote;
        } else {
          this.loteActivo = null;
        }
      } catch (err) {
        console.error('[ADMIN] Error al cargar lotes:', err);
      }
    },

    /**
     * Pestaña 4: Carga los usuarios del sistema (GET /admin/usuarios)
     */
    async cargarUsuarios() {
      try {
        const res = await api.get('/admin/usuarios');
        this.usuarios = res.usuarios || [];
      } catch (err) {
        console.error('[ADMIN] Error al cargar usuarios:', err);
      }
    },

    /**
     * Pestaña 2: Extensión de turnos en caliente con validación estricta > 0
     */
    async extenderLote() {
      if (!this.loteActivo) {
        showToast({ message: 'No hay un lote activo para extender', type: 'warning' });
        return;
      }

      // Validación estricta anti-negativos
      const cantidad = parseInt(this.extensionCantidad, 10);
      if (isNaN(cantidad) || cantidad <= 0) {
        showToast({ message: 'Ingrese una cantidad válida mayor a 0', type: 'danger' });
        return;
      }

      const nuevoLimite = this.loteActivo.numero_hasta + cantidad;
      this.loadingAction = true;

      try {
        const res = await api.patch(`/lotes/${this.loteActivo.id}/extender`, {
          nuevo_numero_hasta: nuevoLimite
        });

        this.loteActivo = res.lote;
        showToast({
          message: `Lote ${res.lote.numero_lote} extendido: +${cantidad} turnos habilitados`,
          type: 'success'
        });
        await this.cargarLotes();
        await this.cargarKPIs();
      } catch (err) {
        console.error('[ADMIN] Error extendiendo lote:', err);
        showToast({ message: err.message || 'Error al extender lote', type: 'danger' });
      } finally {
        this.loadingAction = false;
      }
    },

    /**
     * Pestaña 2: Pausar el lote activo al finalizar la jornada
     */
    async pausarLote() {
      if (!this.loteActivo) return;
      if (!confirm(`¿Pausar el Lote ${this.loteActivo.numero_lote}? Podrá continuar mañana desde el turno ${this.loteActivo.ultimo_numero_llamado + 1}.`)) {
        return;
      }

      try {
        await api.patch(`/lotes/${this.loteActivo.id}/pausar`);
        showToast({ message: 'Lote pausado correctamente', type: 'info' });
        await this.cargarLotes();
        await this.cargarKPIs();
      } catch (err) {
        showToast({ message: err.message, type: 'danger' });
      }
    },

    /**
     * Pestaña 2: Activar un lote en estado pausado o preparado
     */
    async activarLote(loteId) {
      try {
        await api.patch(`/lotes/${loteId}/activar`);
        showToast({ message: 'Lote activado con éxito', type: 'success' });
        await this.cargarLotes();
        await this.cargarKPIs();
      } catch (err) {
        showToast({ message: err.message, type: 'danger' });
      }
    },

    /**
     * Pestaña 2: Cierre definitivo de un lote
     */
    async cerrarLote() {
      if (!this.loteActivo) return;
      if (!confirm(`¿Cerrar definitivamente el Lote ${this.loteActivo.numero_lote}? Esta acción es irreversible.`)) {
        return;
      }

      try {
        await api.patch(`/lotes/${this.loteActivo.id}/cerrar`);
        showToast({ message: 'Lote cerrado definitivamente', type: 'info' });
        this.loteActivo = null;
        await this.cargarLotes();
        await this.cargarKPIs();
      } catch (err) {
        showToast({ message: err.message, type: 'danger' });
      }
    },

    /**
     * Pestaña 2: Crear un nuevo lote correlativo
     */
    async crearNuevoLote() {
      const cantidad = parseInt(this.nuevoLote.cantidad, 10);
      if (isNaN(cantidad) || cantidad <= 0) {
        showToast({ message: 'El total de vouchers debe ser mayor a 0', type: 'warning' });
        return;
      }

      try {
        const res = await api.post('/lotes', {
          numero_desde: 1,
          numero_hasta: cantidad
        });
        showToast({ message: `Lote ${res.lote.numero_lote} creado con éxito (1 al ${cantidad})`, type: 'success' });
        this.showNewLotModal = false;
        this.nuevoLote.cantidad = 500;
        await this.cargarLotes();
      } catch (err) {
        showToast({ message: err.message, type: 'danger' });
      }
    },

    /**
     * Pestaña 3: Asignar operador a mesa en caliente
     */
    async asignarOperadorAMesa(mesaId, event) {
      const selectVal = event.target.value;
      const operadorId = selectVal ? parseInt(selectVal, 10) : null;

      try {
        await api.patch(`/mesas/${mesaId}/asignar`, {
          operador_id: operadorId
        });
        showToast({ message: 'Asignación de mesa actualizada', type: 'success' });
        await this.cargarMesas();
      } catch (err) {
        console.error('[ADMIN] Error asignando operador:', err);
        showToast({ message: err.message || 'Conflicto de asignación', type: 'danger' });
        await this.cargarMesas(); // Revertir select
      }
    },

    /**
     * Pestaña 3: Alternar estado de mesa (Pausar / Activar)
     */
    async toggleEstadoMesa(mesa) {
      const nuevoEstado = mesa.estado === 'activa' ? 'pausada' : 'activa';
      try {
        await api.patch(`/mesas/${mesa.id}/estado`, {
          estado: nuevoEstado
        });
        showToast({ message: `Mesa ${mesa.numero} marcada como ${nuevoEstado}`, type: 'info' });
        await this.cargarMesas();
        await this.cargarKPIs();
      } catch (err) {
        showToast({ message: err.message, type: 'danger' });
      }
    },

    /**
     * Pestaña 3: Crear nueva mesa de trabajo
     */
    async crearMesa() {
      const num = parseInt(this.nuevaMesa.numero, 10);
      const nom = this.nuevaMesa.nombre.trim();

      if (!num || !nom) {
        showToast({ message: 'Complete número y nombre de mesa', type: 'warning' });
        return;
      }

      try {
        await api.post('/mesas', {
          numero: num,
          nombre: nom
        });
        showToast({ message: `Mesa ${num} creada correctamente`, type: 'success' });
        this.nuevaMesa = { numero: '', nombre: '' };
        this.showNewMesaModal = false;
        await this.cargarMesas();
      } catch (err) {
        showToast({ message: err.message, type: 'danger' });
      }
    },

    /**
     * Pestaña 4: Crear nuevo usuario
     */
    async crearUsuario() {
      const { username, nombre_completo, password, rol } = this.nuevoUsuario;
      if (!username.trim() || !nombre_completo.trim() || !password) {
        showToast({ message: 'Complete todos los campos obligatorios', type: 'warning' });
        return;
      }

      try {
        await api.post('/admin/usuarios', {
          username: username.trim(),
          nombre_completo: nombre_completo.trim(),
          password,
          rol
        });
        showToast({ message: 'Usuario creado con éxito', type: 'success' });
        this.nuevoUsuario = { username: '', nombre_completo: '', password: '', rol: 'operador' };
        this.showNewUserModal = false;
        await this.cargarUsuarios();
      } catch (err) {
        showToast({ message: err.message, type: 'danger' });
      }
    },

    /**
     * Pestaña 4: Alternar estado activo de usuario
     */
    async toggleUsuarioActivo(u) {
      try {
        await api.patch(`/admin/usuarios/${u.id}`, {
          activo: !u.activo
        });
        u.activo = !u.activo;
        showToast({ message: `Usuario ${u.username} ${u.activo ? 'activado' : 'desactivado'}`, type: 'info' });
      } catch (err) {
        showToast({ message: err.message, type: 'danger' });
      }
    },

    /**
     * Pestaña 4: Abrir modal de edición de usuario
     */
    abrirEditarUsuario(u) {
      this.usuarioAEditar = {
        id: u.id,
        username: u.username,
        nombre_completo: u.nombre_completo,
        password: '',
        rol: u.rol
      };
      this.showEditUserModal = true;
    },

    /**
     * Pestaña 4: Guardar cambios de usuario
     */
    async guardarEdicionUsuario() {
      if (!this.usuarioAEditar.id) return;
      const { id, nombre_completo, rol, password } = this.usuarioAEditar;
      if (!nombre_completo.trim()) {
        showToast({ message: 'El nombre no puede estar vacío', type: 'warning' });
        return;
      }

      const payload = {
        nombre_completo: nombre_completo.trim(),
        rol
      };
      if (password && password.trim()) {
        if (password.length < 8) {
          showToast({ message: 'La nueva contraseña debe tener al menos 8 caracteres', type: 'warning' });
          return;
        }
        payload.password = password;
      }

      try {
        await api.patch(`/admin/usuarios/${id}`, payload);
        showToast({ message: 'Usuario actualizado correctamente', type: 'success' });
        this.showEditUserModal = false;
        await this.cargarUsuarios();
      } catch (err) {
        showToast({ message: err.message || 'Error al editar usuario', type: 'danger' });
      }
    },

    /**
     * Pestaña 4: Carga los parámetros del sistema (GET /admin/configuracion)
     */
    async cargarConfiguracion() {
      try {
        const res = await api.get('/admin/configuracion');
        if (res && res.configuracion) {
          this.config.kiosko_web_activo = res.configuracion.kiosko_web_activo === 'true';
          this.config.alerta_vouchers_restantes = parseInt(res.configuracion.alerta_vouchers_restantes || '20', 10);
          this.config.tiempo_max_atencion_min = parseInt(res.configuracion.tiempo_max_atencion_min || '5', 10);
        }
        const vozGuardada = localStorage.getItem('turnero_voz_habilitada');
        this.config.voz_habilitada = vozGuardada !== null ? vozGuardada === 'true' : true;
      } catch (err) {
        console.warn('[ADMIN] Error al cargar configuración:', err);
      }
    },

    /**
     * Pestaña 4: Actualizar un switch o parámetro de configuración
     */
    async actualizarConfig(clave, valor) {
      if (clave === 'voz_habilitada') {
        this.config.voz_habilitada = valor;
        localStorage.setItem('turnero_voz_habilitada', String(valor));
        showToast({ message: `Voz de llamados ${valor ? 'activada' : 'desactivada'}`, type: 'info' });
        return;
      }

      try {
        await api.patch(`/admin/configuracion/${clave}`, { valor: String(valor) });
        this.config[clave] = (valor === 'true' || valor === true) ? true : (valor === 'false' || valor === false ? false : valor);
        showToast({ message: 'Parámetro actualizado en el servidor', type: 'success' });
      } catch (err) {
        showToast({ message: err.message || 'Error al actualizar parámetro', type: 'danger' });
      }
    },

    /**
     * Pestaña 4: Descarga del reporte CSV diario
     */
    descargarCSV() {
      const fecha = new Date().toISOString().slice(0, 10);
      window.location.href = `/admin/reporte/csv?fecha=${fecha}`;
    },

    /**
     * Helper para formatear segundos en mm:ss
     */
    formatearTiempo(seg) {
      if (!seg && seg !== 0) return '--:--';
      return formatTimer(seg);
    },

    /**
     * WebSocket: Inicialización de canal 'admin:all'
     */
    initWebSocket() {
      const token = api.getToken();
      if (!token) return;

      this.ws = new TurneroWSClient({
        token,
        canal: 'admin:all'
      });

      this.ws.onStatusChange(({ status }) => {
        this.wsConnected = status === 'CONECTADO';
      });

      // Escuchar eventos en vivo del sistema
      this.ws.on('turno_llamado', () => {
        this.cargarKPIs();
        this.cargarMesas();
      });

      this.ws.on('mesa_actualizada', () => {
        this.cargarKPIs();
        this.cargarMesas();
      });

      this.ws.on('lote_extendido', () => {
        this.cargarLotes();
        this.cargarKPIs();
      });

      this.ws.on('lote_pausado', () => {
        this.cargarLotes();
        this.cargarKPIs();
      });

      this.ws.on('lote_activado', () => {
        this.cargarLotes();
        this.cargarKPIs();
      });

      this.ws.on('lote_cerrado', () => {
        this.cargarLotes();
        this.cargarKPIs();
      });

      this.ws.on('config_actualizada', () => {
        this.cargarConfiguracion();
      });

      this.ws.on('lote_agotado', () => {
        showToast({ message: 'ALERTA: El lote activo se ha agotado', type: 'warning', duration: 7000 });
        this.cargarKPIs();
      });

      this.ws.connect();
    },

    /**
     * Cierre de sesión del administrador
     */
    async logout() {
      try {
        if (this.ws) this.ws.disconnect();
        await api.post('/auth/logout');
      } catch {}
      api.clearSession(true);
    }
  };
}

// Registro seguro para Alpine.js
function registerAdminWithAlpine() {
  if (window.Alpine) {
    window.Alpine.data('adminView', adminView);
  }
}

if (window.Alpine) {
  registerAdminWithAlpine();
} else {
  document.addEventListener('alpine:init', registerAdminWithAlpine);
}

if (typeof window !== 'undefined') {
  window.adminView = adminView;
}
