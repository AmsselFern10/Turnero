/**
 * ==============================================================================
 * WS-CLIENT.JS — Cliente WebSocket Institucional Resiliente
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cumple con:
 * - RF-WS-01: Cero polling, comunicación push en tiempo real.
 * - RF-WS-02: Canales segmentados (mesa:<id>, tv:global, admin:all, kiosko:<token>).
 * - RF-WS-03: Handshake autenticado via ticket efímero / JWT.
 * - RF-WS-04: Reconexión con backoff exponencial + Full Jitter.
 * - RF-WS-05: Solicitud y recepción de snapshot de sincronización al reconectar.
 * - RF-WS-06: Heartbeat cada 30s con detección de corte silencioso de red (simétrico).
 * - RF-WS-07: Protocolo uniforme { tipo, payload, seq, timestamp }.
 * - Invariantes 1-6: Secuencia monotónica, auto-sincronización y ciclo de vida de navegador.
 * ==============================================================================
 */

export class TurneroWSClient {
  /**
   * @param {Object} options
   * @param {string} [options.url] - URL base ws:// o wss://. Si no se indica, usa window.location.
   * @param {string} [options.token] - JWT válido del usuario (si aplica).
   * @param {string} [options.ticket] - Ticket efímero de un solo uso (si aplica).
   * @param {string} [options.canal='tv:global'] - Canal a suscribir ('mesa:X', 'tv:global', 'admin:all', 'kiosko:X').
   * @param {number|string} [options.mesaId] - ID numérico de la mesa si es operador.
   * @param {number} [options.baseDelay=1000] - Tiempo base en ms para backoff (1s).
   * @param {number} [options.maxDelay=30000] - Tiempo máximo en ms para backoff (30s).
   * @param {number} [options.heartbeatInterval=20000] - Intervalo de ping en ms (20s LAN tolerante).
   * @param {number} [options.silenceTimeout=60000] - Tiempo máximo sin actividad antes de reconectar (60s).
   */
  constructor(options = {}) {
    this.token = options.token || '';
    this.ticket = options.ticket || '';
    this.canal = options.canal || 'tv:global';
    this.mesaId = options.mesaId || null;
    this.baseDelay = options.baseDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.heartbeatInterval = options.heartbeatInterval || 20000; // 20s para LAN tolerante
    this.silenceTimeout = options.silenceTimeout || 40000;       // 40s para detección segura

    // Determinar URL del WebSocket
    if (options.url) {
      this.baseUrl = options.url;
    } else {
      const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
      this.baseUrl = `${protocol}//${host}/ws`;
    }

    this.ws = null;
    this.connectionGeneration = 0; // ID de generación para evitar condiciones de carrera en reconexiones
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.stabilityTimer = null;
    this.lastActivityTime = Date.now();
    this.isForcedClosed = false;

    // Control de secuencia de eventos monotónicos (Invariante 1)
    this.lastSeq = 0;

    // Estados: 'CONECTANDO' | 'CONECTADO' | 'RECONECTANDO' | 'DESCONECTADO'
    this.status = 'DESCONECTADO';

    // Manejo de listeners
    this.listeners = new Map();
    this.statusListeners = new Set();

    // Eventos de ciclo de vida del navegador (WS-015)
    this._initBrowserLifecycle();
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
   * Elimina todos los listeners de un tipo específico o todos los listeners registrados.
   * @param {string} [tipo]
   */
  removeAllListeners(tipo) {
    if (tipo) {
      this.listeners.delete(tipo);
    } else {
      this.listeners.clear();
      this.statusListeners.clear();
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
   * Construye la URL de conexión con parámetros de autenticación y canal.
   * @private
   */
  _buildUrl() {
    const url = new URL(this.baseUrl, typeof window !== 'undefined' ? window.location.href : 'http://localhost:3000');
    if (this.ticket) {
      url.searchParams.set('ticket', this.ticket);
    } else if (this.token) {
      url.searchParams.set('token', this.token);
    }
    if (this.canal) url.searchParams.set('canal', this.canal);
    if (this.mesaId) url.searchParams.set('mesa_id', String(this.mesaId));
    return url.toString();
  }

  /**
   * Obtiene un ticket efímero de conexión si hay un token JWT disponible (WS-005).
   * @private
   */
  async _prepareTicket() {
    if (!this.token || this.canal === 'tv:global' || this.canal.startsWith('kiosko:')) {
      return;
    }
    try {
      const resp = await fetch('/auth/ws-ticket', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          canal: this.canal,
          mesa_id: this.mesaId
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.ticket) {
          this.ticket = data.ticket;
        }
      } else if (resp.status === 401 || resp.status === 403) {
        console.error(`[WS] Ticket rechazado con código ${resp.status}. Acceso denegado o sesión expirada.`);
        this.isForcedClosed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this._notifyStatus('DESCONECTADO');
        this._dispatchAuthError(resp.status, 'Acceso no autorizado al canal o sesión inválida');
        return false;
      }
    } catch (_) {
      // Si falla por desconexión física de red (offline), continúa el flujo normal de reconexión
    }
  }

  /**
   * Inicia la conexión WebSocket.
   */
  async connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isForcedClosed = false;
    const currentGen = ++this.connectionGeneration;
    this._notifyStatus(this.reconnectAttempts === 0 ? 'CONECTANDO' : 'RECONECTANDO');

    // Intentar obtener ticket efímero para no exponer JWT en logs
    const ticketResult = await this._prepareTicket();

    // Si otra llamada a connect() o disconnect() ocurrió, o si el ticket fue rechazado (401/403), abortar
    if (currentGen !== this.connectionGeneration || this.isForcedClosed || ticketResult === false) return;

    try {
      const fullUrl = this._buildUrl();
      const socket = new WebSocket(fullUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (currentGen !== this.connectionGeneration) {
          try { socket.close(1001, 'conexion_reemplazada'); } catch (_) {}
          return;
        }

        console.info(`[WS] Conexión establecida con éxito en canal: ${this.canal}`);
        const wasReconnecting = this.reconnectAttempts > 0;
        this.lastActivityTime = Date.now();
        this._notifyStatus('CONECTADO');

        // La estabilidad se confirma tras 10 segundos continuos o primer mensaje de datos (WS-009)
        if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
        this.stabilityTimer = setTimeout(() => {
          if (this.status === 'CONECTADO') {
            this.reconnectAttempts = 0;
          }
        }, 10000);

        // Iniciar ciclo simétrico de Heartbeat cada 20 segundos (tolerante para LAN)
        this._startHeartbeat();

        // Si fue una reconexión, solicitar snapshot de sincronización (RF-WS-05)
        if (wasReconnecting) {
          this.solicitarSnapshot();
        }
      };

      socket.onmessage = (event) => {
        if (currentGen !== this.connectionGeneration) return;
        // Cualquier frame del servidor (datos, pong de aplicación JSON) renueva lastActivityTime.
        // Los pings W3C nativos del servidor se responden automáticamente por el navegador
        // y los pongs nativos RFC 6455 no son visibles desde JS — cubiertos por onmessage vía
        // el pong de aplicación JSON (tipo:'pong') que el hub siempre responde junto al pong W3C.
        this.lastActivityTime = Date.now();
        this._handleMessage(event.data);
      };

      socket.onclose = (event) => {
        if (currentGen !== this.connectionGeneration) return;

        this._stopHeartbeat();
        if (this.stabilityTimer) {
          clearTimeout(this.stabilityTimer);
          this.stabilityTimer = null;
        }

        if (this.isForcedClosed) {
          this._notifyStatus('DESCONECTADO');
          return;
        }

        console.warn(`[WS] Conexión cerrada (código: ${event.code}, razón: ${event.reason || 'sin especificar'}).`);

        // Código 4401 / 1008: No autorizado o sesión expirada
        if (event.code === 4401 || event.code === 1008) {
          console.error('[WS] No autorizado / Sesión expirada. Cancelando reconexión automática.');
          this._notifyStatus('DESCONECTADO');
          this._dispatchAuthError(event.code, event.reason);
          return;
        }

        // Código 4403: Canal prohibido (IDOR detectado por servidor)
        if (event.code === 4403) {
          console.error('[WS] Error 4403: Acceso denegado al canal solicitado.');
          this._notifyStatus('DESCONECTADO');
          this._dispatchAuthError(4403, event.reason);
          return;
        }

        this._scheduleReconnect();
      };

      socket.onerror = (err) => {
        if (currentGen !== this.connectionGeneration) return;
        console.warn('[WS] Evento de error en socket:', err);
      };
    } catch (err) {
      console.error('[WS] Excepción al inicializar WebSocket:', err);
      this._scheduleReconnect();
    }
  }

  /**
   * Procesa mensajes de entrada conforme al protocolo estándar:
   * { tipo, payload, seq, timestamp }
   * @private
   */
  _handleMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);
      const { tipo, payload, seq, timestamp } = msg;

