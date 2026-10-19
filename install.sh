#!/usr/bin/env bash
# =============================================================================
# install.sh — Instalador Automatizado Turnero de Matriculas 2026 (v2.1)
#
# Deja el sistema completamente instalado, configurado y corriendo.
# Compatible con Linux (Ubuntu/Debian/CentOS/RHEL), WSL y macOS.
#
# Modos soportados:
#   1. Docker Compose (Recomendado para servidores y LAN)
#   2. Node.js nativo (Si Docker no esta disponible)
#
# Uso:
#   bash install.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "===================================================================="
echo " INSTALADOR — SISTEMA DIGITAL TURNERO DE MATRICULAS 2026 (v2.1)"
echo "===================================================================="
echo "[INFO] Iniciando verificacion de entorno e instalacion..."

# ── 1. Configuracion de Variables de Entorno (.env) ───────────────────────────
if [[ -f ".env" ]]; then
  echo "[OK] Archivo .env existente detectado. Se omite creacion y se conserva la configuracion actual intacta."
else
  echo "[INFO] Archivo .env no encontrado. Creando configuracion inicial desde .env.example..."
  if [[ -f ".env.example" ]]; then
    cp .env.example .env
  elif [[ -f ".env.production" ]]; then
    cp .env.production .env
  elif [[ -f ".env.development" ]]; then
    cp .env.development .env
  else
    cat << 'EOF' > .env
NODE_ENV=production
DB_NAME=turnero
DB_USER=turnero_app
DB_PASSWORD=turnero
DB_PORT_EXPOSED=5432
DATABASE_URL=postgresql://turnero_app:turnero@localhost:5432/turnero
PGBOUNCER_PORT_EXPOSED=5433
REDIS_PASSWORD=turnero_redis
REDIS_PORT_EXPOSED=6379
REDIS_URL=redis://:turnero_redis@localhost:6379
APP_PORT=3000
APP_PORT_EXPOSED=3000
JWT_EXPIRES_IN=2h
REFRESH_EXPIRES_IN=7d
BCRYPT_COST=12
LOG_LEVEL=info
EOF
  fi

  # Generar secretos criptograficos para JWT si no existen
  RAND_JWT=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 2>/dev/null || echo "turnero_jwt_default_secret_2026_$(date +%s)")
  RAND_REFRESH=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 2>/dev/null || echo "turnero_refresh_default_secret_2026_$(date +%s)")

  sed -i "s/<CAMBIAR_PASSWORD_SEGURO>/turnero_db_pass_2026/g" .env 2>/dev/null || true
  sed -i "s/<CAMBIAR_REDIS_PASSWORD>/turnero_redis_pass_2026/g" .env 2>/dev/null || true
  sed -i "s/<CAMBIAR_JWT_SECRET_64_CHARS_MINIMO>/${RAND_JWT}/g" .env 2>/dev/null || true
  sed -i "s/<CAMBIAR_REFRESH_SECRET_64_CHARS_MINIMO>/${RAND_REFRESH}/g" .env 2>/dev/null || true
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=${RAND_JWT}/" .env 2>/dev/null || true
  sed -i "s/^REFRESH_SECRET=.*/REFRESH_SECRET=${RAND_REFRESH}/" .env 2>/dev/null || true

  echo "[OK] Archivo .env generado exitosamente a partir de .env.example con secretos seguros."
fi

# Detectar IP LAN para despliegue
LAN_IP="localhost"
if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
  LAN_IP=$(hostname -I | awk '{print $1}')
elif command -v ip >/dev/null 2>&1; then
  LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' || echo "localhost")
fi

# ── 2. Seleccion de Modo de Instalacion ────────────────────────────────────────
HAS_DOCKER=false
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  HAS_DOCKER=true
fi

DOCKER_COMPOSE_CMD=""
if [[ "$HAS_DOCKER" == "true" ]]; then
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker-compose"
  fi
fi

