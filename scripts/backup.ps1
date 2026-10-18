# =============================================================================
# backup.ps1 — Respaldo Automatico de PostgreSQL (Windows)
# Sistema Turnero de Matriculas 2026 (v2.1)
#
# Uso manual:
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
#
# Uso automatico con Programador de Tareas de Windows:
#   powershell -ExecutionPolicy Bypass -File "scripts\backup.ps1"
#
# Restauracion:
#   scripts\restore.ps1 backups\turnero-YYYY-MM-DD_HH-mm.sql.gz
# =============================================================================

param(
    [string]$EnvFile = "",
    [int]$KeepDays   = 7
)

$ErrorActionPreference = "Stop"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$BackupDir  = Join-Path $ProjectDir "backups"

# Cargar variables del .env si existe
$envPath = if ($EnvFile) { $EnvFile } elseif (Test-Path (Join-Path $ProjectDir ".env")) { Join-Path $ProjectDir ".env" } else { Join-Path $ProjectDir ".env.development" }
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

# Crear directorio de backups si no existe
if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir | Out-Null }

$Timestamp  = (Get-Date -Format "yyyy-MM-dd_HH-mm")
$BackupFile = Join-Path $BackupDir "turnero-$Timestamp.sql.gz"

Write-Host "[$([datetime]::UtcNow.ToString('o'))] Iniciando respaldo de $DbName..."

# pg_dump dentro del contenedor | comprimir con gzip (requiere git-bash o WSL en PATH)
# Alternativa: usa el pg_dump nativo si tienes PostgreSQL client instalado en Windows
try {
    $dump = & docker exec $DbContainer pg_dump -U $DbUser -Fp --no-password $DbName
    if ($LASTEXITCODE -ne 0) { throw "pg_dump fallo con codigo $LASTEXITCODE" }

    # Comprimir con System.IO.Compression
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($dump -join "`n")
    $fs    = [System.IO.File]::Create($BackupFile)
    $gz    = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Compress)
    $gz.Write($bytes, 0, $bytes.Length)
    $gz.Close(); $fs.Close()

    $sizeMB = [math]::Round((Get-Item $BackupFile).Length / 1MB, 2)
    Write-Host "[$([datetime]::UtcNow.ToString('o'))] Respaldo creado: $BackupFile ($sizeMB MB)"
} catch {
    Write-Error "ERROR en el respaldo: $_"
    exit 1
}

# Rotar: eliminar respaldos mas antiguos que $KeepDays dias
$old = Get-ChildItem -Path $BackupDir -Filter "turnero-*.sql.gz" |
       Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }
if ($old.Count -gt 0) {
    $old | Remove-Item -Force
    Write-Host "[$([datetime]::UtcNow.ToString('o'))] Rotacion: $($old.Count) respaldo(s) antiguo(s) eliminado(s)."
}

Write-Host "[$([datetime]::UtcNow.ToString('o'))] Respaldo completado exitosamente."
