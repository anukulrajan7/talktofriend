# Monitoring Setup

TalkToFriend ships with a full monitoring stack: Prometheus for metrics collection, Grafana for dashboards and alerts, and Uptime-Kuma for external uptime checks.

## Default URLs

| Service | URL | Notes |
|---|---|---|
| Grafana | http://localhost:3001 | Dashboards + alert rules |
| Prometheus | http://localhost:9090 | Raw metrics, query explorer |
| Uptime-Kuma | http://localhost:3002 | External uptime monitoring |
| Admin dashboard | /admin.html | Live stats, no auth |
| Prometheus metrics | /metrics | Raw text format |
| Health check | /healthz | Returns `{"ok":true}` |
| Stats JSON | /api/stats | Full JSON snapshot |

## Accessing Grafana from a VPS

Grafana binds to localhost only. To access it from your laptop:

```bash
ssh -L 3001:localhost:3001 user@your-vps-ip
```

Then open http://localhost:3001 in your browser. The tunnel forwards port 3001 through SSH. Same pattern works for Prometheus (9090) and Uptime-Kuma (3002).

You can also open all three at once:

```bash
ssh -L 3001:localhost:3001 -L 9090:localhost:9090 -L 3002:localhost:3002 user@your-vps-ip
```

## Grafana Dashboard

The pre-built dashboard is at `deploy/grafana/dashboard.json`. It is auto-provisioned on first start — no import needed.

Panels include:
- Active rooms, peers, WebSocket connections (gauges)
- Uptime
- Room create/destroy rate over time
- Chat message rate
- Signaling traffic (offers, answers, ICE)
- Rate limit hits and errors
- SFU workers and routers count
- Peer join/leave rate

Default login: `admin` / the value of `GRAFANA_PASSWORD` in your `.env` (default: `changeme` — change it).

## Setting Up Telegram Alerts

1. Open Telegram and message `@BotFather`. Send `/newbot` and follow the prompts. Copy the bot token it gives you.

2. Start a chat with your bot (send it any message). Then message `@userinfobot` to get your personal chat ID.

3. Add to your `.env`:

```
TELEGRAM_BOT_TOKEN=123456:ABC-your-token-here
TELEGRAM_CHAT_ID=987654321
```

4. Restart the stack:

```bash
cd deploy && docker-compose restart
```

5. In Grafana (http://localhost:3001), go to Alerting → Contact points → New contact point. Choose Telegram, paste your bot token and chat ID. Test it to confirm delivery.

Alert rules are managed inside Grafana. Common rules to add:
- `ttf_rooms_active > 400` — approaching room limit
- `rate(ttf_errors_total[5m]) > 0.1` — error spike
- `rate(ttf_rateLimitHits_total[5m]) > 1` — rate limit abuse

## Reading Metrics Directly

The `/metrics` endpoint returns Prometheus-format text:

```bash
curl http://localhost:3000/metrics
```

Key metrics:
- `ttf_rooms_active` — current room count
- `ttf_peers_in_rooms` — current peer count
- `ttf_sockets_active` — WebSocket connections
- `ttf_uptime_seconds` — process uptime
- `ttf_roomsCreated_total`, `ttf_peersJoined_total` — counters
- `ttf_rateLimitHits_total`, `ttf_errors_total` — error counters

## Health Check

```bash
curl https://yourdomain.com/healthz
# {"ok":true}
```

Non-200 response or no response = server is down.

## Stats JSON

```bash
curl http://localhost:3000/api/stats | jq .
```

Returns current gauges, all-time totals, configured limits, DB stats, and SFU worker/router info.

## Troubleshooting

**Grafana shows "No data"**
- Prometheus must be scraping successfully. Check http://localhost:9090/targets — the `talktofriend` target should be UP.
- If Prometheus can't reach the app, check that the app is running: `docker-compose ps`.

**Prometheus target is down**
- The app exposes metrics at `http://app:3000/metrics` inside Docker. Check `deploy/prometheus.yml` for the scrape config.
- Restart: `docker-compose restart prometheus`.

**Telegram alerts not arriving**
- Test the bot token: `curl https://api.telegram.org/bot<TOKEN>/getMe`
- Confirm the chat ID is correct (must be a number, not a username).
- Make sure you've sent the bot at least one message first.

**Admin dashboard shows "error"**
- The `/api/stats` endpoint failed. Check server logs: `docker-compose logs app`.
- CORS is not an issue since admin.html is served from the same origin.

**Uptime-Kuma showing downtime**
- Configure a monitor pointing to `https://yourdomain.com/healthz`.
- Check the Caddy/reverse proxy logs if HTTPS isn't terminating correctly.