      // Resetear intentos de reconexión al recibir primer mensaje válido
      this.reconnectAttempts = 0;

      // Control de secuencia monotónica: detectar posibles huecos
      if (seq !== undefined && seq !== null) {
        if (this.lastSeq > 0 && seq > this.lastSeq + 1) {
          console.warn(`[WS] Detectado salto de secuencia en canal ${this.canal}: esperado ${this.lastSeq + 1}, recibido ${seq}. Solicitando snapshot...`);
          this.solicitarSnapshot();
        }
        this.lastSeq = seq;
      }

      // 1. Responder a pings del servidor con un pong de aplicación
      if (tipo === 'ping') {
        this.send('pong', { clientTime: Date.now() });
        return;
      }

      // 2. Si es pong del servidor, confirma salud de red
      if (tipo === 'pong') {
        return;
      }

      // 3. Disparar listeners registrados para este tipo de mensaje
      if (tipo && this.listeners.has(tipo)) {
        for (const callback of this.listeners.get(tipo)) {
          try {
            callback(payload, timestamp, msg);
          } catch (err) {
            console.error(`[WS] Error en listener para tipo "${tipo}":`, err);
          }
        }
      }

      // 4. Listener comodín '*'
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

    try {
      this.ws.send(message);
      return true;
    } catch (err) {
      console.error('[WS] Error al enviar mensaje:', err);
      return false;
    }
  }

  /**
   * Solicita el snapshot de estado más reciente al servidor central (RF-WS-05).
   */
  solicitarSnapshot() {
    return this.send('solicitar_snapshot', {
      canal: this.canal,
      mesaId: this.mesaId
    });
  }

  /**
   * Inicia el latido simétrico (Heartbeat) de 30s y monitoreo de silencio de red (60s).
   * @private
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // 1. Detectar corte silencioso: si han pasado más de silenceTimeout ms (40s) sin actividad, forzar reconexión
      const elapsedSilence = Date.now() - this.lastActivityTime;
      if (elapsedSilence > this.silenceTimeout) {
        console.warn(`[WS] Corte silencioso detectado (${(elapsedSilence / 1000).toFixed(0)}s sin tráfico, umbral=${this.silenceTimeout / 1000}s). Reiniciando socket...`);
        if (this.ws) {
          try { this.ws.close(1001, 'silencio_detectado'); } catch (_) {}
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
   * Programa la reconexión con Backoff Exponencial + Full Jitter (WS-009):
   * delay = random(500, min(maxDelay, baseDelay * 2^(intentos-1)))
   * @private
   */
  _scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectAttempts++;

    // Full Jitter para evitar efecto manada en 50 pantallas tras reinicio (WS-009)
    const maxInterval = Math.min(this.maxDelay, this.baseDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 6)));
    const delay = Math.max(500, Math.floor(Math.random() * maxInterval));

    console.info(`[WS] Reconectando en ${(delay / 1000).toFixed(1)}s (intento #${this.reconnectAttempts})...`);
    this._notifyStatus('RECONECTANDO', delay);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Integra eventos de ciclo de vida del navegador (WS-015).
   * @private
   */
  _initBrowserLifecycle() {
    if (typeof window === 'undefined') return;

    // Al restaurarse la conexión física a la red, reconectar de inmediato
    window.addEventListener('online', () => {
      console.info('[WS] Evento online detectado. Reconectando de inmediato...');
      this.reconnectAttempts = 0;
      this.connect();
    });

    // Al volver a la pestaña, verificar estado y solicitar snapshot
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          console.info('[WS] Pestaña visible y socket cerrado. Reconectando...');
          this.connect();
        } else {
          this.solicitarSnapshot();
        }
      }
    });

    // Cierre limpio al cerrar o navegar fuera de la página
    window.addEventListener('pagehide', () => {
      if (this.ws) {
        try { this.ws.close(1000, 'Página descargada'); } catch (_) {}
      }
    });
  }

  /**
   * Notifica errores de autenticación a posibles manejadores externos.
   * @private
   */
  _dispatchAuthError(code, reason) {
    if (this.listeners.has('auth_error')) {
      for (const cb of this.listeners.get('auth_error')) {
        try { cb({ code, reason }); } catch (_) {}
      }
    }
  }

  /**
   * Actualiza el token JWT (ej: tras refresh token transparente) y reconecta de inmediato.
   * @param {string} newToken
   */
  setToken(newToken) {
    this.token = newToken;
    this.ticket = ''; // Limpiar ticket previo
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
    this.connectionGeneration++;
    this._stopHeartbeat();

    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'Cliente cerró sesión');
      } catch (_) {}
      this.ws = null;
    }
    this._notifyStatus('DESCONECTADO');
  }
}
