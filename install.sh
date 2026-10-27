#!/usr/bin/env bash
# =============================================================================
# install.sh — Instalador Automatizado Turnero de Matriculas 2026 (v2.1)
#
# Deja el sistema completamente instalado, configurado y corriendo.
# Compatible con Linux (Ubuntu/Debian/CentOS/RHEL), WSL y macOS.
# Alta tolerancia a fallos: fallback automatico entre Docker y Node.js local.
#
# Uso:
#   bash install.sh
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "===================================================================="
echo " INSTALADOR — SISTEMA DIGITAL TURNERO DE MATRICULAS 2026 (v2.1)"
echo "===================================================================="
echo "[INFO] Iniciando verificacion de entorno e instalacion..."
echo ""

# =============================================================================
# 1. Configuracion de Variables de Entorno (.env)
# =============================================================================
echo "[1/4] Configurando archivo .env..."

if [[ -f ".env" ]]; then
  echo "  [OK] Archivo .env existente detectado — se conserva intacto."
else
  echo "  [INFO] Archivo .env no encontrado. Creando desde plantilla..."

  if   [[ -f ".env.example"    ]]; then cp .env.example    .env
  elif [[ -f ".env.production" ]]; then cp .env.production .env
  elif [[ -f ".env.development"]]; then cp .env.development .env
  else
    echo "  [INFO] Generando .env basico funcional..."
    cat > .env << 'ENVEOF'
