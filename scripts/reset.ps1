# =============================================================================
# reset.ps1 — Reseteo Total del Sistema Turnero 2026 (Windows PowerShell)
#
# Borra todos los turnos, lotes, mesas y operadores, dejando UNICAMENTE:
#   Usuario: admin
#   Contrasena: Admin2026!
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\reset.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\reset.ps1 -Force
# =============================================================================

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

Write-Host "===================================================="
Write-Host " ADVERTENCIA: RESETEO TOTAL DEL SISTEMA TURNERO 2026"
Write-Host "===================================================="
Write-Host "Esta accion borrara definitivamente:"
Write-Host "  - Todos los turnos historicos y en atencion"
Write-Host "  - Todos los lotes de vouchers"
Write-Host "  - Todas las mesas configuradas"
Write-Host "  - Todos los operadores registrados"
Write-Host "  - Todos los logs de auditoria"
Write-Host ""
Write-Host "Se mantendra UNICAMENTE:"
Write-Host "  - 1 usuario administrador: admin / Admin2026!"
Write-Host "===================================================="

if (-not $Force) {
    $resp = Read-Host "Desea continuar con el reseteo? [s/N]"
    if ($resp -notmatch "^(s|si|y|yes)$") {
        Write-Host "[CANCELADO] Operacion cancelada por el usuario."
        exit 0
    }
}

$nodeInstalled = (Get-Command node -ErrorAction SilentlyContinue)
if ($nodeInstalled) {
    Write-Host "[INFO] Ejecutando reseteo mediante Node.js local..."
    & node (Join-Path $ScriptDir "reset.js")
} else {
    $dockerRunning = (docker ps -q -f name=turnero-app 2>$null)
    if ($dockerRunning) {
        Write-Host "[INFO] Ejecutando reseteo dentro del contenedor turnero-app..."
        & docker exec turnero-app node scripts/reset.js
    } else {
        Write-Error "[ERROR] No se encontro ejecutable de 'node' local ni contenedor 'turnero-app' activo."
        exit 1
    }
}
