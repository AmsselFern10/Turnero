#!/usr/bin/env bash
# =============================================================================
# restore.sh — Restauración de Respaldo de PostgreSQL
# Sistema Turnero de Matrículas 2026 (v2.1)
#
# Uso:
#   bash scripts/restore.sh backups/turnero-2026-10-11_02-00.sql.gz
#
# ADVERTENCIA: Este script reemplaza TODA la base de datos.
#   Usar solo en entorno de prueba o con confirmacion en produccion.
# =============================================================================

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Uso: $0 <archivo_backup.sql.gz>"
  exit 1
fi

BACKUP_FILE="$1"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "ERROR: No se encontro el archivo de respaldo: $BACKUP_FILE"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

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

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] RESTAURANDO $BACKUP_FILE en $DB_NAME..."
echo "ADVERTENCIA: Esto borrara todos los datos actuales. Ctrl+C en 5 segundos para cancelar..."
sleep 5

# Terminar conexiones activas antes de restaurar
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB_NAME' AND pid <> pg_backend_pid();" \
  > /dev/null 2>&1 || true

# Limpiar esquema public para evitar colisiones de tablas, funciones y primary keys existentes
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO $DB_USER; GRANT ALL ON SCHEMA public TO public;" \
  > /dev/null 2>&1 || true

# Restaurar
gunzip -c "$BACKUP_FILE" | docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Restauracion completada desde $BACKUP_FILE."
