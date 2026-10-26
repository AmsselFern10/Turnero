const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Verificación de Rediseño UI/UX y Lógica de Kiosko (Tablet/Celular) en HTTP LAN', async () => {
  const kioskoHtmlPath = path.join(__dirname, '../src/public/kiosko.html');
  const kioskoJsPath = path.join(__dirname, '../src/public/js/pages/kiosko.js');

  const kioskoHtml = fs.readFileSync(kioskoHtmlPath, 'utf8');
  const kioskoJs = fs.readFileSync(kioskoJsPath, 'utf8');

  // 1. Eliminación del Botón de Configuración en el Voucher
  assert.ok(
    !kioskoHtml.includes('abrirModalImpresora()') ||
    !kioskoHtml.match(/<!-- ACCIONES -->[\s\S]*?abrirModalImpresora\(\)[\s\S]*?Volver al inicio/),
    'El botón "Configurar" debe estar eliminado por completo de las acciones del voucher'
  );
  assert.ok(
    !kioskoHtml.includes('Configurar</button>') && !kioskoHtml.includes('Configurar\n') && !kioskoHtml.includes('Configurar</span>'),
    'No debe existir ningún botón o texto "Configurar" en el comprobante del ticket'
  );

  // Control centralizado en el header
  assert.ok(
    kioskoHtml.includes('x-show="impresoraServidorActiva"') &&
    kioskoHtml.includes('@click="abrirModalImpresora()"') &&
    kioskoHtml.includes('aria-label="Configuración de impresora de tickets"'),
    'La configuración de impresora debe estar centralizada en el header bajo x-show="impresoraServidorActiva"'
  );

  // 2. Responsividad en Tablets y Celulares
  // Header adaptable
  assert.ok(
    kioskoHtml.includes('flex flex-wrap items-center justify-between gap-2.5 sm:gap-4'),
    'El header debe usar flex-wrap y espaciado responsivo para evitar solapamientos'
  );
  assert.ok(
    kioskoHtml.includes('badgeImpresoraTextoMobile'),
    'El header debe contar con versión móvil de la insignia de impresora'
  );
  assert.ok(
    kioskoHtml.includes('<span class="hidden sm:inline">Salir al inicio</span>') &&
    kioskoHtml.includes('<span class="sm:hidden">Inicio</span>'),
    'El botón de salir al inicio debe adaptarse en pantallas angostas'
  );

  // Canvas y tarjetas responsivas
  assert.ok(
    kioskoHtml.includes('px-3 sm:px-4 py-4 sm:py-6') &&
    kioskoHtml.includes('p-4 sm:p-6 md:p-8'),
    'El canvas central y las tarjetas deben tener padding responsivo para tablets y celulares'
  );
  assert.ok(
    kioskoHtml.includes('min-h-[48px] h-12 sm:h-14'),
    'Los botones principales deben tener un área táctil mínima de 48px'
  );

  // QR responsivo en kiosko.js
  assert.ok(
    kioskoJs.includes('const anchoPantalla = typeof window !== \'undefined\' ? window.innerWidth : 400') &&
    kioskoJs.includes('anchoPantalla < 420 ? 160 : 190'),
    'El código QR debe escalar su tamaño dinámicamente según el ancho de la pantalla'
  );

  // 3. Restricción HTTP para Web Bluetooth y Guía de Red LAN
  // Lógica en kiosko.js
  assert.ok(
    kioskoJs.includes('get esHttpNoSeguro ()'),
    'kiosko.js debe implementar el getter esHttpNoSeguro'
  );
  assert.ok(
    kioskoJs.includes('get bluetoothBloqueadoPorHttp ()'),
    'kiosko.js debe implementar el getter bluetoothBloqueadoPorHttp'
  );
  assert.ok(
    kioskoJs.includes('Impresión por red LAN recomendada'),
    'badgeImpresoraTexto debe mostrar advertencia sutil recomendando red LAN cuando Bluetooth está en HTTP'
  );
  assert.ok(
    kioskoJs.includes('LAN recomendada'),
    'badgeImpresoraTextoMobile debe mostrar versión compacta recomendando LAN'
  );

  // Modal de Impresora en kiosko.html
  assert.ok(
    kioskoHtml.includes('Recomendado para red LAN'),
    'Opción 1 (TCP/IP) debe destacar la insignia "Recomendado para red LAN"'
  );
  assert.ok(
    kioskoHtml.includes(':disabled="bluetoothBloqueadoPorHttp || !bluetoothDisponible"'),
    'Opción 2 (Bluetooth) debe estar deshabilitada si bluetoothBloqueadoPorHttp es verdadero'
  );
  assert.ok(
    kioskoHtml.includes('Requiere HTTPS') &&
    kioskoHtml.includes('En red HTTP use <strong>Impresión LAN (TCP/IP)</strong> o <strong>Controlador del Sistema</strong>'),
    'Opción 2 (Bluetooth) debe mostrar la advertencia y badge explicativo sobre la restricción HTTP'
  );
  assert.ok(
    kioskoHtml.includes('Controlador del Sistema (Ventana / Diálogo nativo)') &&
    kioskoHtml.includes('Nativo') &&
    kioskoHtml.includes('Compatible con red local HTTP'),
    'Opción 3 (Controlador del Sistema) debe indicar que es compatible nativamente con HTTP local'
  );

  // 4. Lógica de impresión según configuración del Admin
  // Manual vs Automática vs Desactivada
  assert.ok(
    kioskoHtml.includes('impresoraServidorActiva && tieneImpresoraHabilitada && !impresionAutomatica'),
    'El botón "Imprimir voucher" solo debe aparecer si la impresión manual está activa en admin y hay impresora habilitada'
  );
  assert.ok(
    kioskoHtml.includes('!impresionAutomatica'),
    'Si la impresión automática está activa, no debe mostrarse el botón de imprimir'
  );
  assert.ok(
    kioskoHtml.includes('x-show="impresoraServidorActiva"'),
    'Si la impresión general está desactivada en admin, la configuración en el header permanece oculta'
  );
});
