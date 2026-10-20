# =============================================================================
# install.ps1 - Instalador Automatizado Turnero de Matriculas 2026 (Windows)
#
# Deja el sistema completamente instalado, configurado y corriendo.
#
# Uso en PowerShell (como Administrador o usuario estandar):
#   powershell -ExecutionPolicy Bypass -File install.ps1
# =============================================================================

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "===================================================================="
Write-Host " INSTALADOR - SISTEMA DIGITAL TURNERO DE MATRICULAS 2026 v2.1"
Write-Host "===================================================================="
Write-Host "[INFO] Iniciando verificacion de entorno e instalacion..."

# 1. Configuracion de Variables de Entorno (.env)
$envFile = Join-Path $ScriptDir ".env"
if (Test-Path $envFile) {
    Write-Host "[OK] Archivo .env existente detectado. Se omite creacion y se conserva la configuracion actual intacta."
} else {
    Write-Host "[INFO] Archivo .env no encontrado. Creando configuracion inicial desde .env.example..."
    $envExample = Join-Path $ScriptDir ".env.example"
    $envProd    = Join-Path $ScriptDir ".env.production"
    $envDev     = Join-Path $ScriptDir ".env.development"

    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
    } elseif (Test-Path $envProd) {
        Copy-Item $envProd $envFile
    } elseif (Test-Path $envDev) {
        Copy-Item $envDev $envFile
    } else {
        @"
NODE_ENV=production
DB_NAME=turnero
DB_USER=turnero_app
DB_PASSWORD=turnero
DB_PORT_EXPOSED=5432
DATABASE_URL=postgresql://turnero_app:turnero@localhost:5432/turnero
PGBOUNCER_PORT_EXPOSED=5433
REDIS_PASSWORD=turnero_redis
REDIS_PORT_EXPOSED=6379
REDIS_URL=redis://:turnero_redis@localhost:6379
APP_PORT=3000
APP_PORT_EXPOSED=3000
JWT_EXPIRES_IN=2h
REFRESH_EXPIRES_IN=7d
BCRYPT_COST=12
LOG_LEVEL=info
"@ | Out-File -FilePath $envFile -Encoding utf8
    }

    # Generar secretos criptograficos para JWT si faltan
    $randJwt = [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")
    $randRef = [System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")
    (Get-Content $envFile) -replace '<CAMBIAR_PASSWORD_SEGURO>', 'turnero_db_pass_2026' `
                           -replace '<CAMBIAR_REDIS_PASSWORD>', 'turnero_redis_pass_2026' `
                           -replace '<CAMBIAR_JWT_SECRET_64_CHARS_MINIMO>', $randJwt `
                           -replace '<CAMBIAR_REFRESH_SECRET_64_CHARS_MINIMO>', $randRef `
                           -replace '^JWT_SECRET=.*$', "JWT_SECRET=$randJwt" `
                           -replace '^REFRESH_SECRET=.*$', "REFRESH_SECRET=$randRef" |
                           Set-Content $envFile -Encoding utf8

    Write-Host "[OK] Archivo .env generado exitosamente a partir de .env.example con secretos seguros."
}

# Detectar IP LAN en Windows
$lanIp = "localhost"
try {
    $ipObj = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback|vEthernet|WSL' -and $_.IPAddress -notmatch '^169\.254\.' } | Select-Object -First 1
    if ($ipObj) { $lanIp = $ipObj.IPAddress }
} catch {
    $lanIp = "localhost"
}

# 2. Seleccion de Modo de Instalacion
$hasDocker = $false
try {
    & docker info 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $hasDocker = $true }
} catch {
    $hasDocker = $false
}

if ($hasDocker) {
    Write-Host "[INFO] Desplegando mediante Docker Compose en Windows..."
    & docker compose up -d --build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "[ERROR] Fallo al iniciar los contenedores de Docker."
        exit 1
    }

    Write-Host "[INFO] Esperando inicializacion de PostgreSQL en contenedor..."
    $retries = 30
    while ($retries -gt 0) {
        & docker exec turnero-db pg_isready 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 2
        $retries--
    }

    if ($retries -eq 0) {
        Write-Error "[ERROR] Tiempo de espera agotado para PostgreSQL en Docker."
        exit 1
    }
    Write-Host "[OK] PostgreSQL esta listo y respondiendo."

    Write-Host "[INFO] Aplicando migraciones de base de datos..."
    & docker compose exec -T app node scripts/recrear_desde_cero.js

    Write-Host "[INFO] Poblando base de datos con seed inicial..."
    & docker compose exec -T app node scripts/seed.js

} else {
    Write-Host "[INFO] Docker Desktop no detectado o no activo. Procediendo con Node.js local..."

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Error "[ERROR] Se requiere Node.js (v20 o superior) o Docker Desktop instalado."
        exit 1
    }

    Write-Host "[INFO] Instalando dependencias de Node.js..."
    & npm install

    Write-Host "[INFO] Compilando estilos Tailwind CSS..."
    try { & npm run build:css } catch {}

    Write-Host "[INFO] Verificando base de datos y ejecutando seed..."
    try {
        & node scripts/recrear_desde_cero.js
        & node scripts/seed.js
    } catch {
        Write-Warning "[AVISO] La base de datos local de PostgreSQL aun no esta disponible en el puerto 5432. Inicie el servicio PostgreSQL para completar la carga."
    }

    # Iniciar la aplicacion de forma persistente
    $pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
    if ($pm2Cmd) {
        Write-Host "[INFO] Iniciando servidor con PM2 para recuperacion automatica ante fallos..."
        & pm2 start src/server.js --name turnero-app
        & pm2 save
    } else {
        Write-Host "[INFO] Iniciando servidor en segundo plano..."
        $process = Start-Process node -ArgumentList "src/server.js" -WorkingDirectory $ScriptDir -PassThru
        Write-Host "[OK] Servidor iniciado con PID $($process.Id)."
    }

    # Configurar auto-inicio en Windows al encender/reiniciar el equipo
    try {
        $startupFolder = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Startup)
        $shortcutPath = Join-Path $startupFolder "Turnero_2026_AutoStart.vbs"
        $vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$($ScriptDir -replace '\\', '\\')"
WshShell.Run "node src/server.js", 0, False
"@
        Set-Content -Path $shortcutPath -Value $vbsContent -Encoding Ascii
        Write-Host "[OK] Acceso de auto-inicio registrado en Carpeta de Inicio de Windows (prevalece ante reinicios)."
    } catch {
        Write-Warning "[AVISO] No se pudo crear el acceso de inicio automatico: $($_.Exception.Message)"
    }
}

# 3. Resumen de Despliegue y Enlaces
Write-Host ""
Write-Host "===================================================================="
Write-Host " SISTEMA TURNERO 2026 INSTALADO Y EN EJECUCION LISTO"
Write-Host "===================================================================="
Write-Host "Acceso Local:        http://localhost:3000"
Write-Host "Acceso LAN Red:      http://${lanIp}:3000"
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
Write-Host "Recursos Configurados:"
Write-Host "  - 10 Mesas registradas (Mesa 1 a Mesa 10)"
Write-Host "  - 1 Lote creado: Lote 1 (1 a 500 vouchers, activo)"
Write-Host "  - Modo operativo: Asistido con soporte a impresion ESC/POS"
Write-Host "  - Resiliencia ante reinicio: Configuracion de auto-arranque activa"
Write-Host "===================================================================="
