/**
 * ==============================================================================
 * ESCPOS-PRINTER.JS — Controlador y Generador ESC/POS para Kiosko Web
 * Sistema Turnero de Matriculas 2026 (v2.1)
 *
 * Provee:
 *  1. Generador de secuencias binarias estándar ESC/POS (Uint8Array).
 *  2. Conector Web Bluetooth (GATT) para impresoras térmicas portátiles.
 *  3. Helpers para formateo de tickets y pruebas locales.
 *
 * Cumple: RF-USA-04 (Cero emojis), Offline-First, LAN Resilient.
 * ==============================================================================
 */

const ESC = 0x1B;
const GS  = 0x1D;

export const ESCPOS_CMD = {
  INIT:          new Uint8Array([ESC, 0x40]),
  ALIGN_CENTER:  new Uint8Array([ESC, 0x61, 0x01]),
  ALIGN_LEFT:    new Uint8Array([ESC, 0x61, 0x00]),
  BOLD_ON:       new Uint8Array([ESC, 0x45, 0x01]),
  BOLD_OFF:      new Uint8Array([ESC, 0x45, 0x00]),
  DOUBLE_HEIGHT: new Uint8Array([ESC, 0x21, 0x10]),
  NORMAL_SIZE:   new Uint8Array([ESC, 0x21, 0x00]),
  FONT_LARGE:    new Uint8Array([GS,  0x21, 0x11]), // 2x alto y ancho
  FONT_HUGE:     new Uint8Array([GS,  0x21, 0x22]), // 3x alto y ancho
  FONT_NORMAL:   new Uint8Array([GS,  0x21, 0x00]),
  LINE_FEED:     new Uint8Array([0x0A]),
  CUT_FULL:      new Uint8Array([GS,  0x56, 0x41, 0x02]), // Avance 2 líneas y corte completo
  CUT_PARTIAL:   new Uint8Array([GS,  0x56, 0x42, 0x02])  // Avance 2 líneas y corte parcial
};

const encoder = new TextEncoder();

/**
 * Convierte un string en Uint8Array con salto de línea.
 * @param {string} str 
 * @returns {Uint8Array}
 */
export function encodeText(str) {
  return encoder.encode(str + '\n');
}

/**
 * Concatena múltiples Uint8Array en uno solo.
 * @param {Uint8Array[]} arrays 
 * @returns {Uint8Array}
 */
