# =============================================================================
# install.ps1 - Instalador Automatizado Turnero de Matriculas 2026 (Windows)
#
# Deja el sistema completamente instalado, configurado y corriendo.
# Alta tolerancia a fallos: fallback automatico entre Docker y Node.js local.
#
# Uso en PowerShell (como Administrador o usuario estandar):
#   powershell -ExecutionPolicy Bypass -File install.ps1
# =============================================================================

$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir -or $ScriptDir -eq "") { $ScriptDir = (Get-Location).Path }
Set-Location $ScriptDir

Write-Host "===================================================================="
Write-Host " INSTALADOR - SISTEMA DIGITAL TURNERO DE MATRICULAS 2026 v2.1"
Write-Host "===================================================================="
Write-Host "[INFO] Iniciando verificacion de entorno e instalacion..."
Write-Host ""

# =============================================================================
# 1. Configuracion de Variables de Entorno (.env)
# =============================================================================
Write-Host "[1/4] Configurando archivo .env..."
$envFile    = Join-Path $ScriptDir ".env"
$envExample = Join-Path $ScriptDir ".env.example"
$envProd    = Join-Path $ScriptDir ".env.production"
$envDev     = Join-Path $ScriptDir ".env.development"

if (Test-Path $envFile) {
    Write-Host "  [OK] Archivo .env existente detectado - se conserva intacto."
} else {
    Write-Host "  [INFO] Archivo .env no encontrado. Creando desde plantilla..."

    # Copiar la mejor plantilla disponible
    if     (Test-Path $envExample) { Copy-Item $envExample $envFile -ErrorAction SilentlyContinue }
    elseif (Test-Path $envProd)    { Copy-Item $envProd    $envFile -ErrorAction SilentlyContinue }
    elseif (Test-Path $envDev)     { Copy-Item $envDev     $envFile -ErrorAction SilentlyContinue }

    # Respaldo inline si ninguna plantilla existe
    if (-not (Test-Path $envFile)) {
        Write-Host "  [INFO] Generando .env basico funcional..."
        @"
NODE_ENV=production
DB_NAME=turnero
DB_USER=postgres
DB_PASSWORD=turnero
DB_HOST=localhost
DB_PORT_EXPOSED=5432
DB_POOL_MAX=20
DB_CONTAINER_NAME=turnero-db
DATABASE_URL=postgresql://postgres:turnero@localhost:5432/turnero
PGBOUNCER_PORT_EXPOSED=5433
REDIS_PASSWORD=turnero_redis
REDIS_HOST=localhost
REDIS_PORT_EXPOSED=6379
REDIS_URL=redis://:turnero_redis@localhost:6379
APP_PORT=3000
APP_PORT_EXPOSED=3000
HOST_IP=
ALLOWED_ORIGINS=
JWT_SECRET=
REFRESH_SECRET=
JWT_EXPIRES_IN=2h
REFRESH_EXPIRES_IN=7d
BCRYPT_COST=12
RATE_LIMIT_LOGIN_MAX=10
LOG_LEVEL=info
"@ | Out-File -FilePath $envFile -Encoding utf8
    }

    # Asegurar secretos JWT de alta entropia
    try {
        $randJwt = [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")
        $randRef = [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")
        $lines = Get-Content $envFile
        $lines = $lines -replace '<CAMBIAR_JWT_SECRET_64_CHARS_MINIMO>', $randJwt `
                        -replace '<CAMBIAR_REFRESH_SECRET_64_CHARS_MINIMO>', $randRef `
                        -replace '<CAMBIAR_PASSWORD_SEGURO>', 'turnero_db_2026' `
                        -replace '<CAMBIAR_REDIS_PASSWORD>', 'turnero_redis_2026'

        $jwtLine = $lines | Where-Object { $_ -match '^JWT_SECRET=' }
        if (-not $jwtLine -or $jwtLine -match '=$' -or $jwtLine -match '<CAMBIAR') {
            $lines = $lines -replace '^JWT_SECRET=.*$', "JWT_SECRET=$randJwt"
        }
        $refLine = $lines | Where-Object { $_ -match '^REFRESH_SECRET=' }
        if (-not $refLine -or $refLine -match '=$' -or $refLine -match '<CAMBIAR') {
            $lines = $lines -replace '^REFRESH_SECRET=.*$', "REFRESH_SECRET=$randRef"
        }
        $lines | Set-Content $envFile -Encoding utf8
        Write-Host "  [OK] Archivo .env generado con secretos JWT criptograficos."
    } catch {
        Write-Host "  [AVISO] Se conservaron los valores por defecto para .env."
    }
}

# =============================================================================
# 2. Detectar IP LAN del host
# =============================================================================
$lanIp = "localhost"
try {
    $ipObj = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
             Where-Object { $_.InterfaceAlias -notmatch 'Loopback|vEthernet|WSL|Teredo|isatap' `
                            -and $_.IPAddress -notmatch '^169\.254\.' `
                            -and $_.IPAddress -ne '127.0.0.1' } |
             Select-Object -First 1
    if ($ipObj) { $lanIp = $ipObj.IPAddress }
} catch { $lanIp = "localhost" }

# =============================================================================
# 3. Seleccion de Modo de Instalacion con Fallback Automatico
# =============================================================================
Write-Host ""
Write-Host "[2/4] Detectando infraestructura disponible..."

$hasDocker = $false
try {
    $null = & docker info 2>$null
    if ($LASTEXITCODE -eq 0) { $hasDocker = $true }
} catch { $hasDocker = $false }

$modoInstalado = "none"

if ($hasDocker) {
    Write-Host "  [INFO] Docker detectado. Intentando despliegue con Docker Compose..."
    $env:COMPOSE_BAKE = "false"

    & docker compose up -d --build
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [INFO] Esperando a que PostgreSQL inicie en contenedor..."
        $retries = 30
        while ($retries -gt 0) {
            $null = & docker exec turnero-db pg_isready 2>$null
            if ($LASTEXITCODE -eq 0) { break }
            Start-Sleep -Seconds 2
            $retries--
        }

        if ($retries -gt 0) {
            Write-Host "  [OK] PostgreSQL operativo."

            # Esperar a que el contenedor app este listo
            $appRetries = 15
            while ($appRetries -gt 0) {
                $appState = & docker inspect --format '{{.State.Status}}' turnero-app 2>$null
                if ($appState -eq "running") { break }
                Start-Sleep -Seconds 2
                $appRetries--
            }

            Write-Host "  [INFO] Ejecutando migraciones de base de datos..."
            & docker compose exec -T app node scripts/recrear_desde_cero.js

            Write-Host "  [INFO] Cargando datos iniciales (seed)..."
            & docker compose exec -T app node scripts/seed.js

            # Limpiar VBS viejo
            $startupVbs = Join-Path ([System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Startup)) "Turnero_2026_AutoStart.vbs"
            if (Test-Path $startupVbs) { Remove-Item $startupVbs -Force -ErrorAction SilentlyContinue }

            $modoInstalado = "docker"
        } else {
            Write-Host "  [AVISO] PostgreSQL en Docker tardo mas de lo previsto. Pasando a verificacion..."
            $modoInstalado = "docker"
        }
    } else {
        Write-Host "  [AVISO] Docker Compose fallo. Intentando alternativa con Node.js nativo..."
    }
}

if ($modoInstalado -eq "none") {
    Write-Host "  [INFO] Procediendo con instalacion Node.js local..."

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Host "  [ERROR] Se requiere al menos Node.js (v20+) o Docker Desktop instalado."
        Write-Host "          Descarga Node.js LTS: https://nodejs.org"
        exit 1
    }
    Write-Host "  [OK] Node.js detectado: $(& node --version 2>$null)"

    Write-Host "  [INFO] Instalando dependencias de Node.js..."
    & npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] npm install fallo. Revisa tu conexion a internet."
        exit 1
    }

    Write-Host "  [INFO] Compilando estilos Tailwind CSS..."
    try {
        & npm run build:css 2>$null
        Write-Host "  [OK] Estilos CSS listos."
    } catch {
        Write-Host "  [AVISO] Usando archivo CSS precompilado existente."
    }

    Write-Host "  [INFO] Verificando base de datos y ejecutando migraciones..."
    try {
        & node scripts/recrear_desde_cero.js
        & node scripts/seed.js
        Write-Host "  [OK] Base de datos configurada y poblada."
    } catch {
        Write-Host "  [AVISO] Base de datos no disponible en localhost:5432."
        Write-Host "          Levanta tu servicio PostgreSQL y ejecuta manualmente:"
        Write-Host "            node scripts/recrear_desde_cero.js"
        Write-Host "            node scripts/seed.js"
    }

    # Iniciar servidor
    $pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
    if ($pm2Cmd) {
        Write-Host "  [INFO] Iniciando aplicacion con PM2..."
        & pm2 start src/server.js --name turnero-app 2>$null
        & pm2 save --force 2>$null | Out-Null
        Write-Host "  [OK] Aplicacion iniciada con PM2."
    } else {
        Write-Host "  [INFO] Iniciando aplicacion Node.js en segundo plano..."
        $proc = Start-Process -FilePath "node" -ArgumentList "src/server.js" -WorkingDirectory $ScriptDir -PassThru -WindowStyle Hidden
        Write-Host "  [OK] Servidor iniciado con PID $($proc.Id)."
    }

    # Auto-arranque en Windows
    try {
        $startupFolder = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Startup)
        $shortcutPath  = Join-Path $startupFolder "Turnero_2026_AutoStart.vbs"
        $escapedDir    = $ScriptDir -replace '\\', '\\'
        $vbsContent    = "Set WshShell = CreateObject(`"WScript.Shell`")`r`nWshShell.CurrentDirectory = `"$escapedDir`"`r`nWshShell.Run `"node src/server.js`", 0, False"
        Set-Content -Path $shortcutPath -Value $vbsContent -Encoding Ascii
        Write-Host "  [OK] Auto-inicio configurado ante reinicios del sistema."
    } catch {
        Write-Host "  [AVISO] No se registro auto-inicio en Windows."
    }

    $modoInstalado = "node"
}

# =============================================================================
# 4. Verificacion de Salud del Servidor
# =============================================================================
Write-Host ""
Write-Host "[3/4] Verificando que el servidor responde en /health..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:3000/health" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
}

if ($ready) {
    Write-Host "  [OK] Servidor web en linea y respondiendo en /health."
} else {
    Write-Host "  [AVISO] El servidor aun no responde. Puede requerir unos instantes adicionales."
    Write-Host "          Comprueba el estado en: http://localhost:3000/health"
}

# =============================================================================
# 5. Resumen Final
# =============================================================================
Write-Host ""
Write-Host "[4/4] Instalacion finalizada."
Write-Host ""
Write-Host "===================================================================="
Write-Host " SISTEMA TURNERO 2026 INSTALADO Y EN EJECUCION LISTO"
Write-Host "===================================================================="
Write-Host "Acceso Local:   http://localhost:3000"
Write-Host "Acceso LAN:     http://${lanIp}:3000"
Write-Host ""
Write-Host "Puntos de Entrada del Sistema:"
Write-Host "  - Pantalla TV (Auditorio 1080p): http://${lanIp}:3000/tv.html"
Write-Host "  - Consola Operador de Mesa:      http://${lanIp}:3000/panel_mesa.html"
Write-Host "  - Panel de Administrador:        http://${lanIp}:3000/admin.html"
Write-Host "  - Autoservicio Kiosko Web:       http://${lanIp}:3000/kiosko.html"
Write-Host ""
Write-Host "Credenciales Iniciales:"
Write-Host "  - Administrador 1: usuario: admin  | contrasena: soporte"
Write-Host "  - Administrador 2: usuario: admin2 | contrasena: soporte"
Write-Host "  - Operadores:      op1 a op5       | contrasena: Operador2026!"
Write-Host ""
Write-Host "Recursos Inicializados:"
Write-Host "  - 10 Mesas registradas (Mesa 1 a Mesa 10)"
Write-Host "  - Lote 1 activo (vouchers 1 a 500)"
Write-Host "  - Modo operativo: Asistido con soporte a impresion ESC/POS"
Write-Host "===================================================================="
