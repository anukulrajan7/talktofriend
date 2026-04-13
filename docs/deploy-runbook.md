# Deploy Runbook

Step-by-step guide for deploying TalkToFriend on a VPS.

## Prerequisites

- VPS with at least 4 GB RAM and 2 CPU cores (DigitalOcean, Hetzner, Hostinger, etc.)
- Ubuntu 22.04+ or Debian 12+
- Docker and Docker Compose installed
- A domain name with an A record pointing to your VPS public IP
- Ports open in your firewall: 80, 443, and UDP/TCP 40000–49999

Install Docker if needed:

```bash
curl -fsSL https://get.docker.com | sh
```

## First Deploy

```bash
# SSH into your VPS
ssh user@your-vps-ip

# Clone the repo
git clone https://github.com/anukulrajan7/talktofriend.git /opt/talktofriend
cd /opt/talktofriend

# Copy and edit environment config
cp .env.example .env
nano .env
```

Required `.env` values to set:

```
DOMAIN=talk.example.com          # your domain
ANNOUNCED_IP=1.2.3.4             # your VPS public IP
GRAFANA_PASSWORD=a-strong-password
```

Optional but recommended:

```
MS_WORKERS=2                     # match your CPU core count
TELEGRAM_BOT_TOKEN=...           # for alert notifications
TELEGRAM_CHAT_ID=...
```

```bash
# Run the deploy script
cd deploy
chmod +x deploy.sh
./deploy.sh
```

The script builds images, starts all services via docker-compose, and configures Caddy for automatic HTTPS. Wait about 60 seconds for everything to come up.

Verify it's working:

```bash
curl https://talk.example.com/healthz
# Expected: {"ok":true}
```

## Port Configuration

Open these ports on your VPS firewall (ufw example):

```bash
ufw allow 80/tcp      # HTTP (Let's Encrypt challenge)
ufw allow 443/tcp     # HTTPS
ufw allow 40000:49999/udp  # WebRTC media (mediasoup)
ufw allow 40000:49999/tcp  # WebRTC fallback
ufw enable
```

If using a cloud provider (DigitalOcean, AWS, etc.), also open these ranges in the provider's firewall/security group.

The UDP range is required for WebRTC media to flow. Calls will fail or fall back to relay without it.

## Updates

```bash
cd /opt/talktofriend
git pull

cd deploy
docker-compose build
docker-compose up -d
```

Docker Compose will restart only the containers whose images changed. Existing rooms will be dropped (signaling is stateless except for active sessions).

If you use GitHub Actions for CI/CD, see `.github/workflows/` for the auto-deploy workflow. It SSHs into the VPS and runs the same commands.

## Monitoring Access

Grafana, Prometheus, and Uptime-Kuma bind to localhost only. Use SSH tunnels to access them:

```bash
# Grafana
ssh -L 3001:localhost:3001 user@your-vps-ip
# Open http://localhost:3001

# Prometheus
ssh -L 9090:localhost:9090 user@your-vps-ip
# Open http://localhost:9090

# All at once
ssh -L 3001:localhost:3001 -L 9090:localhost:9090 -L 3002:localhost:3002 user@your-vps-ip
```

The admin dashboard is available at `https://yourdomain.com/admin.html` without a tunnel (it's served by the app itself).

## Backup

Three things to back up:

**SQLite database** — chat history and room metadata:
```bash
cp /opt/talktofriend/data/talktofriend.db ~/backup-$(date +%Y%m%d).db
```

**`.env` file** — all configuration:
```bash
cp /opt/talktofriend/.env ~/env-backup
```

**Grafana volume** — alert rules and custom dashboards:
```bash
docker run --rm -v talktofriend_grafana_data:/data -v ~/:/backup \
  alpine tar czf /backup/grafana-$(date +%Y%m%d).tar.gz /data
```

For automated backups, add a cron job:
```bash
crontab -e
# Add:
0 3 * * * cp /opt/talktofriend/data/talktofriend.db /opt/backups/db-$(date +\%Y\%m\%d).db
```

## Troubleshooting

**Calls connect but no audio/video**
- UDP ports 40000–49999 are probably blocked. Check your firewall.
- Verify `ANNOUNCED_IP` in `.env` matches your actual public IP.
- Restart the app after changing `ANNOUNCED_IP`: `docker-compose restart app`.

**HTTPS not working / Caddy errors**
- DNS must propagate before Caddy can get a certificate. Wait a few minutes after pointing the A record.
- Check Caddy logs: `docker-compose logs caddy`.
- Ensure port 80 is open (needed for ACME HTTP challenge).

**"Server at capacity" errors**
- Increase `MAX_TOTAL_ROOMS` or `MAX_TOTAL_SOCKETS` in `.env`, then restart.
- Consider upgrading your VPS if CPU/memory is the bottleneck.

**App container keeps restarting**
- Check logs: `docker-compose logs app`.
- Common cause: `ANNOUNCED_IP` not set, or mediasoup can't bind to the port range.

**mediasoup workers not starting**
- Reduce `MS_WORKERS` to 1 and retry. Some VPS providers restrict certain system calls.
- Check `docker-compose logs app` for "mediasoup worker died" messages.

**Checking service status**
```bash
cd /opt/talktofriend/deploy
docker-compose ps           # see all container states
docker-compose logs app     # app logs
docker-compose logs caddy   # reverse proxy logs
```
