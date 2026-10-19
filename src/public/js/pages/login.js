/**
 * ==============================================================================
 * LOGIN.JS — Controlador de Acceso y Selección Dinámica de Mesas
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Flujo:
 *   - Caso A: rol 'admin' -> step 'admin_choice' (ir a admin o ventanilla)
 *   - Caso B: Usuario con mesa_asignada -> modal 'mesa_asignada'
 *   - Caso C: Sin mesa -> step 'mesas_grid' + WS tv:global en vivo
 *
 * Tiempo real en mesas_grid:
 *   - 'mesas_disponibles_actualizadas': actualiza la grilla al instante.
 *   - 'operador_asignado_por_admin': si coincide el userId, redirige automáticamente.
 *   - 'config_actualizada': sincroniza visibilidad y modo de kiosko web.
 *
 * Roles permitidos para operar mesa: operador, admin.
 * ==============================================================================
 */

import { api } from '../api.js';
import { showToast, initFondoPersonalizado } from '../utils.js';
import { TurneroWSClient } from '../ws-client.js';

export function loginView() {
  return {
    step: 'login',
    username: '',
    password: '',
    showPassword: false,
    loading: false,
    loadingMesas: false,
    seleccionando: false,
    errorMessage: '',
    redirectText: '',
    currentUser: null,
    mesas: [],
    mesaPreAsignada: null,
    kioskoActivo: false,
    kioskoModoUso: 'asistido',
    _ws: null,

    get kioskoHref() {
      return (this.kioskoModoUso === 'asistido' || this.kioskoModoUso === 'empleado') ? '/kiosko.html?modo=tablet' : '/kiosko.html';
    },

    get kioskoLabelHeader() {
      return (this.kioskoModoUso === 'asistido' || this.kioskoModoUso === 'empleado') ? 'Modalidad Asistida' : 'Kiosko Estudiante';
    },

    get kioskoLabelCard() {
      return (this.kioskoModoUso === 'asistido' || this.kioskoModoUso === 'empleado')
        ? 'Ir a Modalidad Asistida (Emisión por Operador)'
        : 'Ir a Kiosko Estudiantil (Autoservicio)';
    },

    get noHayMesasDisponibles() {
      return !this.loadingMesas && this.mesas.length === 0 && !this.errorMessage;
    },

    formatearNombreMesa(mesa) {
      if (!mesa?.nombre) return 'Sitio de atención';
      return mesa.nombre.replace(/^Mesa \d+ — /, '');
    },

    async init() {
      this.verificarKioskoActivo();
      this._conectarWSMesas();
      initFondoPersonalizado(this._ws);

      const existingToken = api.getToken();
      if (!existingToken) return;
      try {
        const { usuario } = await api.get('/auth/me');
        this.currentUser = usuario;
        api.setSession(existingToken, usuario);
        this._decidirPasoPostLogin(usuario);
      } catch (_) {
        api.clearSession(false);
      }
    },

    async verificarKioskoActivo() {
      try {
        const res = await api.get('/kiosko/estado');
        if (res && typeof res.activo === 'boolean') {
          this.kioskoActivo = res.activo;
          this.kioskoModoUso = res.modo_uso || 'asistido';
        }
      } catch (_) {
        this.kioskoActivo = false;
        this.kioskoModoUso = 'asistido';
      }
    },

    destroy() {
      this._cerrarWS();
    },

    _decidirPasoPostLogin(usuario) {
      const urlParams = new URLSearchParams(window.location.search);
      const forzarSeleccion = urlParams.get('seleccionar_mesa') === '1' || urlParams.get('seleccionar_mesa') === 'true';

      if (forzarSeleccion) {
        this.step = 'mesas_grid';
        this.cargarMesas();
        this._conectarWSMesas();
        return;
      }

      // Admin con mesa asignada: mostrar aviso con opciones (Mesa o Panel Admin)
      if (usuario.mesa_asignada) {
        this.mesaPreAsignada = usuario.mesa_asignada;
        this.step = 'mesa_asignada';
        return;
      }
      // Admin sin mesa: pantalla de elección estándar
      if (usuario.rol === 'admin') {
        this.step = 'admin_choice';
        return;
      }
      // Operador sin mesa: ir a la grilla
      this.step = 'mesas_grid';
      this.cargarMesas();
      this._conectarWSMesas();
    },

    _conectarWSMesas() {
      if (this._ws) return;

      this._ws = new TurneroWSClient({ canal: 'tv:global' });

      this._ws.on('mesas_disponibles_actualizadas', (payload) => {
        this._actualizarMesaEnGrid(payload);
      });

      this._ws.on('operador_asignado_por_admin', (payload) => {
        if (this.currentUser && Number(payload.operador_id) === Number(this.currentUser.id)) {
          this._redirigirConMesaAsignada(payload.mesa);
        }
      });

      this._ws.on('config_actualizada', (payload) => {
        if (payload?.clave === 'kiosko_web_activo') {
          this.kioskoActivo = payload.valor === 'true';
        }
        if (payload?.clave === 'kiosko_modo_uso') {
          this.kioskoModoUso = payload.valor || 'empleado';
        }
      });

      this._ws.connect();
    },

    _cerrarWS() {
      if (this._ws) {
        this._ws.disconnect();
        this._ws = null;
      }
    },

    _actualizarMesaEnGrid({ mesa, accion } = {}) {
      if (!mesa) return;
      if (accion === 'tomada') {
        this.mesas = this.mesas.filter(m => m.id !== mesa.id);
      } else if (accion === 'liberada' && mesa.estado === 'activa') {
        if (!this.mesas.some(m => m.id === mesa.id)) {
          this.mesas = [...this.mesas, mesa].sort((a, b) => a.numero - b.numero);
        }
      }
    },

    _redirigirConMesaAsignada(mesa) {
      this._cerrarWS();
      api.setSession(null, { ...this.currentUser, mesa_asignada: mesa });
      sessionStorage.setItem('turnero_mesa', JSON.stringify(mesa));
      this.step = 'redirecting';
      this.redirectText = `El administrador te asignó la Mesa ${mesa.numero} — Iniciando consola...`;
      showToast({ message: `Mesa ${mesa.numero} asignada por el administrador`, type: 'success', duration: 3000 });
      setTimeout(() => { window.location.href = '/panel_mesa.html'; }, 1200);
    },

    async handleLogin() {
      this.errorMessage = '';
      const usr = this.username.trim();
      if (!usr || !this.password) {
        this.errorMessage = 'Complete todos los campos para continuar.';
        return;
      }
      if (this.loading) return;
      this.loading = true;
      try {
        const data = await api.post('/auth/login', { username: usr, password: this.password });
        const { token, usuario } = data;
        this.currentUser = usuario;
        api.setSession(token, usuario);
        this._decidirPasoPostLogin(usuario);
      } catch (err) {
        const codigo = err.codigo || 'error_interno';
        if (codigo === 'credenciales_invalidas' || err.status === 401 || err.message?.includes('Credenciales')) {
          this.errorMessage = 'Usuario o contraseña incorrectos.';
        } else if (codigo === 'servidor_ocupado' || err.status === 429 || err.status === 503) {
          this.errorMessage = err.mensaje || 'Demasiados intentos. Intente en unos minutos.';
        } else if (!navigator.onLine || err.name === 'TypeError') {
          this.errorMessage = 'Sin conexión con el servidor. Verifique su red.';
        } else {
          this.errorMessage = err.mensaje || 'No se pudo iniciar sesión. Intente de nuevo.';
        }
      } finally {
        this.loading = false;
      }
    },

    async cargarMesas() {
      if (this.loadingMesas) return;
      this.loadingMesas = true;
      this.errorMessage = '';
      try {
        const res = await api.get('/auth/mesas/disponibles');
        this.mesas = res.mesas || [];
      } catch (err) {
        this.errorMessage = (!navigator.onLine || err.name === 'TypeError')
          ? 'Sin conexión con el servidor. Verifique su red.'
          : 'No se pudo cargar la lista de mesas. Intente nuevamente.';
      } finally {
        this.loadingMesas = false;
      }
    },

    async seleccionarMesa(mesa) {
      if (this.seleccionando) return;
      this.seleccionando = true;
      this.errorMessage = '';
      try {
        const res = await api.post('/auth/seleccionar-mesa', { mesa_id: mesa.id });
        const mesaAsignada = res.mesa;
        this._cerrarWS();
        api.setSession(null, { ...this.currentUser, mesa_asignada: mesaAsignada });
        sessionStorage.setItem('turnero_mesa', JSON.stringify(mesaAsignada));
        this.step = 'redirecting';
        this.redirectText = `Mesa ${mesaAsignada.numero} asignada — Iniciando consola...`;
        setTimeout(() => { window.location.href = '/panel_mesa.html'; }, 450);
      } catch (err) {
        const codigo = err.codigo || (err.data?.error?.codigo) || 'error_interno';
        if (codigo === 'mesa_ocupada') {
          showToast({ message: 'Esta mesa acaba de ser tomada por otro operador.', type: 'warning', duration: 4000 });
          await this.cargarMesas();
        } else if (codigo === 'mesa_inactiva') {
          showToast({ message: 'Esta mesa ya no está activa.', type: 'warning', duration: 4000 });
          await this.cargarMesas();
        } else if (codigo === 'mesa_no_encontrada') {
          showToast({ message: 'La mesa ya no existe.', type: 'warning', duration: 4000 });
          await this.cargarMesas();
        } else if (codigo === 'operador_ya_asignado') {
          this.mesaPreAsignada = err.data?.error?.mesa_actual || null;
          this._cerrarWS();
          this.step = 'mesa_asignada';
        } else if (!navigator.onLine || err.name === 'TypeError') {
          this.errorMessage = 'Sin conexión con el servidor. Verifique su red.';
        } else {
          this.errorMessage = err.mensaje || 'No se pudo tomar la mesa. Intente de nuevo.';
        }
      } finally {
        this.seleccionando = false;
      }
    },

    continuarMesaAsignada() {
      if (!this.mesaPreAsignada) {
        this.step = 'mesas_grid';
        this.cargarMesas();
        this._conectarWSMesas();
        return;
      }
      sessionStorage.setItem('turnero_mesa', JSON.stringify(this.mesaPreAsignada));
      this.step = 'redirecting';
      this.redirectText = `Continuando en Mesa ${this.mesaPreAsignada.numero}...`;
      setTimeout(() => { window.location.href = '/panel_mesa.html'; }, 350);
    },

    irAdmin() {
      window.location.href = '/admin.html';
    },

    async irOperarMesa() {
      if (this.mesaPreAsignada || this.currentUser?.mesa_asignada) {
        this.mesaPreAsignada = this.mesaPreAsignada || this.currentUser?.mesa_asignada;
        this.step = 'mesa_asignada';
        return;
      }
      try {
        const res = await api.get('/auth/me');
        if (res?.usuario?.mesa_asignada) {
          this.currentUser = res.usuario;
          this.mesaPreAsignada = res.usuario.mesa_asignada;
          this.step = 'mesa_asignada';
          return;
        }
      } catch (_) {}

      this.step = 'mesas_grid';
      await this.cargarMesas();
      this._conectarWSMesas();
    },

    volverAdminChoice() {
      this._cerrarWS();
      this.step = 'admin_choice';
    },

    async volverLogin() {
      this.loading = true;
      this._cerrarWS();
      try {
        await api.logout(false);
      } catch (_) {
        api.clearSession(false);
      } finally {
        this.loading = false;
        this.step = 'login';
        this.password = '';
        this.errorMessage = '';
        this.currentUser = null;
        this.mesaPreAsignada = null;
      }
    }
  };
}

function registerWithAlpine() {
  if (typeof window !== 'undefined' && window.Alpine) {
    window.Alpine.data('loginView', loginView);
  }
}

if (typeof window !== 'undefined' && window.Alpine) {
  registerWithAlpine();
} else if (typeof document !== 'undefined') {
  document.addEventListener('alpine:init', registerWithAlpine);
}
