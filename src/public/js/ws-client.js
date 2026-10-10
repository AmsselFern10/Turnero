/**
 * ==============================================================================
 * WS-CLIENT.JS — Cliente WebSocket Institucional Resiliente
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cumple con:
 * - RF-WS-01: Cero polling, comunicación push en tiempo real.
 * - RF-WS-02: Canales segmentados (mesa:<id>, tv:global, admin:all).
 * - RF-WS-03: Handshake autenticado via JWT (query param token).
 * - RF-WS-04: Reconexión con backoff exponencial + jitter (fórmula estricta).
 * - RF-WS-05: Solicitud y recepción de snapshot de sincronización al reconectar.
 * - RF-WS-06: Heartbeat cada 30s con detección de corte silencioso de red.
 * - RF-WS-07: Protocolo uniforme { tipo, payload, timestamp }.
 * ==============================================================================
 */

export class TurneroWSClient {
  /**
   * @param {Object} options
   * @param {string} [options.url] - URL base ws:// o wss://. Si no se indica, usa window.location.
   * @param {string} [options.token] - JWT válido del usuario (si aplica).
   * @param {string} [options.canal='tv:global'] - Canal a suscribir ('mesa:X', 'tv:global', 'admin:all').
   * @param {number|string} [options.mesaId] - ID numérico de la mesa si es operador.
   * @param {number} [options.baseDelay=1000] - Tiempo base en ms para backoff (1s).
   * @param {number} [options.maxDelay=30000] - Tiempo máximo en ms para backoff (30s).
   * @param {number} [options.heartbeatInterval=30000] - Intervalo de ping en ms (30s).
   * @param {number} [options.silenceTimeout=60000] - Tiempo máximo sin actividad antes de reconectar (60s).
   */
  constructor(options = {}) {
    this.token = options.token || '';
    this.canal = options.canal || 'tv:global';
    this.mesaId = options.mesaId || null;
    this.baseDelay = options.baseDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.heartbeatInterval = options.heartbeatInterval || 30000;
    this.silenceTimeout = options.silenceTimeout || 60000;

    // Determinar URL del WebSocket
    if (options.url) {
      this.baseUrl = options.url;
    } else {
      const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
      this.baseUrl = `${protocol}//${host}/ws`;
    }

    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastActivityTime = Date.now();
    this.isForcedClosed = false;

    // Estados: 'CONECTANDO' | 'CONECTADO' | 'RECONECTANDO' | 'DESCONECTADO'
    this.status = 'DESCONECTADO';

    // Manejo de listeners
    this.listeners = new Map();
    this.statusListeners = new Set();
  }

  /**
   * Suscribe un callback a un tipo de mensaje específico (ej: 'nuevo_llamado', 'snapshot').
   * @param {string} tipo
   * @param {Function} callback
   */
  on(tipo, callback) {
    if (!this.listeners.has(tipo)) {
      this.listeners.set(tipo, new Set());
    }
    this.listeners.get(tipo).add(callback);
    return this;
  }

  /**
   * Elimina un callback suscrito.
   * @param {string} tipo
   * @param {Function} callback
   */
  off(tipo, callback) {
    if (this.listeners.has(tipo)) {
      this.listeners.get(tipo).delete(callback);
    }
    return this;
  }

  /**
   * Suscribe un listener a cambios de estado de red/conexión.
   * @param {Function} callback - ({ status, attempt, nextDelay }) => void
   */
  onStatusChange(callback) {
    this.statusListeners.add(callback);
    callback({ status: this.status, attempt: this.reconnectAttempts, nextDelay: 0 });
    return this;
  }

  /**
   * Notifica el estado actual a todos los listeners registrados.
   * @private
   */
  _notifyStatus(status, nextDelay = 0) {
    this.status = status;
    for (const cb of this.statusListeners) {
      try {
        cb({ status, attempt: this.reconnectAttempts, nextDelay });
      } catch (err) {
        console.error('[WS] Error en listener de status:', err);
      }
    }
  }

  /**
   * Construye la URL de conexión con token y parámetros de canal.
   * @private
   */
  _buildUrl() {
    const url = new URL(this.baseUrl, typeof window !== 'undefined' ? window.location.href : 'http://localhost:3000');
    if (this.token) url.searchParams.set('token', this.token);
    if (this.canal) url.searchParams.set('canal', this.canal);
    if (this.mesaId) url.searchParams.set('mesa_id', String(this.mesaId));
    return url.toString();
  }

  /**
   * Inicia la conexión WebSocket.
   */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isForcedClosed = false;
    this._notifyStatus(this.reconnectAttempts === 0 ? 'CONECTANDO' : 'RECONECTANDO');

