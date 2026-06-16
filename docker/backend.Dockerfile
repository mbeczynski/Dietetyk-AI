FROM node:20-slim
WORKDIR /app

# Install curl for health check
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci --only=production

COPY backend/ ./

ENV NODE_ENV=production
ENV DATABASE_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
