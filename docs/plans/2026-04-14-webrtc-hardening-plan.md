# WebRTC Hardening & Quality Plan

## Phase 1: Deploy + Backend Tests (NOW)
**Goal**: Ship the 7 bug fixes and prove the backend works

### 1a. Backend Test Suite
- Signaling flow: create → join → peer-joined → offer relay → answer relay → ICE relay
- 3-peer mesh: verify all 3 pairs get peer-joined + offer/answer
- SFU upgrade: 5 peers trigger upgrade-to-sfu event
- SFU endpoints: get-rtp-capabilities, get-producers, create-transport
- Rate limiting: verify per-IP limits block excess connections
- Room lifecycle: create → fill → leave → cleanup → delete empty
- Edge: double join (same socket), join non-existent room, join full room
- Edge: disconnect mid-call (cleanup fires, peers notified)
- Edge: reconnect (re-join works, peers re-appear)

### 1b. Deploy
- Commit all changes
- Push to remote
- SSH to VPS: pull + restart Docker containers

---

## Phase 2: 3+ Peer Mesh Stability (Critical)
**Goal**: 3-4 person calls work reliably with no missing streams

### Problems to fix
1. **Late offer delivery**: When peer 3 joins, peers 1+2 both send offers. Peer 3 must handle 2 concurrent offers without collision
2. **Video flickering on new peer join**: onRemoteStream fires twice per peer (audio + video track). Second call resets srcObject unnecessarily
3. **Grid layout jump**: Adding a tile mid-call causes layout reflow. Needs smooth transition

### Fixes
- mesh.js: Skip srcObject reset if already set to same stream
- mesh.js: Add connection state logging per-peer for debugging
- app-room.js: Add CSS transition for grid changes (opacity fade)
- Add 3-peer and 4-peer Playwright tests

---

## Phase 3: Video Quality (High Priority)
**Goal**: Crisp 1080p video, graceful degradation on slow networks

### Problems
1. **Not reaching 1080p**: Camera may default to 720p despite constraints
2. **Bitrate too low**: 2.5 Mbps is minimum for 1080p, needs 4-5 Mbps
3. **No adaptive quality**: No bandwidth detection or quality reduction
4. **No quality indicator**: User can't tell if they're getting HD

### Fixes
- media.js: Log actual video resolution after getUserMedia
- mesh.js: Raise video bitrate to 4 Mbps, add `degradationPreference: "maintain-resolution"`
- mesh.js: Add bandwidth stats polling via `pc.getStats()` to detect low bandwidth
- app-room.js: Show quality badge (HD/SD) on each tile based on actual resolution
- app-room.js: When bandwidth drops below 500kbps, show "poor connection" indicator
- app-room.js: Suggest disabling video when bandwidth critically low (< 200kbps)
- Future: Add simulcast for SFU mode (send multiple quality layers)

---

## Phase 4: Flickering & Stream Stability
**Goal**: Zero visual glitches during calls

### Root causes of flickering
1. `ontrack` fires 2x (audio + video) → `_addRemoteTile` called twice → srcObject reset
2. ICE restart causes brief disconnect → tile might flash
3. Track replacement during screen share → video element briefly black

### Fixes
- mesh.js ontrack: Only call onRemoteStream if stream/track actually changed
- app-room.js _addRemoteTile: Check if srcObject is already the same stream before setting
- CSS: Add `background: #12121a` on video element to prevent white flash
- Screen share: Use `replaceTrack` instead of removing/adding (already doing this)
- ICE restart: Keep existing tile during reconnection, don't remove/re-add

---

## Phase 5: 20-User SFU Mode
**Goal**: Full room (20 peers) works with mediasoup SFU

### Current issues
1. get-rtp-capabilities was broken (fixed — wrong callback arity)
2. New peers couldn't see existing producers (fixed — get-producers endpoint)
3. Race during mesh→SFU upgrade (fixed — consumeExisting fallback)
4. No simulcast (all peers get full quality regardless of screen size)
5. No dominant speaker detection for SFU

### Remaining work
- Test with 5-10 real browser peers (Playwright multi-context)
- Add simulcast producing (3 quality layers: high/medium/low)
- Server-side bandwidth estimation per consumer
- Selective forwarding: pause consumers for off-screen peers
- Dominant speaker: highlight active speaker tile
- Transport stats: monitor jitter/packet loss per peer

---

## Phase 6: UI Improvements
**Goal**: Premium feel, smooth interactions

### Planned improvements
1. **Connection quality indicator**: Green/yellow/red dot per peer tile
2. **Speaking indicator**: Already exists (purple glow), verify it works
3. **Peer name on hover**: Show full name on tile hover
4. **Tile layout transitions**: Smooth CSS grid transitions when peers join/leave
5. **Network toast**: "Connection unstable" warning when quality drops
6. **Settings panel**: Device selection (camera/mic dropdown), quality preset
7. **Noise gate**: Visual mic activity indicator even when muted
8. **Mobile**: Swipe gestures for chat, pinch-to-zoom on tiles
9. **Dark/light theme**: Currently dark-only

### Stretch goals
- Virtual backgrounds (Canvas + ML model — heavy, consider WebGL)
- Background blur (same tech, lighter version)
- Gallery vs Speaker view toggle
- Recording (MediaRecorder API, client-side)
- Raise hand gesture

---

## Phase 7: Scheduled SFU Monitoring
**Goal**: Know when things break before users tell us

### Health check script
- Runs every 5 minutes via cron
- Connects to server, creates room, joins, verifies signaling works
- Checks /api/stats for anomalies (high error count, many rooms, few peers)
- Checks mediasoup workers are alive
- Alerts via Telegram if anything fails

### Metrics to watch
- Rooms active vs destroyed ratio
- Average peers per room
- Signaling latency (offer relay time)
- Error rate
- Memory/CPU usage trend

---

## Edge Cases Checklist

| Scenario | Current Status | Fix |
|---|---|---|
| 2-peer mesh | FIXED (double-connect guard) | Deployed |
| 3-peer mesh | Needs testing | Phase 2 |
| 4-peer mesh (max before SFU) | Needs testing | Phase 2 |
| 5th peer triggers SFU upgrade | Partially fixed | Phase 5 |
| Peer leaves mid-call | Works (cleanup + peer-left) | Verified |
| Host leaves | Room continues | Verified |
| Network switch (WiFi→cell) | ICE restart added | Needs testing |
| Tab backgrounded | Socket.IO heartbeat keeps alive | Needs testing |
| Camera permission revoked | Track ends, need graceful handling | Phase 4 |
| Room at 20 peers | SFU mode, untested at scale | Phase 5 |
| Late joiner to SFU | FIXED (get-producers) | Deployed |
| Bandwidth drop | No handling | Phase 3 |
| Audio-only mode | Works (cam toggle) | Verified |
| Screen share | Works (replaceTrack) | Verified |
| Server restart | Rooms lost, reconnect works | Phase 2 |
| Duplicate tab | "Already in room" guard | Works |

---

## Execution Order

```
NOW     → Phase 1 (deploy + backend tests)
TODAY   → Phase 2 (3-peer fix + flickering)
TODAY   → Phase 3 (video quality)
NEXT    → Phase 4 (stream stability)
NEXT    → Phase 5 (20-user SFU)
LATER   → Phase 6 (UI improvements)
LATER   → Phase 7 (monitoring)
```
