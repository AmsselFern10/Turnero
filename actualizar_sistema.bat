@echo off
setlocal EnableDelayedExpansion
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"
cd /d "%~dp0"
title Turnero 2026 - Actualizar y Reiniciar

:: Ruta a PowerShell (preferir pwsh 7, fallback a Windows PowerShell 5)
set "PSX=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "C:\Program Files\PowerShell\7\pwsh.exe" set "PSX=C:\Program Files\PowerShell\7\pwsh.exe"

echo ======================================================================
echo         TURNERO DE MATRICULAS 2026 - ACTUALIZAR Y REINICIAR
echo ======================================================================
echo.

:: 1. Verificar que Git esta disponible
echo [1/6] Verificando Git...
where git >nul 2>&1
if %errorLevel% neq 0 (
    echo   [ERROR] Git no esta instalado o no esta en el PATH del sistema.
    echo   Descarga e instala Git desde: https://git-scm.com
    pause
    exit /b 1
)
echo   [OK] Git disponible.

:: 2. Detectar rama activa y commit actual
echo.
echo [2/6] Verificando estado del repositorio...
for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%B"
if "!BRANCH!"=="" set "BRANCH=main"
echo   Rama activa: !BRANCH!

for /f "delims=" %%C in ('git rev-parse --short HEAD 2^>nul') do set "COMMIT_ANTES=%%C"
echo   Commit actual: !COMMIT_ANTES!

:: 3. Proteger cambios locales con stash defensivo y hacer git pull
echo.
echo [3/6] Descargando ultimas actualizaciones (git pull)...
set "STASH_APLICADO=0"
git diff --quiet 2>nul
if %errorLevel% neq 0 (
    echo   [INFO] Se detectaron cambios locales sin commitear.
    echo          Guardando respaldo temporal con 'git stash'...
    git stash push -m "Auto-stash antes de actualizar (%date% %time%)" >nul 2>&1
    if !errorLevel! equ 0 set "STASH_APLICADO=1"
)

git pull origin !BRANCH! 2>&1
set "PULL_EXIT=!errorLevel!"

if !STASH_APLICADO! equ 1 (
    echo   [INFO] Restaurando cambios locales respaldados...
    git stash pop >nul 2>&1
)

if !PULL_EXIT! neq 0 (
    echo.
    echo   [ERROR] Fallo el comando git pull.
    echo   Posibles razones:
    echo     - Sin conexion a internet o repositorio inaccesible.
    echo     - Conflicto grave entre cambios remotos y locales.
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%C in ('git rev-parse --short HEAD 2^>nul') do set "COMMIT_DESPUES=%%C"
if "!COMMIT_ANTES!"=="!COMMIT_DESPUES!" (
    echo   [INFO] El codigo ya se encontraba en su version mas reciente (!COMMIT_DESPUES!).
    echo   Se reiniciara el sistema para aplicar cambios de configuracion o dependencias.
) else (
    echo   [OK] Codigo actualizado con exito: !COMMIT_ANTES! --^> !COMMIT_DESPUES!
)

:: 4. Detener servicios actuales para aplicar cambios
echo.
echo [4/6] Deteniendo version anterior del Turnero...

:: Detener PM2 si estuviera activo
where pm2 >nul 2>&1
if %errorLevel% equ 0 (
    call pm2 delete turnero-app >nul 2>&1
    call pm2 save --force >nul 2>&1
)

:: Detener Docker Compose
where docker >nul 2>&1
if %errorLevel% equ 0 (
    docker info >nul 2>&1
    if %errorLevel% equ 0 (
        echo   [INFO] Deteniendo contenedores Docker...
        docker compose down >nul 2>&1
    )
)

:: Liberar puerto 3000 de forma forzada
"%PSX%" -NoProfile -NonInteractive -Command "$conns = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue; if ($conns) { $pids = $conns.OwningProcess | Sort-Object -Unique | Where-Object { $_ -gt 0 }; foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host ('  [OK] Liberado puerto 3000 (PID ' + $p + ').') } }"

:: Matar procesos residuales de node ejecutando server.js
"%PSX%" -NoProfile -NonInteractive -Command "Get-Process node -ErrorAction SilentlyContinue | ForEach-Object { $id = $_.Id; try { $cl = (Get-WmiObject Win32_Process -Filter ('ProcessId=' + $id) -ErrorAction SilentlyContinue).CommandLine; if ($cl -match 'server\.js') { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; Write-Host ('  [OK] Proceso node.exe previo finalizado (PID ' + $id + ').') } } catch {} }"
echo   [OK] Sistema detenido limpiamente.

:: 5. Iniciar sistema actualizado
echo.
echo [5/6] Levantando sistema con los nuevos cambios...

:: MODO A: Docker (Recomendado)
where docker >nul 2>&1
if %errorLevel% equ 0 (
    docker info >nul 2>&1
    if %errorLevel% equ 0 (
        set "COMPOSE_BAKE=false"
        echo   [INFO] Reconstruyendo imagenes y levantando contenedores...
        docker compose up -d --build
        if %errorLevel% neq 0 (
            echo   [ERROR] Fallo al iniciar los contenedores de Docker.
            pause
            exit /b 1
        )
        echo   [OK] Contenedores en ejecucion. Esperando que el servidor responda...
        goto verificar_salud
    )
)

:: MODO B: PM2
where pm2 >nul 2>&1
if %errorLevel% equ 0 (
    echo   [INFO] Levantando aplicacion con PM2...
    call npm install >nul 2>&1
    pm2 start src/server.js --name turnero-app 2>nul || pm2 restart turnero-app
    pm2 save --force >nul 2>&1
    echo   [OK] Aplicacion reiniciada con PM2.
    goto verificar_salud
)

:: MODO C: Node nativo
where node >nul 2>&1
if %errorLevel% equ 0 (
    echo   [INFO] Actualizando dependencias npm...
    call npm install
    echo   [INFO] Iniciando servidor con Node.js...
    start "" /B node src/server.js
    timeout /t 3 /nobreak >nul
    goto verificar_salud
)

echo   [ERROR] No se encontro Docker, PM2 ni Node.js para reiniciar el sistema.
pause
exit /b 1

:verificar_salud
echo.
echo [6/6] Verificando salud del servidor (hasta 60 segundos)...
"%PSX%" -NoProfile -NonInteractive -Command "$ready = $false; for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 2; try { $r = Invoke-WebRequest -Uri 'http://localhost:3000/health' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch {} }; if ($ready) { Write-Host '  [OK] Servidor en linea y respondiendo correctamente en /health.' } else { Write-Host '  [AVISO] El servidor aun no responde. Puede continuar iniciando en segundo plano.' }"

echo.
echo ======================================================================
echo  SISTEMA TURNERO 2026 ACTUALIZADO Y EN LINEA
echo ======================================================================
echo   Rama:    !BRANCH!
echo   Commit:  !COMMIT_DESPUES!
echo.
echo Puntos de acceso:
echo   - Pantalla TV:           http://localhost:3000/tv.html
echo   - Operador de Mesa:      http://localhost:3000/panel_mesa.html
echo   - Panel Administrador:   http://localhost:3000/admin.html
echo   - Kiosko de Turnos:      http://localhost:3000/kiosko.html
echo.
echo * Para apagar el sistema y liberar puertos: ejecuta 'detener_sistema.bat'
echo ======================================================================
echo.
pause
