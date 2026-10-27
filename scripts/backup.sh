#!/usr/bin/env bash
# =============================================================================
# backup.sh — Respaldo Automático de PostgreSQL
# Sistema Turnero de Matrículas 2026 (v2.1)
#
# Uso manual:
#   bash scripts/backup.sh
#
# Uso automático (cron diario a las 02:00):
#   0 2 * * * /ruta/al/proyecto/scripts/backup.sh >> /var/log/turnero-backup.log 2>&1
#
# Restauración:
#   bash scripts/restore.sh backups/turnero-YYYY-MM-DD_HH-MM.sql.gz
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_DIR/backups"
KEEP_DAYS=7
TIMESTAMP=$(date +%Y-%m-%d_%H-%M)
BACKUP_FILE="$BACKUP_DIR/turnero-$TIMESTAMP.sql.gz"

ENV_FILE="$PROJECT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  ENV_FILE="$PROJECT_DIR/.env.development"
fi
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

DB_CONTAINER="${DB_CONTAINER_NAME:-turnero-db}"
DB_NAME="${DB_NAME:-turnero}"
DB_USER="${DB_USER:-postgres}"

mkdir -p "$BACKUP_DIR"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Iniciando respaldo de $DB_NAME..."

docker exec "$DB_CONTAINER" \
  pg_dump -U "$DB_USER" --clean --if-exists -Fp --no-password "$DB_NAME" \
  | gzip -9 > "$BACKUP_FILE"

BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Respaldo creado: $BACKUP_FILE ($BACKUP_SIZE)"

DELETED=$(find "$BACKUP_DIR" -name "turnero-*.sql.gz" -mtime "+$KEEP_DAYS" -delete -print | wc -l)
if [[ "$DELETED" -gt 0 ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Rotacion: $DELETED respaldo(s) antiguo(s) eliminado(s)."
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Respaldo completado exitosamente."
