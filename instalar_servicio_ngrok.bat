@echo off
setlocal
cd /d "%~dp0"
title Instalador de Servicio Ngrok - Turnero 2026
echo ======================================================================
echo    INSTALANDO NGROK COMO SERVICIO NATIVO DE WINDOWS (Turnero 2026)
echo ======================================================================
echo.

:: Verificar permisos de Administrador
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [AVISO] Se requieren permisos de Administrador para registrar un servicio de Windows.
    echo Solicitando elevacion de privilegios...
    "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd.exe -ArgumentList '/k \"\"%~f0\"\" ELEVATED' -Verb RunAs"
    exit /b
)

:: Detener cualquier proceso previo de ngrok para liberar puertos y archivos
echo [1/4] Deteniendo procesos previos de ngrok...
taskkill /f /im ngrok.exe >nul 2>&1

:: Si ya existia el servicio, desinstalarlo limpiamente
echo [2/4] Verificando servicio previo...
ngrok service stop >nul 2>&1
ngrok service uninstall >nul 2>&1

:: Instalar el servicio apuntando a ngrok.yml
echo [3/4] Instalando servicio de Windows con ngrok.yml...
ngrok service install --config "%~dp0ngrok.yml"

if %errorLevel% equ 0 (
    echo.
    echo [4/4] Iniciando el servicio ngrok...
    ngrok service start
    echo.
    echo ======================================================================
    echo   EXITO: Servicio nativo de ngrok instalado y activo.
    echo.
    echo   - Arrancara automaticamente cada vez que enciendas la computadora.
    echo   - Sin terminales abiertas.
    echo   - Dominio publico activo:
    echo     https://afternoon-bucket-hesitate.ngrok-free.dev
    echo ======================================================================
) else (
    echo.
    echo [ERROR] No se pudo registrar el servicio.
)

echo.
echo Presione cualquier tecla para cerrar esta ventana...
pause >nul
