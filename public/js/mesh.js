// MeshManager: multi-peer WebRTC (3-4 person mesh).
//
// Rules:
// - When someone joins a room, the ALREADY-PRESENT peers initiate
//   (they receive "peer-joined" and call createOffer).
// - The new joiner waits for offers from existing peers.
// - DataChannel for chat is created by the offerer; answerer gets it via
//   ondatachannel.
//
// Emits callbacks:
//   onRemoteStream(peerId, stream, name)
//   onPeerGone(peerId)
//   onDataChannel(peerId, channel)   — so chat.js can wire up
//   onStateChange(peerId, state)

(function () {
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  class MeshManager {
    constructor({ signaling, callbacks = {} }) {
      this.signaling = signaling;
      this.cb = callbacks;
      this.peers = new Map(); // peerId -> { pc, name, dc, videoSender, remoteStream }
      this.localStream = null;
      this.screenStream = null;

      this._wire();
    }

    _wire() {
      this.signaling.on("room-joined", ({ peers }) => {
        // Existing peers will initiate offers to us. We just register them.
        (peers || []).forEach((p) => {
          if (!this.peers.has(p.id)) this.peers.set(p.id, { pc: null, name: p.name, dc: null });
        });
      });

      this.signaling.on("peer-joined", ({ id, name }) => {
        // A new peer joined AFTER us. We (existing) initiate.
        this._ensurePeer(id, name);
        this._initiate(id);
      });

      this.signaling.on("offer", async ({ from, sdp }) => {
        try {
          const pc = this._ensurePC(from);
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.signaling.sendAnswer(from, answer);
        } catch (e) {
          console.error("[mesh] offer handling failed for", from, e);
          this._tearDown(from);
          this.cb?.onPeerGone?.(from);
        }
      });

      this.signaling.on("answer", async ({ from, sdp }) => {
        try {
          const entry = this.peers.get(from);
          if (!entry?.pc) return;
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (e) {
          console.error("[mesh] answer handling failed for", from, e);
          this._tearDown(from);
          this.cb?.onPeerGone?.(from);
        }
      });

      this.signaling.on("ice-candidate", async ({ from, candidate }) => {
        try {
          const entry = this.peers.get(from);
          if (!entry?.pc) return;
          await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn("[mesh] addIceCandidate:", e);
        }
      });

      this.signaling.on("peer-left", ({ id }) => {
        this._tearDown(id);
        this.cb.onPeerGone?.(id);
      });
    }

    _ensurePeer(id, name) {
      if (!this.peers.has(id)) this.peers.set(id, { pc: null, name: name || "anonymous", dc: null });
      else if (name) this.peers.get(id).name = name;
      return this.peers.get(id);
    }

    _ensurePC(peerId) {
      const entry = this._ensurePeer(peerId);
      if (entry.pc) return entry.pc;

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

      pc.onconnectionstatechange = () => {
        this.cb.onStateChange?.(peerId, pc.connectionState);
      };

      // Add local tracks
      if (this.localStream) {
        this.localStream.getTracks().forEach((track) => {
          const sender = pc.addTrack(track, this.localStream);
          if (track.kind === "video") entry.videoSender = sender;
        });
      }

      return pc;
    }

    async _initiate(peerId) {
      try {
        const entry = this._ensurePeer(peerId);
        const pc = this._ensurePC(peerId);

        // We initiate → we create the DataChannel
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
      this.peers.forEach((_, id) => this._tearDown(id));
      this.screenStream?.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }

    peerCount() { return this.peers.size; }
  }

  window.MeshManager = MeshManager;
})();
