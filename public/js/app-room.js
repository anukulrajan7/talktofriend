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
    statusText: "connecting\u2026",
    statusClass: "text-dim",
    statusDot: "bg-amber-500 animate-pulse",
    toast: "",
    unread: 0,
    overlay: { show: false, title: "", body: "", emoji: "", dismissable: true },
    showDebug: new URLSearchParams(location.search).has("debug") || location.hostname === "localhost",
    blurEnabled: false,
    _bgProcessor: null,
    controlsVisible: true,
    _controlsTimer: null,
    videoQuality: '720p',
    pinnedPeerId: null, // null = gallery view, 'self' or peerId = speaker/pin view

    // Instances
    media: null,
    signaling: null,
    mesh: null,
    sfuClient: null,
    chat: null,
    reactions: null,
    sounds: null,
    speakingDetector: null,

    // Guards — _initialized stays true forever after first connect
    _initialized: false,
    _connectInProgress: false, // prevent re-entrant connect handler

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
        onVolumeChange: (peerId, level) => {
          // Drive audio-reactive speaking ring glow via CSS variable
          const tile = document.querySelector(`[data-peer-id="${peerId}"]`);
          if (tile) tile.style.setProperty('--speak-level', level.toFixed(2));
        },
      });

      // Mood lighting — shift mesh gradient based on time of day
      const h = new Date().getHours();
      document.body.dataset.mood = h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';

      this.reactions = new Reactions({
        mesh: null, // will be set after _initMesh
        overlayEl: document.getElementById("reactions"),
      });

      this.chat = new Chat({
        signaling: this.signaling,
        listEl: document.getElementById("chatList"),
        onNew: (msg) => {
          this.sounds?.chat();
          if (!this.chatOpen && window.innerWidth < 768) {
            this.unread++;
            this._showToast("new message");
          }
          // Detect effect triggers in received messages — all peers see effects
          if (msg?.body) {
            const b = msg.body;
            if (b.includes("☔")) this._triggerEffect("rain");
            else if (b.includes("❄️") && b.includes("snow")) this._triggerEffect("snow");
            else if (b.includes("🎊") || b.includes("🎉")) this._triggerEffect("confetti");
            else if (b.includes("🥳")) this._triggerEffect("celebrate");
            else if (b.includes("💕")) this._triggerEffect("hearts");
            else if (b.includes("🐱")) this._triggerEffect("cat");
            else if (b.includes("🐶")) this._triggerEffect("dog");
            else if (b.includes("🪩")) this._triggerEffect("disco");
            else if (b.includes("👊") && b.includes("nudge")) this._triggerEffect("nudge");
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

      // Global error reporter — sends client errors to server for production visibility
      window.addEventListener("error", (e) => {
        fetch("/api/client-errors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: `${e.message} at ${e.filename}:${e.lineno}`,
            context: "window.onerror",
            userAgent: navigator.userAgent,
          }),
        }).catch(() => {});
      });
      window.addEventListener("unhandledrejection", (e) => {
        fetch("/api/client-errors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: String(e.reason).slice(0, 500),
            context: "unhandledrejection",
            userAgent: navigator.userAgent,
          }),
        }).catch(() => {});
      });

      this.signaling.connect();

      this.signaling.socket.on("connect", async () => {
        console.log("SOCKET CONNECTED", this.mode, this.code);

        // FIX: guard against re-entrant connect handler.
        // Socket.IO can fire "connect" twice during transport upgrade.
        // Without this guard, the second fires the reconnection path
        // while getLocalMedia() is still awaiting, causing null localStream.
        if (this._connectInProgress) {
          console.log("Connect handler already in progress, skipping duplicate");
          return;
        }
        this._connectInProgress = true;

        try {
          // --- Reconnection path ---
          if (this._initialized) {
            console.log("Reconnection detected, cleaning up and re-joining");
            this._cleanupForRejoin();

            // Ensure media is ready before re-joining
            if (!this.media.localStream) {
              try {
                const stream = await this.media.getLocalMedia();
                if (this.micMuted) this.media.setMicEnabled(false);
                if (this.camOff) this.media.setCamEnabled(false);
                this._addLocalTile(stream);
              } catch (e) {
                console.error("Failed to re-acquire media on reconnect");
                return;
              }
            }

            if (this.code) {
              this.signaling.joinRoom(this.code, this.name);
            }
            return;
          }

          // --- First connection path ---
          this._initialized = true;

          try {
            const stream = await this.media.getLocalMedia();
            // FIX: sync track enabled state with UI toggles after acquiring media
            if (this.micMuted) this.media.setMicEnabled(false);
            if (this.camOff) this.media.setCamEnabled(false);
            this._addLocalTile(stream);
          } catch (e) {
            this.overlay = {
              show: true,
              emoji: "\uD83C\uDFA4",
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
        } finally {
          this._connectInProgress = false;
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

      this.signaling.on("room-joined", async ({ code, myId, peers, mode, rtpCapabilities, existingProducers }) => {
        this.code = code;
        this.myId = myId;
        this.roomMode = mode || "mesh";
        this._existingProducers = existingProducers || [];

        // FIX: Populate this.peers from initial peer list.
        // Without this, peerCount resets to 1 whenever peer-joined/peer-left fires
        // because those recalculate from Object.keys(this.peers) which was empty.
        this.peers = {};
        (peers || []).forEach(p => {
          this.peers[p.id] = { name: p.name, state: "connecting", camOff: !!p.camOff };
        });
        this.peerCount = 1 + Object.keys(this.peers).length;
        // Apply cam-off state for existing peers (late joiner support)
        this._pendingCamOff = (peers || []).filter(p => p.camOff).map(p => p.id);

        this.chat.loadHistory(code);

        console.log("room-joined: mode =", this.roomMode, "peers =", Object.keys(this.peers).length);

        if (this.roomMode === "sfu") {
          await this._initSFU();
        } else {
          this._initMesh();
        }

        this._updateStatus("connecting", "negotiating\u2026");
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
        const wasAlone = this.peerCount <= 1;
        this.peers[id] = { name, state: "connecting" };
        this.peerCount = 1 + Object.keys(this.peers).length;

        // First-connection celebration — the magic moment
        if (wasAlone && this.peerCount === 2) {
          this._showToast("vibes connected ✨");
          this.sounds?.celebrate();
          setTimeout(() => { if (window.confetti) window.confetti({ particleCount: 80, spread: 70, origin: { y: 0.7 }, colors: ["#7c3aed","#a78bfa","#fbbf24","#10b981"] }); }, 200);
        } else {
          this._showToast(`${name} joined`);
        }
        this.sounds?.join();
        this._updateConnQuality();
        // In mesh mode, MeshManager handles WebRTC negotiation internally via its own peer-joined listener.
        // In SFU mode, SFUClient handles consume via new-producer events internally.
      });

      this.signaling.on("peer-left", ({ id }) => {
        const leftName = this.peers[id]?.name || "friend";
        delete this.peers[id];
        this._showToast(`${leftName} left`);
        this.sounds?.leave();
        this._removeRemoteTile(id);
        // Defer peerCount update until AFTER tile exit animation completes.
        // Updating peerCount immediately changes the grid class (grid-3 → grid-2)
        // simultaneously with tile removal = compound reflow = video flicker.
        setTimeout(() => {
          this.peerCount = 1 + Object.keys(this.peers).length;
          this._updateConnQuality();
        }, 350);
      });

      // Remote camera state — toggle cam-off class on remote tiles
      this.signaling.on("cam-state", ({ id, camOff }) => {
        const tile = document.querySelector(`[data-peer-id="${id}"]`);
        if (tile) tile.classList.toggle("cam-off", camOff);
      });

      this.signaling.on("error-msg", ({ message }) => {
        // Don't show fatal overlay for "already in room" during reconnect race
        if (message === "You're already in a room.") {
          console.warn("Already in room (reconnect race), ignoring");
          return;
        }

        // Room expired — if host, create a new room automatically
        if (message === "Room does not exist." && this.mode === "host") {
          console.log("Room expired, creating a new one");
          this._showToast("Room expired, creating new room...");
          this.code = "";
          this.signaling.createRoom();
          return;
        }

        this.overlay = {
          show: true,
          emoji: "\uD83D\uDE43",
          title: "Can't join",
          body: this.mode === "guest"
            ? message + " Ask the host for a new link."
            : message,
          dismissable: true,
        };
      });

      this.signaling.on("disconnect", () => {
        this._updateStatus("fail", "reconnecting\u2026");
        // Show reconnecting toast, don't show fatal overlay yet
        this._showToast("connection lost, reconnecting\u2026");
      });

      // NOTE: Socket.IO fires "connect" on every reconnection too,
      // so we handle re-join there (guarded by _initialized).
      // No need for a separate "reconnect" handler that would double-join.

      this.signaling.socket.on("reconnect_failed", () => {
        this._updateStatus("fail", "connection lost");
        this.overlay = {
          show: true,
          emoji: "\uD83D\uDCE1",
          title: "Connection lost",
          body: "Couldn't reconnect to the server. Check your internet and reload.",
          dismissable: false,
        };
      });
    },

    // Clean up stale state before re-joining (on reconnect or revisit)
    _cleanupForRejoin() {
      // Don't touch the local (self) tile — prevent flicker
      // Only clear remote peer tiles
      this._clearRemoteTiles();

      if (this.mesh) {
        this.mesh.close();
        this.mesh = null;
      }
      if (this.sfuClient) {
        this.sfuClient.close();
        this.sfuClient = null;
      }
      this.peers = {};
      this.peerCount = 1;
      this.roomMode = "mesh";
      if (this.reactions) this.reactions.mesh = null;
      this._updateStatus("connecting", "reconnecting\u2026");
    },

    _initMesh() {
      // FIX: Close any existing mesh/SFU before creating new — prevents duplicate listeners
      if (this.mesh) {
        this.mesh.close();
        this.mesh = null;
      }
      if (this.sfuClient) {
        this.sfuClient.close();
        this.sfuClient = null;
      }

      console.log("Initializing mesh mode");
      this.mesh = new MeshManager({
        signaling: this.signaling,
        callbacks: {
          onRemoteStream: (id, stream, peerName) => this._addRemoteTile(id, stream, peerName),
          onPeerGone: (id) => this._removeRemoteTile(id),
          onDataChannel: (id, channel) => {
            this.reactions?.handleIncoming(channel);
            // Also handle cam-state messages from DataChannel (instant P2P path)
            channel.addEventListener("message", (e) => {
              try {
                const msg = JSON.parse(e.data);
                if (msg.type === "cam-state") {
                  const tile = document.querySelector(`[data-peer-id="${id}"]`);
                  if (tile) tile.classList.toggle("cam-off", msg.camOff);
                } else if (msg.type === "filter") {
                  const tile = document.querySelector(`[data-peer-id="${id}"]`);
                  if (tile) {
                    tile.className = tile.className.replace(/\bfilter-\w+/g, "").trim();
                    if (msg.filter && msg.filter !== "filter-none") tile.classList.add(msg.filter);
                  }
                } else if (msg.type === "frame") {
                  const tile = document.querySelector(`[data-peer-id="${id}"]`);
                  if (tile) {
                    tile.className = tile.className.replace(/\bframe-\w+/g, "").trim();
                    if (msg.frame && msg.frame !== "frame-none") tile.classList.add(msg.frame);
                  }
                }
              } catch {}
            });
          },
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
      // FIX: Close any existing mesh/SFU before creating new
      if (this.mesh) {
        this.mesh.close();
        this.mesh = null;
      }
      if (this.sfuClient) {
        this.sfuClient.close();
        this.sfuClient = null;
      }

      console.log("Initializing SFU mode");
      this.sfuClient = new SFUClient({
        signaling: this.signaling,
        callbacks: {
          onRemoteTrack: (peerId, track, kind) => {
            this._handleRemoteTrack(peerId, track, kind);
          },
          onProducerClosed: (peerId, kind) => {
            console.log(`Producer closed: ${peerId} ${kind}`);
            // Remove the specific track from the tile's stream
            const tile = document.querySelector(`[data-peer-id="${peerId}"]`);
            if (tile) {
              const video = tile.querySelector("video");
              const stream = video?.srcObject;
              if (stream) {
                const tracks = stream.getTracks().filter(t => t.kind === kind);
                tracks.forEach(t => { t.stop(); stream.removeTrack(t); });
              }
              // If no tracks left, show "cam off" state
              if (stream && stream.getTracks().length === 0) {
                video.srcObject = null;
                tile.style.background = "#12121a";
              }
            }
          },
        },
      });

      await this.sfuClient.connect();

      // Produce all local tracks
      for (const track of this.media.getProducibleTracks()) {
        await this.sfuClient.produce(track);
      }

      // FIX: consume producers that already exist in the room
      // (peers who produced before we connected)
      if (this._existingProducers && this._existingProducers.length > 0) {
        console.log(`SFU: consuming ${this._existingProducers.length} existing producers from room-joined`);
        for (const { producerId, peerId, kind } of this._existingProducers) {
          await this.sfuClient.consume(producerId, peerId, kind);
        }
        this._existingProducers = [];
      }

      // FIX: request existing producers from server as fallback
      // (handles upgrade-to-sfu race where new-producer events arrive
      // before our listener is registered)
      await this.sfuClient.consumeExisting();

      // Delayed retry: catch producers from peers who finished setup slightly later
      setTimeout(() => {
        if (this.sfuClient) this.sfuClient.consumeExisting();
      }, 3000);

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

    // Trigger visual/audio effects — used by chat commands, visible to all peers
    _triggerEffect(effect) {
      try {
        if (!window.confetti) return;
        switch (effect) {
          case "rain":
            this.reactions?.confettiRain(4000);
            break;
          case "snow": {
            const end = Date.now() + 4000;
            (function snowFrame() {
              window.confetti({ particleCount: 3, startVelocity: 0, ticks: 300,
                origin: { x: Math.random(), y: 0 }, colors: ["#ffffff", "#e0e7ff", "#c7d2fe"],
                shapes: ["circle"], gravity: 0.3, scalar: 0.7 });
              if (Date.now() < end) requestAnimationFrame(snowFrame);
            })();
            break;
          }
          case "confetti":
            this.reactions?._confettiBurst();
            break;
          case "celebrate":
            window.confetti({ particleCount: 150, spread: 120, origin: { y: 0.6 },
              colors: ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#ec4899"] });
            this.sounds?.reaction();
            break;
          case "hearts": {
            const end = Date.now() + 3000;
            (function heartFrame() {
              window.confetti({ particleCount: 2, startVelocity: 15, ticks: 200,
                origin: { x: Math.random(), y: 1 }, colors: ["#ef4444", "#ec4899", "#f472b6"],
                shapes: ["circle"], gravity: -0.2, scalar: 1.2 });
              if (Date.now() < end) requestAnimationFrame(heartFrame);
            })();
            break;
          }
          case "cat":
            this.sounds?._playChord([523, 660, 880], 0.2, 0.06, "sawtooth"); // meow-ish
            break;
          case "dog":
            this.sounds?._playChord([220, 330], 0.15, 0.07, "square"); // woof-ish
            break;
          case "disco": {
            const grid = document.getElementById("grid");
            grid?.classList.add("disco-mode");
            this.sounds?.celebrate();
            setTimeout(() => grid?.classList.remove("disco-mode"), 10000);
            break;
          }
          case "nudge": {
            document.querySelectorAll("#grid .tile").forEach(t => {
              t.classList.add("nudged");
              t.addEventListener("animationend", () => t.classList.remove("nudged"), { once: true });
            });
            this.sounds?.nudge();
            break;
          }
          default:
            // CSS video filters: filter-vintage, filter-noir, etc.
            if (effect.startsWith("filter-")) {
              const selfTile = document.querySelector('[data-peer-id="self"]');
              if (selfTile) {
                // Remove any existing filter class
                selfTile.className = selfTile.className.replace(/\bfilter-\w+/g, "").trim();
                if (effect !== "filter-none") selfTile.classList.add(effect);
              }
              // Broadcast filter to peers via DataChannel
              if (this.mesh) {
                this.mesh.broadcastDataChannel(JSON.stringify({ type: "filter", filter: effect }));
              }
            }
            // Tile frames: frame-neon, frame-fire, frame-chill
            if (effect.startsWith("frame-")) {
              const selfTile = document.querySelector('[data-peer-id="self"]');
              if (selfTile) {
                selfTile.className = selfTile.className.replace(/\bframe-\w+/g, "").trim();
                if (effect !== "frame-none") selfTile.classList.add(effect);
              }
              if (this.mesh) {
                this.mesh.broadcastDataChannel(JSON.stringify({ type: "frame", frame: effect }));
              }
            }
            break;
        }
      } catch (e) { console.warn("[effect]", e); }
    },

    _wireReactionEvents() {
      document.addEventListener("react", (e) => {
        this.sounds?.reaction();
        this.reactions?.trigger(e.detail);
      });
    },

    _wireKeyboard() {
      document.addEventListener("keydown", (e) => {
        try {
          if (e.key === "Escape") {
            document.activeElement?.blur();
            return;
          }

          const inInput = ["INPUT", "TEXTAREA"].includes(e.target?.tagName);
          if (inInput) return; // don't steal keys from chat input

          const key = e.key?.toLowerCase();
          if (key === "m") { this.toggleMute(); }
          else if (key === "v") { this.toggleCam(); }
          else if (key === "s") { this.toggleShare(); }
          else if (key === "b") { this.toggleBlur(); }
        } catch (err) {
          console.error("[keyboard] shortcut error:", err);
        }
      });

      // Auto-hide controls after 4s of inactivity (reappear on mouse/touch/key)
      const resetControlsTimer = () => {
        this.controlsVisible = true;
        clearTimeout(this._controlsTimer);
        this._controlsTimer = setTimeout(() => {
          if (this.peerCount > 1) this.controlsVisible = false;
        }, 4000);
      };
      document.addEventListener("mousemove", resetControlsTimer);
      document.addEventListener("touchstart", resetControlsTimer);
      document.addEventListener("keydown", resetControlsTimer);
      resetControlsTimer();

      window.addEventListener("beforeunload", () => {
        this.media?.close();
        this.mesh?.close();
        this.sfuClient?.close();
        this.signaling?.leave();
      });
    },

    _addLocalTile(stream) {
      // FIX: Guard against duplicate self tiles (e.g. on reconnect)
      const existing = document.querySelector('[data-peer-id="self"]');
      if (existing) {
        existing.querySelector("video").srcObject = stream;
        return;
      }
      const tile = this._createTile("self", this.name, true);
      tile.querySelector("video").srcObject = stream;
      document.getElementById("grid").appendChild(tile);
      this.speakingDetector?.track('self', stream);
    },

    _addRemoteTile(id, stream, peerName) {
      let tile = document.querySelector(`[data-peer-id="${id}"]`);
      if (!tile) {
        tile = this._createTile(id, peerName || this.peers[id]?.name || "friend", false);
        document.getElementById("grid").appendChild(tile);
      }
      const video = tile.querySelector("video");

      // FIX: skip srcObject reset if already set to the same stream.
      // ontrack fires twice (audio + video) with the same stream object.
      // Resetting srcObject causes a brief flicker/black frame.
      if (video.srcObject !== stream) {
        video.srcObject = stream;
        // Autoplay fix — some browsers block autoplay; retry on user interaction
        const playPromise = video.play();
        if (playPromise) {
          playPromise.catch(() => {
            const handler = () => {
              video.play().catch(() => {});
              document.removeEventListener("click", handler);
            };
            document.addEventListener("click", handler, { once: true });
          });
        }
      }
      this.speakingDetector?.track(id, stream);
      // Apply pending cam-off state for late joiners
      if (this._pendingCamOff?.includes(id) || this.peers[id]?.camOff) {
        tile.classList.add("cam-off");
      }
    },

    _removeRemoteTile(id) {
      this.speakingDetector?.untrack(id);
      const tile = document.querySelector(`[data-peer-id="${id}"]`);
      if (!tile) return;
      // Animate exit instead of instant removal — prevents layout snap flicker
      tile.classList.add("tile-leave");
      tile.addEventListener("animationend", () => tile.remove(), { once: true });
      // Safety: remove even if animationend doesn't fire
      setTimeout(() => { if (tile.parentNode) tile.remove(); }, 400);
    },

    // Sync .pinned class on tiles to match reactive pinnedPeerId
    _syncPinnedTiles() {
      const grid = document.getElementById("grid");
      if (!grid) return;
      grid.querySelectorAll(".tile.pinned").forEach(t => t.classList.remove("pinned"));
      if (this.pinnedPeerId) {
        const target = grid.querySelector(`[data-peer-id="${this.pinnedPeerId}"]`);
        if (target) target.classList.add("pinned");
      }
    },

    // FIX: New helper — clear all remote tiles (used on reconnect)
    _clearRemoteTiles() {
      const grid = document.getElementById("grid");
      if (!grid) return;
      grid.querySelectorAll('[data-peer-id]:not([data-peer-id="self"])').forEach(tile => {
        const peerId = tile.dataset.peerId;
        this.speakingDetector?.untrack(peerId);
        tile.remove();
      });
    },

    _createTile(peerId, name, isSelf) {
      const tile = document.createElement("div");
      tile.className = "tile tile-enter relative bg-surf2 rounded-xl overflow-hidden";
      tile.dataset.peerId = peerId;

      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      if (isSelf) video.muted = true;
      // Anti-flicker: GPU compositing + dark bg prevents white/transparent flash
      // Mirror self-video like every video call app (prevents disorientation)
      video.className = "w-full h-full object-cover";
      video.style.cssText = "background:#12121a; will-change:transform;" +
        (isSelf ? "transform:scaleX(-1);" : "");
      tile.appendChild(video);

      // Top-right badges container (quality + connection)
      const badges = document.createElement("div");
      badges.className = "absolute top-2 right-2 flex items-center gap-1.5 z-10";

      // Quality badge (HD/SD)
      const qBadge = document.createElement("div");
      qBadge.className = "quality-badge text-[9px] font-bold px-1.5 py-0.5 rounded bg-black/50 text-dim hidden";
      qBadge.dataset.quality = "";
      badges.appendChild(qBadge);

      // Connection quality dot
      if (!isSelf) {
        const dot = document.createElement("div");
        dot.className = "conn-dot w-2 h-2 rounded-full bg-amber-500";
        dot.title = "connecting";
        badges.appendChild(dot);
      }
      tile.appendChild(badges);

      // Cam-off avatar (shows initials when video is off)
      const avatar = document.createElement("div");
      // Random fun avatar emoji for cam-off (different per peer, consistent per session)
      const avatarEmojis = ["🐱","🐶","🦊","🐼","🐨","🦁","🐯","🐸","🐵","🦉","🐙","🐧","🦋","🐬","🦄","🐲"];
      const emojiIdx = (peerId || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0) % avatarEmojis.length;
      const avatarEmoji = avatarEmojis[emojiIdx];
      const initials = (name || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
      avatar.className = "cam-off-avatar absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 transition-opacity duration-300";
      avatar.innerHTML = `<div class="flex flex-col items-center gap-1">
        <div class="text-4xl sm:text-5xl">${avatarEmoji}</div>
        <div class="text-xs text-dim font-medium">${isSelf ? name : initials}</div>
      </div>`;
      tile.appendChild(avatar);

      // Name label
      const label = document.createElement("div");
      label.className = "absolute bottom-2 left-2 text-xs text-white bg-black/50 px-2 py-0.5 rounded-md z-10";
      label.textContent = isSelf ? `${name} (you)` : name;
      tile.appendChild(label);

      // Double-click to pin/unpin tile (speaker view) — uses reactive pinnedPeerId
      tile.addEventListener("dblclick", () => {
        this.pinnedPeerId = (this.pinnedPeerId === peerId) ? null : peerId;
        this._syncPinnedTiles();
      });

      // Monitor video resolution for quality badge
      if (isSelf) {
        video.addEventListener("resize", () => {
          const h = video.videoHeight;
          if (h >= 1080) this._setBadge(tile, "1080p", "text-ok");
          else if (h >= 720) this._setBadge(tile, "HD", "text-brand-400");
          else if (h >= 480) this._setBadge(tile, "SD", "text-amber-400");
          else if (h > 0) this._setBadge(tile, `${h}p`, "text-danger");
        });
      }

      return tile;
    },

    _setBadge(tile, text, colorClass) {
      const badge = tile.querySelector(".quality-badge");
      if (!badge) return;
      badge.textContent = text;
      badge.className = `quality-badge text-[9px] font-bold px-1.5 py-0.5 rounded bg-black/50 ${colorClass}`;
    },

    _onPeerState(peerId, state) {
      if (this.peers[peerId]) {
        this.peers[peerId].state = state;
      }

      // Update per-tile connection dot
      const tile = document.querySelector(`[data-peer-id="${peerId}"]`);
      const dot = tile?.querySelector(".conn-dot");
      if (dot) {
        if (state === "connected") {
          dot.className = "conn-dot w-2 h-2 rounded-full bg-ok";
          dot.title = "connected";
          // Start monitoring bandwidth for this peer
          this._startBandwidthMonitor(peerId);
        } else if (state === "connecting" || state === "new") {
          dot.className = "conn-dot w-2 h-2 rounded-full bg-amber-500 animate-pulse";
          dot.title = "connecting";
        } else if (state === "disconnected" || state === "failed") {
          dot.className = "conn-dot w-2 h-2 rounded-full bg-danger";
          dot.title = state;
        }
      }

      // Update remote video quality badge when connected
      if (state === "connected" && this.mesh) {
        const entry = this.mesh.peers.get(peerId);
        if (entry?.remoteStream && tile) {
          const video = tile.querySelector("video");
          if (video) {
            video.addEventListener("resize", () => {
              const h = video.videoHeight;
              if (h >= 1080) this._setBadge(tile, "1080p", "text-ok");
              else if (h >= 720) this._setBadge(tile, "HD", "text-brand-400");
              else if (h >= 480) this._setBadge(tile, "SD", "text-amber-400");
              else if (h > 0) this._setBadge(tile, `${h}p`, "text-danger");
            }, { once: false });
          }
        }
      }

      if (state === "connected") {
        this._updateStatus("ok", "connected");
      }
      this._updateConnQuality();
    },

    // Monitor bandwidth per peer — warn on low quality, suggest actions
    _startBandwidthMonitor(peerId) {
      if (!this.mesh) return;
      const entry = this.mesh.peers.get(peerId);
      if (!entry?.pc) return;

      let prevBytesRecv = 0;
      let prevTimestamp = Date.now();
      let lowBwCount = 0;
      let warnedDisableVideo = false;

      const interval = setInterval(async () => {
        if (!entry.pc || entry.pc.connectionState !== "connected") {
          clearInterval(interval);
          return;
        }
        try {
          const stats = await entry.pc.getStats();
          stats.forEach(report => {
            if (report.type === "inbound-rtp" && report.kind === "video") {
              // Calculate receive bitrate
              const now = Date.now();
              const elapsed = (now - prevTimestamp) / 1000;
              const bytesRecv = report.bytesReceived || 0;
              const bitrate = elapsed > 0 ? ((bytesRecv - prevBytesRecv) * 8) / elapsed : 0;
              prevBytesRecv = bytesRecv;
              prevTimestamp = now;

              // Check packet loss
              const lost = report.packetsLost || 0;
              const recv = report.packetsReceived || 1;
              const lossRate = lost / (lost + recv);

              // Update connection dot based on quality
              const tile = document.querySelector(`[data-peer-id="${peerId}"]`);
              const dot = tile?.querySelector(".conn-dot");
              if (dot) {
                if (lossRate > 0.05 || bitrate < 100000) {
                  dot.className = "conn-dot w-2 h-2 rounded-full bg-danger";
                  dot.title = `poor (${(bitrate/1000).toFixed(0)}kbps, ${(lossRate*100).toFixed(1)}% loss)`;
                } else if (lossRate > 0.02 || bitrate < 300000) {
                  dot.className = "conn-dot w-2 h-2 rounded-full bg-amber-400";
                  dot.title = `fair (${(bitrate/1000).toFixed(0)}kbps)`;
                } else {
                  dot.className = "conn-dot w-2 h-2 rounded-full bg-ok";
                  dot.title = `good (${(bitrate/1000).toFixed(0)}kbps)`;
                }
              }

              // Warn on sustained poor quality
              if (bitrate > 0 && bitrate < 150000) {
                lowBwCount++;
                if (lowBwCount >= 3 && !warnedDisableVideo) {
                  this._showToast("poor connection — consider turning off video");
                  warnedDisableVideo = true;
                }
              } else {
                lowBwCount = Math.max(0, lowBwCount - 1);
              }
            }
          });
        } catch (e) { clearInterval(interval); }
      }, 3000);

      entry._statsInterval = interval;
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
        this.connQuality = "vibes \u2728";
      } else if (states.some(s => s === "connected")) {
        this.connQuality = "mid \uD83E\uDD37";
      } else {
        this.connQuality = "ouch \uD83D\uDC80";
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
      // Smooth camera-off transition via CSS opacity instead of abrupt black frame
      const selfTile = document.querySelector('[data-peer-id="self"]');
      if (selfTile) selfTile.classList.toggle("cam-off", this.camOff);
      // Broadcast camera state to all peers (dual-channel for reliability + speed)
      this.signaling.socket.emit("cam-state", { camOff: this.camOff });
      if (this.mesh) {
        this.mesh.broadcastDataChannel(JSON.stringify({ type: "cam-state", camOff: this.camOff }));
      }
    },

    async switchQuality(quality) {
      if (quality === this.videoQuality) return;
      this.videoQuality = quality;
      this._showToast(`switching to ${quality}...`);

      try {
        // Re-acquire camera with new quality
        const stream = await this.media.getLocalMedia({ quality });
        if (this.micMuted) this.media.setMicEnabled(false);
        if (this.camOff) this.media.setCamEnabled(false);

        // Update self tile
        this._addLocalTile(stream);

        // Replace video track in all peer connections
        const newVideoTrack = this.media.videoTrack;
        if (newVideoTrack && this.mesh) {
          this.mesh.localStream = stream;
          this.mesh.peers.forEach((entry) => {
            if (entry.videoSender) entry.videoSender.replaceTrack(newVideoTrack);
          });
        }

        this._showToast(`${quality} active`);
      } catch (e) {
        console.error("Quality switch failed:", e);
        this._showToast(`${quality} not supported by your camera`);
      }
    },

    async toggleBlur() {
      try {
        // Guard: need an active camera track to blur
        if (!this.media?.videoTrack || this.camOff) {
          this._showToast("turn camera on first");
          return;
        }

        if (!this._bgProcessor) {
          this._bgProcessor = new BackgroundProcessor();
        }

        if (this.blurEnabled) {
          const origTrack = this._bgProcessor.disable();
          this.blurEnabled = false;
          this._showToast("blur off");

          if (origTrack && this.mesh) {
            this.mesh.peers.forEach((entry) => {
              if (entry.videoSender) entry.videoSender.replaceTrack(origTrack);
            });
          }
          const selfVideo = document.querySelector('[data-peer-id="self"] video');
          if (selfVideo && this.media.localStream) {
            selfVideo.srcObject = this.media.localStream;
          }
        } else {
          this._showToast("enabling blur...");
          const processedTrack = await this._bgProcessor.enable(this.media.videoTrack);
          this.blurEnabled = true;
          this._showToast("blur on (portrait mode)");

          if (this.mesh) {
            this.mesh.peers.forEach((entry) => {
              if (entry.videoSender) entry.videoSender.replaceTrack(processedTrack);
            });
          }
          const selfVideo = document.querySelector('[data-peer-id="self"] video');
          if (selfVideo) {
            const blurStream = new MediaStream([processedTrack]);
            const audioTrack = this.media.localStream?.getAudioTracks()[0];
            if (audioTrack) blurStream.addTrack(audioTrack);
            selfVideo.srcObject = blurStream;
          }
        }
      } catch (e) {
        console.error("Background blur failed:", e);
        this._showToast("blur failed — " + e.message);
        this.blurEnabled = false;
      }
    },

    async toggleShare() {
      if (this.sharing) {
        await this.media.stopScreenShare();
        this.sharing = false;
        // Unpin self tile when screen share stops
        if (this.pinnedPeerId === "self") {
          this.pinnedPeerId = null;
          this._syncPinnedTiles();
        }

        // In SFU mode, re-produce camera track after stopping screen share
        if (this.sfuClient && this.media.videoTrack) {
          await this.sfuClient.produce(this.media.videoTrack);
        }

        // In mesh mode, replace screen track back with camera on all peer connections
        if (this.mesh && this.media.videoTrack) {
          this.mesh.peers.forEach((entry) => {
            if (entry.videoSender) entry.videoSender.replaceTrack(this.media.videoTrack);
          });
        }
      } else {
        const screenTrack = await this.media.startScreenShare();
        if (!screenTrack) return; // cancelled

        this.sharing = true;
        // Auto-pin self tile when screen sharing (speaker view)
        this.pinnedPeerId = "self";
        this._syncPinnedTiles();

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
      const text = this.chatInput.trim();
      if (!text) return;

      // Chat commands — sent as special messages, all peers trigger effects
      if (text.startsWith("/")) {
        const cmd = text.toLowerCase();
        const commands = {
          "/rain":       { msg: "☔ made it rain", effect: "rain" },
          "/snow":       { msg: "❄️ let it snow",  effect: "snow" },
          "/confetti":   { msg: "🎊 confetti!",    effect: "confetti" },
          "/party":      { msg: "🎉 party time!",  effect: "confetti" },
          "/celebrate":  { msg: "🥳 celebration!",  effect: "celebrate" },
          "/hearts":     { msg: "💕 sending love",  effect: "hearts" },
          "/wave":       { msg: "👋", effect: null },
          "/cat":        { msg: "🐱 meow!", effect: "cat" },
          "/dog":        { msg: "🐶 woof!", effect: "dog" },
          "/disco":      { msg: "🪩 disco time!", effect: "disco" },
          "/nudge":      { msg: "👊 nudge!", effect: "nudge" },
          "/vintage":    { msg: "📷 vintage mode", effect: "filter-vintage" },
          "/noir":       { msg: "🎬 noir mode", effect: "filter-noir" },
          "/warm":       { msg: "☀️ warm vibes", effect: "filter-warm" },
          "/cold":       { msg: "❄️ cold mode", effect: "filter-cold" },
          "/trippy":     { msg: "🌀 trippy!", effect: "filter-trippy" },
          "/frame neon": { msg: "⚡ neon frame", effect: "frame-neon" },
          "/frame fire": { msg: "🔥 fire frame", effect: "frame-fire" },
          "/frame chill":{ msg: "💎 chill frame", effect: "frame-chill" },
          "/frame off":  { msg: "frame off", effect: "frame-none" },
        };
        const entry = commands[cmd];
        if (entry) {
          if (entry.effect) this._triggerEffect(entry.effect);
          this.chat.send(entry.msg);
        } else {
          this.chat.send(text);
        }
      } else {
        this.chat.send(text);
      }

      this.chatInput = "";
      this.unread = 0;
    },
  };
}