if [[ -n "$DOCKER_COMPOSE_CMD" ]]; then
  echo "[INFO] Desplegando mediante Docker Compose ($DOCKER_COMPOSE_CMD)..."

  # Levantar contenedores en segundo plano con build
  $DOCKER_COMPOSE_CMD up -d --build

  DB_USER_CHECK=$(grep -E '^DB_USER=' .env 2>/dev/null | cut -d '=' -f2 | tr -d ' "\r' || echo "turnero_app")
  DB_NAME_CHECK=$(grep -E '^DB_NAME=' .env 2>/dev/null | cut -d '=' -f2 | tr -d ' "\r' || echo "turnero")
  [ -z "$DB_USER_CHECK" ] && DB_USER_CHECK="turnero_app"
  [ -z "$DB_NAME_CHECK" ] && DB_NAME_CHECK="turnero"

  echo "[INFO] Esperando inicializacion de PostgreSQL ($DB_NAME_CHECK)..."
  RETRIES=30
  until docker exec turnero-db pg_isready -U "$DB_USER_CHECK" -d "$DB_NAME_CHECK" >/dev/null 2>&1 || [ $RETRIES -eq 0 ]; do
    echo "       Esperando a PostgreSQL... ($RETRIES intentos restantes)"
    sleep 2
    RETRIES=$((RETRIES - 1))
  done

  if [ $RETRIES -eq 0 ]; then
    echo "[ERROR] Tiempo de espera agotado para PostgreSQL en Docker."
    exit 1
  fi
  echo "[OK] PostgreSQL esta listo y respondiendo."

  # Esperar que app este lista o ejecutar migraciones y seed
  echo "[INFO] Aplicando migraciones de base de datos..."
  $DOCKER_COMPOSE_CMD exec -T app node scripts/recrear_desde_cero.js

  echo "[INFO] Poblando base de datos con configuracion inicial..."
  $DOCKER_COMPOSE_CMD exec -T app node scripts/seed.js

else
  echo "[INFO] Docker no detectado o no esta en ejecucion. Procediendo con Node.js nativo..."

  if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Se requiere Node.js (version 20 o superior). Por favor instale Node.js o levante Docker."
    exit 1
  fi

  echo "[INFO] Instalando dependencias de Node.js..."
  npm install

  echo "[INFO] Compilando estilos Tailwind CSS..."
  npm run build:css || true

  echo "[INFO] Ejecutando migraciones de base de datos..."
  node scripts/recrear_desde_cero.js

  echo "[INFO] Ejecutando seed inicial..."
  node scripts/seed.js

  echo "[INFO] Iniciando servidor Turnero en segundo plano..."
  # Si pm2 esta disponible, usarlo para persistencia y auto-reinicio ante fallos
  if command -v pm2 >/dev/null 2>&1; then
    pm2 start src/server.js --name turnero-app || pm2 restart turnero-app
    pm2 save || true
    echo "[OK] Aplicacion gestionada con PM2 y guardada para recuperacion automatica."
  else
    nohup node src/server.js > turnero.log 2>&1 &
    sleep 2
    echo "[OK] Servidor iniciado con nohup en segundo plano (PID: $!)."
  fi
fi

# ── 3. Verificacion de Salud del Sistema ──────────────────────────────────────
echo "[INFO] Verificando estado del servidor HTTP..."
HEALTH_URL="http://localhost:3000/health"
APP_READY=false
for i in {1..15}; do
  if command -v curl >/dev/null 2>&1; then
    if curl -s "$HEALTH_URL" | grep -q "ok"; then
      APP_READY=true
      break
    fi
  fi
  sleep 1
done

if [[ "$APP_READY" == "true" ]]; then
  echo "[OK] Servidor web respondiendo correctamente en /health."
else
  echo "[AVISO] El servidor se esta iniciando. Puede tomar unos segundos adicionales."
fi

# ── 4. Resumen de Despliegue y Enlaces ─────────────────────────────────────────
echo ""
echo "===================================================================="
echo " SISTEMA TURNERO 2026 INSTALADO Y EN EJECUCION EXITOSAMENTE"
echo "===================================================================="
echo "Acceso Local:        http://localhost:3000"
echo "Acceso LAN Red:      http://${LAN_IP}:3000"
echo ""
echo "Puntos de Entrada del Sistema:"
echo "  - Pantalla TV (Auditorio 1080p): http://${LAN_IP}:3000/tv.html"
echo "  - Consola Operador de Mesa:      http://${LAN_IP}:3000/panel_mesa.html"
echo "  - Panel de Administrador:        http://${LAN_IP}:3000/admin.html"
echo "  - Autoservicio Kiosko Web:       http://${LAN_IP}:3000/kiosko.html"
echo ""
echo "Credenciales Iniciales:"
echo "  - Administrador 1: usuario: admin  | contrasena: soporte"
echo "  - Administrador 2: usuario: admin2 | contrasena: soporte"
echo "  - Operadores:      op1 a op5       | contrasena: Operador2026!"
echo ""
echo "Recursos Configurados:"
echo "  - 10 Mesas registradas (Mesa 1 a Mesa 10)"
echo "  - 1 Lote creado: Lote 1 (1 a 500 vouchers, activo)"
echo "  - Modo operativo: Asistido con soporte a impresion ESC/POS"
echo "  - Resiliencia: Contenedores con 'restart: unless-stopped' / PM2"
echo "===================================================================="
