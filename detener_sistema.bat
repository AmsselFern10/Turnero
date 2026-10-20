@echo off
setlocal
cd /d "%~dp0"
title Turnero 2026 - Detener Sistema y Liberar Puertos

echo ======================================================================
echo          TURNERO DE MATRICULAS 2026 - DETENER SISTEMA COMPLETO
echo ======================================================================
echo.

:: 1. Desactivar auto-inicio en Windows (creado por install.ps1)
echo [1/4] Desactivando inicio automatico de Windows...
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Turnero_2026_AutoStart.vbs"
if exist "%STARTUP_VBS%" (
    del /f /q "%STARTUP_VBS%" >nul 2>&1
    echo   [OK] Acceso de auto-inicio eliminado de la carpeta Inicio de Windows.
) else (
    echo   [INFO] No habia acceso de inicio automatico registrado.
)

:: 2. Detener y desregistrar PM2 si existe
echo.
echo [2/4] Verificando gestor de procesos PM2...
where pm2 >nul 2>&1
if %errorLevel% equ 0 (
    call pm2 delete turnero-app >nul 2>&1
    call pm2 save --force >nul 2>&1
    echo   [OK] Proceso 'turnero-app' detenido y eliminado de PM2.
) else (
    echo   [INFO] PM2 no esta configurado en este equipo.
)

:: 3. Detener contenedores Docker si estan activos
echo.
echo [3/4] Verificando contenedores Docker...
where docker >nul 2>&1
if %errorLevel% equ 0 (
    docker info >nul 2>&1
    if %errorLevel% equ 0 (
        echo   [INFO] Deteniendo contenedores con 'docker compose down'...
        docker compose down >nul 2>&1
        echo   [OK] Contenedores de base de datos, redis y app detenidos.
    ) else (
        echo   [INFO] Docker no esta en ejecucion.
    )
) else (
    echo   [INFO] Docker no esta instalado en este equipo.
)

:: 4. Liberar puerto 3000 forzando cierre de procesos en escucha
echo.
echo [4/4] Verificando y liberando puerto 3000...
set "ENCONTRADO=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000"') do (
    if not "%%P"=="0" (
        set "ENCONTRADO=1"
        taskkill /f /pid %%P >nul 2>&1
        echo   [OK] Proceso con PID %%P finalizado.
    )
)
if "%ENCONTRADO%"=="0" (
    echo   [OK] El puerto 3000 ya se encontraba libre.
)

:: Confirmacion final de puerto limpio
echo.
echo ======================================================================
echo                  ESTADO ACTUAL DEL SISTEMA
echo ======================================================================
netstat -ano | findstr ":3000" >nul 2>&1
if %errorLevel% equ 0 (
    echo [ADVERTENCIA] Aun se detecta actividad en el puerto 3000.
) else (
    echo [EXITO] Sistema Turnero 2026 COMPLETAMENTE DETENIDO.
    echo [EXITO] Puerto 3000 LIMPIO Y LIBRE.
    echo [EXITO] Auto-inicio DESACTIVADO. No se encendera solo al reiniciar.
)
echo ======================================================================
echo.
echo Para volver a encender el sistema cuando lo necesites:
echo   - Opcion 1: Doble clic en 'iniciar_sistema.bat' [Inicio rapido]
echo   - Opcion 2: Ejecutar en PowerShell 'install.ps1' [Reinstalacion]
echo.
pause
