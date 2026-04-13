# Changelog

All notable changes to TalkToFriend will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-14

### Initial release

**Core**
- WebRTC mesh mode for 2-4 person calls (zero server media cost)
- mediasoup SFU for 5-20 person calls
- Automatic mesh to SFU upgrade when room hits 5 peers
- Room codes like `happy-tiger-42` (memorable, shareable)
- Screen share with picture-in-picture self-preview
- In-call text chat with SQLite history (24h auto-cleanup)
- Emoji reactions with canvas-confetti
- Keyboard shortcuts (M/V/S for mute/video/screen)
- Active speaker detection with pulse ring
- Sound effects on join, leave, chat, reaction, mute
- Connection quality labels ("vibes", "mid", "ouch", "solid")
- Graceful reconnect with auto rejoin
- PWA support (installable, offline landing)

**Security**
- Rate limiting (per-IP, per-socket, per-room)
- CORS with strict origin matching
- CSP headers on all pages
- Input validation on all SFU operations
- XSS-safe chat rendering (DOM APIs, no innerHTML)
- DataChannel emoji allowlist
- SQLite WAL mode with prepared statements

**Infrastructure**
- Docker + docker-compose stack (app + Caddy + Prometheus + Grafana + Uptime-Kuma)
- Caddy HTTPS with auto Let's Encrypt
- GitHub Actions CI/CD (test + SSH deploy to VPS)
- Prometheus metrics at `/metrics`
- Grafana dashboard (14 panels)
- Grafana alerting (5 rules) with Telegram notifications
- Admin dashboard at `/admin.html`
- Health check at `/healthz`
- Structured logging via pino

**Docs**
- README.md with quick start
- TERMS.md, PRIVACY.md
- docs/how-webrtc-works.md
- docs/monitoring-setup.md
- docs/deploy-runbook.md
