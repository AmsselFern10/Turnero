# =============================================================================
# restore.ps1 — Restauracion de Respaldo de PostgreSQL (Windows)
# Sistema Turnero de Matriculas 2026 (v2.1)
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\restore.ps1 backups\turnero-FECHA.sql.gz
#
# ADVERTENCIA: Reemplaza TODA la base de datos. Usar solo en pruebas o emergencia.
# =============================================================================

param(
    [Parameter(Mandatory=$true)]
    [string]$BackupFile
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackupFile)) {
    Write-Error "No se encontro el archivo de respaldo: $BackupFile"
    exit 1
}

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$envPath = if (Test-Path (Join-Path $ProjectDir ".env")) { Join-Path $ProjectDir ".env" } else { Join-Path $ProjectDir ".env.development" }

if (Test-Path $envPath) {
    Get-Content $envPath | Where-Object { $_ -match '^\s*([^#][^=]+)=(.*)$' } | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            $k = $Matches[1].Trim(); $v = $Matches[2].Trim().Trim('"')
            [Environment]::SetEnvironmentVariable($k, $v, "Process")
        }
    }
}

$DbContainer = if ($env:DB_CONTAINER_NAME) { $env:DB_CONTAINER_NAME } else { "turnero-db" }
$DbName      = if ($env:DB_NAME)           { $env:DB_NAME }           else { "turnero" }
$DbUser      = if ($env:DB_USER)           { $env:DB_USER }           else { "postgres" }

Write-Host "[$([datetime]::UtcNow.ToString('o'))] RESTAURANDO $BackupFile en $DbName..."
Write-Host "ADVERTENCIA: Esto borrara todos los datos actuales. Ctrl+C para cancelar (5 segundos)..."
Start-Sleep -Seconds 5

# Descomprimir en memoria y pasar por stdin a psql
try {
    $fs  = [System.IO.File]::OpenRead($BackupFile)
    $gz  = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Decompress)
    $sr  = New-Object System.IO.StreamReader($gz)
    $sql = $sr.ReadToEnd()
    $sr.Close(); $gz.Close(); $fs.Close()

    # Terminar conexiones activas
    docker exec $DbContainer psql -U $DbUser -d postgres -c `
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DbName' AND pid <> pg_backend_pid();" 2>$null | Out-Null

    # Restaurar
    $sql | docker exec -i $DbContainer psql -U $DbUser -d $DbName
    if ($LASTEXITCODE -ne 0) { throw "psql fallo con codigo $LASTEXITCODE" }

    Write-Host "[$([datetime]::UtcNow.ToString('o'))] Restauracion completada desde $BackupFile."
} catch {
    Write-Error "ERROR en la restauracion: $_"
    exit 1
}