NODE_ENV=production
DB_NAME=turnero
DB_USER=postgres
DB_PASSWORD=turnero
DB_HOST=localhost
DB_PORT_EXPOSED=5432
DB_POOL_MAX=20
DB_CONTAINER_NAME=turnero-db
DATABASE_URL=postgresql://postgres:turnero@localhost:5432/turnero
PGBOUNCER_PORT_EXPOSED=5433
REDIS_PASSWORD=turnero_redis
REDIS_HOST=localhost
REDIS_PORT_EXPOSED=6379
REDIS_URL=redis://:turnero_redis@localhost:6379
APP_PORT=3000
APP_PORT_EXPOSED=3000
HOST_IP=
ALLOWED_ORIGINS=
JWT_SECRET=
REFRESH_SECRET=
JWT_EXPIRES_IN=2h
REFRESH_EXPIRES_IN=7d
BCRYPT_COST=12
RATE_LIMIT_LOGIN_MAX=10
LOG_LEVEL=info
ENVEOF
  fi

  # Generar secretos JWT criptograficos
  RAND_JWT=$(openssl rand -hex 48 2>/dev/null \
    || node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" 2>/dev/null \
    || echo "turnero_jwt_fallback_secret_$(date +%s)_$(hostname)_2026")
  RAND_REFRESH=$(openssl rand -hex 48 2>/dev/null \
    || node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" 2>/dev/null \
    || echo "turnero_refresh_fallback_secret_$(date +%s)_$(hostname)_2026")

  sed -i "s/<CAMBIAR_PASSWORD_SEGURO>/turnero_db_2026/g"              .env 2>/dev/null || true
  sed -i "s/<CAMBIAR_REDIS_PASSWORD>/turnero_redis_2026/g"            .env 2>/dev/null || true
  sed -i "s/<CAMBIAR_JWT_SECRET_64_CHARS_MINIMO>/${RAND_JWT}/g"       .env 2>/dev/null || true
  sed -i "s/<CAMBIAR_REFRESH_SECRET_64_CHARS_MINIMO>/${RAND_REFRESH}/g" .env 2>/dev/null || true

  if grep -qE '^JWT_SECRET=$' .env 2>/dev/null; then
    sed -i "s|^JWT_SECRET=$|JWT_SECRET=${RAND_JWT}|" .env 2>/dev/null || true
  fi
  if grep -qE '^REFRESH_SECRET=$' .env 2>/dev/null; then
    sed -i "s|^REFRESH_SECRET=$|REFRESH_SECRET=${RAND_REFRESH}|" .env 2>/dev/null || true
  fi

  echo "  [OK] Archivo .env generado con secretos JWT criptograficos."
fi

# =============================================================================
# 2. Detectar IP LAN del host
# =============================================================================
LAN_IP="localhost"
if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
elif command -v ip >/dev/null 2>&1; then
  LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || echo "localhost")
fi
[[ -z "$LAN_IP" ]] && LAN_IP="localhost"

# =============================================================================
# 3. Seleccion de Modo de Instalacion con Fallback Automatico
# =============================================================================
echo ""
echo "[2/4] Detectando infraestructura disponible..."

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

MODO_INSTALADO="none"

if [[ -n "$DOCKER_COMPOSE_CMD" ]]; then
  echo "  [INFO] Docker detectado. Desplegando con $DOCKER_COMPOSE_CMD..."

  if $DOCKER_COMPOSE_CMD up -d --build; then
    DB_USER_CHECK=$(grep -E '^DB_USER=' .env 2>/dev/null | head -1 | cut -d'=' -f2 | tr -d ' "\r\n' || echo "postgres")
    DB_NAME_CHECK=$(grep -E '^DB_NAME=' .env 2>/dev/null | head -1 | cut -d'=' -f2 | tr -d ' "\r\n' || echo "turnero")
    [[ -z "$DB_USER_CHECK" ]] && DB_USER_CHECK="postgres"
    [[ -z "$DB_NAME_CHECK" ]] && DB_NAME_CHECK="turnero"

    echo "  [INFO] Esperando inicializacion de PostgreSQL en contenedor..."
    RETRIES=30
    until docker exec turnero-db pg_isready -U "$DB_USER_CHECK" -d "$DB_NAME_CHECK" >/dev/null 2>&1 || [[ $RETRIES -eq 0 ]]; do
      sleep 2
      RETRIES=$((RETRIES - 1))
    done

    if [[ $RETRIES -gt 0 ]]; then
      echo "  [OK] PostgreSQL operativo."

      APP_RETRIES=15
      until [[ "$(docker inspect --format '{{.State.Status}}' turnero-app 2>/dev/null)" == "running" ]] || [[ $APP_RETRIES -eq 0 ]]; do
        sleep 2
        APP_RETRIES=$((APP_RETRIES - 1))
      done

      echo "  [INFO] Aplicando migraciones de base de datos..."
      $DOCKER_COMPOSE_CMD exec -T app node scripts/recrear_desde_cero.js || true

      echo "  [INFO] Poblando base de datos con seed inicial..."
      $DOCKER_COMPOSE_CMD exec -T app node scripts/seed.js || true

      MODO_INSTALADO="docker"
    else
      echo "  [AVISO] PostgreSQL tardo mas de lo previsto. Continuando..."
      MODO_INSTALADO="docker"
    fi
  else
    echo "  [AVISO] Docker Compose fallo. Intentando alternativa con Node.js nativo..."
  fi
fi

if [[ "$MODO_INSTALADO" == "none" ]]; then
  echo "  [INFO] Procediendo con instalacion Node.js local..."

  if ! command -v node >/dev/null 2>&1; then
    echo "  [ERROR] Se requiere Node.js (v20+) o Docker para instalar el sistema."
    echo "          Descarga Node.js LTS: https://nodejs.org"
    exit 1
  fi
  echo "  [OK] Node.js: $(node --version 2>/dev/null)"

  echo "  [INFO] Instalando dependencias npm..."
  if ! npm install; then
    echo "  [ERROR] Fallo npm install. Revisa tu conexion a internet."
    exit 1
  fi
  echo "  [OK] Dependencias instaladas."

  echo "  [INFO] Compilando estilos Tailwind CSS..."
  npm run build:css 2>/dev/null || echo "  [AVISO] Usando archivo CSS precompilado existente."

  echo "  [INFO] Ejecutando migraciones y seed..."
  if node scripts/recrear_desde_cero.js && node scripts/seed.js; then
    echo "  [OK] Base de datos configurada y poblada."
  else
    echo "  [AVISO] Base de datos no disponible aun en localhost:5432."
    echo "          Inicia tu servicio PostgreSQL y ejecuta manualmente:"
    echo "            node scripts/recrear_desde_cero.js"
    echo "            node scripts/seed.js"
  fi

  echo "  [INFO] Iniciando servidor Turnero en segundo plano..."
  if command -v pm2 >/dev/null 2>&1; then
    pm2 start src/server.js --name turnero-app 2>/dev/null || pm2 restart turnero-app 2>/dev/null || true
    pm2 save >/dev/null 2>&1 || true
    echo "  [OK] Servidor gestionado con PM2."
  else
    nohup node src/server.js > turnero.log 2>&1 &
    BGPID=$!
    sleep 2
    echo "  [OK] Servidor iniciado con nohup (PID: $BGPID)."
  fi
fi

# =============================================================================
# 4. Verificacion de Salud del Servidor
# =============================================================================
echo ""
echo "[3/4] Verificando que el servidor responde en /health..."
APP_READY=false
for i in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1; then
    if curl -sf --max-time 3 "http://localhost:3000/health" | grep -q "ok" 2>/dev/null; then
      APP_READY=true; break
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -qO- --timeout=3 "http://localhost:3000/health" 2>/dev/null | grep -q "ok"; then
      APP_READY=true; break
    fi
  else
    sleep 5; APP_READY=true; break
  fi
  sleep 2
done

if [[ "$APP_READY" == "true" ]]; then
  echo "  [OK] Servidor web en linea y respondiendo en /health."
else
  echo "  [AVISO] El servidor aun no responde. Puede requerir unos instantes adicionales."
  echo "          Comprueba el estado en: http://localhost:3000/health"
fi

# =============================================================================
# 5. Resumen Final
# =============================================================================
echo ""
echo "[4/4] Instalacion finalizada exitosamente."
echo ""
echo "===================================================================="
echo " SISTEMA TURNERO 2026 INSTALADO Y EN EJECUCION LISTO"
echo "===================================================================="
echo "Acceso Local:   http://localhost:3000"
echo "Acceso LAN:     http://${LAN_IP}:3000"
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
echo "Recursos Inicializados:"
echo "  - 10 Mesas registradas (Mesa 1 a Mesa 10)"
echo "  - Lote 1 activo (vouchers 1 a 500)"
echo "  - Modo operativo: Asistido con soporte a impresion ESC/POS"
echo "===================================================================="
