# ── Stage 1: Build (compile mediasoup C++ worker) ─────────────
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# ── Stage 2: Runtime (no build tools — smaller, faster) ───────
FROM node:22-bookworm-slim

WORKDIR /app

# Only the compiled node_modules — no python3/make/g++
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY public/ ./public/

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "--experimental-sqlite", "--no-warnings", "server/server.js"]
