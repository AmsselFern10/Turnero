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

# Copiar manifiestos primero para aprovechar caché de Docker
COPY package.json package-lock.json* ./

RUN npm ci --only=production && npm cache clean --force

# ── Stage: Desarrollo (con hot-reload) ───────────────────────────────────────
FROM node:20-alpine AS development

WORKDIR /app

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

# Copiar solo dependencias de producción desde 'deps'
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=fastify:nodejs . .

USER fastify

EXPOSE 3000

# Señales de Docker manejadas por Node.js directamente
CMD ["node", "src/server.js"]
