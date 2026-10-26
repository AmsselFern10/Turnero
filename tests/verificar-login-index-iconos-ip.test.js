const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Verificación de Index: Iconos SVG limpios, CSS de icon-box y Redirección a IP configurada', async () => {
  const indexHtmlPath = path.join(__dirname, '../src/public/index.html');
  const loginJsPath = path.join(__dirname, '../src/public/js/pages/login.js');
  const componentsCssPath = path.join(__dirname, '../src/public/css/components.css');
  const kioskoServicePath = path.join(__dirname, '../src/modules/kiosko/service.js');

  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const loginJs = fs.readFileSync(loginJsPath, 'utf8');
  const componentsCss = fs.readFileSync(componentsCssPath, 'utf8');
  const kioskoService = fs.readFileSync(kioskoServicePath, 'utf8');

  // 1. Redirección a la IP configurada (no a localhost)
  assert.ok(
    loginJs.includes('mesaPreAsignada: null'),
    'login.js debe registrar mesaPreAsignada: null en el estado inicial de Alpine'
  );
  assert.ok(
    loginJs.includes('kioskoUrlBase: \'\''),
    'login.js debe registrar kioskoUrlBase en su estado'
  );
  assert.ok(
    loginJs.includes('this.kioskoUrlBase = res.url_base || res.url_publica || \'\''),
    'verificarKioskoActivo() debe capturar url_base de la respuesta'
  );
  assert.ok(
    loginJs.includes('get kioskoHref()') &&
    loginJs.includes('let base = (this.kioskoUrlBase || \'\').trim()'),
    'kioskoHref debe utilizar kioskoUrlBase para armar el enlace'
  );
  assert.ok(
    loginJs.includes('esAsistido ? `${base}?modo=tablet` : base'),
    'kioskoHref debe anexar ?modo=tablet en modo asistido a la IP base configurada'
  );

  // 2. Fallback de url_base en servicio backend
  assert.ok(
    kioskoService.includes('const lanIp = getLanIpAddress()') &&
    kioskoService.includes('url_base: urlBase'),
    'getKioskoEstado debe retornar la IP configurada o la IP de LAN en url_base'
  );

  // 3. Iconos SVG limpios en index.html
  assert.ok(
    !indexHtml.includes('m-3 8.25h3m-3 3.75h3m-6-3.75H6.375'),
    'index.html NO debe contener trazos SVG rotos/duplicados en el icono de tablet/móvil'
  );
  assert.ok(
    indexHtml.includes('d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3"'),
    'index.html debe contener el trazo limpio estándar de dispositivo móvil/tablet'
  );
  assert.ok(
    indexHtml.includes('x-show="!showPassword"') && indexHtml.includes('x-show="showPassword"'),
    'index.html debe alternar entre icono de ojo abierto y cerrado en la contraseña'
  );
  assert.ok(
    indexHtml.includes('icon-box icon-box-md bg-emerald-600 text-white rounded-xl flex items-center justify-center shrink-0'),
    'El indicador de número de mesa debe tener flex centering y rounded-xl explícito'
  );

  // 4. CSS de icon-box en components.css
  assert.ok(
    componentsCss.includes('.icon-box,') &&
    componentsCss.includes('.icon-box-md,') &&
    componentsCss.includes('.icon-box-lg {'),
    'components.css debe agrupar .icon-box, .icon-box-md y .icon-box-lg con flex centering y border-radius'
  );
  assert.ok(
    componentsCss.includes('.input-field:-webkit-autofill'),
    'components.css debe manejar :-webkit-autofill para evitar problemas de contraste y color'
  );
});
