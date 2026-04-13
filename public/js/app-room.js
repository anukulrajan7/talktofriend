function room() {
  return {
    // State
    code: "",
    name: "",
    myId: null,
    mode: "guest",
    roomMode: "mesh",       // 'mesh' or 'sfu' — set by server
    micMuted: false,
    camOff: false,
    sharing: false,
    chatOpen: false,
    chatInput: "",
    copied: false,
    peers: {},
    peerCount: 1,
    connState: "connecting", // 'connecting' | 'ok' | 'fail'
    statusText: "connecting…",
    statusClass: "text-dim",
    statusDot: "bg-amber-500 animate-pulse",
    toast: "",
    unread: 0,
    overlay: { show: false, title: "", body: "", emoji: "", dismissable: true },

    // Instances
    media: null,
    signaling: null,
    mesh: null,
    sfuClient: null,
    chat: null,
    reactions: null,
    sounds: null,
    speakingDetector: null,

    // Guards
    _hasHandledConnect: false,

    // Connection quality
    connQuality: "waiting",

    async init() {
      const params = new URLSearchParams(location.search);
      this.mode = params.get("mode") || "guest";
      this.code = (params.get("code") || "").toLowerCase().trim();
      this.name = params.get("name") || localStorage.getItem("ttf_name") || "anonymous";

      if (this.mode === "guest" && !this.code) {
        location.href = "/";
        return;
      }

      this.signaling = new Signaling();
      this.media = new MediaManager();
      this.sounds = new Sounds();

      this.speakingDetector = new SpeakingDetector({
        onSpeakingChange: (peerId, speaking) => {
          const tile = document.querySelector(`[data-peer-id="${peerId}"]`);
          if (tile) tile.classList.toggle('speaking', speaking);
        },
      });

      this.reactions = new Reactions({
        mesh: null, // will be set after _initMesh
        overlayEl: document.getElementById("reactions"),
      });

      this.chat = new Chat({
        signaling: this.signaling,
        listEl: document.getElementById("chatList"),
        onNew: () => {
          this.sounds?.chat();
          if (!this.chatOpen && window.innerWidth < 768) {
            this.unread++;
            this._showToast("new message");
          }
        },
      });

      this._wireSignaling();
      this._wireReactionEvents();
      this._wireKeyboard();

      // Listen for browser-level "stop sharing" button
      document.addEventListener("screen-share-ended", () => {
        this.sharing = false;
        // Re-produce camera if in SFU mode
        if (this.sfuClient && this.media.videoTrack) {
          this.sfuClient.produce(this.media.videoTrack);
        }
      });

      this.signaling.connect();

      this.signaling.socket.on("connect", async () => {
        console.log("SOCKET CONNECTED", this.mode, this.code);

        // Prevent duplicate execution on reconnect
        if (this._hasHandledConnect) {
          console.log("connect already handled, skipping");
          return;
        }
        this._hasHandledConnect = true;

        try {
          const stream = await this.media.getLocalMedia();
          this._addLocalTile(stream);
        } catch (e) {
          this.overlay = {
            show: true,
            emoji: "🎤",
            title: "Need camera & mic",
            body: "Please grant permission in your browser, then reload this page.",
            dismissable: false,
          };
          return;
        }

        if (this.mode === "host") {
          if (this.code) {
            console.log("Joining existing room:", this.code);
            this.signaling.joinRoom(this.code, this.name);
          } else {
            console.log("Creating new room");
            this.signaling.createRoom();
          }
        } else {
          console.log("Guest joining room:", this.code);
          this.signaling.joinRoom(this.code, this.name);
        }
      });
    },

    _wireSignaling() {
      this.signaling.on("room-created", ({ code, myId }) => {
        this.code = code;
        this.myId = myId;

        history.replaceState(
          null,
          "",
          `/room.html?mode=host&code=${encodeURIComponent(code)}&name=${encodeURIComponent(this.name)}`
        );

        // Join after creation
        this.signaling.joinRoom(code, this.name);
      });

      this.signaling.on("room-joined", async ({ code, myId, peers, mode, rtpCapabilities }) => {
        this.code = code;
        this.myId = myId;
        this.roomMode = mode || "mesh";
        this.peerCount = 1 + (peers?.length || 0);
        this.chat.loadHistory(code);

        console.log("room-joined: mode =", this.roomMode, "peers =", peers?.length || 0);

        if (this.roomMode === "sfu") {
          await this._initSFU();
        } else {
          this._initMesh();
        }

        this._updateStatus("connecting", "negotiating…");
      });

      this.signaling.on("upgrade-to-sfu", async ({ rtpCapabilities }) => {
        console.log("Upgrading to SFU mode");
        this.roomMode = "sfu";

        // Close mesh connections
        if (this.mesh) {
          this.mesh.close();
          this.mesh = null;
        }

        await this._initSFU();
      });

      this.signaling.on("peer-joined", ({ id, name }) => {
        this.peers[id] = { name, state: "connecting" };
        this.peerCount = 1 + Object.keys(this.peers).length;
        this._showToast(`${name} joined`);
        this.sounds?.join();
        this._updateConnQuality();
        // In mesh mode, MeshManager handles WebRTC negotiation internally via its own peer-joined listener.
        // In SFU mode, SFUClient handles consume via new-producer events internally.
      });

      this.signaling.on("peer-left", ({ id }) => {
        const leftName = this.peers[id]?.name || "friend";
        delete this.peers[id];
        this.peerCount = 1 + Object.keys(this.peers).length;
        this._showToast(`${leftName} left`);
        this.sounds?.leave();
        this._updateConnQuality();
        this._removeRemoteTile(id);
      });

      this.signaling.on("error-msg", ({ message }) => {
        this.overlay = {
          show: true,
          emoji: "🙃",
          title: "Can't join",
          body: message,
          dismissable: false,
        };
      });

      this.signaling.on("disconnect", () => {
        this._updateStatus("fail", "reconnecting…");
        this._hasHandledConnect = false;
        // Show reconnecting toast, don't show fatal overlay yet
        this._showToast("connection lost, reconnecting…");
      });

      this.signaling.socket.on("reconnect", () => {
        console.log("Reconnected to server");
        this._updateStatus("ok", "reconnected");
        this._showToast("reconnected!");
        // Re-join the room
        if (this.code) {
          this.signaling.joinRoom(this.code, this.name);
        }
      });

      this.signaling.socket.on("reconnect_failed", () => {
        this._updateStatus("fail", "connection lost");
        this.overlay = {
          show: true,
          emoji: "📡",
          title: "Connection lost",
          body: "Couldn't reconnect to the server. Check your internet and reload.",
          dismissable: false,
        };
      });
    },

    _initMesh() {
      console.log("Initializing mesh mode");
      this.mesh = new MeshManager({
        signaling: this.signaling,
        callbacks: {
          onRemoteStream: (id, stream, peerName) => this._addRemoteTile(id, stream, peerName),
          onPeerGone: (id) => this._removeRemoteTile(id),
          onDataChannel: (id, channel) => this.reactions?.handleIncoming(channel),
          onStateChange: (id, state) => this._onPeerState(id, state),
        },
      });

      // Give MeshManager the already-acquired local stream
      this.mesh.localStream = this.media.localStream;

      // Wire reactions to mesh for broadcasting
      if (this.reactions) {
        this.reactions.mesh = this.mesh;
      }
    },

    async _initSFU() {
      console.log("Initializing SFU mode");
      this.sfuClient = new SFUClient({
        signaling: this.signaling,
        callbacks: {
          onRemoteTrack: (peerId, track, kind) => {
            this._handleRemoteTrack(peerId, track, kind);
          },
          onProducerClosed: (peerId, kind) => {
            console.log(`Producer closed: ${peerId} ${kind}`);
          },
        },
      });

      await this.sfuClient.connect();

      // Produce all local tracks
      for (const track of this.media.getProducibleTracks()) {
        await this.sfuClient.produce(track);
      }

      this._updateStatus("ok", "connected (SFU)");
      this._updateConnQuality();
    },

    _handleRemoteTrack(peerId, track, kind) {
      let tile = document.querySelector(`[data-peer-id="${peerId}"]`);
      if (!tile) {
        const peerName = this.peers[peerId]?.name || "friend";
        tile = this._createTile(peerId, peerName, false);
        document.getElementById("grid").appendChild(tile);
      }

      const video = tile.querySelector("video");

      // Get existing stream or create new one
      let stream = video.srcObject;
      if (!stream) {
        stream = new MediaStream();
        video.srcObject = stream;
      }

      // Remove existing track of same kind before adding new one
      const existing = stream.getTracks().filter(t => t.kind === kind);
      existing.forEach(t => stream.removeTrack(t));
      stream.addTrack(track);

      // Re-track for speaking detection when audio track arrives
      if (kind === 'audio') {
        this.speakingDetector?.track(peerId, stream);
      }
    },

    _wireReactionEvents() {
      document.addEventListener("react", (e) => {
        this.sounds?.reaction();
        this.reactions?.trigger(e.detail);
      });
    },

    _wireKeyboard() {
      document.addEventListener("keydown", (e) => {
        if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
        if (e.key === "m" || e.key === "M") this.toggleMute();
        else if (e.key === "v" || e.key === "V") this.toggleCam();
        else if (e.key === "s" || e.key === "S") this.toggleShare();
      });

      window.addEventListener("beforeunload", () => {
        this.media?.close();
        this.mesh?.close();
        this.sfuClient?.close();
        this.signaling?.leave();
      });
    },

    _addLocalTile(stream) {
      const tile = this._createTile("self", this.name, true);
      tile.querySelector("video").srcObject = stream;
      document.getElementById("grid").appendChild(tile);
      this.speakingDetector?.track('self', stream);
    },

    _addRemoteTile(id, stream, peerName) {
      let tile = document.querySelector(`[data-peer-id="${id}"]`);
      if (!tile) {
        tile = this._createTile(id, peerName || "friend", false);
        document.getElementById("grid").appendChild(tile);
      }
      tile.querySelector("video").srcObject = stream;
      this.speakingDetector?.track(id, stream);
    },

    _removeRemoteTile(id) {
      this.speakingDetector?.untrack(id);
      const tile = document.querySelector(`[data-peer-id="${id}"]`);
      if (tile) tile.remove();
    },

    _createTile(peerId, name, isSelf) {
      const tile = document.createElement("div");
      tile.className = "tile tile-enter relative bg-surf2 rounded-xl overflow-hidden";
      tile.dataset.peerId = peerId;

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      if (isSelf) video.muted = true;
      video.className = "w-full h-full object-cover";
      tile.appendChild(video);

      // Name label
      const label = document.createElement("div");
      label.className = "absolute bottom-2 left-2 text-xs text-white bg-black/50 px-2 py-0.5 rounded-md";
      label.textContent = isSelf ? `${name} (you)` : name;
      tile.appendChild(label);

      return tile;
    },

    _onPeerState(peerId, state) {
      if (this.peers[peerId]) {
        this.peers[peerId].state = state;
      }
      if (state === "connected") {
        this._updateStatus("ok", "connected");
      }
      this._updateConnQuality();
    },

    _updateConnQuality() {
      if (this.roomMode === "sfu") {
        // SFU mode: use transport stats if available
        this.connQuality = "solid";
        return;
      }

      // Mesh mode: check peer connection states
      const peerIds = Object.keys(this.peers);
      if (peerIds.length === 0) {
        this.connQuality = "waiting";
        return;
      }

      // Simple heuristic based on connection state
      const states = peerIds.map(id => this.peers[id]?.state);
      if (states.every(s => s === "connected")) {
        this.connQuality = "vibes ✨";
      } else if (states.some(s => s === "connected")) {
        this.connQuality = "mid 🤷";
      } else {
        this.connQuality = "ouch 💀";
      }
    },

    _updateStatus(kind, text) {
      this.connState = kind;
      this.statusText = text;
    },

    _showToast(msg) {
      this.toast = msg;
      setTimeout(() => (this.toast = ""), 2500);
    },

    copyLink() {
      const url = `${location.origin}/room.html?mode=guest&code=${encodeURIComponent(this.code)}&name=friend`;
      navigator.clipboard.writeText(url).then(() => {
        this.copied = true;
        setTimeout(() => (this.copied = false), 2000);
      });
    },

    toggleMute() {
      this.micMuted = !this.micMuted;
      this.media.setMicEnabled(!this.micMuted);
      if (this.micMuted) {
        this.sounds?.mute();
      } else {
        this.sounds?.unmute();
      }
    },

    toggleCam() {
      this.camOff = !this.camOff;
      this.media.setCamEnabled(!this.camOff);
    },

    async toggleShare() {
      if (this.sharing) {
        await this.media.stopScreenShare();
        this.sharing = false;

        // In SFU mode, re-produce camera track after stopping screen share
        if (this.sfuClient && this.media.videoTrack) {
          await this.sfuClient.produce(this.media.videoTrack);
        }

        // In mesh mode, MeshManager.stopScreenShare already handled track replacement internally.
        // But since we're using MediaManager for screen share now, tell mesh to update senders.
        if (this.mesh && this.media.videoTrack) {
          this.mesh.peers.forEach((entry) => {
            if (entry.videoSender) entry.videoSender.replaceTrack(this.media.videoTrack);
          });
        }
      } else {
        const screenTrack = await this.media.startScreenShare();
        if (!screenTrack) return; // cancelled

        this.sharing = true;

        if (this.sfuClient) {
          // SFU: produce screen track (replaces video producer)
          await this.sfuClient.produce(screenTrack);
        } else if (this.mesh) {
          // Mesh: replace video sender tracks directly
          this.mesh.peers.forEach((entry) => {
            if (entry.videoSender) entry.videoSender.replaceTrack(screenTrack);
          });
        }
      }
    },

    leave() {
      this.speakingDetector?.close();
      this.media?.close();
      this.mesh?.close();
      this.sfuClient?.close();
      this.signaling?.leave();
      location.href = "/";
    },

    sendChat() {
      if (!this.chatInput.trim()) return;
      this.chat.send(this.chatInput);
      this.chatInput = "";
      // Reset unread when user sends
      this.unread = 0;
    },
  };
}
