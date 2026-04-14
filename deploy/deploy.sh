#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$DEPLOY_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${CYAN}[info]${NC}  $*"; }
success() { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
error()   { echo -e "${RED}[error]${NC} $*" >&2; }

echo ""
echo -e "${CYAN}TalkToFriend — Deployment Script${NC}"
echo "================================="
echo ""

# ---------- Preflight checks ----------

if ! command -v docker &>/dev/null; then
  error "Docker is not installed. Install it from https://docs.docker.com/get-docker/"
  exit 1
fi
success "Docker found: $(docker --version)"

if ! docker compose version &>/dev/null; then
  error "docker compose (v2) is not available. Update Docker Desktop or install the plugin."
  exit 1
fi
success "Docker Compose found: $(docker compose version)"

# ---------- .env setup ----------

ENV_FILE="$PROJECT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  info "No .env found — copying from .env.example"
  cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
  warn ".env created. You should review it before going to production."
fi

# Source current .env so we can check values
set -o allexport
# shellcheck disable=SC1090
source "$ENV_FILE"
set +o allexport

# Prompt for DOMAIN if not set or still placeholder
if [ -z "${DOMAIN:-}" ] || [ "$DOMAIN" = "talk.example.com" ]; then
  echo ""
  read -rp "Enter your domain name (e.g. talktofriend.online) or press Enter for localhost: " DOMAIN_INPUT
  DOMAIN_INPUT="${DOMAIN_INPUT:-localhost}"
  if grep -q "^DOMAIN=" "$ENV_FILE"; then
    sed -i.bak "s|^DOMAIN=.*|DOMAIN=${DOMAIN_INPUT}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    echo "DOMAIN=${DOMAIN_INPUT}" >> "$ENV_FILE"
  fi
  DOMAIN="$DOMAIN_INPUT"
  success "Domain set to: $DOMAIN"
fi

# Prompt for GRAFANA_PASSWORD if still default
if [ -z "${GRAFANA_PASSWORD:-}" ] || [ "$GRAFANA_PASSWORD" = "changeme" ]; then
  echo ""
  warn "Grafana password is not set (using default 'changeme' is insecure)."
  read -rp "Enter Grafana admin password (or press Enter to keep 'changeme'): " GF_PASS_INPUT
  if [ -n "$GF_PASS_INPUT" ]; then
    if grep -q "^GRAFANA_PASSWORD=" "$ENV_FILE"; then
      sed -i.bak "s|^GRAFANA_PASSWORD=.*|GRAFANA_PASSWORD=${GF_PASS_INPUT}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
      echo "GRAFANA_PASSWORD=${GF_PASS_INPUT}" >> "$ENV_FILE"
    fi
    success "Grafana password updated."
  else
    warn "Keeping default password. Change it before exposing Grafana publicly."
  fi
fi

# Warn if ANNOUNCED_IP is empty
if [ -z "${ANNOUNCED_IP:-}" ] || [ "${ANNOUNCED_IP:-}" = " " ]; then
  warn "ANNOUNCED_IP is not set in .env — mediasoup WebRTC relay will NOT work."
  warn "Set it to your server's public IP address."
fi

# ---------- Build & start core app ----------

echo ""
info "Building app Docker image..."
cd "$DEPLOY_DIR"
docker compose -f docker-compose.yml build

echo ""
info "Starting app + Caddy..."
docker compose -f docker-compose.yml up -d

echo ""
info "Waiting for app to become healthy..."
ATTEMPTS=0
MAX_ATTEMPTS=20
until curl -sf http://localhost:3000/healthz &>/dev/null; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then
    warn "App health check timed out. Check logs: docker compose -f docker-compose.yml logs app"
    break
  fi
  sleep 3
done

if [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; then
  success "App is healthy."
fi

# ---------- Start monitoring stack (separate) ----------

echo ""
info "Starting monitoring stack (Prometheus + Grafana + Uptime Kuma)..."
docker compose -f docker-compose.monitoring.yml up -d
success "Monitoring stack started."

# ---------- Status ----------

echo ""
echo -e "${GREEN}=============================="
echo -e "  Deployment complete!"
echo -e "==============================${NC}"
echo ""

if [ "$DOMAIN" = "localhost" ]; then
  echo "  App:          http://localhost:3000"
  echo "  Metrics:      http://localhost:3000/metrics"
else
  echo "  App:          https://${DOMAIN}"
  echo "  Metrics:      https://${DOMAIN}/metrics"
  echo "  Grafana:      https://grafana.${DOMAIN}"
fi

echo ""
echo "  Prometheus:   http://localhost:9090  (localhost only)"
echo "  Grafana:      http://localhost:3001  (localhost only)"
echo "  Uptime Kuma:  http://localhost:3002  (localhost only)"
echo ""
echo "  App logs:         docker compose -f docker-compose.yml logs -f"
echo "  Monitoring logs:  docker compose -f docker-compose.monitoring.yml logs -f"
echo "  Stop app:         docker compose -f docker-compose.yml down"
echo "  Stop monitoring:  docker compose -f docker-compose.monitoring.yml down"
echo ""
