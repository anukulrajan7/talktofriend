// MeshManager: multi-peer WebRTC (2-4 person mesh).
//
// Rules:
// - When someone joins a room, the ALREADY-PRESENT peers initiate
//   (they receive "peer-joined" and call createOffer).
// - The new joiner waits for offers from existing peers.
// - DataChannel for reactions is created by the offerer; answerer gets it via
//   ondatachannel.
//
// Emits callbacks:
//   onRemoteStream(peerId, stream, name)
//   onPeerGone(peerId)
//   onDataChannel(peerId, channel)
//   onStateChange(peerId, state)

(function () {
  // Default STUN-only (overridden by server TURN credentials)
  let ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  // Fetch TURN credentials — returns a promise that resolves when ready
  const iceReady = (async () => {
    try {
      const res = await fetch("/api/turn-credentials");
      const data = await res.json();
      if (data.iceServers && data.iceServers.length > 0) {
        ICE_SERVERS = data.iceServers;
        console.log("[mesh] ICE servers loaded (STUN+TURN)", ICE_SERVERS.length, "servers");
      }
    } catch (e) {
      console.warn("[mesh] TURN credentials unavailable, using STUN only", e);
    }
  })();

  class MeshManager {
    constructor({ signaling, callbacks = {} }) {
      this.signaling = signaling;
      this.cb = callbacks;
      this.peers = new Map(); // peerId -> { pc, name, dc, videoSender, remoteStream, iceBuf }
      this.localStream = null;
      this.screenStream = null;
      this._closed = false;
      this._handlers = {};

      this._wire();
    }

    _wire() {
      // Store handler references so we can remove them on close()
      this._handlers.peerJoined = ({ id, name }) => {
        if (this._closed) return;
        this._ensurePeer(id, name);
        this._initiate(id);
      };

      this._handlers.offer = async ({ from, sdp }) => {
        if (this._closed) return;
        try {
          const pc = await this._ensurePC(from);
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.signaling.sendAnswer(from, answer);
        } catch (e) {
          console.error("[mesh] offer handling failed for", from, e);
          this._tearDown(from);
          this.cb?.onPeerGone?.(from);
        }
      };

      this._handlers.answer = async ({ from, sdp }) => {
        if (this._closed) return;
        try {
          const entry = this.peers.get(from);
          if (!entry?.pc) return;
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (e) {
          console.error("[mesh] answer handling failed for", from, e);
          this._tearDown(from);
          this.cb?.onPeerGone?.(from);
        }
      };

      this._handlers.iceCandidate = async ({ from, candidate }) => {
        if (this._closed) return;
        try {
          const entry = this.peers.get(from);
          if (!entry?.pc) {
            // Buffer ICE candidate until peer connection is created
            const peer = this._ensurePeer(from);
            peer.iceBuf.push(candidate);
            return;
          }
          await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn("[mesh] addIceCandidate:", e);
        }
      };

      this._handlers.peerLeft = ({ id }) => {
        if (this._closed) return;
        this._tearDown(id);
        this.cb.onPeerGone?.(id);
      };

      this.signaling.on("peer-joined", this._handlers.peerJoined);
      this.signaling.on("offer", this._handlers.offer);
      this.signaling.on("answer", this._handlers.answer);
      this.signaling.on("ice-candidate", this._handlers.iceCandidate);
      this.signaling.on("peer-left", this._handlers.peerLeft);
    }

    _ensurePeer(id, name) {
      if (!this.peers.has(id)) {
        this.peers.set(id, { pc: null, name: name || "anonymous", dc: null, videoSender: null, remoteStream: null, iceBuf: [] });
      } else if (name) {
        this.peers.get(id).name = name;
      }
      return this.peers.get(id);
    }

    async _ensurePC(peerId) {
      const entry = this._ensurePeer(peerId);
      if (entry.pc) return entry.pc;

      // Wait for TURN credentials to be fetched before creating PeerConnection
      await iceReady;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      entry.pc = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) this.signaling.sendIce(peerId, event.candidate);
      };

      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (stream) {
          entry.remoteStream = stream;
          this.cb.onRemoteStream?.(peerId, stream, entry.name);
        }
      };

      pc.ondatachannel = (event) => {
        entry.dc = event.channel;
        this.cb.onDataChannel?.(peerId, event.channel);
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log(`[mesh] ICE state ${peerId}: ${state}`);
        if (state === "failed") {
          console.log(`[mesh] ICE restart for ${peerId}`);
          pc.restartIce();
        }
        if (state === "disconnected") {
          // Give it 5s to recover before cleanup
          entry._disconnectTimer = setTimeout(() => {
            if (pc.iceConnectionState === "disconnected") {
              console.log(`[mesh] peer ${peerId} disconnected timeout — cleaning up`);
              this._tearDown(peerId);
              this.cb.onPeerGone?.(peerId);
            }
          }, 5000);
        }
        if (state === "connected" || state === "completed") {
          clearTimeout(entry._disconnectTimer);
        }
      };

      pc.onconnectionstatechange = () => {
        this.cb.onStateChange?.(peerId, pc.connectionState);
      };

      // Add local tracks with quality constraints
      if (this.localStream) {
        this.localStream.getTracks().forEach((track) => {
          const sender = pc.addTrack(track, this.localStream);
          if (track.kind === "video") {
            entry.videoSender = sender;
            // Set video encoding quality
            try {
              const params = sender.getParameters();
              if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
              }
              params.encodings[0].maxBitrate = 2500000;   // 2.5 Mbps for 1080p
              params.encodings[0].maxFramerate = 30;
              sender.setParameters(params).catch(() => {});
            } catch (e) { /* older browsers */ }
          }
          if (track.kind === "audio") {
            try {
              const params = sender.getParameters();
              if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
              }
              params.encodings[0].maxBitrate = 64000;    // 64 kbps Opus
              sender.setParameters(params).catch(() => {});
            } catch (e) { /* older browsers */ }
          }
        });
      }

      // Drain any buffered ICE candidates
      if (entry.iceBuf && entry.iceBuf.length > 0) {
        for (const c of entry.iceBuf) {
          pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        entry.iceBuf = [];
      }

      return pc;
    }

    async _initiate(peerId) {
      try {
        const entry = this._ensurePeer(peerId);
        const pc = await this._ensurePC(peerId);

        // We initiate — we create the DataChannel
        const dc = pc.createDataChannel("chat", { ordered: true });
        entry.dc = dc;
        this.cb.onDataChannel?.(peerId, dc);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signaling.sendOffer(peerId, offer);
      } catch (e) {
        console.error("[mesh] _initiate failed for", peerId, e);
        this._tearDown(peerId);
        this.cb?.onPeerGone?.(peerId);
      }
    }

    _tearDown(peerId) {
      const entry = this.peers.get(peerId);
      if (!entry) return;
      try { entry.pc?.close(); } catch {}
      try { entry.dc?.close(); } catch {}
      this.peers.delete(peerId);
    }

    // ------------------ Controls ------------------
    setMicEnabled(enabled) {
      this.localStream?.getAudioTracks().forEach((t) => (t.enabled = enabled));
    }
    setCamEnabled(enabled) {
      this.localStream?.getVideoTracks().forEach((t) => (t.enabled = enabled));
    }

    async startScreenShare() {
      if (this.screenStream) return;
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = this.screenStream.getVideoTracks()[0];
      this.peers.forEach((entry) => {
        if (entry.videoSender) entry.videoSender.replaceTrack(screenTrack);
      });
      screenTrack.onended = () => this.stopScreenShare();
    }

    async stopScreenShare() {
      if (!this.screenStream) return;
      const camTrack = this.localStream?.getVideoTracks()[0];
      this.peers.forEach((entry) => {
        if (entry.videoSender && camTrack) entry.videoSender.replaceTrack(camTrack);
      });
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }

    broadcastDataChannel(message) {
      this.peers.forEach((entry) => {
        if (entry.dc && entry.dc.readyState === "open") {
          try { entry.dc.send(message); } catch {}
        }
      });
    }

    close() {
      this._closed = true;

      // Remove signaling listeners to prevent duplicate handlers on re-init
      if (this._handlers.peerJoined) this.signaling.off("peer-joined", this._handlers.peerJoined);
      if (this._handlers.offer) this.signaling.off("offer", this._handlers.offer);
      if (this._handlers.answer) this.signaling.off("answer", this._handlers.answer);
      if (this._handlers.iceCandidate) this.signaling.off("ice-candidate", this._handlers.iceCandidate);
      if (this._handlers.peerLeft) this.signaling.off("peer-left", this._handlers.peerLeft);
      this._handlers = {};

      this.peers.forEach((_, id) => this._tearDown(id));
      this.screenStream?.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }

    peerCount() { return this.peers.size; }
  }

  window.MeshManager = MeshManager;
})();
