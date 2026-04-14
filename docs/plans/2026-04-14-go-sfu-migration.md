# Go SFU Migration Plan

## Why Move SFU to Go?

**Current**: Node.js (signaling + chat) + mediasoup (C++ SFU workers)
**Problem**: mediasoup C++ workers are fast but tightly coupled to Node.js. Each worker is a separate process that Node spawns. On a 2-CPU VPS, we get 2 workers max. Scaling means bigger VPS or splitting rooms across servers (complex).

**Go advantage**: goroutines handle thousands of concurrent media streams natively. Pion (Go WebRTC library) is battle-tested, used by LiveKit, Jitsi, and many production SFUs. A single Go process on 2 CPUs can handle what mediasoup needs 2+ workers for, with lower memory overhead.

**Target**: 200+ concurrent SFU rooms (5+ peers each) on same 2-CPU/8GB VPS.

## Architecture: Sidecar Pattern

```
Browser ──WebSocket──→ Node.js (port 3100)
                        │  signaling, chat, rooms, rate limits
                        │
                        │──HTTP/gRPC──→ Go SFU (port 3200)
                        │                 │  media routing only
                        │                 │  WebRTC transports
                        │                 │  producer/consumer mgmt
                        │
Browser ──WebRTC/UDP──→ Go SFU (ports 40000-40200)
```

**Key idea**: Node.js stays as the "brain" (signaling, auth, rooms, chat). Go SFU is the "muscle" (media only). They talk via internal HTTP API on localhost.

## Phase 1: Go SFU Service (Standalone)

### 1.1 Project Structure
```
sfu/
├── cmd/sfu/main.go          # Entry point
├── internal/
│   ├── server/server.go     # HTTP API server
│   ├── room/room.go         # Room → Router mapping
│   ├── peer/peer.go         # Peer transports + tracks
│   └── config/config.go     # Env-based config
├── go.mod
├── go.sum
├── Dockerfile
└── README.md
```

### 1.2 Go SFU HTTP API (consumed by Node.js)

```
POST   /rooms/:code/create          → Create router for room
DELETE /rooms/:code                  → Close router, cleanup
POST   /rooms/:code/peers/:id/join  → Create send+recv transports
DELETE /rooms/:code/peers/:id       → Close peer transports
POST   /rooms/:code/peers/:id/produce   → Start producing media
POST   /rooms/:code/peers/:id/consume   → Start consuming producer
POST   /rooms/:code/peers/:id/resume    → Resume consumer
GET    /health                       → Health check
GET    /metrics                      → Prometheus metrics
```

### 1.3 Dependencies
- `github.com/pion/webrtc/v4` — WebRTC implementation
- `github.com/pion/interceptor` — Media pipeline (NACK, PLI, TWCC)
- Standard library `net/http` — API server (no framework needed)

## Phase 2: Node.js Integration

### 2.1 Replace mediasoup calls in signaling.js

Current flow (mediasoup):
```
client → "create-transport" → Node → mediasoup.createWebRtcTransport()
client → "produce" → Node → transport.produce()
client → "consume" → Node → transport.consume()
```

New flow (Go SFU):
```
client → "create-transport" → Node → HTTP POST go-sfu:3200/rooms/:code/peers/:id/join
client → "produce" → Node → HTTP POST go-sfu:3200/rooms/:code/peers/:id/produce
client → "consume" → Node → HTTP POST go-sfu:3200/rooms/:code/peers/:id/consume
```

### 2.2 What stays in Node.js
- Socket.IO signaling (all events)
- Room creation/joining/leaving logic
- Rate limiting
- Chat persistence (SQLite)
- Mesh mode (< 5 peers) — unchanged, P2P
- SFU upgrade decision (>= 5 peers triggers Go SFU)
- Prometheus metrics aggregation

### 2.3 What moves to Go
- WebRTC transport creation (ICE, DTLS)
- Media track routing (produce/consume)
- Codec negotiation (VP8, VP9, Opus)
- NACK/PLI/TWCC interceptors
- RTP packet forwarding

## Phase 3: Docker Deployment

```yaml
# deploy/docker-compose.yml
services:
  app:
    # Node.js signaling (unchanged)
    container_name: ttf-app
    network_mode: host
    ...

  sfu:
    build:
      context: ..
      dockerfile: sfu/Dockerfile
    container_name: ttf-sfu
    network_mode: host
    environment:
      - PORT=3200
      - ANNOUNCED_IP=${ANNOUNCED_IP}
      - RTC_MIN_PORT=40000
      - RTC_MAX_PORT=40200
```

## Phase 4: Client Changes

**Minimal** — the client Socket.IO events stay the same. Node.js translates between Socket.IO events and Go SFU HTTP API. The client never talks to Go directly except for WebRTC media (UDP).

The only client change: WebRTC transport parameters come from Go instead of mediasoup. The parameter format is slightly different (Pion vs mediasoup) but we normalize in Node.js.

## Migration Strategy

1. **Build Go SFU** with the HTTP API (Phase 1)
2. **Add feature flag** `SFU_BACKEND=go|mediasoup` (default: mediasoup)
3. **Wire Node.js** to call Go SFU when flag is `go` (Phase 2)
4. **Test with real users** — both backends side by side
5. **Remove mediasoup** once Go SFU is stable (Phase 3)
6. **Remove mediasoup from package.json** — no more C++ build step, Dockerfile gets much simpler

## Timeline Estimate

| Phase | Work | Complexity |
|-------|------|-----------|
| Phase 1: Go SFU service | Core media routing | High |
| Phase 2: Node.js integration | HTTP bridge | Medium |
| Phase 3: Docker deployment | Compose + CI | Low |
| Phase 4: Client tweaks | Parameter mapping | Low |
| Phase 5: Remove mediasoup | Cleanup | Low |

## Risks

- **Pion vs mediasoup feature parity**: mediasoup has simulcast, bandwidth estimation, FEC built-in. Pion has them via interceptors but requires manual wiring.
- **Audio/video sync**: Need careful RTP timestamp handling.
- **Testing**: WebRTC testing is hard to automate. Manual testing with real devices needed.

## Decision

Build Phase 1 first as a standalone Go service. Test it independently. Then integrate. This way we can always fall back to mediasoup if something goes wrong.
