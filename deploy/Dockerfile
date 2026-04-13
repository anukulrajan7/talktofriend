FROM node:22-bookworm-slim

# mediasoup native dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Copy app code
COPY server/ ./server/
COPY public/ ./public/

# Data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3000
# mediasoup RTC ports
EXPOSE 40000-49999/udp
EXPOSE 40000-49999/tcp

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "--experimental-sqlite", "--no-warnings", "server/server.js"]
