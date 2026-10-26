const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Verificación de UI/UX en Configuración: Distribución en 2 Columnas, Botón Probar, Modo Físico y Modal Info', async () => {
  const adminHtmlPath = path.join(__dirname, '../src/public/admin.html');
  const adminJsPath = path.join(__dirname, '../src/public/js/pages/admin.js');
  const componentsCssPath = path.join(__dirname, '../src/public/css/components.css');

  const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
  const adminJs = fs.readFileSync(adminJsPath, 'utf8');
  const componentsCss = fs.readFileSync(componentsCssPath, 'utf8');

  // 1. Modo Físico con etiqueta discreta 'Predeterminado' bajo el título
  assert.ok(
    adminHtml.includes('Predeterminado') && adminHtml.includes('Físico / Talonario'),
    'Debe contener la etiqueta visible "Predeterminado" en la tarjeta de Modo Físico'
  );
  assert.ok(
    adminHtml.includes('Vouchers de papel</span>') && adminHtml.includes('badge-default-subtle uppercase tracking-wide">Predeterminado</span>'),
    'La insignia Predeterminado debe ubicarse de forma compacta en la línea de subtítulo con .badge-default-subtle'
  );
  assert.ok(
    componentsCss.includes('.badge-default-subtle'),
    'components.css debe definir .badge-default-subtle con font-size de 9px y padding compacto'
  );

  // 2. Iconos (i) clickeables vinculados a abrirModalInfoModo
  assert.ok(
    adminHtml.includes("abrirModalInfoModo('fisico')"),
    'El botón de información en Modo Físico debe llamar a abrirModalInfoModo(\'fisico\')'
  );
  assert.ok(
    adminHtml.includes("abrirModalInfoModo('asistido')"),
    'El botón de información en Modo Asistido debe llamar a abrirModalInfoModo(\'asistido\')'
  );
  assert.ok(
    adminHtml.includes("abrirModalInfoModo('estudiante')"),
    'El botón de información en Modo Estudiantil debe llamar a abrirModalInfoModo(\'estudiante\')'
  );

  // 3. Consolidación en 2 Columnas (50% / 50%) para Asistido y Estudiantil
  assert.ok(
    adminHtml.includes('grid-cols-1 md:grid-cols-2') && adminHtml.includes('Límite Diario y Control de Emisión:'),
    'Modo Asistido debe consolidar Límite Diario y Enlace en una cuadrícula de 2 columnas fijas (50%/50%)'
  );
  assert.ok(
    adminHtml.includes('grid-cols-1 md:grid-cols-2') && adminHtml.includes('Límite Diario de Turnos Móviles:'),
    'Modo Estudiantil debe consolidar Límite Diario y Enlace en una cuadrícula de 2 columnas fijas (50%/50%)'
  );
  assert.ok(
    adminHtml.includes('input-compact'),
    'Los campos de Límite Diario deben usar la clase input-compact para evitar deformaciones'
  );
  assert.ok(
    componentsCss.includes('.input-compact'),
    'components.css debe definir .input-compact con ancho máximo fijo'
  );

  // 4. Corrección del botón Probar y eliminación de URLs redundantes en Bloque B
  assert.ok(
    adminHtml.includes('Diagnóstico de Red Local:'),
    'Bloque B debe estructurar la columna 1 como Diagnóstico de Red Local'
  );
  assert.ok(
    adminHtml.includes('inline-flex items-center gap-1.5 text-slate-700 border border-slate-300'),
    'El botón de prueba debe ser un botón de acción secundario compacto (outline) y no abarcar el 100% del ancho'
  );
  assert.ok(
    adminHtml.includes('gap-8 items-start'),
    'La cuadrícula de diagnóstico y dirección pública debe tener un espaciado amplio (gap-8)'
  );
  assert.ok(
    !adminHtml.includes('label class="font-semibold block text-slate-700 text-xs">URL en Red Local (LAN):</label>'),
    'Debe eliminar la etiqueta redundante de URL en Red Local en Bloque B'
  );

  // 5. Modal modalInfoModo en admin.html
  assert.ok(
    adminHtml.includes('x-show="modalInfoModo"'),
    'admin.html debe contener el modal modalInfoModo'
  );
  assert.ok(
    adminHtml.includes('¿Cómo funciona esta modalidad?'),
    'El modal debe contener las explicaciones paso a paso de cada modalidad'
  );

  // 6. Estado y métodos en admin.js
  assert.ok(
    adminJs.includes('modalInfoModo: null'),
    'admin.js debe registrar modalInfoModo: null en su estado Alpine'
  );
  assert.ok(
    adminJs.includes('abrirModalInfoModo(modo)'),
    'admin.js debe implementar el método abrirModalInfoModo(modo)'
  );
  assert.ok(
    adminJs.includes('cerrarModalInfoModo()'),
    'admin.js debe implementar el método cerrarModalInfoModo()'
  );

  // 7. Configuración de Impresión: Lógica condicional, colapso en Modo Físico y Tooltips
  assert.ok(
    adminHtml.includes("getModoOperacionActual() === 'fisico'") &&
    adminHtml.includes('La impresión digital no aplica en el Modo Físico'),
    'Debe colapsar el bloque de impresión a una línea informativa cuando el Modo Físico está activo'
  );
  assert.ok(
    adminHtml.includes("getModoOperacionActual() !== 'fisico'"),
    'El formulario de impresión debe desplegarse únicamente cuando el modo es Asistido o Estudiantil'
  );
  assert.ok(
    componentsCss.includes('.tooltip-container') && componentsCss.includes('.tooltip-bubble'),
    'components.css debe contener clases institucionales para tooltips flotantes (.tooltip-container, .tooltip-bubble)'
  );
  assert.ok(
    adminHtml.includes('tooltip-container') && adminHtml.includes('Define el formato tipográfico, márgenes y código QR'),
    'El campo Ancho del Papel debe utilizar un tooltip flotante en lugar de texto estático permanente'
  );
  assert.ok(
    adminHtml.includes('tooltip-container') && adminHtml.includes('En modo manual el personal o estudiante pulsa'),
    'El campo Comportamiento en Pantalla debe utilizar un tooltip flotante en lugar de texto estático permanente'
  );
  assert.ok(
    adminHtml.includes('gap-8 lg:gap-12') && adminHtml.includes('select-compact-ticket'),
    'La cuadrícula de opciones de impresión debe tener una separación generosa (gap-8 lg:gap-12) y select compacto con .select-compact-ticket'
  );
  assert.ok(
    componentsCss.includes('.select-compact-ticket') && componentsCss.includes('.button-group-compact'),
    'components.css debe definir .select-compact-ticket y .button-group-compact con max-width fijo'
  );

  // 8. Cero emojis
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  assert.ok(!emojiRegex.test(adminHtml), 'admin.html no debe contener emojis (RF-USA-04)');
});
