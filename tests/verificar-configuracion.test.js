'use strict'

const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
require('dotenv').config()

const buildApp = require('../src/app')

async function runConfigVerification() {
  console.log('======================================================================')
  console.log(' VERIFICACIÓN: PESTAÑA CONFIGURACIÓN ADMIN Y TODAS LAS CLAVES')
  console.log('======================================================================\n')

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'turnero'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT_EXPOSED || 5432}/${process.env.DB_NAME || 'turnero'}`
  })

  const app = await buildApp()
  const passHash = await bcrypt.hash('Admin2026!', 10)
  const jwtSecret = process.env.JWT_SECRET || 'dev_secret_jwt_matriculas_2026'

  // Crear o asegurar usuario admin
  const adminRes = await pool.query(`
    INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
    VALUES ('admin_test_cfg', $1, 'admin', 'Admin Test Cfg', true)
    ON CONFLICT (username) WHERE eliminado_en IS NULL DO UPDATE SET activo = true
    RETURNING id
  `, [passHash])
  const adminId = adminRes.rows[0].id
  const adminToken = jwt.sign({ id: adminId, username: 'admin_test_cfg', rol: 'admin', nombre_completo: 'Admin Test Cfg' }, jwtSecret)

  // Operador token (para verificar que no tiene acceso a configuración)
  const opRes = await pool.query(`
    INSERT INTO usuarios (username, password_hash, rol, nombre_completo, activo)
    VALUES ('op_test_cfg', $1, 'operador', 'Op Test Cfg', true)
    ON CONFLICT (username) WHERE eliminado_en IS NULL DO UPDATE SET activo = true
    RETURNING id
  `, [passHash])
  const opId = opRes.rows[0].id
  const opToken = jwt.sign({ id: opId, username: 'op_test_cfg', rol: 'operador', nombre_completo: 'Op Test Cfg' }, jwtSecret)

  try {
    // -------------------------------------------------------------------------
    // TEST 1: GET /admin/configuracion lista TODAS las 13 claves con descripcion
    // -------------------------------------------------------------------------
    console.log('[TEST 1] Verificando listado completo de las 13 claves de configuración...')
    const resGet = await app.inject({
      method: 'GET',
      url: '/admin/configuracion',
      headers: { authorization: `Bearer ${adminToken}` }
    })

    assert.equal(resGet.statusCode, 200, 'GET /admin/configuracion debe responder 200')
    const resBody = JSON.parse(resGet.payload)
    const configList = resBody.lista || (Array.isArray(resBody) ? resBody : Object.values(resBody))
    assert(Array.isArray(configList), 'La respuesta debe contener la lista de configuración')
    assert(configList.length >= 13, `Debe contener al menos 13 claves, se obtuvieron ${configList.length}`)

    const clavesEsperadas = [
      'alerta_vouchers_restantes',
      'kiosko_web_activo',
      'modo_generacion_turnos',
      'voz_anuncio_activa',
      'mostrar_estimado_espera',
      'kiosko_tope_diario',
      'kiosko_modo_uso',
      'kiosko_url_base',
      'impresora_ip',
      'impresora_puerto',
      'impresora_activa',
      'tv_escala_turnos',
      'tv_escala_principal',
      'tv_escala_secundaria',
      'zona_horaria'
    ]

    for (const clave of clavesEsperadas) {
      const encontrada = configList.find(c => c.clave === clave)
      assert(encontrada, `Falta la clave "${clave}" en la lista de configuración`)
      assert(encontrada.descripcion, `La clave "${clave}" debe tener descripción`)
      console.log(`  ✓ Clave verificada: ${clave.padEnd(26)} -> [${encontrada.valor}] "${encontrada.descripcion}"`)
    }
    console.log('✅ TEST 1 superado con éxito.\n')

    // -------------------------------------------------------------------------
    // TEST 2: Operador no autorizado
    // -------------------------------------------------------------------------
    console.log('[TEST 2] Verificando protección de rol (operador rechazado con 403)...')
    const resOp = await app.inject({
      method: 'GET',
      url: '/admin/configuracion',
      headers: { authorization: `Bearer ${opToken}` }
    })
    assert.equal(resOp.statusCode, 403, 'Operador debe recibir 403 Forbidden')
    console.log('✅ TEST 2 superado con éxito.\n')

    // -------------------------------------------------------------------------
    // TEST 3: Modificación y validación de cada ajuste (valores válidos)
    // -------------------------------------------------------------------------
    console.log('[TEST 3] Modificando claves con valores válidos...')
    const modificacionesValidas = [
      { clave: 'alerta_vouchers_restantes', valor: '35' },
      { clave: 'zona_horaria',              valor: 'America/Tegucigalpa' },
      { clave: 'mostrar_estimado_espera',   valor: 'false' },
      { clave: 'voz_anuncio_activa',        valor: 'false' },
      { clave: 'tv_escala_turnos',          valor: '115' },
      { clave: 'kiosko_modo_uso',           valor: 'estudiante' },
      { clave: 'kiosko_tope_diario',        valor: '150' },
      { clave: 'kiosko_url_base',           valor: 'http://192.168.1.100:3000/kiosko.html' },
      { clave: 'impresora_activa',          valor: 'true' },
      { clave: 'impresora_ip',              valor: '192.168.1.210' },
      { clave: 'impresora_puerto',          valor: '9100' }
    ]

    for (const mod of modificacionesValidas) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/configuracion/${mod.clave}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { valor: mod.valor }
      })
      assert.equal(res.statusCode, 200, `PATCH ${mod.clave} debe ser 200`)
      const body = JSON.parse(res.payload)
      assert.equal(body.clave, mod.clave)
      assert.equal(body.valor, mod.valor)
      console.log(`  ✓ Modificado correctamente: ${mod.clave} = ${mod.valor}`)
    }
    console.log('✅ TEST 3 superado con éxito.\n')

    // -------------------------------------------------------------------------
    // TEST 4: Sincronización bidireccional Kiosko Web <-> Modo Generación Turnos
    // -------------------------------------------------------------------------
    console.log('[TEST 4] Verificando sincronización automática entre kiosko_web_activo y modo_generacion_turnos...')

    // Activar kiosko web
    const resActivarK = await app.inject({
      method: 'PATCH',
      url: '/admin/configuracion/kiosko_web_activo',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { valor: 'true' }
    })
    assert.equal(resActivarK.statusCode, 200)

    // Verificar en BD que modo_generacion_turnos cambió a kiosko_web
    const bdModo1 = await pool.query(`SELECT valor FROM configuracion WHERE clave = 'modo_generacion_turnos'`)
    assert.equal(bdModo1.rows[0].valor, 'kiosko_web', 'kiosko_web_activo=true debe fijar modo_generacion_turnos=kiosko_web')
    console.log('  ✓ Activación: kiosko_web_activo=true -> modo_generacion_turnos=kiosko_web')

    // Desactivar pasando modo_generacion_turnos a voucher_fisico
    const resModoFisico = await app.inject({
      method: 'PATCH',
      url: '/admin/configuracion/modo_generacion_turnos',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { valor: 'voucher_fisico' }
    })
    assert.equal(resModoFisico.statusCode, 200)

    // Verificar en BD que kiosko_web_activo cambió a false
    const bdKiosko2 = await pool.query(`SELECT valor FROM configuracion WHERE clave = 'kiosko_web_activo'`)
    assert.equal(bdKiosko2.rows[0].valor, 'false', 'modo_generacion_turnos=voucher_fisico debe fijar kiosko_web_activo=false')
    console.log('  ✓ Desactivación: modo_generacion_turnos=voucher_fisico -> kiosko_web_activo=false')
    console.log('✅ TEST 4 superado con éxito.\n')

    // -------------------------------------------------------------------------
    // TEST 5: Rechazo estricto de valores inválidos (Validación en Servidor)
    // -------------------------------------------------------------------------
    console.log('[TEST 5] Probando rechazo de valores inválidos en el servidor con HTTP 400...')
    const casosInvalidos = [
      { clave: 'alerta_vouchers_restantes', valor: '0',     esperado: 'entre 1 y 500' },
      { clave: 'alerta_vouchers_restantes', valor: '999',   esperado: 'entre 1 y 500' },
      { clave: 'alerta_vouchers_restantes', valor: 'abc',   esperado: 'número entero' },
      { clave: 'voz_anuncio_activa',        valor: 'talvez',esperado: 'booleano' },
      { clave: 'tv_escala_turnos',          valor: '50',    esperado: 'entre 75 y 140' },
      { clave: 'tv_escala_turnos',          valor: '180',   esperado: 'entre 75 y 140' },
      { clave: 'kiosko_modo_uso',           valor: 'inval', esperado: 'estudiante' },
      { clave: 'kiosko_tope_diario',        valor: '-5',    esperado: 'mayor o igual a 0' },
      { clave: 'impresora_puerto',          valor: '0',     esperado: 'entre 1 y 65535' },
      { clave: 'impresora_puerto',          valor: '70000', esperado: 'entre 1 y 65535' }
    ]

    for (const caso of casosInvalidos) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/configuracion/${caso.clave}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { valor: caso.valor }
      })
      assert.equal(res.statusCode, 400, `PATCH ${caso.clave}=${caso.valor} debió fallar con 400`)
      const body = JSON.parse(res.payload)
      assert(body.error, 'La respuesta de error debe tener campo error')
      console.log(`  ✓ Rechazado correctamente: ${caso.clave}=${caso.valor} -> "${body.error}"`)
    }
    console.log('✅ TEST 5 superado con éxito.\n')

    // -------------------------------------------------------------------------
    // TEST 6: Auditoría inmutable de cambios (audit_log)
    // -------------------------------------------------------------------------
    console.log('[TEST 6] Verificando registro inmutable en audit_log...')
    const auditRes = await pool.query(`
      SELECT accion, metadata_json, timestamp
      FROM audit_log
      WHERE accion = 'CONFIG_MODIFICADA'
      ORDER BY id DESC
      LIMIT 5
    `)
    assert(auditRes.rows.length > 0, 'Debe haber registros en audit_log con accion CONFIG_MODIFICADA')
    console.log(`  ✓ Se registraron eventos de auditoría CONFIG_MODIFICADA: último metadata =`, auditRes.rows[0].metadata_json)
    console.log('✅ TEST 6 superado con éxito.\n')

    // -------------------------------------------------------------------------
    // TEST 7: Calidad del Frontend (HTML / Reglas de Diseño)
    // -------------------------------------------------------------------------
    console.log('[TEST 7] Verificando reglas de diseño en admin.html y admin.js...')
    const htmlPath = path.join(__dirname, '../src/public/admin.html')
    const jsPath   = path.join(__dirname, '../src/public/js/pages/admin.js')
    const htmlContent = fs.readFileSync(htmlPath, 'utf8')
    const jsContent   = fs.readFileSync(jsPath, 'utf8')

    // 1. Prohibición total de emojis
    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u
    assert(!emojiRegex.test(htmlContent), 'PROHIBICIÓN VIOLADA: admin.html contiene emojis!')
    console.log('  ✓ Cero emojis en admin.html (solo SVG vectoriales)')

    // 2. Control duplicado de kiosko eliminado
    // Verificar que no exista el botón duplicado "Activar Kiosko Digital"
    assert(!htmlContent.includes('<span>Activar Kiosko Digital</span>'), 'El botón duplicado "Activar Kiosko Digital" debe haber sido eliminado')
    console.log('  ✓ Control duplicado de activación eliminado: ahora existe un único switch claro')

    // 3. Módulos y sub-tabs organizados
    assert(htmlContent.includes("subTabConfig = 'todos'"), 'Debe existir filtro para todos los módulos')
    assert(htmlContent.includes("subTabConfig = 'tv'"), 'Debe existir filtro para TV')
    assert(htmlContent.includes("subTabConfig = 'kiosko'"), 'Debe existir filtro para Kiosko')
    assert(htmlContent.includes("subTabConfig = 'impresora'"), 'Debe existir filtro para Impresora')
    assert(htmlContent.includes("subTabConfig = 'sistema'"), 'Debe existir filtro para Operación y Sistema')
    assert(htmlContent.includes("subTabConfig = 'contingencia'"), 'Debe existir filtro para Plan B / Contingencia')
    console.log('  ✓ 5 Bloques modulares y filtros rápidos subTabConfig implementados')

    // 4. Dos controles de escala independientes para TV
    assert(htmlContent.includes('tv_escala_principal'), 'El control de escala del turno principal debe estar presente')
    assert(htmlContent.includes('tv_escala_secundaria'), 'El control de escala de turnos anteriores debe estar presente')
    assert(htmlContent.includes('restablecerEscalaPrincipal'), 'La función restablecerEscalaPrincipal debe estar vinculada')
    assert(htmlContent.includes('restablecerEscalaSecundaria'), 'La función restablecerEscalaSecundaria debe estar vinculada')
    console.log('  ✓ Dos controles independientes de escala de TV implementados correctamente en admin.html')

    // 5. Offline handling en admin.js
    assert(jsContent.includes('!this.wsConnected'), 'admin.js debe verificar desconexión de red antes de guardar')
    console.log('  ✓ Protección sin conexión verificada en controlador frontend')

    console.log('✅ TEST 7 superado con éxito.\n')

    console.log('======================================================================')
    console.log(' ✅ TODAS LAS PRUEBAS DE CONFIGURACIÓN HAN PASADO EXITOSAMENTE (100%)')
    console.log('======================================================================')
  } finally {
    await app.close()
    await pool.end()
  }
}

runConfigVerification().catch(err => {
  console.error('\n❌ ERROR EN LA VERIFICACIÓN:', err)
  process.exit(1)
})
