@echo off
setlocal EnableDelayedExpansion
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"
cd /d "%~dp0"
title Turnero 2026 - Detener Sistema y Liberar Puertos

:: Ruta a PowerShell (preferir pwsh 7, fallback a Windows PowerShell 5)
set "PSX=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "C:\Program Files\PowerShell\7\pwsh.exe" set "PSX=C:\Program Files\PowerShell\7\pwsh.exe"

echo ======================================================================
echo          TURNERO DE MATRICULAS 2026 - DETENER SISTEMA COMPLETO
echo ======================================================================
echo.

:: 1. Desactivar auto-inicio en Windows (creado por install.ps1)
echo [1/5] Desactivando inicio automatico de Windows...
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Turnero_2026_AutoStart.vbs"
if exist "%STARTUP_VBS%" (
    del /f /q "%STARTUP_VBS%" >nul 2>&1
    echo   [OK] Acceso de auto-inicio eliminado de la carpeta Inicio de Windows.
) else (
    echo   [INFO] No habia acceso de inicio automatico registrado.
)

:: 2. Detener y desregistrar PM2 si existe
echo.
echo [2/5] Verificando gestor de procesos PM2...
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
echo [3/5] Verificando contenedores Docker...
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

:: 4. Liberar puerto 3000 via PowerShell (compatible Windows 10/11)
echo.
echo [4/5] Verificando y liberando puerto 3000...
"%PSX%" -NoProfile -NonInteractive -Command "$conns = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue; if ($conns) { $pids = $conns.OwningProcess | Sort-Object -Unique | Where-Object { $_ -gt 0 }; foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host ('  [OK] Proceso PID ' + $p + ' en puerto 3000 finalizado.') } } else { Write-Host '  [OK] El puerto 3000 ya se encontraba libre.' }"

:: 5. Matar procesos node.exe que tengan server.js en su CommandLine
echo.
echo [5/5] Verificando procesos Node.js residuales (server.js)...
"%PSX%" -NoProfile -NonInteractive -Command "$found = $false; Get-Process node -ErrorAction SilentlyContinue | ForEach-Object { $id = $_.Id; try { $cl = (Get-WmiObject Win32_Process -Filter ('ProcessId=' + $id) -ErrorAction SilentlyContinue).CommandLine; if ($cl -match 'server\.js') { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; Write-Host ('  [OK] node.exe (server.js) PID ' + $id + ' finalizado.'); $found = $true } } catch {} }; if (-not $found) { Write-Host '  [OK] No se encontraron procesos Node.js residuales del servidor.' }"

:: Confirmacion final de estado del sistema
echo.
echo ======================================================================
echo                  ESTADO ACTUAL DEL SISTEMA
echo ======================================================================
"%PSX%" -NoProfile -NonInteractive -Command "if (Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue) { Write-Host '[ADVERTENCIA] Aun se detecta actividad en el puerto 3000.' } else { Write-Host '[EXITO] Sistema Turnero 2026 COMPLETAMENTE DETENIDO.'; Write-Host '[EXITO] Puerto 3000 LIMPIO Y LIBRE.'; Write-Host '[EXITO] Auto-inicio DESACTIVADO. No se encendera solo al reiniciar.' }"
echo ======================================================================
echo.
echo Para volver a encender el sistema cuando lo necesites:
echo   - Opcion 1: Doble clic en 'iniciar_sistema.bat' [Inicio rapido]
echo   - Opcion 2: Ejecutar en PowerShell 'install.ps1' [Reinstalacion]
echo.
pause
