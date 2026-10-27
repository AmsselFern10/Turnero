/**
 * MÓDULO: offline_docker_audit
 * OBJETIVO: Auditoría offline y Docker: HTMLs sin recursos externos (CDN),
 *   CSS y fuentes autoalojadas, controladores con destroy(), Dockerfiles y migraciones SQL.
 * EJECUCIÓN: node tests/offline_docker_audit.test.js
 */

const fs   = require('fs');
const path = require('path');

const rootDir   = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'src', 'public');

let errors = 0;
let checks = 0;

function assert(condition, message) {
  checks++;
  if (!condition) {
    errors++;
    console.error(`  [FAIL] ${message}`);
  } else {
    console.log(`  [OK]   ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. AUDITORIA OFFLINE EN ARCHIVOS HTML
// ---------------------------------------------------------------------------
console.log('\n[1] Verificando que ningun HTML descargue nada de Internet...');
const htmlFiles = ['index.html', 'panel_mesa.html', 'admin.html', 'tv.html', 'kiosko.html'];

for (const file of htmlFiles) {
  const filePath = path.join(publicDir, file);
  assert(fs.existsSync(filePath), `Archivo HTML existe: ${file}`);
  if (!fs.existsSync(filePath)) continue;
  const content = fs.readFileSync(filePath, 'utf8');

  const externalScripts = content.match(/<script[^>]+src=["'](https?:\/\/[^"']+)["']/gi) || [];
  assert(externalScripts.length === 0, `${file}: Cero scripts externos (${externalScripts.length} encontrados)`);

  const externalLinks = content.match(/<link[^>]+href=["'](https?:\/\/[^"']+)["']/gi) || [];
  assert(externalLinks.length === 0, `${file}: Cero estilos/recursos externos en <link> (${externalLinks.length} encontrados)`);

  const emojiRegex = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  assert(!emojiRegex.test(content), `${file}: Cero emojis (conforme a RF-USA-04)`);
}

// ---------------------------------------------------------------------------
// 2. AUDITORIA OFFLINE EN CSS Y FUENTES
// ---------------------------------------------------------------------------
console.log('\n[2] Verificando que los archivos CSS sean 100% autonomos y autoalojados...');
const cssFiles = fs.readdirSync(path.join(publicDir, 'css')).filter(f => f.endsWith('.css'));

for (const file of cssFiles) {
  const filePath = path.join(publicDir, 'css', file);
  const content  = fs.readFileSync(filePath, 'utf8');

  const importMatches   = content.match(/@import\s+[^;]+;/g) || [];
  const externalImports = importMatches.filter(i => i.includes('http://') || i.includes('https://'));
  assert(externalImports.length === 0, `${file}: Cero @import externos (${externalImports.length} encontrados)`);

  const urlMatches = content.match(/url\(['"']?(https?:\/\/[^'"')]+)['"']?\)/gi) || [];
  assert(urlMatches.length === 0, `${file}: Cero url(...) externas (${urlMatches.length} encontrados)`);
}

const fontsDir = path.join(publicDir, 'assets', 'fonts');
assert(fs.existsSync(fontsDir), 'Directorio de fuentes existe (/assets/fonts)');
if (fs.existsSync(fontsDir)) {
  const fonts = fs.readdirSync(fontsDir);
  const expectedFonts = [
    'inter-400.woff2', 'inter-500.woff2', 'inter-600.woff2', 'inter-700.woff2', 'inter-800.woff2',
    'jetbrains-mono-400.woff2', 'jetbrains-mono-500.woff2', 'jetbrains-mono-600.woff2', 'jetbrains-mono-700.woff2', 'jetbrains-mono-800.woff2'
  ];
  for (const ef of expectedFonts) {
    assert(fonts.includes(ef), `Fuente autoalojada presente: ${ef}`);
  }
}

const vendorDir = path.join(publicDir, 'vendor');
assert(fs.existsSync(path.join(vendorDir, 'alpine-3.13.3.min.js')), 'Libreria vendor presente: alpine-3.13.3.min.js');
assert(fs.existsSync(path.join(vendorDir, 'qrcode.min.js')),        'Libreria vendor presente: qrcode.min.js');
assert(fs.existsSync(path.join(publicDir, 'assets', 'audio', 'bell.mp3')), 'Audio institucional presente: bell.mp3');

// ---------------------------------------------------------------------------
// 3. AUDITORIA OFFLINE EN JAVASCRIPT CLIENTE
// ---------------------------------------------------------------------------
console.log('\n[3] Verificando controladores JS del frontend...');
const jsPagesDir = path.join(publicDir, 'js', 'pages');
const jsPages    = fs.readdirSync(jsPagesDir).filter(f => f.endsWith('.js'));

for (const file of jsPages) {
  const content = fs.readFileSync(path.join(jsPagesDir, file), 'utf8');
  const windowPollution = content.match(/window\.(loginView|panelMesaView|adminView|tvView|kioskoView)\s*=/g) || [];
  assert(windowPollution.length === 0, `${file}: Cero contaminacion de window.* (${windowPollution.join(', ')})`);
  assert(content.includes('destroy()') || content.includes('destroy ()'), `${file}: Implementa ciclo de vida destroy()`);
}

// ---------------------------------------------------------------------------
// 4. AUDITORIA DOCKER Y ARCHIVOS DE DESPLIEGUE
// ---------------------------------------------------------------------------
console.log('\n[4] Verificando configuracion y archivos de Docker...');

const dockerignorePath = path.join(rootDir, '.dockerignore');
assert(fs.existsSync(dockerignorePath), 'Archivo .dockerignore existe');
if (fs.existsSync(dockerignorePath)) {
  const di = fs.readFileSync(dockerignorePath, 'utf8');
  assert(di.includes('node_modules'), '.dockerignore excluye node_modules');
  assert(di.includes('.env'),         '.dockerignore excluye .env');
  assert(di.includes('.git'),         '.dockerignore excluye .git');
}

const dockerfilePath = path.join(rootDir, 'Dockerfile');
assert(fs.existsSync(dockerfilePath), 'Archivo Dockerfile existe');
if (fs.existsSync(dockerfilePath)) {
  const df = fs.readFileSync(dockerfilePath, 'utf8');
  assert(df.includes('AS deps'),        'Dockerfile contiene stage deps');
  assert(df.includes('AS development'), 'Dockerfile contiene stage development');
  assert(df.includes('AS production'),  'Dockerfile contiene stage production');
  assert(df.includes('--omit=dev'),     'Dockerfile usa npm ci --omit=dev para produccion');
}

const composePath = path.join(rootDir, 'docker-compose.yml');
assert(fs.existsSync(composePath), 'Archivo docker-compose.yml existe');
if (fs.existsSync(composePath)) {
  const compose = fs.readFileSync(composePath, 'utf8');
  assert(compose.includes('container_name: turnero-db'),                        'docker-compose define servicio db (PostgreSQL)');
  assert(compose.includes('container_name: turnero-redis'),                     'docker-compose define servicio redis');
  assert(compose.includes('container_name: turnero-pgbouncer'),                 'docker-compose define servicio pgbouncer');
  assert(compose.includes('container_name: turnero-app'),                       'docker-compose define servicio app');
  assert(compose.includes('./migrations:/docker-entrypoint-initdb.d:ro'),       'docker-compose monta migrations en /docker-entrypoint-initdb.d');
}

// ---------------------------------------------------------------------------
// 5. MIGRACIONES SQL CONSOLIDADAS (4 archivos, 001 a 004)
// ---------------------------------------------------------------------------
const migrationsDir = path.join(rootDir, 'migrations');
const migrations    = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
console.log(`\n[5] Verificando migraciones SQL consolidadas (${migrations.length} archivos en raiz)...`);

assert(migrations.length === 4, `Exactamente 4 archivos SQL en migrations/ (encontrados: ${migrations.length})`);
assert(migrations[0].startsWith('001_'), 'Primera migracion es 001_tablas_datos.sql');
assert(migrations[1].startsWith('002_'), 'Segunda migracion es 002_indices.sql');
assert(migrations[2].startsWith('003_'), 'Tercera migracion es 003_funciones_triggers.sql');
assert(migrations[3].startsWith('004_'), 'Cuarta migracion es 004_complementos.sql');

const historicoDir  = path.join(migrationsDir, 'historico');
assert(fs.existsSync(historicoDir), 'Directorio migrations/historico/ existe (originales preservados)');

// 6. Scripts de seed y recrear
const recrearScript = fs.readFileSync(path.join(rootDir, 'scripts', 'recrear_desde_cero.js'), 'utf8');
assert(recrearScript.includes('sqlFiles'), 'recrear_desde_cero.js itera todas las migraciones');

const seedScript = fs.readFileSync(path.join(rootDir, 'scripts', 'seed.js'), 'utf8');
assert(seedScript.includes('tv_escala_principal'),         'seed.js incluye tv_escala_principal');
assert(seedScript.includes('kiosko_impresion_automatica'), 'seed.js incluye kiosko_impresion_automatica');
assert(seedScript.includes('fondo_imagen_url'),            'seed.js incluye fondo_imagen_url');
assert(seedScript.includes('admin2'),                      'seed.js incluye admin2');
assert(seedScript.includes('soporte'),                     'seed.js incluye contrasena soporte');

// ---------------------------------------------------------------------------
// RESULTADO
// ---------------------------------------------------------------------------
console.log('\n================================================================');
console.log(`RESULTADO: ${checks} verificaciones realizadas.`);
if (errors === 0) {
  console.log('ESTADO: AUDITORIA COMPLETA - 0 ERRORES.');
} else {
  console.error(`ESTADO: ${errors} ERRORES DETECTADOS.`);
  process.exit(1);
}
console.log('================================================================\n');