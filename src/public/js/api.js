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
  }

  /**
   * Obtiene el token JWT actual desde sessionStorage.
   * @returns {string|null}
   */
  getToken() {
    try {
      return sessionStorage.getItem('token');
    } catch {
      return null;
    }
  }

  /**
   * Almacena o actualiza la sesión en sessionStorage.
   * @param {string} token - JWT emitido por Fastify
   * @param {Object} [usuario] - Datos de perfil del usuario
   */
  setSession(token, usuario = null) {
    if (token) sessionStorage.setItem('token', token);
    if (usuario) sessionStorage.setItem('usuario', JSON.stringify(usuario));
  }

  /**
   * Obtiene los datos del usuario logueado en la sesión activa.
   * @returns {Object|null}
   */
  getUser() {
    try {
      const data = sessionStorage.getItem('usuario');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  /**
   * Limpia la sesion actual y opcionalmente redirige a la pantalla de acceso.
   * Elimina todas las claves de sesion para evitar fugas en PCs compartidas.
   */
  clearSession(redirect = true) {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('usuario');
    sessionStorage.removeItem('mesa_seleccionada');
    sessionStorage.removeItem('turnero_mesa');
    sessionStorage.removeItem('turnero_jwt');
    sessionStorage.removeItem('turnero_user');
    if (redirect && window.location.pathname !== '/index.html' && window.location.pathname !== '/') {
      window.location.href = '/index.html';
    }
  }

  /**
   * Cierra sesion del lado servidor (blacklist JWT en Redis) y limpia sessionStorage.
   * Siempre intentar el logout remoto; si falla la red, limpiar igual.
   * @param {boolean} [redirect=true] - Si redirigir a /index.html tras limpiar
   */
  async logout(redirect = true) {
    try {
      await this.request('/auth/logout', { method: 'POST' });
    } catch (_) {
      // Silencioso: si el servidor no responde, igual limpiamos la sesion local
    } finally {
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
        this.clearSession(true);
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
        this.clearSession(true);
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
        if (responseData.mensaje) {
          mensaje = responseData.mensaje;
        }
        if (responseData.error) {
          if (typeof responseData.error === 'object') {
            // Formato del contrato: { error: { codigo, mensaje } }
            codigo = responseData.error.codigo || codigo;
            mensaje = responseData.error.mensaje || mensaje;
          } else if (typeof responseData.error === 'string') {
            // Legado: { error: 'texto' }
            mensaje = responseData.error;
          }
        } else if (responseData.message) {
          mensaje = responseData.message;
        }
      }

      // Mapeo de codigos HTTP a codigos semanticos cuando el servidor no los provee
      if (codigo === 'error_interno') {
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
