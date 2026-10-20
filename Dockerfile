# =============================================================================
# Turnero de Matrículas 2026 — Dockerfile (multi-stage)
#
# Stages:
#   deps        → instala dependencias (base compartida)
#   development → agrega devDependencies + nodemon (hot-reload)
#   production  → imagen mínima solo con dependencias de producción
# =============================================================================

# ── Base: dependencias de producción ─────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Herramientas necesarias para compilar módulos nativos (bcrypt) en Alpine
RUN apk add --no-cache python3 make g++

# Copiar manifiestos primero para aprovechar caché de Docker
COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

# ── Stage: Desarrollo (con hot-reload) ───────────────────────────────────────
FROM node:20-alpine AS development

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force

# Copiar código fuente
COPY . .

EXPOSE 3000

# nodemon para hot-reload en desarrollo
CMD ["npx", "nodemon", "--watch", "src", "src/server.js"]

# ── Stage: Producción ─────────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Crear usuario no-root para seguridad
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 fastify

WORKDIR /app

# Copiar código fuente primero y luego las dependencias de producción limpias
COPY --chown=fastify:nodejs . .
COPY --from=deps --chown=fastify:nodejs /app/node_modules ./node_modules
# Asegurar que la carpeta de subidas exista con permisos para fastify
RUN mkdir -p /app/src/public/assets/uploads && chown -R fastify:nodejs /app/src/public/assets/uploads

USER fastify

EXPOSE 3000

# Señales de Docker manejadas por Node.js directamente
CMD ["node", "src/server.js"]
