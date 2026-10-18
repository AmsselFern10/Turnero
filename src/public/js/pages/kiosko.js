/**
 * ==============================================================================
 * KIOSKO.JS — Controlador de Autoservicio y Toma de Turnos Táctil
 * Sistema Turnero de Matrículas 2026 (v2.1)
 *
 * Cumple con:
 * - Numeración propia e independiente de lotes de vouchers físicos.
 * - Idempotency-Key por toque: protege contra doble clic o timeout de red.
 * - Restricción de 1 turno activo por smartphone (localStorage + deviceId).
 * - Modo Tablet (?modo=tablet) sin restricción de 1 turno por dispositivo.
 * - Seguimiento móvil en tiempo real vía canal público único 'kiosko:publico'.
 * - Sistema de audio híbrido, vibración y WakeLock para evitar pantalla apagada.
 * - Fallback accesible de código QR vectorial sin dibujos falsos.
 * ==============================================================================
 */

import { api } from '../api.js';
import { TurneroWSClient } from '../ws-client.js';
import { playCallChime } from '../utils.js';

function generarUUID () {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export function kioskoView () {
  return {
    // Estado de la pantalla: 'welcome' | 'ticket' | 'seguimiento'
    step: 'welcome',

    // Modo operativo: true si es tablet de portón (?modo=tablet)
    esTablet: false,

    // Estado del kiosko obtenido de /kiosko/estado
    kioskoActivo: true,
    topeAlcanzado: false,

    // Datos del ticket emitido
    ticketData: {
      numero: null,
      token: null,
      creado_en: null,
      posicion_en_cola: 0,
      tiempoEstimadoMin: 0,
      tracking_url: ''
    },

    // Estado del turno en seguimiento desde smartphone
    seguimientoData: {
      numero: null,
      estado: 'esperando', // 'esperando' | 'en_atencion' | 'atendido' | 'cancelado'
      posicion: 0,
      mesa: null,
      llamado_en: null
    },

    // Estados de interfaz y red
    isGenerating: false,
    isPrinting: false,
    errorMessage: '',
    mostrarBotonReintentar: false,
    toastMessage: '',
    showToast: false,
    qrFallback: false,
    wsConectado: true,
    redLocalOk: true,
    impresionAutomatica: false,   // Refleja config kiosko_impresion_automatica (solo tablet)

    // Idempotencia y dispositivo
    deviceId: null,
    currentIdempotencyKey: null,

    // Temporizadores y referencias de limpieza
    autoResetTimer: null,
    cuentaRegresivaTimer: null,
    cuentaRegresiva: 0,
    ws: null,
    wakeLockSentinel: null,
    _onVisibilityHandler: null,
    tituloOriginal: typeof document !== 'undefined' ? document.title : '',

    /**
     * Propiedad calculada: texto de personas antes en ticket
     */
    get personasAntesTexto () {
      const pos = this.ticketData.posicion_en_cola ?? 0;
      if (pos === 0) return 'Próximo a pasar';
      if (pos === 1) return '1 persona antes';
      return `${pos} personas antes`;
    },

    /**
     * Propiedad calculada: texto de personas antes en seguimiento
     */
    get seguimientoPersonasAntesTexto () {
      const pos = this.seguimientoData.posicion ?? 0;
      if (pos === 0) return '¡Eres el próximo en ser llamado!';
      if (pos === 1) return '1 persona antes de ti';
      return `${pos} personas antes de ti`;
    },

    /**
     * Inicialización del Kiosko
     */
    async init () {
      // 1. Detectar modo tablet desde la URL (?modo=tablet)
      const urlParams = new URLSearchParams(window.location.search);
      this.esTablet = urlParams.get('modo') === 'tablet';

      // 2. Obtener o generar identificador persistente del dispositivo móvil
      this.inicializarDeviceId();

      // 3. Conectar al WebSocket en canal público para avisos en vivo
      this.conectarWebSocketPublico();

      // 4. Comprobar si se ingresó directamente con ?token=64chars
      const tokenParam = urlParams.get('token');
      if (tokenParam) {
        if (tokenParam.length === 64) {
          this.step = 'seguimiento';
          await this.iniciarSeguimiento(tokenParam);
          return;
        } else {
          this.errorMessage = 'El enlace de seguimiento no es válido o está incompleto.';
          this.step = 'welcome';
          return;
        }
      }

      // 5. En celulares (no tablet): comprobar si ya tiene un turno activo en localStorage
      if (!this.esTablet) {
        const turnoLocal = this.obtenerTurnoGuardado();
        if (turnoLocal && turnoLocal.token && turnoLocal.token.length === 64) {
          this.step = 'seguimiento';
          await this.iniciarSeguimiento(turnoLocal.token);
          return;
        }
      }

      // 6. Consultar estado del kiosko para bloquear botón si está pausado o tope lleno
      this.step = 'welcome';
      await this.verificarEstadoKiosko();

      // 7. Sincronización al despertar pantalla del celular
      this._onVisibilityHandler = () => {
        const token = this.ticketData.token || this.seguimientoData.token;
        if (document.visibilityState === 'visible' && this.step === 'seguimiento' && token) {
          this.sincronizarSeguimiento(token);
        }
      };
      document.addEventListener('visibilitychange', this._onVisibilityHandler);
    },

    /**
     * Obtiene o genera UUID de dispositivo persistente en localStorage
     */
    inicializarDeviceId () {
      try {
        let did = localStorage.getItem('turnero_device_id');
        if (!did) {
          did = generarUUID();
          localStorage.setItem('turnero_device_id', did);
        }
        this.deviceId = did;
      } catch (_) {
        this.deviceId = generarUUID();
      }
    },

    /**
     * Obtiene datos del turno activo guardado en localStorage
     */
    obtenerTurnoGuardado () {
      try {
        const raw = localStorage.getItem('turnero_mi_turno');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.token) return null;

        const hoyStr = new Date().toISOString().slice(0, 10);
        if (parsed.fecha && parsed.fecha !== hoyStr) {
          localStorage.removeItem('turnero_mi_turno');
          return null;
        }
        if (parsed.creado_en) {
          const fechaCreado = new Date(parsed.creado_en).toISOString().slice(0, 10);
          if (fechaCreado !== hoyStr) {
            localStorage.removeItem('turnero_mi_turno');
            return null;
          }
        }
        return parsed;
      } catch (_) {
        return null;
      }
    },

    /**
     * Guarda el turno activo en localStorage
     */
    guardarTurnoLocal (data) {
      try {
        const hoyStr = new Date().toISOString().slice(0, 10);
        localStorage.setItem('turnero_mi_turno', JSON.stringify({
          token: data.token,
          numero: data.numero,
          creado_en: data.creado_en,
          fecha: hoyStr
        }));
      } catch (_) {}
    },

    /**
     * Limpia el turno activo de localStorage al finalizar la atención
     */
    liberarTurnoSeguimiento () {
      try {
        localStorage.removeItem('turnero_mi_turno');
      } catch (_) {}
      this.soltarWakeLock();
      document.title = this.tituloOriginal;
      this.ticketData = { numero: null, token: null, creado_en: null, posicion_en_cola: 0, tiempoEstimadoMin: 0, tracking_url: '' };
      this.seguimientoData = { numero: null, estado: 'esperando', posicion: 0, mesa: null, llamado_en: null };
      this.step = 'welcome';
      window.history.replaceState({}, '', window.location.pathname + (this.esTablet ? '?modo=tablet' : ''));
    },

    /**
     * Consulta el estado del kiosko al abrir la pantalla
     */
    async verificarEstadoKiosko () {
      try {
        const res = await api.get('/kiosko/estado', { public: true });
        this.redLocalOk = true;
        this.kioskoActivo = res.activo === true;
        this.topeAlcanzado = res.tope_alcanzado === true;
        // Leer ajuste de impresión automática (solo aplica en modo tablet)
        if (res.impresion_automatica !== undefined) {
          this.impresionAutomatica = res.impresion_automatica === true;
        }

        if (!this.kioskoActivo) {
          this.errorMessage = 'El autoservicio digital no está activo actualmente. Por favor solicite su voucher en el módulo de recepción.';
        } else if (this.topeAlcanzado) {
          this.errorMessage = 'Se ha alcanzado el límite diario de turnos para el día de hoy.';
        } else {
          this.errorMessage = '';
        }
      } catch (err) {
        this.redLocalOk = false;
        console.warn('[Kiosko] No se pudo verificar estado del kiosko:', err);
      }
    },

    /**
     * Formatea el número de turno (#047)
     */
    formatTicket (num) {
      if (num === null || num === undefined || num === '' || isNaN(num)) return '--';
      return '#' + String(num).padStart(3, '0');
    },

    /**
     * Generación atómica de turno táctil (RF-GEN-02 con numeración propia e Idempotency-Key)
     */
    async generarTurno () {
      if (this.isGenerating || !this.kioskoActivo || this.topeAlcanzado) return;

      this.isGenerating = true;
      this.errorMessage = '';
      this.mostrarBotonReintentar = false;

      // Generar Idempotency-Key única si no hay una activa de un intento previo
      if (!this.currentIdempotencyKey) {
        this.currentIdempotencyKey = generarUUID();
      }

      try {
        const headers = {
          'Idempotency-Key': this.currentIdempotencyKey,
          'X-Device-Id': this.deviceId
        };

        const body = {
          idempotency_key: this.currentIdempotencyKey,
          device_id: this.deviceId,
          modo: this.esTablet ? 'tablet' : 'celular'
        };

        const data = await api.post('/turnos/generar', body, {
          headers,
          public: true
        });

        // Éxito: limpiar idempotency key para futuros turnos
        this.currentIdempotencyKey = null;

        const posicion = data.posicion_en_cola ?? 0;
        const estimadoMin = data.tiempo_estimado_min ?? Math.max(1, Math.round((posicion * 3) / 2));

        this.ticketData = {
          numero: data.numero,
          token: data.token,
          creado_en: data.creado_en,
          posicion_en_cola: posicion,
          tiempoEstimadoMin: estimadoMin,
          tracking_url: data.tracking_url || `${window.location.origin}/kiosko.html?token=${encodeURIComponent(data.token)}`
        };

        this.seguimientoData = {
          numero: data.numero,
          estado: 'esperando',
          posicion: posicion,
          mesa: null,
          llamado_en: null
        };

        // Si es smartphone, guardar en localStorage para persistencia ante recarga
        if (!this.esTablet) {
          this.guardarTurnoLocal(this.ticketData);
        }

        // Cambiar a pantalla de ticket / voucher
        this.step = 'ticket';
        this.mostrarToast(`Turno ${this.formatTicket(data.numero)} asignado exitosamente`);

        // Renderizar el código QR vectorial (200px)
        this.$nextTick(() => {
          this.generarCodigoQR(this.ticketData.tracking_url);
        });

        // Tablet: reset rápido de 8s con cuenta regresiva. Celular: 45s sin countdown.
        if (this.esTablet) {
          this.iniciarAutoReset(8);
          this.iniciarCuentaRegresiva(8);
          // Impresión automática en modo tablet cuando el ajuste está activo
          if (this.impresionAutomatica) {
            // El servidor ya disparó la impresión (setImmediate en routes.js).
            // Mostramos el aviso de confirmación; si hay error del servidor lo capturamos
            // en un POST adicional como verificación diferida.
            this._verificarImpresionAutoTablet();
          }
        } else {
          this.iniciarAutoReset(45);
        }

      } catch (err) {
        console.error('[Kiosko] Error al generar turno:', err);
        const status = err.status || 500;
        const codigo = err.codigo || '';

        if (status === 403 || codigo === 'kiosko_desactivado' || codigo === 'modo_no_kiosko') {
          this.errorMessage = err.message || 'El módulo de autoservicio no está activo. Solicite su voucher físico en el módulo de recepción.';
          this.kioskoActivo = false;
        } else if (status === 409 || codigo === 'tope_diario_alcanzado') {
          this.errorMessage = 'Se ha alcanzado el límite diario de turnos configurado para hoy.';
          this.topeAlcanzado = true;
        } else if (status === 429 || codigo === 'espere_antes_de_reintentar') {
          this.errorMessage = 'Por favor espere unos segundos antes de solicitar otro turno.';
        } else if (status === 503 || codigo === 'cola_llena') {
          this.errorMessage = 'El servidor está temporalmente sobrecargado. Intente en unos minutos.';
          this.mostrarBotonReintentar = true;
        } else {
          this.errorMessage = err.message || 'Error de comunicación con el nodo central. Compruebe la conexión de red.';
          this.mostrarBotonReintentar = true;
        }
      } finally {
        this.isGenerating = false;
      }
    },

    /**
     * Reintento ante fallo de red conservando la misma clave de idempotencia
     */
    async reintentar () {
      this.errorMessage = '';
      this.mostrarBotonReintentar = false;
      if (this.step === 'welcome') {
        await this.generarTurno();
      } else if (this.step === 'seguimiento' && this.ticketData.token) {
        await this.iniciarSeguimiento(this.ticketData.token);
      }
    },

    /**
     * Renderiza el código QR vectorial apuntando a la URL pública de seguimiento
     */
    generarCodigoQR (trackingUrl) {
      const container = document.getElementById('kiosko-qr-container');
      if (!container) return;

      container.innerHTML = '';
      this.qrFallback = false;

      if (window.QRCode) {
        try {
          new window.QRCode(container, {
            text: trackingUrl,
            width: 200,
            height: 200,
            colorDark: '#0F172A',
            colorLight: '#FFFFFF',
            correctLevel: window.QRCode.CorrectLevel.M
          });
        } catch (qrErr) {
          console.warn('[Kiosko] Librería QR reportó error. Activando enlace de respaldo:', qrErr);
          this.qrFallback = true;
        }
      } else {
        this.qrFallback = true;
      }
    },

    /**
     * Imprime el voucher.
     * - TABLET (esTablet=true): llama POST /kiosko/imprimir → impresora ESC/POS en red.
     *   Si la impresora no esta configurada o falla, muestra el error y ofrece fallback web.
     * - CELULAR: abre ventana aislada con el voucher → dialogo del sistema (PDF o impresora).
     */
    async imprimirTicket () {
      this.isPrinting = true;
      const num       = this.formatTicket(this.ticketData.numero);
      const numLimpio = num.replace('#', '');

      // ── MODO TABLET: impresion directa ESC/POS via backend ──────────────────
      if (this.esTablet) {
        try {
          const res = await fetch('/kiosko/imprimir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              numero:       this.ticketData.numero,
              formato:      num,
              modulo:       'Modulo General de Matriculas',
              tracking_url: this.ticketData.tracking_url || ''
            })
          });

          const data = await res.json().catch(() => ({}));

          if (res.ok) {
            this.mostrarToast(`${num} enviado a la impresora`);
          } else if (res.status === 409) {
            // Impresora no configurada → avisar y ofrecer ventana del sistema como fallback
            this.mostrarToast(`Sin impresora configurada — abriendo dialogo del sistema`);
            this._abrirVentanaImpresion(num, numLimpio);
          } else {
            // Error de red o timeout → mensaje descriptivo
            this.mostrarToast(data.mensaje || 'Error al enviar a la impresora');
          }
        } catch (err) {
          // Sin conexion al servidor (raro en LAN, pero posible)
          this.mostrarToast('No se pudo contactar al servidor de impresion');
          console.error('[Kiosko] Error fetch /kiosko/imprimir:', err);
        } finally {
          this.isPrinting = false;
          this.reiniciarAutoReset();
        }
        return;
      }

      // ── MODO CELULAR: ventana aislada con voucher HTML ───────────────────────
      this._abrirVentanaImpresion(num, numLimpio);
      this.isPrinting = false;
      this.reiniciarAutoReset();
    },

    /**
     * Abre una ventana emergente con el HTML del voucher para impresion/PDF.
     * Usado como flujo principal en celular y como fallback en tablet.
     */
    _abrirVentanaImpresion (num, numLimpio) {
      const trackingUrl = this.ticketData.tracking_url || '';
      const ahora = new Date();
      const fecha = ahora.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const hora  = ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

      // Capturar QR como data URL
      const qrContainer = document.getElementById('kiosko-qr-container');
      const qrCanvas = qrContainer?.querySelector('canvas');
      const qrImg    = qrContainer?.querySelector('img');
      let qrHtml = '';
      if (qrCanvas) {
        try { qrHtml = `<img src="${qrCanvas.toDataURL('image/png')}" width="130" height="130" alt="QR">`; } catch (_) {}
      } else if (qrImg?.src) {
        qrHtml = `<img src="${qrImg.src}" width="130" height="130" alt="QR">`;
      }
      if (!qrHtml && trackingUrl) {
        qrHtml = `<p class="url-fallback">${trackingUrl}</p>`;
      }

      const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Voucher-${numLimpio}-Matriculas2026</title>
  <style>
    @page { size: 80mm auto; margin: 4mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Courier New', Courier, monospace; background: #fff; display: flex; justify-content: center; padding: 2mm; }
    .voucher { width: 72mm; border: 1.5px solid #1e293b; border-radius: 4mm; padding: 5mm 4mm; text-align: center; }
    .inst   { font-size: 7pt; color: #475569; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 3mm; }
    .numero { font-size: 52pt; font-weight: 900; color: #0f172a; line-height: 1; letter-spacing: -1px; margin: 1mm 0; }
    .modulo { font-size: 7.5pt; color: #64748b; margin-bottom: 3mm; }
    .sep    { border: none; border-top: 1px dashed #cbd5e1; margin: 3mm 0; }
    .qr img { display: block; margin: 0 auto; }
    .qr-label  { font-size: 7pt; color: #64748b; margin-top: 2mm; }
    .url-fallback { font-size: 6pt; color: #3b82f6; word-break: break-all; margin-top: 1mm; }
    .pie    { font-size: 6.5pt; color: #94a3b8; margin-top: 3mm; padding-top: 2mm; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="voucher">
    <div class="inst">Matriculas 2026 - Turno Digital</div>
    <div class="numero">${num}</div>
    <div class="modulo">Modulo General de Matriculas</div>
    <hr class="sep">
    <div class="qr">
      ${qrHtml}
      <div class="qr-label">Escanea para seguir tu turno en tiempo real</div>
    </div>
    <div class="pie">${fecha} &bull; ${hora} &bull; Valido solo para hoy</div>
  </div>
</body>
</html>`;

      const win = window.open('', '_blank', 'width=340,height=520,toolbar=no,menubar=no');
      if (!win) { this.mostrarToast('Permite las ventanas emergentes para imprimir'); return; }

      win.document.write(html);
      win.document.close();
      win.focus();
      win.onload = () => { win.print(); win.close(); };
      setTimeout(() => { try { win.print(); win.close(); } catch (_) {} }, 900);

      this.mostrarToast(`Voucher ${num} listo para imprimir`);
      document.title = `Voucher-${numLimpio}-Matriculas2026`;
      setTimeout(() => { document.title = this.tituloOriginal; }, 3000);
    },

    /**
     * Vuelve a la pantalla inicial de bienvenida y limpia los datos de memoria
     */
    volverABienvenida () {
      if (this.autoResetTimer) {
        clearTimeout(this.autoResetTimer);
        this.autoResetTimer = null;
      }
      this.errorMessage = '';
      this.ticketData = {
        numero: null,
        token: null,
        creado_en: null,
        posicion_en_cola: 0,
        tiempoEstimadoMin: 0,
        tracking_url: ''
      };
      this.step = 'welcome';
    },

    /**
     * Inicia o reinicia el retorno automático.
     * Tablet: 8s. Celular/presencial: 45s.
     */
    iniciarAutoReset (segundos) {
      const seg = segundos ?? (this.esTablet ? 8 : 45);
      if (this.autoResetTimer) clearTimeout(this.autoResetTimer);
      this.autoResetTimer = setTimeout(() => {
        this.volverABienvenida();
      }, seg * 1000);
    },

    /**
     * Cuenta regresiva visible en pantalla (solo tablet)
     */
    iniciarCuentaRegresiva (segundos) {
      if (this.cuentaRegresivaTimer) clearInterval(this.cuentaRegresivaTimer);
      this.cuentaRegresiva = segundos;
      this.cuentaRegresivaTimer = setInterval(() => {
        this.cuentaRegresiva--;
        if (this.cuentaRegresiva <= 0) {
          clearInterval(this.cuentaRegresivaTimer);
          this.cuentaRegresivaTimer = null;
          this.cuentaRegresiva = 0;
        }
      }, 1000);
    },

    reiniciarAutoReset () {
      if (this.step === 'ticket') {
        const seg = this.esTablet ? 8 : 45;
        this.iniciarAutoReset(seg);
        if (this.esTablet) this.iniciarCuentaRegresiva(seg);
      }
    },

    /**
     * Tablet: asigna el siguiente turno de inmediato sin pasar por bienvenida.
     * Limpia el ticket actual y lanza generarTurno() directamente.
     */
    async asignarSiguiente () {
      if (this.autoResetTimer) { clearTimeout(this.autoResetTimer); this.autoResetTimer = null; }
      if (this.cuentaRegresivaTimer) { clearInterval(this.cuentaRegresivaTimer); this.cuentaRegresivaTimer = null; }
      this.cuentaRegresiva = 0;
      this.errorMessage = '';
      this.ticketData = { numero: null, token: null, creado_en: null, posicion_en_cola: 0, tiempoEstimadoMin: 0, tracking_url: '' };
      this.step = 'welcome';
      // Pequeña pausa visual para que el empleado vea el reset antes de generar
      await new Promise(r => setTimeout(r, 300));
      await this.generarTurno();
    },

    /**
     * Conexión WebSocket al canal público único 'kiosko:publico' (RF-WS-01)
     */
    conectarWebSocketPublico () {
      if (this.ws) return;

      this.ws = new TurneroWSClient({
        canal: 'kiosko:publico',
        token: ''
      });

      this.ws.onStatusChange(({ status }) => {
        this.wsConectado = status === 'CONECTADO';
        this.redLocalOk = status === 'CONECTADO';
      });

      this.ws.on('snapshot', (payload) => {
        if (payload && (this.step === 'seguimiento' || this.step === 'ticket')) {
          this.procesarAvisoLlamados(payload);
        }
      });

      this.ws.on('llamados', (payload) => {
        if (payload && (this.step === 'seguimiento' || this.step === 'ticket')) {
          this.procesarAvisoLlamados(payload);
        }
      });

      this.ws.on('config_actualizada', (payload) => {
        if (!payload) return;
        if (payload.clave === 'kiosko_web_activo') {
          this.kioskoActivo = String(payload.valor).toLowerCase() === 'true';
          if (!this.kioskoActivo) {
            this.errorMessage = 'El autoservicio digital no está activo actualmente. Por favor solicite su voucher en el módulo de recepción.';
          } else {
            if (!this.topeAlcanzado) this.errorMessage = '';
          }
        } else if (payload.clave === 'kiosko_impresion_automatica') {
          // Solo relevante en tablet, pero actualizamos siempre (reactivo)
          this.impresionAutomatica = String(payload.valor).toLowerCase() === 'true';
        }
      });

      this.ws.connect();
    },

    /**
     * Procesa los avisos en tiempo real para el smartphone del estudiante
     */
    procesarAvisoLlamados (payload) {
      const miNumero = this.seguimientoData.numero;
      if (!miNumero) return;

      const ultimo = payload.ultimo_llamado;
      const ultimos = payload.ultimos_llamados || [];

      // 1. Verificar si mi número fue llamado a ventanilla
      const llamadoDirecto = ultimo && Number(ultimo.numero) === Number(miNumero);
      const enUltimos = ultimos.find(u => Number(u.numero) === Number(miNumero));

      if (llamadoDirecto || enUltimos) {
        const infoLlamado = llamadoDirecto ? ultimo : enUltimos;
        const nombreMesa = infoLlamado.mesa_nombre || (infoLlamado.mesa_numero ? `Mesa ${infoLlamado.mesa_numero}` : 'Ventanilla');

        this.step = 'seguimiento';
        this.seguimientoData.estado = 'en_atencion';
        this.seguimientoData.mesa = nombreMesa;
        this.seguimientoData.llamado_en = infoLlamado.llamado_en || new Date().toISOString();

        // Alerta audiovisual intensiva
        this.emitirAlertaLlamado(nombreMesa);
        return;
      }

      // 2. Si sigo en espera, actualizar la posición calculada
      if (this.seguimientoData.estado === 'esperando') {
        if (ultimo && ultimo.numero) {
          const diferencia = Math.max(0, miNumero - Number(ultimo.numero) - 1);
          this.seguimientoData.posicion = diferencia;
        } else if (payload.proximo_numero && miNumero >= payload.proximo_numero) {
          this.seguimientoData.posicion = Math.max(0, miNumero - Number(payload.proximo_numero));
        }

        // Resincronización con el servidor para garantizar posición exacta real
        if (this.ticketData.token && !this._syncDebounce) {
          this._syncDebounce = setTimeout(() => {
            this._syncDebounce = null;
            if (this.ticketData.token && this.step === 'seguimiento') {
              this.sincronizarSeguimiento(this.ticketData.token);
            }
          }, 600);
        }
      }
    },

    /**
     * Emite chime institucional, vibración y titila título de pestaña
     */
    async emitirAlertaLlamado (nombreMesa) {
      try {
        await playCallChime();
      } catch (_) {}

      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        try {
          navigator.vibrate([300, 150, 300, 150, 600]);
        } catch (_) {}
      }

      document.title = `¡TU TURNO! ${nombreMesa} — Matrículas 2026`;
      this.mostrarToast(`¡Es tu turno! Dirígete a ${nombreMesa}`);
    },

    /**
     * Modo Smartphone: Inicia seguimiento personal y bloquea pantalla apagada
     */
    async iniciarSeguimiento (token) {
      this.ticketData.token = token;
      this.errorMessage = '';
      this.mostrarBotonReintentar = false;

      // Solicitar mantener pantalla encendida (Screen WakeLock API)
      this.solicitarWakeLock();

      await this.sincronizarSeguimiento(token);
    },

    /**
     * Consulta única a /turnos/mi-turno/:token para sincronización precisa
     */
    async sincronizarSeguimiento (token) {
      try {
        const res = await api.get(`/turnos/mi-turno/${token}`, { public: true });
        this.redLocalOk = true;

        // Comprobar si el turno es de hoy o de un día anterior
        const hoyStr = new Date().toISOString().slice(0, 10);
        const fechaTurnoStr = res.fecha_turno ? new Date(res.fecha_turno).toISOString().slice(0, 10) : null;
        const esDiaAnterior = Boolean(fechaTurnoStr && fechaTurnoStr !== hoyStr);

        if (res.estado === 'cancelado' || esDiaAnterior) {
          this.liberarTurnoSeguimiento();
          this.errorMessage = 'Su turno anterior ha caducado o fue cancelado por el operador. Puede solicitar un nuevo turno.';
          return;
        }

        if (res.estado === 'atendido') {
          this.seguimientoData = {
            numero: res.numero,
            estado: 'atendido',
            posicion: 0,
            mesa: res.mesa || null,
            llamado_en: res.llamado_en || null
          };
          return;
        }

        this.seguimientoData = {
          numero: res.numero,
          estado: res.estado,
          posicion: res.posicion ?? 0,
          mesa: res.mesa || null,
          llamado_en: res.llamado_en || null
        };

        if (res.estado === 'en_atencion' && res.mesa) {
          this.emitirAlertaLlamado(res.mesa);
        }

      } catch (err) {
        console.error('[Seguimiento] Error consultando mi turno:', err);
        const status = err.status || 0;
        if (status === 404) {
          this.liberarTurnoSeguimiento();
          this.errorMessage = 'El enlace no es válido o el turno ha expirado. Puede solicitar un nuevo turno.';
        } else if (status === 503) {
          this.errorMessage = 'El servidor está temporalmente ocupado. Reintentando...';
          this.mostrarBotonReintentar = true;
        } else {
          this.errorMessage = 'Sin conexión con el servidor del campus. Verifique su WiFi.';
          this.mostrarBotonReintentar = true;
        }
      }
    },

    /**
     * Solicita mantener pantalla encendida para el estudiante
     */
    async solicitarWakeLock () {
      if ('wakeLock' in navigator) {
        try {
          this.wakeLockSentinel = await navigator.wakeLock.request('screen');
        } catch (wlErr) {
          console.info('[Kiosko] WakeLock no disponible:', wlErr.message);
        }
      }
    },

    soltarWakeLock () {
      if (this.wakeLockSentinel) {
        try {
          this.wakeLockSentinel.release();
        } catch (_) {}
        this.wakeLockSentinel = null;
      }
    },

    /**
     * Despliega notificación toast no intrusiva
     */
    mostrarToast (mensaje) {
      this.toastMessage = mensaje;
      this.showToast = true;
      setTimeout(() => {
        this.showToast = false;
      }, 4000);
    },

    /**
     * Verificación diferida de impresión automática en modo tablet.
     * El servidor ya disparó la impresión vía setImmediate; este método confirma
     * con un POST /kiosko/imprimir que la impresión no haya fallado silenciosamente.
     * Si falló, muestra un aviso visible sin afectar el turno ya creado.
     */
    async _verificarImpresionAutoTablet () {
      // Pequeña pausa para que el setImmediate del servidor alcance la impresora
      await new Promise(r => setTimeout(r, 1200));
      try {
        await api.post('/kiosko/imprimir', {
          turno_id:     this.ticketData.id,
          numero:       this.ticketData.numero,
          token:        this.ticketData.token,
          tracking_url: this.ticketData.tracking_url || ''
        });
      } catch (printErr) {
        // La impresión falló — aviso no bloqueante. El turno sigue siendo válido.
        const codigo = printErr.code || '';
        let aviso = `Turno ${this.formatTicket(this.ticketData.numero)} generado. `;
        if (codigo === 'IMPRESORA_INACTIVA' || codigo === 'IP_NO_CONFIGURADA') {
          aviso += 'Impresora no configurada — entregue el número manualmente.';
        } else if (codigo === 'TIMEOUT') {
          aviso += 'La impresora no respondió — reintente desde el panel o entregue el número manualmente.';
        } else {
          aviso += 'Error de impresión — el turno ya está registrado.';
        }
        this.mostrarToast(aviso);
        console.warn('[Kiosko] Impresión automática no confirmada:', printErr.message || printErr);
      }
    },

    /**
     * Limpieza en desmontaje
     */
    destroy () {
      if (this.autoResetTimer) clearTimeout(this.autoResetTimer);
      if (this.cuentaRegresivaTimer) clearInterval(this.cuentaRegresivaTimer);
      if (this.ws) this.ws.disconnect();
      if (this._onVisibilityHandler) {
        document.removeEventListener('visibilitychange', this._onVisibilityHandler);
        this._onVisibilityHandler = null;
      }
      this.soltarWakeLock();
      document.title = this.tituloOriginal;
    }
  };
}

// ── Registro idempotente con Alpine.js ──────────────────────────────────────
function registerKioskoWithAlpine() {
  if (typeof window !== 'undefined' && window.Alpine) {
    window.Alpine.data('kioskoView', kioskoView);
  }
}

if (typeof window !== 'undefined' && window.Alpine) {
  registerKioskoWithAlpine();
} else if (typeof document !== 'undefined') {
  document.addEventListener('alpine:init', registerKioskoWithAlpine);
}
