@echo off
setlocal
cd /d "%~dp0"
title Turnero 2026 - Inicio Rapido del Sistema
echo ======================================================================
echo             TURNERO DE MATRICULAS 2026 — INICIO DEL SISTEMA
echo ======================================================================
echo.

:: 1. Si Docker esta disponible y corriendo, iniciar contenedores
where docker >nul 2>&1
if %errorLevel% equ 0 (
    docker info >nul 2>&1
    if %errorLevel% equ 0 (
        echo [INFO] Docker activo. Iniciando contenedores en segundo plano...
        docker compose up -d
        echo.
        echo [OK] Contenedores activos con politica 'restart: unless-stopped'.
        echo      Acceso local: http://localhost:3000
        goto fin
    )
)

:: 2. Si PM2 esta instalado globalmente, usar PM2
where pm2 >nul 2>&1
if %errorLevel% equ 0 (
    echo [INFO] Iniciando mediante gestor de procesos PM2...
    pm2 start src/server.js --name turnero-app
    pm2 save
    echo.
    echo [OK] Aplicacion corriendo y protegida ante caidas por PM2.
    echo      Acceso local: http://localhost:3000
    goto fin
)

:: 3. Inicio directo mediante Node.js
echo [INFO] Iniciando servidor con Node.js en esta consola...
echo [INFO] Para detener el servidor presiona Ctrl + C.
echo.
node src/server.js
exit /b

:fin
echo.
echo ======================================================================
echo  El sistema Turnero esta listo. Puedes abrir:
echo  - Pantalla TV:           http://localhost:3000/tv.html
echo  - Operador de Mesa:      http://localhost:3000/panel_mesa.html
echo  - Panel Administrador:   http://localhost:3000/admin.html
echo  - Kiosko de Turnos:      http://localhost:3000/kiosko.html
echo ======================================================================
echo.
pause
