@echo off
setlocal
cd /d "%~dp0"
title Turnero 2026 - Inicio Rapido del Sistema

echo ======================================================================
echo             TURNERO DE MATRICULAS 2026 - INICIO DEL SISTEMA
echo ======================================================================
echo.

:: 1. Reactivar auto-inicio en Windows al encender o reiniciar el equipo
echo [1/2] Configurando auto-inicio de Windows...
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "STARTUP_VBS=%STARTUP_FOLDER%\Turnero_2026_AutoStart.vbs"
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

:: Opcion A: Si Docker esta disponible y corriendo, iniciar contenedores
where docker >nul 2>&1
if %errorLevel% equ 0 (
    docker info >nul 2>&1
    if %errorLevel% equ 0 (
        set "COMPOSE_BAKE=false"
        echo   [INFO] Docker detectado. Iniciando contenedores en segundo plano...
        docker compose up -d
        echo   [OK] Contenedores activos en puerto 3000 con politica 'restart: unless-stopped'.
        goto fin
    )
)

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
