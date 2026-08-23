# Multi-stage Containerfile for Railway / Podman / Docker

# Stage 1: Build Web Dashboard
FROM node:22-alpine AS web-builder
WORKDIR /app/backend/web
COPY backend/web/package*.json ./
RUN npm install
COPY backend/web/ ./
RUN npm run build

# Stage 2: Build Backend Server
FROM node:22-alpine AS server-builder
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build:server

# Stage 3: Production Runtime
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

# Install production dependencies only
COPY backend/package*.json ./
RUN npm install --omit=dev

# Copy compiled backend and web assets
COPY --from=server-builder /app/backend/dist ./dist
COPY --from=web-builder /app/backend/web/dist ./web/dist

EXPOSE 4000

CMD ["node", "dist/server.js"]