export function concatBytes(arrays) {
  const totalLength = arrays.reduce((acc, curr) => acc + curr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Genera comandos ESC/POS para imprimir un código QR nativo.
 * @param {string} url 
 * @returns {Uint8Array[]}
 */
export function generarComandosQRESCPOS(url) {
  if (!url || typeof url !== 'string' || url.trim() === '') return [];
  const cleanUrl = url.trim();
  const data = encoder.encode(cleanUrl);
  const pL = (data.length + 3) % 256;
  const pH = Math.floor((data.length + 3) / 256);

  return [
    ESCPOS_CMD.ALIGN_CENTER,
    // Modelo 2: GS ( k 0x04 0x00 0x31 0x41 0x32 0x00
    new Uint8Array([GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    // Tamaño de módulo (5 puntos): GS ( k 0x03 0x00 0x31 0x43 0x05
    new Uint8Array([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x05]),
    // Corrección de error M: GS ( k 0x03 0x00 0x31 0x45 0x31
    new Uint8Array([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31]),
    // Almacenar datos: GS ( k pL pH 0x31 0x50 0x30 <data>
    new Uint8Array([GS, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30]),
    data,
    // Imprimir QR del buffer: GS ( k 0x03 0x00 0x31 0x51 0x30
    new Uint8Array([GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]),
    ESCPOS_CMD.LINE_FEED
  ];
}

/**
 * Construye el buffer binario ESC/POS para el ticket térmico.
 * @param {object} ticket 
 * @returns {Uint8Array}
 */
export function construirVoucherESCPOS(ticket = {}) {
  const ahora = new Date();
  const fechaStr = ticket.fecha || ahora.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const horaStr  = ticket.hora  || ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const formato  = ticket.formato || `#${String(ticket.numero || 0).padStart(3, '0')}`;
  const modulo   = ticket.modulo || 'Modulo General de Matriculas';
  const url      = ticket.tracking_url || '';

  const partes = [
    ESCPOS_CMD.INIT,
    ESCPOS_CMD.ALIGN_CENTER,

    // Encabezado
    ESCPOS_CMD.BOLD_ON,
    encodeText('MATRICULAS 2026'),
    ESCPOS_CMD.BOLD_OFF,
    encodeText('Turno Digital'),
    ESCPOS_CMD.LINE_FEED,

    encodeText('--------------------------------'),

    // Número de turno colosal
    ESCPOS_CMD.FONT_LARGE,
    ESCPOS_CMD.BOLD_ON,
    encodeText(formato),
    ESCPOS_CMD.BOLD_OFF,
    ESCPOS_CMD.FONT_NORMAL,
    ESCPOS_CMD.LINE_FEED,

    // Módulo
    ESCPOS_CMD.DOUBLE_HEIGHT,
    encodeText(modulo),
    ESCPOS_CMD.NORMAL_SIZE,
    ESCPOS_CMD.LINE_FEED,

    encodeText('--------------------------------'),

    // Código QR nativo ESC/POS
    ...generarComandosQRESCPOS(url),

    // Instrucción y URL
    ESCPOS_CMD.ALIGN_CENTER,
    ESCPOS_CMD.BOLD_ON,
    encodeText('Consulta tu turno:'),
    ESCPOS_CMD.BOLD_OFF
  ];

  if (url) {
    partes.push(encodeText(url));
    partes.push(ESCPOS_CMD.LINE_FEED);
  }

  // Pie y corte
  partes.push(
    encodeText(`${fechaStr} ${horaStr}`),
    encodeText('Valido solo para hoy'),
    ESCPOS_CMD.LINE_FEED,
    ESCPOS_CMD.LINE_FEED,
    ESCPOS_CMD.LINE_FEED,
    ESCPOS_CMD.CUT_PARTIAL
  );

  return concatBytes(partes);
}

// ── Servicios Bluetooth conocidos para impresoras térmicas ESC/POS ───────────
const BLE_PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // Servicio estándar ESC/POS
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC Transparent UART
  0xffe0                                  // HM-10 y genéricas
];

/**
 * Cliente Web Bluetooth para impresoras térmicas portátiles.
 */
export class WebBluetoothThermalPrinter {
  constructor() {
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.deviceName = '';
    this.status = 'desconectado'; // 'desconectado' | 'conectando' | 'conectado' | 'error'
    this.onStatusChange = null;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);
  }

  _setStatus(st) {
    this.status = st;
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(st, this.deviceName);
    }
  }

  async conectar() {
    if (!WebBluetoothThermalPrinter.isSupported()) {
      throw new Error('Web Bluetooth no está soportado en este navegador o requiere conexión HTTPS.');
    }

    this._setStatus('conectando');

    try {
      // 1. Escanear dispositivos (con fallback de acceptAllDevices)
      let dev = null;
      try {
        dev = await navigator.bluetooth.requestDevice({
          filters: [
            { services: ['000018f0-0000-1000-8000-00805f9b34fb'] },
            { services: ['e7810a71-73ae-499d-8c15-faa9aef0c3f2'] },
            { services: ['49535343-fe7d-4ae5-8fa9-9fafd205e455'] },
            { services: [0xffe0] }
          ],
          optionalServices: BLE_PRINTER_SERVICES
        });
      } catch (filterErr) {
        // Si no coincide con los filtros estándar, permitir seleccionar entre todos los dispositivos visibles
        dev = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: BLE_PRINTER_SERVICES
        });
      }

      if (!dev) {
        throw new Error('No se seleccionó ningún dispositivo Bluetooth.');
      }

      this.device = dev;
      this.deviceName = dev.name || 'Impresora Bluetooth';

      dev.addEventListener('gattserverdisconnected', () => {
        this.characteristic = null;
        this.server = null;
        this._setStatus('desconectado');
      });

      // 2. Conectar al GATT Server
      this.server = await dev.gatt.connect();

      // 3. Buscar el servicio y característica de escritura
      const services = await this.server.getPrimaryServices();
      let targetChar = null;

      for (const service of services) {
        try {
          const chars = await service.getCharacteristics();
          for (const c of chars) {
            if (c.properties.write || c.properties.writeWithoutResponse) {
              targetChar = c;
              break;
            }
          }
        } catch (_) {}
        if (targetChar) break;
      }

      if (!targetChar) {
        throw new Error('No se encontró una característica de escritura en la impresora Bluetooth seleccionada.');
      }

      this.characteristic = targetChar;
      this._setStatus('conectado');

      try {
        localStorage.setItem('turnero_kiosko_bt_name', this.deviceName);
      } catch (_) {}

      return { ok: true, nombre: this.deviceName };
    } catch (err) {
      this._setStatus('desconectado');
      throw err;
    }
  }

  desconectar() {
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      try {
        this.device.gatt.disconnect();
      } catch (_) {}
    }
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.deviceName = '';
    this._setStatus('desconectado');
    try {
      localStorage.removeItem('turnero_kiosko_bt_name');
    } catch (_) {}
  }

  isConnected() {
    return Boolean(this.server && this.server.connected && this.characteristic);
  }

  /**
   * Envía los bytes ESC/POS en bloques seguros (chunking de 128 bytes).
   * @param {Uint8Array} data 
   */
  async imprimir(data) {
    if (!this.isConnected()) {
      // Intentar reconectar si tenemos el dispositivo instanciado
      if (this.device && this.device.gatt) {
        this._setStatus('conectando');
        this.server = await this.device.gatt.connect();
        const services = await this.server.getPrimaryServices();
        for (const service of services) {
          try {
            const chars = await service.getCharacteristics();
            for (const c of chars) {
              if (c.properties.write || c.properties.writeWithoutResponse) {
                this.characteristic = c;
                break;
              }
            }
          } catch (_) {}
          if (this.characteristic) break;
        }
        if (!this.characteristic) {
          throw new Error('La impresora Bluetooth se desconectó. Vuelva a vincularla.');
        }
        this._setStatus('conectado');
      } else {
        throw new Error('No hay impresora Bluetooth conectada. Vincule una desde ajustes.');
      }
    }

    const CHUNK_SIZE = 128;
    for (let i = 0; i < data.length; i += CHUNK_SIZE) {
      const chunk = data.slice(i, i + CHUNK_SIZE);
      if (this.characteristic.properties.writeWithoutResponse) {
        await this.characteristic.writeValueWithoutResponse(chunk);
      } else {
        await this.characteristic.writeValueWithResponse(chunk);
      }
      // Pequeño retardo entre bloques para evitar saturar el buffer de la impresora
      await new Promise(r => setTimeout(r, 20));
    }

    return { ok: true };
  }
}