    try {
      const fullUrl = this._buildUrl();
      this.ws = new WebSocket(fullUrl);

      this.ws.onopen = () => {
        console.info(`[WS] Conexión establecida con éxito en canal: ${this.canal}`);
        const wasReconnecting = this.reconnectAttempts > 0;
        this.reconnectAttempts = 0;
        this.lastActivityTime = Date.now();
        this._notifyStatus('CONECTADO');

        // Iniciar ciclo de Heartbeat cada 30 segundos
        this._startHeartbeat();

        // Si fue una reconexión tras micro-corte, solicitar snapshot explícito de sincronización
        if (wasReconnecting) {
          this.solicitarSnapshot();
        }
      };

      this.ws.onmessage = (event) => {
        this.lastActivityTime = Date.now();
        this._handleMessage(event.data);
      };

      this.ws.onclose = (event) => {
        this._stopHeartbeat();

        if (this.isForcedClosed) {
          this._notifyStatus('DESCONECTADO');
          return;
        }

        console.warn(`[WS] Conexión cerrada (código: ${event.code}, razón: ${event.reason || 'sin especificar'}).`);

        // Error 1008: No autorizado (token revocado o inválido)
        if (event.code === 1008) {
          console.error('[WS] Error 1008: No autorizado. Cancelando reintentos hasta nuevo token.');
          this._notifyStatus('DESCONECTADO');
          return;
        }

        this._scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.warn('[WS] Evento de error en socket:', err);
      };
    } catch (err) {
      console.error('[WS] Excepción al inicializar WebSocket:', err);
      this._scheduleReconnect();
    }
  }

  /**
   * Procesa mensajes de entrada conforme al protocolo estándar:
   * { tipo, payload, timestamp }
   * @private
   */
  _handleMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);
      const { tipo, payload, timestamp } = msg;

      // Responder a pings del servidor con un pong de aplicación
      if (tipo === 'ping') {
        this.send('pong', { clientTime: Date.now() });
        return;
      }

      // Si es un pong, simplemente actualizar marca de actividad
      if (tipo === 'pong') {
        return;
      }

      // Disparar listeners del tipo de mensaje correspondiente
      if (tipo && this.listeners.has(tipo)) {
        for (const callback of this.listeners.get(tipo)) {
          try {
            callback(payload, timestamp, msg);
          } catch (err) {
            console.error(`[WS] Error en listener para tipo "${tipo}":`, err);
          }
        }
      }

      // Listener comodín '*'
      if (this.listeners.has('*')) {
        for (const callback of this.listeners.get('*')) {
          try {
            callback(msg);
          } catch (err) {
            console.error('[WS] Error en listener wildcard:', err);
          }
        }
      }
    } catch (err) {
      console.warn('[WS] Formato de mensaje no válido como JSON:', rawData, err);
    }
  }

  /**
   * Envía un mensaje estructurado al servidor si el socket está abierto.
   * @param {string} tipo
   * @param {Object} [payload={}]
   */
  send(tipo, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const message = JSON.stringify({
      tipo,
      payload,
      timestamp: new Date().toISOString()
    });

    this.ws.send(message);
    return true;
  }

  /**
   * Solicita el snapshot de estado más reciente al servidor central (RF-WS-05).
   */
  solicitarSnapshot() {
    console.info('[WS] Solicitando snapshot de sincronización...');
    return this.send('solicitar_snapshot', {
      canal: this.canal,
      mesaId: this.mesaId
    });
  }

  /**
   * Inicia el latido (Heartbeat) de 30s y monitoreo de silencio de red (60s).
   * @private
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // 1. Detectar corte silencioso: si han pasado más de 60s sin actividad, forzar reconexión
      const elapsedSilence = Date.now() - this.lastActivityTime;
      if (elapsedSilence > this.silenceTimeout) {
        console.warn(`[WS] Corte silencioso detectado (${(elapsedSilence / 1000).toFixed(0)}s de inactividad). Reiniciando conexión...`);
        if (this.ws) {
          try { this.ws.close(); } catch {}
        }
        return;
      }

      // 2. Enviar ping proactivo cada 30 segundos
      this.send('ping', { heartbeat: true });
    }, this.heartbeatInterval);
  }

  /**
   * Detiene el ciclo de Heartbeat.
   * @private
   */
  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Programa la reconexión con Backoff Exponencial + Jitter exacto:
   * delay = min(base * 2^intentos + random(0, 1000), 30000)
   * @private
   */
  _scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectAttempts++;
    const exponential = this.baseDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 6));
    const jitter = Math.random() * 1000;
    const delay = Math.min(Math.round(exponential + jitter), this.maxDelay);

    console.info(`[WS] Reconectando en ${(delay / 1000).toFixed(1)}s (intento #${this.reconnectAttempts})...`);
    this._notifyStatus('RECONECTANDO', delay);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Actualiza el token JWT (ej: tras refresh token transparente) y reconecta de ser necesario.
   * @param {string} newToken
   */
  setToken(newToken) {
    this.token = newToken;
    if (this.status === 'CONECTADO') {
      this.disconnect();
      this.connect();
    }
  }

  /**
   * Desconecta limpiamente el socket y cancela temporizadores.
   */
  disconnect() {
    this.isForcedClosed = true;
    this._stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'Cliente cerró sesión');
      } catch {}
      this.ws = null;
    }
    this._notifyStatus('DESCONECTADO');
  }
}

// Compatibilidad con entornos sin módulos ES6
if (typeof window !== 'undefined') {
  window.TurneroWSClient = TurneroWSClient;
}
