/**
 * ==============================================================================
 * API.JS — Cliente HTTP Centralizado y Resiliente (Fetch)
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cumple con:
 * - RF-AUTH-01 / 02: Manejo de autenticación por Bearer Token.
 * - RF-AUTH-06: Renovación transparente via POST /auth/refresh (cookie HttpOnly).
 * - RNF-SEG-05: Credenciales incluidas y protección de sesión.
 * ==============================================================================
 */

class ApiClient {
  constructor() {
    this.refreshPromise = null; // Previene múltiples llamados concurrentes a /auth/refresh
    this._authChannel = null;
    this._initSessionSync();
  }

  /**
   * Sincronización proactiva de sesión entre pestañas del mismo navegador/dispositivo.
   * Si otra pestaña inicia sesión como otro usuario o cierra sesión, invalida inmediatamente
   * la sesión actual para evitar colisiones y estados inconsistentes.
   * @private
   */
  _initSessionSync() {
    if (typeof window === 'undefined') return;

    const procesarCambioRemoto = (nuevaSesion) => {
      // Pantallas públicas (TV o Kiosko no autenticado) no se ven afectadas
      const pathname = window.location.pathname;
      if (pathname.includes('tv.html') || pathname.includes('kiosko.html')) {
        return;
      }

      const currentToken = this.getToken();
      const currentUser = this.getUser();

      // Si no hay sesión local activa en esta pestaña, no hay nada que invalidar
      if (!currentToken && !currentUser) return;

      if (!nuevaSesion) {
        // Otra pestaña ejecutó un logout explícito
        console.warn('[API-SYNC] Sesión cerrada explícitamente en otra pestaña. Limpiando sesión local...');
        this.clearSession(true);
        return;
      }

      // Si es el MISMO usuario actualizando sesión o abriendo otra pestaña, sincronizar token
      if (currentUser && nuevaSesion.userId && Number(nuevaSesion.userId) === Number(currentUser.id)) {
        if (nuevaSesion.token && nuevaSesion.token !== currentToken) {
          sessionStorage.setItem('token', nuevaSesion.token);
        }
        return;
      }

      // Si inició sesión otro usuario DISTINTO en otra pestaña del mismo navegador
      if (currentUser && nuevaSesion.userId && Number(nuevaSesion.userId) !== Number(currentUser.id)) {
        console.warn(`[API-SYNC] Se detectó inicio de sesión de otro usuario (${nuevaSesion.username || nuevaSesion.userId}). Invalidando sesión anterior...`);
        this.clearSession(false);
        if (window.location.pathname !== '/index.html' && window.location.pathname !== '/') {
          window.location.href = '/index.html?sesion_cerrada=1';
        }
      }
    };

    // Canal 1: evento de storage en localStorage (funciona entre todas las pestañas)
    window.addEventListener('storage', (e) => {
      if (e.key === 'turnero_active_session') {
        try {
          const val = e.newValue ? JSON.parse(e.newValue) : null;
          procesarCambioRemoto(val);
        } catch (_) {}
      }
    });

    // Canal 2: BroadcastChannel (comunicación instantánea sin retrasos en navegadores modernos)
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this._authChannel = new BroadcastChannel('turnero_auth_sync');
        this._authChannel.onmessage = (msg) => {
          if (msg.data?.type === 'LOGOUT') {
            procesarCambioRemoto(null);
          } else if (msg.data?.type === 'LOGIN') {
            procesarCambioRemoto(msg.data.payload);
          }
        };
      } catch (_) {}
    }
  }

  /**
   * Obtiene el token JWT actual desde sessionStorage o localStorage (sesión activa compartida).
   * @returns {string|null}
   */
  getToken() {
    try {
      const token = sessionStorage.getItem('token');
      if (token) return token;

      // Fallback a localStorage para pestañas nuevas del mismo usuario en este navegador
      const raw = localStorage.getItem('turnero_active_session');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.token) {
          sessionStorage.setItem('token', parsed.token);
          if (parsed.usuario) {
            sessionStorage.setItem('usuario', JSON.stringify(parsed.usuario));
          }
          return parsed.token;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Almacena o actualiza la sesión en sessionStorage y la sincroniza entre pestañas.
   * @param {string} token - JWT emitido por Fastify
   * @param {Object} [usuario] - Datos de perfil del usuario
   */
  setSession(token, usuario = null) {
    if (token) sessionStorage.setItem('token', token);
    if (usuario) sessionStorage.setItem('usuario', JSON.stringify(usuario));

    if (token) {
      try {
        const userObj = usuario || this.getUser();
        const payload = {
          userId: userObj?.id,
          username: userObj?.username,
          rol: userObj?.rol,
          token: token,
          usuario: userObj,
          timestamp: Date.now()
        };
        localStorage.setItem('turnero_active_session', JSON.stringify(payload));
        if (this._authChannel) {
          this._authChannel.postMessage({ type: 'LOGIN', payload });
        }
      } catch (_) {}
    }
  }

  /**
   * Obtiene los datos del usuario logueado en la sesión activa.
   * @returns {Object|null}
   */
  getUser() {
    try {
      const data = sessionStorage.getItem('usuario');
      if (data) return JSON.parse(data);

      // Fallback a localStorage para pestañas nuevas del mismo usuario en este navegador
      const raw = localStorage.getItem('turnero_active_session');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.usuario) {
          sessionStorage.setItem('usuario', JSON.stringify(parsed.usuario));
          if (parsed.token) sessionStorage.setItem('token', parsed.token);
          return parsed.usuario;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Limpia la sesión local de esta pestaña y opcionalmente redirige a la pantalla de acceso.
   * NO transmite LOGOUT a otras pestañas (eso solo lo hace logout() explícito).
   */
  clearSession(redirect = true) {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('usuario');
    sessionStorage.removeItem('mesa_seleccionada');
    sessionStorage.removeItem('turnero_mesa');
    sessionStorage.removeItem('turnero_jwt');
    sessionStorage.removeItem('turnero_user');

    // BORRADO OBLIGATORIO DE LA SESIÓN COMPARTIDA EN LOCALSTORAGE
    // Evita que getToken() y getUser() vuelvan a hidratar el token caducado tras reinicios de servidor
    try {
      localStorage.removeItem('turnero_active_session');
    } catch (_) {}

    if (redirect && typeof window !== 'undefined') {
      const pathname = window.location.pathname;
      if (pathname !== '/index.html' && pathname !== '/') {
        window.location.href = '/index.html';
      }
      // Si ya estamos en /index.html o /, NUNCA recargar la página.
      // Recargar con tokens inválidos causaba bucle infinito y parpadeo continuo.
    }
  }

  /**
   * Cierra sesión explícitamente en el servidor y notifica a todas las pestañas de este navegador.
   * @param {boolean} [redirect=true] - Si redirigir a /index.html tras limpiar
   */
  async logout(redirect = true) {
    try {
      await this.request('/auth/logout', { method: 'POST' });
    } catch (_) {
      // Silencioso: si el servidor no responde, igual limpiamos la sesión
    } finally {
      try {
        localStorage.removeItem('turnero_active_session');
        if (this._authChannel) {
          this._authChannel.postMessage({ type: 'LOGOUT' });
        }
      } catch (_) {}
      this.clearSession(redirect);
    }
  }

  /**
   * Intenta refrescar el token de forma transparente mediante la cookie HttpOnly.
   * Si ya hay una solicitud en curso, reutiliza la misma promesa para evitar tormentas de peticiones.
   * @private
   * @returns {Promise<string>} Nuevo token JWT
   */
  async _refreshToken() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const response = await fetch('/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include' // Obligatorio para transmitir cookie HttpOnly
        });

        if (!response.ok) {
          throw new Error('Refresh token expirado o revocado');
        }

        const data = await response.json();
        if (!data.token) {
          throw new Error('Respuesta de refresh inválida');
        }

        this.setSession(data.token);
        return data.token;
      } catch (err) {
        console.warn('[API] Sesión expirada definitivamente:', err.message);
        // Si estamos en la página de login (/index.html o /), limpiar sin recargar para no crear bucle de parpadeo
        const isLoginPage = typeof window !== 'undefined' && (
          window.location.pathname === '/index.html' || window.location.pathname === '/'
        );
        this.clearSession(!isLoginPage);
        throw err;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Método base para ejecutar peticiones HTTP con interceptor automático.
   * @param {string} endpoint - Ruta relativa o URL completa (ej: '/turnos/llamar')
   * @param {Object} [options={}] - Opciones de fetch
   * @returns {Promise<any>}
   */
  async request(endpoint, options = {}) {
    const config = {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        ...(options.headers || {})
      },
      ...options
    };

    // Serialización automática del body si es objeto
    if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
      config.headers['Content-Type'] = 'application/json';
      config.body = JSON.stringify(config.body);
    }

    // Inyección de token de autorización si existe (solo en modo autenticado)
    const isPublicPage = typeof window !== 'undefined' && (
      window.location.pathname.includes('kiosko') ||
      window.location.pathname.includes('tv')
    );
    const isPublic = options.public === true || (isPublicPage && !options.requireAuth);

    if (!isPublic) {
      const token = this.getToken();
      if (token && !config.headers['Authorization']) {
        config.headers['Authorization'] = `Bearer ${token}`;
      }
    }

    let response;
    try {
      response = await fetch(endpoint, config);
    } catch (networkError) {
      console.error(`[API] Error de red al solicitar ${endpoint}:`, networkError);
      throw networkError;
    }

    // Interceptor 401 Unauthorized: intento de renovación transparente (solo en modo autenticado)
    if (response.status === 401 && !options._isRetry && !isPublic) {
      // Evitar loop infinito si la ruta que dio 401 era el propio /auth/refresh o /auth/login
      if (endpoint.includes('/auth/refresh') || endpoint.includes('/auth/login')) {
        const isLoginPage = typeof window !== 'undefined' && (
          window.location.pathname === '/index.html' || window.location.pathname === '/'
        );
        this.clearSession(!isLoginPage);
        throw new Error('Credenciales inválidas o expiradas');
      }

      try {
        console.info(`[API] Token expirado en ${endpoint}. Intentando renovación transparente...`);
        const newToken = await this._refreshToken();

        // Reintentar la petición original con el nuevo token
        const retryConfig = {
          ...options,
          _isRetry: true,
          headers: {
            ...(options.headers || {}),
            'Authorization': `Bearer ${newToken}`
          }
        };
        return this.request(endpoint, retryConfig);
      } catch (refreshErr) {
        // La sesión no pudo renovarse
        throw refreshErr;
      }
    }

    // Procesamiento de la respuesta
    const contentType = response.headers.get('content-type') || '';
    let responseData = null;

    if (contentType.includes('application/json')) {
      responseData = await response.json();
    } else {
      responseData = await response.text();
    }

    // Manejo de errores HTTP 4xx / 5xx
    // Normalizar siempre al contrato { codigo, mensaje } para que los controladores
    // de pagina no tengan que manejar multiples formatos de error.
    if (!response.ok) {
      let codigo = 'error_interno';
      let mensaje = `Error HTTP ${response.status}`;

      if (responseData) {
        if (responseData.codigo) {
          codigo = responseData.codigo;
        }
        if (responseData.error && typeof responseData.error === 'object') {
          // Formato del contrato: { error: { codigo, mensaje } }
          codigo = responseData.error.codigo || codigo;
          mensaje = responseData.error.mensaje || mensaje;
        } else if (responseData.mensaje) {
          mensaje = responseData.mensaje;
        } else if (responseData.message) {
          mensaje = responseData.message;
        } else if (typeof responseData.error === 'string') {
          mensaje = responseData.error;
        }
      }

      // Mapeo de codigos HTTP a codigos semanticos cuando el servidor no los provee
      if (codigo === 'error_interno') {
        if (mensaje && mensaje.toLowerCase().includes('espera')) {
          codigo = 'sin_turnos_en_espera';
        } else {
          const httpCodigos = {
            400: 'validacion_invalida',
            401: 'credenciales_invalidas',
            403: 'sin_permiso',
            404: 'mesa_no_encontrada',
            409: 'conflicto',
            429: 'servidor_ocupado',
            503: 'servidor_ocupado'
          };
          codigo = httpCodigos[response.status] || 'error_interno';
        }
      }

      const httpError = new Error(mensaje);
      httpError.status = response.status;
      httpError.codigo = codigo;
      httpError.mensaje = mensaje;   // alias para compatibilidad con el contrato { codigo, mensaje }
      httpError.data = responseData;

      // Extraer Retry-After del servidor (segundos) para que el cliente espere el tiempo correcto
      // antes de reintentar — evita "thundering herd" al volver de sobrecarga.
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter && (response.status === 429 || response.status === 503)) {
        httpError.retryAfterMs = parseInt(retryAfter, 10) * 1000 || 10000;
      }

      throw httpError;
    }

    return responseData;
  }

  /**
   * Petición HTTP GET
   * @param {string} url
   * @param {Object} [options]
   */
  get(url, options = {}) {
    return this.request(url, { ...options, method: 'GET' });
  }

  /**
   * Petición HTTP POST
   * @param {string} url
   * @param {any} [data]
   * @param {Object} [options]
   */
  post(url, data = null, options = {}) {
    return this.request(url, { ...options, method: 'POST', body: data });
  }

  /**
   * Petición HTTP PATCH
   * @param {string} url
   * @param {any} [data]
   * @param {Object} [options]
   */
  patch(url, data = null, options = {}) {
    return this.request(url, { ...options, method: 'PATCH', body: data });
  }

  /**
   * Petición HTTP DELETE
   * @param {string} url
   * @param {Object} [options]
   */
  delete(url, options = {}) {
    return this.request(url, { ...options, method: 'DELETE' });
  }

  /**
   * Descarga un recurso como Blob (útil para CSV, PDF).
   * Pasa el JWT en cabecera Authorization — no en la URL.
   * @param {string} url
   * @returns {Promise<Blob>}
   */
  async getBlob(url) {
    const token = this.getToken();
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': '*/*',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    });
    if (!response.ok) {
      const err = new Error(`Error al descargar: HTTP ${response.status}`);
      err.status = response.status;
      err.mensaje = err.message;
      throw err;
    }
    return response.blob();
  }
}

// Instancia singleton para importación como módulo ES6
export const api = new ApiClient();
