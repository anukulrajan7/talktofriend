# TalkToFriend

> Zero-BS video calls. No sign-up, no tracking. Self-hostable.

Video calls for up to 20 people — P2P for small groups, SFU for larger ones. No accounts, no Big Tech, no nonsense. Deploy it yourself in minutes.

## Features

- Up to 20 people per room
- P2P mesh for small calls (2-4), SFU for larger (5-20)
- Dual SFU backends: **mediasoup** (default) or **Go/Pion** (`SFU_BACKEND=go`)
- Auto-switch between mesh and SFU as people join/leave
- 1080p video (HD fallback) with adaptive bitrate caps (2.5 Mbps video, 64 kbps audio)
- ICE restart on connection failure + TURN relay support
- Screen share with PiP self-preview
- In-call chat (persisted per room, auto-cleaned)
- Reactions + confetti
- Keyboard shortcuts: M (mute), V (camera), S (screen share)
- Room codes like `happy-tiger-42` — no login needed
- Prometheus metrics + Grafana dashboard
- Docker deploy with Traefik HTTPS
- Load tested: 1500 concurrent connections, 500 rooms, zero errors

## Quick Start (local dev)

Requires Node.js 22+.

```bash
git clone https://github.com/anukulrajan7/talktofriend.git
cd talktofriend/server
npm install
npm run dev
```

Open http://localhost:3000. Create a room, then open a second tab or device and join with the room code.

## Self-Host with Docker

```bash
# 1. Clone and configure
git clone https://github.com/anukulrajan7/talktofriend.git
cd talktofriend
cp .env.example .env
# Edit .env: set DOMAIN and ANNOUNCED_IP

# 2. Deploy (one command)
bash deploy/deploy.sh
```

That script pulls images, runs docker-compose, and sets up Traefik with automatic HTTPS. Your instance will be live at the domain you set.

Manual alternative:

```bash
docker-compose up -d
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DOMAIN` | — | Your domain for Caddy HTTPS (e.g. `talk.example.com`) |
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `production` | `development` or `production` |
| `ANNOUNCED_IP` | — | Your server's public IP (required for mediasoup) |
| `MS_WORKERS` | `4` | mediasoup worker count — match your CPU cores |
| `RTC_MIN_PORT` | `40000` | UDP port range start for media (open in firewall) |
| `RTC_MAX_PORT` | `49999` | UDP port range end for media (open in firewall) |
| `MAX_PEOPLE_PER_ROOM` | `20` | Hard cap per room |
| `MAX_TOTAL_ROOMS` | `500` | Server-wide room limit |
| `MAX_TOTAL_SOCKETS` | `2000` | Max concurrent connections |
| `SFU_BACKEND` | `mediasoup` | SFU backend: `mediasoup` (default) or `go` (Pion) |
| `GO_SFU_URL` | `http://127.0.0.1:3200` | Go SFU service URL (when `SFU_BACKEND=go`) |
| `TURN_SECRET` | — | HMAC secret for TURN credential generation |
| `TURN_SERVER` | — | TURN server URL (e.g. `turn:your-server:3478`) |
| `GRAFANA_PASSWORD` | `changeme` | Grafana admin password — change this |
| `TELEGRAM_BOT_TOKEN` | — | Optional: alert bot token |
| `TELEGRAM_CHAT_ID` | — | Optional: Telegram chat for alerts |

## Monitoring & Admin

- Live stats: `/api/stats` (JSON)
- Prometheus metrics: `/metrics`
- Health check: `/healthz`
- Admin dashboard: `/admin.html` (no auth, self-host only)

### Stack
- **Prometheus** on `:9090` — metrics collection
- **Grafana** on `:3001` — dashboards + alerts
- **Uptime-Kuma** on `:3002` — external monitoring
- **Telegram** — alert notifications (configure in `.env`)

See `docs/monitoring-setup.md` for full guide and `docs/deploy-runbook.md` for deployment.

## Tech Stack

- Node.js + Express — HTTP server + signaling
- Socket.IO — real-time signaling and chat
- mediasoup — WebRTC SFU for larger calls (default)
- Go + Pion — optional lightweight SFU backend
- coturn — TURN relay server for NAT traversal
- SQLite — chat persistence
- Tailwind CSS + Alpine.js — frontend
- Traefik — reverse proxy with automatic HTTPS
- Prometheus + Grafana — metrics and dashboards

## Architecture

```
2-4 peers: Browser ←→ Browser (P2P mesh, direct WebRTC)
5-20 peers: Browser → SFU → Browser (server-mediated, one upload per peer)
```

Calls with 2-4 people run as a P2P mesh — browsers connect directly, no media touches the server. At 5+ people the server switches to an SFU (mediasoup or Go/Pion), where each client sends one stream up and the server fans it out. The switch happens automatically as people join or leave.

The Node.js server handles signaling (room join/leave, SDP/ICE relay) and chat. TURN credentials are generated server-side with HMAC signing for secure NAT traversal. Video is capped at 1080p/2.5 Mbps with automatic fallback to lower resolutions.

## License

MIT
