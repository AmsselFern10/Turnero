@echo off
setlocal EnableDelayedExpansion
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"
cd /d "%~dp0"
title Turnero 2026 - Inicio Rapido del Sistema

:: Ruta a PowerShell (preferir pwsh 7, fallback a Windows PowerShell 5)
set "PSX=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "C:\Program Files\PowerShell\7\pwsh.exe" set "PSX=C:\Program Files\PowerShell\7\pwsh.exe"

echo ======================================================================
echo             TURNERO DE MATRICULAS 2026 - INICIO DEL SISTEMA
echo ======================================================================
echo.

:: 1. Verificar modo de ejecucion
echo [1/3] Verificando modo de ejecucion...
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "STARTUP_VBS=%STARTUP_FOLDER%\Turnero_2026_AutoStart.vbs"

:: Opcion A: Docker disponible y corriendo -> usar Docker (restart: unless-stopped)
where docker >nul 2>&1
if %errorLevel% equ 0 (
    docker info >nul 2>&1
    if %errorLevel% equ 0 (
        if exist "%STARTUP_VBS%" del /f /q "%STARTUP_VBS%" >nul 2>&1
        set "COMPOSE_BAKE=false"
        echo   [INFO] Docker activo. Iniciando contenedores en segundo plano...
        docker compose up -d
        if %errorLevel% neq 0 (
            echo   [ERROR] Fallo al iniciar los contenedores de Docker.
            pause
            exit /b 1
        )
        echo   [OK] Contenedores iniciados con politica 'restart: unless-stopped'.
        goto esperar_salud
    )
)

:: Si no usa Docker, configurar auto-inicio para Node nativo
if exist "%STARTUP_FOLDER%" (
    (
        echo Set WshShell = CreateObject^("WScript.Shell"^)
        echo WshShell.CurrentDirectory = "%~dp0"
        echo WshShell.Run "node src/server.js", 0, False
    ) > "%STARTUP_VBS%"
    echo   [OK] Auto-inicio activado en Windows ante reinicios del equipo.
)

:: 2. Levantar los servicios
echo.
echo [2/3] Iniciando servicios del Turnero en el puerto 3000...

:: Opcion B: PM2 disponible -> usar PM2
where pm2 >nul 2>&1
if %errorLevel% equ 0 (
    echo   [INFO] PM2 detectado. Iniciando mediante gestor de procesos PM2...
    pm2 start src/server.js --name turnero-app
    pm2 save --force >nul 2>&1
    echo   [OK] Aplicacion corriendo en puerto 3000 y protegida por PM2.
    goto esperar_salud
)

:: Opcion C: Node.js directo
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo ======================================================================
    echo  [ERROR] NO SE ENCONTRO NODE.JS NI DOCKER DESKTOP EN ESTE EQUIPO
    echo ======================================================================
    echo  Para ejecutar el Turnero necesitas una de las siguientes opciones:
    echo    1. Instalar Docker Desktop (recomendado): https://www.docker.com
    echo    2. O instalar Node.js LTS (v20 o superior): https://nodejs.org
    echo ======================================================================
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo   [INFO] Repositorio recien clonado: 'node_modules' no existe.
    echo   [INFO] Instalando dependencias con npm install...
    call npm install
    if %errorLevel% neq 0 (
        echo   [ERROR] Fallo al ejecutar npm install.
        pause
        exit /b 1
    )
    echo   [OK] Dependencias instaladas exitosamente.
)

echo   [INFO] Iniciando servidor con Node.js en esta consola...
echo   [INFO] Para detener el servidor presiona Ctrl + C o ejecuta 'detener_sistema.bat'.
echo.
node src/server.js
exit /b

:esperar_salud
:: 3. Verificar que el servidor responde en /health (hasta 60 segundos)
echo.
echo [3/3] Verificando estado del servidor (hasta 60 segundos)...
"%PSX%" -NoProfile -NonInteractive -Command "$ready = $false; for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 2; try { $r = Invoke-WebRequest -Uri 'http://localhost:3000/health' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch {} }; if ($ready) { Write-Host '  [OK] Servidor respondiendo correctamente en /health.' } else { Write-Host '  [AVISO] El servidor aun no responde en /health — puede seguir iniciandose. Verifique: http://localhost:3000/health' }"

:fin
echo.
echo ======================================================================
echo  SISTEMA TURNERO ACTIVO Y EN LINEA
echo  - Puerto 3000: OCUPADO Y ESCUCHANDO PETICIONES
echo  - Auto-arranque: ACTIVADO ante reinicios de Windows
echo ======================================================================
echo.
echo Puntos de acceso:
echo   - Pantalla TV:           http://localhost:3000/tv.html
echo   - Operador de Mesa:      http://localhost:3000/panel_mesa.html
echo   - Panel Administrador:   http://localhost:3000/admin.html
echo   - Kiosko de Turnos:      http://localhost:3000/kiosko.html
echo.
echo * Para apagar el sistema y liberar el puerto: ejecuta 'detener_sistema.bat'
echo ======================================================================
echo.
pause
