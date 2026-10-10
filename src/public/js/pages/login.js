/**
 * ==============================================================================
 * LOGIN.JS — Controlador de Acceso y Selección Dinámica de Mesas
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Flujo:
 * - Caso A: rol 'admin'/'supervisor' -> step 'admin_choice' (Admin o Ventanilla)
 * - Caso B: Operador con mesa_asignada -> Redirección directa a panel_mesa.html
 * - Caso C: Operador sin mesa -> step 'mesas_grid' -> GET /auth/mesas -> POST /auth/seleccionar-mesa
 * ==============================================================================
 */

import { api } from '../api.js';

/**
 * Fábrica de datos y estado reactivo para Alpine.js
 */
export function loginView() {
  return {
    // Estados de pantalla: 'login' | 'admin_choice' | 'mesas_grid' | 'redirecting'
    step: 'login',

    // Campos de credenciales
    username: '',
    password: '',
    showPassword: false,

    // Indicadores y mensajes
    loading: false,
    loadingMesas: false,
    errorMessage: '',
    redirectText: '',

    // Datos del usuario y entorno
    currentUser: null,
    mesas: [],

    /**
     * Inicialización del controlador
     */
    init() {
      // Si ya hay sesión válida con mesa activa, redirigir
      const existingToken = api.getToken();
      const existingUser = api.getUser();

      if (existingToken && existingUser) {
        this.currentUser = existingUser;
        const mesa = sessionStorage.getItem('turnero_mesa') || sessionStorage.getItem('mesa_seleccionada');
        if (mesa && existingUser.rol === 'operador') {
          window.location.href = '/panel_mesa.html';
          return;
        }
      }
    },

    /**
     * Procesa el envío del formulario de login
     */
    async handleLogin() {
      this.errorMessage = '';
      if (!this.username.trim() || !this.password) {
        this.errorMessage = 'Por favor complete todos los campos requeridos.';
        return;
      }

      this.loading = true;

      try {
        const data = await api.post('/auth/login', {
          username: this.username.trim(),
          password: this.password
        });

        const { token, usuario } = data;
        this.currentUser = usuario;

        // Persistir en sessionStorage (modelo compatible con PCs compartidas)
        api.setSession(token, usuario);
        sessionStorage.setItem('turnero_jwt', token);
        sessionStorage.setItem('turnero_user', JSON.stringify(usuario));

        // ── CASO A: Administrador o Supervisor ────────────────────────────────
        if (usuario.rol === 'admin' || usuario.rol === 'supervisor') {
          this.step = 'admin_choice';
          return;
        }

        // ── CASO B: Operador con Mesa Pre-asignada por el Administrador ──────
        if (usuario.mesa_asignada) {
          const mesa = usuario.mesa_asignada;
          sessionStorage.setItem('turnero_mesa', JSON.stringify(mesa));
          sessionStorage.setItem('mesa_seleccionada', JSON.stringify(mesa));

          this.step = 'redirecting';
          this.redirectText = `Bienvenido(a) ${usuario.nombre} • Ingresando a Mesa ${mesa.numero}...`;

          setTimeout(() => {
            window.location.href = '/panel_mesa.html';
          }, 450);
          return;
        }

        // ── CASO C: Operador Libre (Auto-asignación desde Grilla) ─────────────
        this.step = 'mesas_grid';
        await this.cargarMesas();

      } catch (err) {
        console.warn('[LOGIN] Error de acceso:', err);
        this.errorMessage = err.message || 'Credenciales inválidas. Verifique su usuario y contraseña.';
      } finally {
        this.loading = false;
      }
    },

    /**
     * Consulta las mesas activas/disponibles vía GET /auth/mesas
     */
    async cargarMesas() {
      this.loadingMesas = true;
      this.errorMessage = '';

      try {
        const res = await api.get('/auth/mesas');
        this.mesas = res.mesas || [];
      } catch (err) {
        console.error('[LOGIN] Error cargando mesas:', err);
        this.errorMessage = 'No se pudo cargar la lista de mesas. Intente nuevamente.';
      } finally {
        this.loadingMesas = false;
      }
    },

    /**
     * Asigna al operador a una mesa libre vía POST /auth/seleccionar-mesa
     * @param {Object} mesa - Objeto mesa { id, numero, nombre, estado, operador_nombre }
     */
    async seleccionarMesa(mesa) {
      if (mesa.operador_nombre || mesa.estado === 'inactiva') {
        return;
      }

      this.loading = true;
      this.errorMessage = '';

      try {
        const res = await api.post('/auth/seleccionar-mesa', {
          mesa_id: mesa.id
        });

        const mesaAsignada = res.mesa || mesa;
        sessionStorage.setItem('turnero_mesa', JSON.stringify(mesaAsignada));
        sessionStorage.setItem('mesa_seleccionada', JSON.stringify(mesaAsignada));

        this.step = 'redirecting';
        this.redirectText = `Mesa ${mesa.numero} asignada con éxito • Iniciando consola...`;

        setTimeout(() => {
          window.location.href = '/panel_mesa.html';
        }, 450);

      } catch (err) {
        console.error('[LOGIN] Error al seleccionar mesa:', err);
        this.errorMessage = err.message || 'La mesa seleccionada ya fue ocupada por otro operador.';
        await this.cargarMesas();
      } finally {
        this.loading = false;
      }
    },

    /**
     * Caso A: Ir al Panel de Administración
     */
    irAdmin() {
      window.location.href = '/admin.html';
    },

    /**
     * Caso A: El Administrador decide operar una ventanilla
     */
    async irOperarMesa() {
      this.step = 'mesas_grid';
      await this.cargarMesas();
    },

    /**
     * Vuelve al paso de login y limpia estado local
     */
    volverLogin() {
      api.clearSession(false);
      this.step = 'login';
      this.password = '';
      this.errorMessage = '';
      this.currentUser = null;
    }
  };
}

// ── REGISTRO RESILIENTE EN ALPINE (Soporta carga asíncrona y defer) ──────────
function registerWithAlpine() {
  if (window.Alpine) {
    window.Alpine.data('loginView', loginView);
  }
}

if (window.Alpine) {
  registerWithAlpine();
} else {
  document.addEventListener('alpine:init', registerWithAlpine);
}

// Exposición global para que x-data="loginView" resuelva siempre sin importar orden
if (typeof window !== 'undefined') {
  window.loginView = loginView;
}
