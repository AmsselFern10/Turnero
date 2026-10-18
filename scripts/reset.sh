#!/usr/bin/env bash
# =============================================================================
# reset.sh — Reseteo Total del Sistema Turnero 2026 (v2.1)
#
# Borra todos los turnos, lotes, mesas y operadores, dejando UNICAMENTE:
#   Usuario: admin
#   Contraseña: soporte
#
# Uso:
#   bash scripts/reset.sh
#   bash scripts/reset.sh --yes
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "===================================================="
echo " ADVERTENCIA: RESETEO TOTAL DEL SISTEMA TURNERO 2026"
echo "===================================================="
echo "Esta accion borrara definitivamente:"
echo "  - Todos los turnos historicos y en atencion"
echo "  - Todos los lotes de vouchers"
echo "  - Todas las mesas configuradas"
echo "  - Todos los operadores registrados"
echo "  - Todos los logs de auditoria"
echo ""
echo "Se mantendra UNICAMENTE:"
echo "  - 1 usuario administrador: admin / soporte"
echo "===================================================="

CONFIRMED=false
if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
  CONFIRMED=true
fi

if [[ "$CONFIRMED" != "true" ]]; then
  read -r -p "Desea continuar con el reseteo? [s/N]: " RESP
  if [[ "$RESP" != "s" && "$RESP" != "S" && "$RESP" != "si" && "$RESP" != "SI" ]]; then
    echo "[CANCELADO] Operacion cancelada por el usuario."
    exit 0
  fi
fi

# Verificar si node esta disponible en el host
if command -v node >/dev/null 2>&1; then
  echo "[INFO] Ejecutando reseteo mediante Node.js local..."
  node "$PROJECT_DIR/scripts/reset.js"
elif command -v docker >/dev/null 2>&1 && docker ps | grep -q "turnero-app"; then
  echo "[INFO] Ejecutando reseteo dentro del contenedor turnero-app..."
  docker exec turnero-app node scripts/reset.js
else
  echo "[ERROR] No se encontro ejecutable de 'node' local ni contenedor 'turnero-app' activo."
  exit 1
fi
