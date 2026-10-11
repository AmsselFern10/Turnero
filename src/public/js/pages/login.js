/**
 * ==============================================================================
 * LOGIN.JS — Controlador de Acceso y Seleccion Dinamica de Mesas
 * Sistema Turnero de Matriculas 2026 (v2.1)
 *
 * Flujo:
 *   - Caso A: rol 'admin'/'supervisor' -> step 'admin_choice' (Admin o Ventanilla)
 *   - Caso B: Operador con mesa_asignada -> modal 'mesa_asignada' (INC-3)
 *   - Caso C: Operador sin mesa -> step 'mesas_grid' -> GET /auth/mesas/disponibles
 *             -> POST /auth/seleccionar-mesa (check-and-set atomico)
 *
 * Contrato de errores: todos los errores tienen { codigo, mensaje } desde api.js.
 * Los mensajes de error se muestran SOLO en una region aria-live (sin alert()).
 * Nunca se imprimen credenciales en consola.
 * ==============================================================================
 */

import { api } from '../api.js';
import { showToast } from '../utils.js';

/**
 * Fabrica de datos y estado reactivo para Alpine.js
 */
export function loginView() {
  return {
    // Estados de pantalla: 'login' | 'admin_choice' | 'mesas_grid' | 'mesa_asignada' | 'redirecting'
    step: 'login',

    // Campos de credenciales
    username: '',
    password: '',
    showPassword: false,

    // Indicadores y mensajes
    loading: false,
    loadingMesas: false,
    seleccionando: false,  // proteccion anti-doble-clic en "Tomar mesa"
    errorMessage: '',
    redirectText: '',

    // Datos del usuario y entorno
    currentUser: null,
    mesas: [],
    mesaPreAsignada: null,  // Usada en el modal INC-3

    /**
     * Inicializacion del controlador.
     * Si hay sesion valida, llama a GET /auth/me para decidir que mostrar
     * sin exponer el login a quien ya tiene sesion activa.
     */
    async init() {
      const existingToken = api.getToken();
      if (!existingToken) return;  // Sin sesion -> mostrar login normalmente

      try {
        const { usuario } = await api.get('/auth/me');
        this.currentUser = usuario;
        api.setSession(existingToken, usuario);
        this._decidirPasoPostLogin(usuario);
      } catch (_) {
        // Token expirado o invalido: el refresh ya fue intentado por api.js
        // Si llego aqui, la sesion no era recuperable -> mostrar login
        api.clearSession(false);
      }
    },

    /**
     * Centraliza la logica de decision post-login (login exitoso o recarga).
     * @param {Object} usuario - Datos del usuario autenticado
     * @private
     */
    _decidirPasoPostLogin(usuario) {
      // ── CASO A: Administrador o Supervisor ────────────────────────────────
      if (usuario.rol === 'admin' || usuario.rol === 'supervisor') {
        this.step = 'admin_choice';
        return;
      }

      // ── CASO B: Operador con Mesa Pre-asignada ────────────────────────────
      // Puede venir del admin (Fase 0) o de una sesion anterior no cerrada.
      if (usuario.mesa_asignada) {
        this.mesaPreAsignada = usuario.mesa_asignada;
        this.step = 'mesa_asignada';  // Muestra el <dialog> INC-3
        return;
      }

      // ── CASO C: Operador Libre -> Grilla de mesas disponibles ─────────────
      this.step = 'mesas_grid';
      this.cargarMesas();
    },

    /**
     * Procesa el envio del formulario de login.
     * No imprime credenciales en consola.
     */
    async handleLogin() {
      this.errorMessage = '';

      // Validacion minima en cliente (el servidor valida con schema)
      const usr = this.username.trim();
      if (!usr || !this.password) {
        this.errorMessage = 'Complete todos los campos para continuar.';
        return;
      }

      if (this.loading) return;  // Proteccion anti-doble-envio (Enter rapido)
      this.loading = true;

      try {
        const data = await api.post('/auth/login', {
          username: usr,
          password: this.password
        });

        const { token, usuario } = data;
        this.currentUser = usuario;

        // Persistir en sessionStorage a traves del cliente centralizado
        api.setSession(token, usuario);

        this._decidirPasoPostLogin(usuario);

      } catch (err) {
        // err.mensaje ya esta normalizado por api.js; nunca exponer err.message cruda
        const codigo = err.codigo || 'error_interno';

        if (codigo === 'credenciales_invalidas' || err.status === 401) {
          // Mensaje generico: no revelar si el usuario no existe o la contrasena es incorrecta
          this.errorMessage = 'Usuario o contrasena incorrectos.';
        } else if (codigo === 'demasiados_intentos' || err.status === 429) {
          this.errorMessage = err.mensaje || 'Demasiados intentos. Intente en 15 minutos.';
        } else if (!navigator.onLine || err.name === 'TypeError') {
          this.errorMessage = 'Sin conexion con el servidor. Verifique su red.';
        } else {
          this.errorMessage = err.mensaje || 'No se pudo iniciar sesion. Intente de nuevo.';
        }
      } finally {
        this.loading = false;
        // Nunca limpiar this.password aqui: el usuario puede querer corregir el usuario
      }
    },

    /**
     * Consulta las mesas activas y disponibles via GET /auth/mesas/disponibles (INC-2).
     * El filtro va completamente en el backend.
     */
    async cargarMesas() {
      if (this.loadingMesas) return;
      this.loadingMesas = true;
      this.errorMessage = '';

      try {
        const res = await api.get('/auth/mesas/disponibles');
        this.mesas = res.mesas || [];
      } catch (err) {
        if (!navigator.onLine || err.name === 'TypeError') {
          this.errorMessage = 'Sin conexion con el servidor. Verifique su red.';
        } else {
          this.errorMessage = 'No se pudo cargar la lista de mesas. Intente nuevamente.';
        }
      } finally {
        this.loadingMesas = false;
      }
    },

    /**
     * Asigna al operador a una mesa libre via POST /auth/seleccionar-mesa.
     * Protegido contra doble clic (una sola peticion en vuelo).
     * @param {Object} mesa - Objeto mesa { id, numero, nombre, estado }
     */
    async seleccionarMesa(mesa) {
      if (this.seleccionando) return;  // Anti-doble-clic
      this.seleccionando = true;
      this.errorMessage = '';

      try {
        const res = await api.post('/auth/seleccionar-mesa', {
          mesa_id: mesa.id
        });

        const mesaAsignada = res.mesa;

        // Guardar en sessionStorage en un unico lugar
        api.setSession(null, { ...this.currentUser, mesa_asignada: mesaAsignada });
        sessionStorage.setItem('turnero_mesa', JSON.stringify(mesaAsignada));

        this.step = 'redirecting';
        this.redirectText = `Mesa ${mesaAsignada.numero} asignada — Iniciando consola...`;

        setTimeout(() => {
          window.location.href = '/panel_mesa.html';
        }, 450);

      } catch (err) {
        const codigo = err.codigo || (err.data?.error?.codigo) || 'error_interno';

        if (codigo === 'mesa_ocupada') {
          showToast({ message: 'Esta mesa acaba de ser tomada por otro operador.', type: 'warning', duration: 4000 });
          // Recargar la grilla automaticamente para reflejar el nuevo estado
          await this.cargarMesas();
        } else if (codigo === 'mesa_inactiva') {
          showToast({ message: 'Esta mesa ya no esta activa.', type: 'warning', duration: 4000 });
          await this.cargarMesas();
        } else if (codigo === 'mesa_no_encontrada') {
          showToast({ message: 'La mesa ya no existe.', type: 'warning', duration: 4000 });
          await this.cargarMesas();
        } else if (codigo === 'operador_ya_asignado') {
          // El operador ya tiene otra mesa asignada -> mostrar modal INC-3
          const mesaActual = err.data?.error?.mesa_actual || null;
          this.mesaPreAsignada = mesaActual;
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

    /**
     * INC-3: Operador continua a su mesa pre-asignada sin cambiar.
     */
    continuarMesaAsignada() {
      if (!this.mesaPreAsignada) {
        // Datos insuficientes -> ir a la grilla
        this.step = 'mesas_grid';
        this.cargarMesas();
        return;
      }
      sessionStorage.setItem('turnero_mesa', JSON.stringify(this.mesaPreAsignada));
      this.step = 'redirecting';
      this.redirectText = `Continuando en Mesa ${this.mesaPreAsignada.numero}...`;
      setTimeout(() => { window.location.href = '/panel_mesa.html'; }, 350);
    },

    /**
     * INC-3: Operador libera su mesa y vuelve a ver la grilla.
     * Llama a POST /auth/liberar-mesa (auditado en BD).
     */
    async liberarMesa() {
      this.loading = true;
      try {
        await api.post('/auth/liberar-mesa');
        this.mesaPreAsignada = null;
        sessionStorage.removeItem('turnero_mesa');
        // Actualizar datos del usuario en sessionStorage
        const usuario = api.getUser();
        if (usuario) {
          usuario.mesa_asignada = null;
          api.setSession(null, usuario);
        }
        this.step = 'mesas_grid';
        await this.cargarMesas();
      } catch (err) {
        showToast({ message: 'No se pudo liberar la mesa. Intente de nuevo.', type: 'danger' });
      } finally {
        this.loading = false;
      }
    },

    /**
     * Caso A: Ir al Panel de Administracion.
     */
    irAdmin() {
      window.location.href = '/admin.html';
    },

    /**
     * Caso A: El Administrador decide operar una ventanilla.
     */
    async irOperarMesa() {
      this.step = 'mesas_grid';
      await this.cargarMesas();
    },

    /**
     * Volver al login: invalida la sesion en el servidor (blacklist JWT) y limpia
     * sessionStorage para evitar que la sesion quede abierta en un PC compartido.
     */
    async volverLogin() {
      this.loading = true;
      try {
        // api.logout() llama POST /auth/logout y luego clearSession(false)
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

// ── REGISTRO RESILIENTE EN ALPINE (Soporta carga asincrona y defer) ──────────
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
