@echo off
setlocal
cd /d "%~dp0"
title Turnero 2026 - Inicio Rapido del Sistema

echo ======================================================================
echo             TURNERO DE MATRICULAS 2026 - INICIO DEL SISTEMA
echo ======================================================================
echo.

:: 1. Gestionar servicios y auto-arranque
echo [1/2] Verificando modo de ejecucion...
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "STARTUP_VBS=%STARTUP_FOLDER%\Turnero_2026_AutoStart.vbs"

:: Opcion A: Si Docker esta disponible y corriendo, usar Docker (maneja su propio auto-inicio con restart: unless-stopped)
where docker >nul 2>&1
if %errorLevel% equ 0 (
    docker info >nul 2>&1
    if %errorLevel% equ 0 (
        :: Limpiar script VBS viejo para evitar errores de Windows Script Host
        if exist "%STARTUP_VBS%" del /f /q "%STARTUP_VBS%" >nul 2>&1
        set "COMPOSE_BAKE=false"
        echo   [INFO] Docker activo. Iniciando contenedores en segundo plano...
        docker compose up -d
        echo   [OK] Contenedores activos en puerto 3000 con politica 'restart: unless-stopped'.
        goto fin
    )
)

:: Si no se usa Docker, configurar auto-inicio para Node nativo
if exist "%STARTUP_FOLDER%" (
    (
        echo Set WshShell = CreateObject^("WScript.Shell"^)
        echo WshShell.CurrentDirectory = "%~dp0"
        echo WshShell.Run "node src/server.js", 0, False
    ) > "%STARTUP_VBS%"
    echo   [OK] Auto-inicio activado en Windows ante reinicios del equipo.
)

:: 2. Levantar los servicios y ocupar el puerto 3000
echo.
echo [2/2] Iniciando servicios del Turnero en el puerto 3000...

:: Opcion B: Si PM2 esta instalado globalmente, usar PM2
where pm2 >nul 2>&1
if %errorLevel% equ 0 (
    echo   [INFO] PM2 detectado. Iniciando mediante gestor de procesos PM2...
    pm2 start src/server.js --name turnero-app
    pm2 save --force >nul 2>&1
    echo   [OK] Aplicacion corriendo en puerto 3000 y protegida por PM2.
    goto fin
)

:: Opcion C: Inicio directo mediante Node.js
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
