// GoSFUClient: Standard WebRTC client for Go/Pion SFU.
//
// Unlike mediasoup-client, this uses native RTCPeerConnection.
// Flow:
//   1. Client sends offer to server (via Socket.IO → Node.js → Go SFU)
//   2. Go SFU returns answer
//   3. ICE candidates exchanged
//   4. Tracks added/received via standard WebRTC API
//
// Callbacks:
//   onRemoteStream(peerId, stream)  — new remote media stream
//   onPeerGone(peerId)              — remote peer disconnected

(function () {
  class GoSFUClient {
    constructor({ signaling, callbacks = {} }) {
      this.signaling = signaling;
      this.cb = callbacks;
      this.pc = null;
      this.localStream = null;
      this._closed = false;
      this._handlers = {};
      this._iceServers = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ];
    }

    // Fetch TURN credentials before connecting
    async _loadIceServers() {
      try {
        const res = await fetch("/api/turn-credentials");
        const data = await res.json();
        if (data.iceServers && data.iceServers.length > 0) {
          this._iceServers = data.iceServers;
          console.log("[go-sfu] ICE servers loaded (STUN+TURN)");
        }
      } catch (e) {
        console.warn("[go-sfu] TURN unavailable, using STUN only");
      }
    }

    async connect(localStream) {
      if (this.pc) {
        console.warn("[go-sfu] already connected");
        return;
      }

      this.localStream = localStream;
      await this._loadIceServers();

      // Create PeerConnection
      this.pc = new RTCPeerConnection({
        iceServers: this._iceServers,
        iceTransportPolicy: "all",
      });

      // Add local tracks (audio + video)
      if (localStream) {
        localStream.getTracks().forEach((track) => {
          this.pc.addTrack(track, localStream);
          console.log("[go-sfu] added local track:", track.kind);
        });
      }

      // Handle remote tracks from SFU
      this.pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (!stream) return;

        console.log("[go-sfu] remote track received:", event.track.kind, "stream:", stream.id);

        // Notify callback with stream
        // The stream ID encodes the peer ID from Go SFU
        this.cb.onRemoteStream?.(stream.id, stream);

        event.track.onmute = () => {
          console.log("[go-sfu] track muted:", event.track.kind);
        };
        event.track.onended = () => {
          console.log("[go-sfu] track ended:", event.track.kind);
        };
      };

      // ICE candidates → send to server
      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.signaling.socket.emit("sfu-ice", {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          });
        }
      };

      // Connection state monitoring
      this.pc.oniceconnectionstatechange = () => {
        console.log("[go-sfu] ICE state:", this.pc.iceConnectionState);
        if (this.pc.iceConnectionState === "failed") {
          console.error("[go-sfu] ICE failed — restarting");
          this.pc.restartIce();
        }
      };

      this.pc.onconnectionstatechange = () => {
        console.log("[go-sfu] connection state:", this.pc.connectionState);
      };

      // Wire server events
      this._handlers.sfuAnswer = ({ sdp, type }) => {
        console.log("[go-sfu] received SDP answer from server");
        this.pc.setRemoteDescription(new RTCSessionDescription({ sdp, type }))
          .catch((e) => console.error("[go-sfu] setRemoteDescription failed:", e));
      };

      this._handlers.sfuIce = ({ candidate, sdpMid, sdpMLineIndex }) => {
        if (!candidate) return;
        this.pc.addIceCandidate(new RTCIceCandidate({ candidate, sdpMid, sdpMLineIndex }))
          .catch((e) => console.warn("[go-sfu] addIceCandidate failed:", e));
      };

      this._handlers.sfuRenegotiate = async () => {
        // Go SFU requests renegotiation when tracks change
        console.log("[go-sfu] renegotiation requested");
        await this._sendOffer();
      };

      this.signaling.socket.on("sfu-answer", this._handlers.sfuAnswer);
      this.signaling.socket.on("sfu-ice", this._handlers.sfuIce);
      this.signaling.socket.on("sfu-renegotiate", this._handlers.sfuRenegotiate);

      // Send initial offer
      await this._sendOffer();
    }

    async _sendOffer() {
      if (!this.pc || this._closed) return;

      try {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        console.log("[go-sfu] sending offer to server");

        this.signaling.socket.emit("sfu-offer", {
          sdp: offer.sdp,
          type: offer.type,
        });
      } catch (e) {
        console.error("[go-sfu] createOffer failed:", e);
      }
    }

    // Replace a track (e.g. camera → screen share)
    async replaceTrack(oldTrack, newTrack) {
      if (!this.pc) return;

      const sender = this.pc.getSenders().find((s) => s.track === oldTrack);
      if (sender) {
        await sender.replaceTrack(newTrack);
        console.log("[go-sfu] track replaced:", newTrack.kind);
      }
    }

    // Mute/unmute
    setTrackEnabled(kind, enabled) {
      if (!this.pc) return;
      this.pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === kind) {
          sender.track.enabled = enabled;
        }
      });
    }

    close() {
      if (this._closed) return;
      this._closed = true;

      // Remove event listeners
      if (this._handlers.sfuAnswer) this.signaling.socket.off("sfu-answer", this._handlers.sfuAnswer);
      if (this._handlers.sfuIce) this.signaling.socket.off("sfu-ice", this._handlers.sfuIce);
      if (this._handlers.sfuRenegotiate) this.signaling.socket.off("sfu-renegotiate", this._handlers.sfuRenegotiate);

      // Close PeerConnection
      if (this.pc) {
        this.pc.close();
        this.pc = null;
      }

      console.log("[go-sfu] client closed");
    }
  }

  window.GoSFUClient = GoSFUClient;
})();
