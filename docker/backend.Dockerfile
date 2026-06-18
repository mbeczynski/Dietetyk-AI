FROM node:20-slim
WORKDIR /app

# Install curl for health check
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci --only=production

COPY backend/ ./

# Uruchamiamy proces Node jako nieprivilegiowanego użytkownika "node" (wbudowany
# w obraz bazowy node:*, uid/gid 1000), a nie jako root. Ogranicza to skutki
# ewentualnej podatności w zależnościach npm - proces wewnątrz kontenera nie ma
# uprawnień roota nawet jeśli ktoś uzyska RCE.
# WAŻNE: katalog ./data montowany z hosta (wolumen /app/data) musi być na
# serwerze czytelny/zapisywalny dla uid 1000 (np. `chown -R 1000:1000 ./data`),
# inaczej backend nie będzie mógł zapisać do bazy SQLite po tej zmianie.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV DATABASE_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

# Docker (i docker-compose) sprawdza co 30s, czy backend faktycznie odpowiada
# i ma dostęp do bazy danych (GET /api/healthz - patrz backend/routes/healthcheck.js).
# Kontener oznaczony jako "unhealthy" po 3 nieudanych próbach pod rząd.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/healthz || exit 1

CMD ["node", "server.js"]
