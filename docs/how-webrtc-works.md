# How WebRTC Works (by reading this codebase)

> If you've never touched WebRTC before, this page is a tour of the codebase with the why behind every line.

## The Three Things a WebRTC App Has To Do

1. **Signal:** two peers find each other and swap metadata
2. **Negotiate:** agree on codecs, crypto keys, who sends what
3. **Connect:** punch through NATs and send encrypted media

Our code maps cleanly to these:

- **Signal** → `server/server.js` + `public/js/signaling.js`
- **Negotiate** → `public/js/webrtc.js` (SDP offer/answer)
- **Connect** → Pion/browser handles this given STUN config in `webrtc.js`

## 1. The Signaling Server

Open `server/server.js`. The whole thing is ~100 lines.

Key idea: the server is a **relay for text messages**. It doesn't know what media is. It just passes SDP blobs and ICE candidates between two connected sockets.

```js
socket.on("offer", ({ sdp }) => {
  if (!joinedRoom) return;
  socket.to(joinedRoom).emit("offer", { sdp });
});
```

That's it. Server receives an offer, forwards it to everyone else in the room (which is exactly one other peer). Same for `answer` and `ice-candidate`.

**Why WebSocket / Socket.IO?** You need bidirectional real-time messaging. HTTP polling would add latency. WebSocket is the right tool. Socket.IO adds auto-reconnect and room abstraction on top.

## 2. The SDP Dance

Open `public/js/webrtc.js`. Look at `_createOffer()`:

```js
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
this.signaling.sendOffer(offer);
```

Three calls. What do they do?

### `pc.createOffer()`
Asks the browser: "I want to start a call. Generate an offer that describes my capabilities — what codecs I support, whether I'm sending audio + video, my DTLS fingerprint."

Returns an SDP string like:
```
v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111 103 104
a=rtpmap:111 opus/48000/2
a=fingerprint:sha-256 ...
m=video 9 UDP/TLS/RTP/SAVPF 96 97 98
a=rtpmap:96 VP8/90000
```

### `pc.setLocalDescription(offer)`
Tells the browser: "Commit to this offer locally. Start generating ICE candidates based on it."

### Send it to the other peer
Via signaling. The other peer will call `setRemoteDescription(offer)`, then `createAnswer()`, sending their answer back.

## 3. ICE Candidates

This is the trickiest part. Uncomment the console.log in `webrtc.js` and see them in real time:

```js
this.pc.onicecandidate = (event) => {
  if (event.candidate) {
    console.log("local ICE:", event.candidate);
    this.signaling.sendIceCandidate(event.candidate);
  }
};
```

A candidate looks like:
```
candidate:1234 1 udp 2122260223 192.168.1.10 54321 typ host
```

- `typ host` — a local network IP (works if both peers on same LAN)
- `typ srflx` — server-reflexive (public IP discovered via STUN)
- `typ relay` — via a TURN server (not configured in v1)

Both peers generate candidates in parallel and trade them via signaling. The browsers' ICE agents try each combination until one succeeds.

## 4. `ontrack` — The Payoff

```js
this.pc.ontrack = (event) => {
  if (event.streams && event.streams[0]) {
    this.onRemoteStream?.(event.streams[0]);
  }
};
```

When remote media arrives, the browser fires `ontrack`. We grab the stream and attach it to the `<video>` element. That's when you see your friend.

## What STUN Actually Does

In our code:

```js
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
];
```

When the browser generates ICE candidates, it also contacts the STUN server and asks: "What IP/port do I look like from outside?" STUN replies: "You look like `103.x.x.x:54321`." That public address becomes a `srflx` candidate.

Without STUN, you'd only have `host` candidates — your local LAN IP — which won't help a peer across the internet.

## Why TURN Matters (and Why We Don't Ship It)

If both peers are behind **symmetric NATs** (mobile carrier CGNAT, some corporate networks), neither can send packets directly to the other, even with the correct public IPs. Packets get dropped.

TURN solves this by relaying: you send to TURN, TURN forwards to peer, and vice versa. But now the server sees your media (encrypted, but still relayed), and you pay bandwidth for both directions.

We don't bundle TURN because:
1. ~80% of connections work without it
2. Running TURN costs bandwidth
3. Self-hosters should opt in

See [self-hosting docs](./self-hosting.md) for deploying coturn.

## Why Screen Share Is Just a Track Swap

Look at `webrtc.js` → `startScreenShare()`:

```js
this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
const screenTrack = this.screenStream.getVideoTracks()[0];
if (this.videoSender) await this.videoSender.replaceTrack(screenTrack);
```

`RTCRtpSender.replaceTrack()` swaps the source of a sending track **without renegotiation**. The remote peer sees the same video track suddenly carrying screen frames instead of camera frames. Elegant.

## What's Encrypted

Everything media-related. WebRTC doesn't let you opt out.

- **DTLS** — secures the key exchange (TLS over UDP)
- **SRTP** — encrypts each RTP packet in flight
- Browser generates a self-signed certificate with a fingerprint included in the SDP
- Both sides verify each other's fingerprint — prevents man-in-the-middle on media

Signaling itself is NOT encrypted unless you deploy with HTTPS/WSS (which you must in production).

## Debugging

Open `chrome://webrtc-internals` in Chrome. You get:
- Every peer connection on every tab
- Every SDP ever exchanged
- Every ICE candidate ever gathered
- Live stats: bitrate, jitter, packet loss, RTT

See [debugging.md](./debugging.md) for a survival guide.

## The Reason This Codebase Exists

Most WebRTC tutorials dump a 500-line example and say "here's how it works." This codebase keeps every module under 150 lines so you can read it end-to-end in one coffee.

If you understand this repo, you understand WebRTC well enough to know when you need a library (LiveKit, Pion) and why — and not before.

## Related

- [p2p-limits.md](./p2p-limits.md) — why P2P breaks past 3-4 people
- [self-hosting.md](./self-hosting.md) — run it on your own server
- [debugging.md](./debugging.md) — when things go sideways
