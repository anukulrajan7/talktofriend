# ── Stage 1: Build Go binary ──────────────────────────────────
FROM golang:1.22-bookworm AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /sfu ./cmd/sfu

# ── Stage 2: Minimal runtime ─────────────────────────────────
FROM debian:bookworm-slim

COPY --from=builder /sfu /usr/local/bin/sfu

ENV PORT=3200

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["sfu"]
