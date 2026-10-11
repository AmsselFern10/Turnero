/**
 * ==============================================================================
 * LOGIN.JS — Controlador de Acceso y Seleccion Dinamica de Mesas
 * Sistema Turnero de Matriculas 2026 (v2.1)
 *
 * Flujo:
 *   - Caso A: rol 'admin'/'admin' -> step 'admin_choice' (ir a admin o ventanilla)
 *   - Caso B: Usuario con mesa_asignada -> modal 'mesa_asignada' (INC-3)
 *   - Caso C: Sin mesa -> step 'mesas_grid' + WS tv:global en vivo
 *
 * Tiempo real en mesas_grid:
 *   - 'mesas_disponibles_actualizadas': actualiza la grilla al instante.
 *   - 'operador_asignado_por_admin': si coincide el userId, redirige automaticamente.
 *
 * Roles permitidos para operar mesa: operador, admin.
 * ==============================================================================
 */

import { api } from '../api.js';
import { showToast } from '../utils.js';

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
    _ws: null,
    _wsReconnectTimer: null,
    _wsIntentos: 0,

    async init() {
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

    destroy() {
      this._cerrarWS();
    },

    _decidirPasoPostLogin(usuario) {
      if (usuario.rol === 'admin') {
        this.step = 'admin_choice';
        return;
      }
      if (usuario.mesa_asignada) {
        this.mesaPreAsignada = usuario.mesa_asignada;
        this.step = 'mesa_asignada';
        return;
      }
      this.step = 'mesas_grid';
      this.cargarMesas();
      this._conectarWSMesas();
    },

    _conectarWSMesas() {
      if (this._ws && (
        this._ws.readyState === WebSocket.OPEN ||
        this._ws.readyState === WebSocket.CONNECTING
      )) return;
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${protocol}://${location.host}/ws?canal=tv%3Aglobal`;
      try { this._ws = new WebSocket(url); } catch (_) { return; }

      this._ws.onopen = () => { this._wsIntentos = 0; };

      this._ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        const { tipo, payload } = msg;
        if (tipo === 'mesas_disponibles_actualizadas') {
          this._actualizarMesaEnGrid(payload);
        }
        if (tipo === 'operador_asignado_por_admin') {
          if (this.currentUser && Number(payload.operador_id) === Number(this.currentUser.id)) {
            this._redirigirConMesaAsignada(payload.mesa);
          }
        }
      };

      this._ws.onclose = () => {
        this._ws = null;
        if (this.step === 'mesas_grid') {
          const delay = Math.min(1000 * Math.pow(2, this._wsIntentos) + Math.random() * 500, 30000);
          this._wsIntentos = Math.min(this._wsIntentos + 1, 6);
          this._wsReconnectTimer = setTimeout(() => this._conectarWSMesas(), delay);
        }
      };

      this._ws.onerror = () => { try { this._ws.close(); } catch (_) {} };
    },

    _cerrarWS() {
      clearTimeout(this._wsReconnectTimer);
      this._wsReconnectTimer = null;
      if (this._ws) { try { this._ws.close(); } catch (_) {} this._ws = null; }
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
      this.redirectText = `El administrador te asigno la Mesa ${mesa.numero} — Iniciando consola...`;
      showToast({ message: `Mesa ${mesa.numero} asignada por el administrador`, type: 'success', duration: 3000 });
      setTimeout(() => { window.location.href = '/panel_mesa.html'; }, 1200);
    },

    async handleLogin() {
      this.errorMessage = '';
      const usr = this.username.trim();
      if (!usr || !this.password) { this.errorMessage = 'Complete todos los campos para continuar.'; return; }
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
        if (codigo === 'credenciales_invalidas' || err.status === 401) {
          this.errorMessage = 'Usuario o contrasena incorrectos.';
        } else if (codigo === 'servidor_ocupado' || err.status === 429 || err.status === 503) {
          this.errorMessage = err.mensaje || 'Demasiados intentos. Intente en unos minutos.';
        } else if (!navigator.onLine || err.name === 'TypeError') {
          this.errorMessage = 'Sin conexion con el servidor. Verifique su red.';
        } else {
          this.errorMessage = err.mensaje || 'No se pudo iniciar sesion. Intente de nuevo.';
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
          ? 'Sin conexion con el servidor. Verifique su red.'
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
          showToast({ message: 'Esta mesa ya no esta activa.', type: 'warning', duration: 4000 });
          await this.cargarMesas();
        } else if (codigo === 'mesa_no_encontrada') {
          showToast({ message: 'La mesa ya no existe.', type: 'warning', duration: 4000 });
          await this.cargarMesas();
        } else if (codigo === 'operador_ya_asignado') {
          this.mesaPreAsignada = err.data?.error?.mesa_actual || null;
          this._cerrarWS();
          this.step = 'mesa_asignada';
        } else if (!navigator.onLine || err.name === 'TypeError') {
          this.errorMessage = 'Sin conexion con el servidor. Verifique su red.';
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

    async liberarMesa() {
      this.loading = true;
      try {
        await api.post('/auth/liberar-mesa');
        this.mesaPreAsignada = null;
        sessionStorage.removeItem('turnero_mesa');
        const usuario = api.getUser();
        if (usuario) { usuario.mesa_asignada = null; api.setSession(null, usuario); }
        this.step = 'mesas_grid';
        await this.cargarMesas();
        this._conectarWSMesas();
      } catch (err) {
        showToast({ message: 'No se pudo liberar la mesa. Intente de nuevo.', type: 'danger' });
      } finally {
        this.loading = false;
      }
    },

    irAdmin() { window.location.href = '/admin.html'; },

    async irOperarMesa() {
      this.step = 'mesas_grid';
      await this.cargarMesas();
      this._conectarWSMesas();
    },

    async volverLogin() {
      this.loading = true;
      this._cerrarWS();
      try { await api.logout(false); } catch (_) { api.clearSession(false); } finally {
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
  if (window.Alpine) window.Alpine.data('loginView', loginView);
}

if (window.Alpine) {
  registerWithAlpine();
} else {
  document.addEventListener('alpine:init', registerWithAlpine);
}


