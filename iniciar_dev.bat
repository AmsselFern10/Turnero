@echo off
setlocal EnableDelayedExpansion
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0;C:\Program Files\PowerShell\7;C:\Program Files\Docker\Docker\resources\bin;%PATH%"
cd /d "%~dp0"
title Turnero 2026 - Modo Desarrollo [Nodemon + DB/Redis]

echo ======================================================================
echo       TURNERO DE MATRICULAS 2026 - INICIO EN MODO DESARROLLO
echo ======================================================================
echo.

:: 1. Verificar Node.js
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] No se encontro Node.js en este equipo.
    echo Por favor instala Node.js LTS v20 o superior desde https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: 2. Verificar dependencias locales
if not exist "node_modules\" (
    echo [1/3] La carpeta node_modules no existe. Instalando dependencias...
    call npm install
    if %errorLevel% neq 0 (
        echo [ERROR] Fallo npm install.
        pause
        exit /b 1
    )
    echo   [OK] Dependencias instaladas.
) else (
    echo [1/3] Dependencias locales node_modules detectadas.
)

:: 3. Verificar Docker y levantar base de datos y Redis
echo.
echo [2/3] Levantando base de datos PostgreSQL y Redis con Docker...

where docker >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo [ERROR] Docker no esta instalado o no se encuentra en PATH.
    echo Para desarrollo necesitas Docker Desktop para PostgreSQL y Redis.
    echo Descargalo desde: https://www.docker.com
    echo.
    pause
    exit /b 1
)

docker info >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo ======================================================================
    echo  [AVISO] DOCKER DESKTOP NO ESTA INICIADO
    echo ======================================================================
    echo  Inicia la aplicacion Docker Desktop en Windows y espera a que arranque.
    echo  Una vez abierta, presiona cualquier tecla para continuar...
    echo ======================================================================
    pause >nul
    docker info >nul 2>&1
    if !errorLevel! neq 0 (
        echo [ERROR] Docker Desktop sigue sin responder.
        pause
        exit /b 1
    )
)

:: Levantar servicios de soporte en segundo plano
set "COMPOSE_BAKE=false"
docker compose up -d db redis pgbouncer
if %errorLevel% neq 0 (
    echo [ERROR] Fallo al levantar los contenedores de base de datos y redis.
    pause
    exit /b 1
)

:: Esperar que PostgreSQL este aceptando conexiones
echo   [INFO] Esperando inicializacion de PostgreSQL en puerto 5432...
set "RETRIES=25"
:esperar_db
if %RETRIES% equ 0 goto db_lista
docker exec turnero-db pg_isready >nul 2>&1
if %errorLevel% equ 0 goto db_lista
timeout /t 1 /nobreak >nul
set /a RETRIES=%RETRIES%-1
goto esperar_db

:db_lista
echo   [OK] PostgreSQL y Redis listos y respondiendo.

:: 4. Iniciar Nodemon para desarrollo
echo.
echo [3/3] Iniciando servidor con recarga en vivo [Nodemon]...
echo ======================================================================
echo  MODO DESARROLLO ACTIVO
echo ======================================================================
echo  - Backend:           http://localhost:3000
echo  - Consola Operador:  http://localhost:3000/panel_mesa.html
echo  - Pantalla TV:       http://localhost:3000/tv.html
echo  - Administrador:     http://localhost:3000/admin.html
echo  - Kiosko Web:        http://localhost:3000/kiosko.html
echo.
echo  * Para reiniciar manualmente el servidor: escribe rs y pulsa Enter.
echo  * Para detener el servidor Node: presiona Ctrl + C.
echo  * Para apagar PostgreSQL y Redis al terminar: ejecuta detener_sistema.bat
echo ======================================================================
echo.

call npm run dev
if %errorLevel% neq 0 (
    echo.
    echo [AVISO] El servidor se ha detenido.
    pause
)
