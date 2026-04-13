const { generateRoomCode } = require("./words");
const db = require("./db");
const limits = require("./limits");
const metrics = require("./metrics");
const logger = require("./logger");
const sfu = require("./sfu");

// code -> { peers: Map<socketId, { name, ip, joinedAt }>, createdAt, hostIp, mode, sfuPeers }
// mode: 'mesh' | 'sfu'
// sfuPeers: Map<socketId, { sendTransport, recvTransport, producers: Map, consumers: Map }>
const rooms = new Map();

const SFU_THRESHOLD = 5;

function countRooms() {
  return rooms.size;
}

function countPeers() {
  let n = 0;
  for (const r of rooms.values()) n += r.peers.size;
  return n;
}

function ipFromSocket(socket) {
  return (
    socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    socket.handshake.address ||
    "unknown"
  );
}

// Helper: get the sfuPeers entry for a socket, creating it if needed
function ensureSfuPeer(room, socketId) {
  if (!room.sfuPeers.has(socketId)) {
    room.sfuPeers.set(socketId, {
      sendTransport: null,
      recvTransport: null,
      producers: new Map(),
      consumers: new Map(),
    });
  }
  return room.sfuPeers.get(socketId);
}

// Helper: get a transport by direction from the sfuPeers map
function getSfuTransport(room, socketId, direction) {
  const peer = room.sfuPeers.get(socketId);
  if (!peer) return null;
  return direction === "send" ? peer.sendTransport : peer.recvTransport;
}

// Helper: find a consumer by id across all consumers of a peer
function getConsumer(room, socketId, consumerId) {
  const peer = room.sfuPeers.get(socketId);
  if (!peer) return null;
  return peer.consumers.get(consumerId) || null;
}

// Close and clean up all SFU resources for a peer
function closeSfuPeer(room, socketId) {
  const peer = room.sfuPeers.get(socketId);
  if (!peer) return;

  for (const producer of peer.producers.values()) {
    try { producer.close(); } catch (_) {}
  }
  for (const consumer of peer.consumers.values()) {
    try { consumer.close(); } catch (_) {}
  }
  if (peer.sendTransport) {
    try { peer.sendTransport.close(); } catch (_) {}
  }
  if (peer.recvTransport) {
    try { peer.recvTransport.close(); } catch (_) {}
  }

  room.sfuPeers.delete(socketId);
}

function attach(io) {
  // Middleware
  io.use((socket, next) => {
    const ip = ipFromSocket(socket);

    if (limits.ipOverLimit(ip)) {
      metrics.inc("rateLimitHits");
      return next(new Error("Too many connections from your IP."));
    }

    if (io.engine.clientsCount >= limits.LIMITS.maxTotalSockets) {
      metrics.inc("rateLimitHits");
      return next(new Error("Server at capacity — try again shortly."));
    }

    // 🛡️ Ensure object
    if (!socket.data || typeof socket.data !== "object") {
      socket.data = {};
    }

    socket.data.ip = ip;
    next();
  });

  io.on("connection", (socket) => {
    // 🛡️ Always ensure object
    if (!socket.data || typeof socket.data !== "object") {
      socket.data = {};
    }

    const ip = socket.data?.ip || "unknown";

    limits.incConnection(ip);
    metrics.setGauge("sockets", io.engine.clientsCount);

    // ✅ FIX: avoid null (admin-ui crash)
    socket.data.joinedRoom = undefined;
    socket.data.name = "";

    logger.debug({ id: socket.id, ip }, "socket connected");

    // Rate limiter wrapper
    const withMsgLimit = (handler) => async (...args) => {
      try {
        await limits.wsMessageLimiter.consume(socket.id);
      } catch {
        metrics.inc("rateLimitHits");
        socket.emit("error-msg", { message: "Slow down — too many messages." });
        // If last arg is a callback, call it with error so client isn't left hanging
        const maybeCb = args[args.length - 1];
        if (typeof maybeCb === "function") maybeCb({ error: "rate limited" });
        return;
      }

      try {
        await handler(...args);
      } catch (e) {
        metrics.inc("errors");
        logger.error({ err: e, event: handler.name }, "handler error");
        // Notify client via callback if present
        const maybeCb = args[args.length - 1];
        if (typeof maybeCb === "function") maybeCb({ error: "internal server error" });
      }
    };

    // ---------------- CREATE ROOM ----------------
    socket.on("create-room", withMsgLimit(async () => {
      try {
        await limits.roomCreateLimiter.consume(ip);
      } catch {
        metrics.inc("rateLimitHits");
        socket.emit("error-msg", {
          message: "Too many rooms created. Wait an hour."
        });
        return;
      }

      if (rooms.size >= limits.LIMITS.maxTotalRooms) {
        socket.emit("error-msg", {
          message: "Server at capacity — try again shortly."
        });
        return;
      }

      if (limits.tooManyRoomsHeld(ip)) {
        socket.emit("error-msg", {
          message: "You already have the max rooms open."
        });
        return;
      }

      let code;
      do {
        code = generateRoomCode();
      } while (rooms.has(code));

      rooms.set(code, {
        peers: new Map(),
        createdAt: Date.now(),
        hostIp: ip,
        mode: "mesh",
        sfuPeers: new Map(),
      });

      db.createRoom(code, ip);
      limits.holdRoom(ip, code);

      metrics.inc("roomsCreated");
      metrics.setGauge("rooms", rooms.size);

      socket.emit("room-created", {
        code,
        myId: socket.id
      });

      logger.info({ code, ip, socketId: socket.id }, "room created");
    }));

    // ---------------- JOIN ROOM ----------------
    socket.on("join-room", withMsgLimit(async ({ code, name }) => {
      code = String(code || "").toLowerCase().trim();
      name = String(name || "").slice(0, 24).trim() || "anonymous";

      const room = rooms.get(code);

      if (!room) {
        socket.emit("error-msg", { message: "Room does not exist." });
        return;
      }

      if (room.peers.size >= limits.LIMITS.maxPeoplePerRoom) {
        socket.emit("error-msg", {
          message: `Room is full (max ${limits.LIMITS.maxPeoplePerRoom}).`
        });
        return;
      }

      if (socket.data.joinedRoom) {
        socket.emit("error-msg", {
          message: "You're already in a room."
        });
        return;
      }

      const existing = [...room.peers.entries()].map(([id, info]) => ({
        id,
        name: info.name
      }));

      room.peers.set(socket.id, {
        name,
        ip,
        joinedAt: Date.now()
      });

      socket.join(code);

      socket.data.joinedRoom = code;
      socket.data.name = name;

      db.touchRoom(code);

      metrics.inc("peersJoined");
      metrics.setGauge("peersInRooms", countPeers());

      // Auto-switch to SFU when threshold is reached
      if (room.peers.size >= SFU_THRESHOLD && room.mode === "mesh") {
        room.mode = "upgrading"; // intermediate state — prevents concurrent upgrades

        try {
          const router = await sfu.getOrCreateRouter(code);
          const rtpCapabilities = router.rtpCapabilities;
          room.mode = "sfu"; // set AFTER router is ready

          logger.info({ code, peers: room.peers.size }, "room upgraded to SFU mode");
          io.to(code).emit("upgrade-to-sfu", { rtpCapabilities });

          socket.emit("room-joined", {
            code,
            myId: socket.id,
            peers: existing,
            mode: "sfu",
            rtpCapabilities,
          });
        } catch (e) {
          room.mode = "mesh"; // rollback on failure
          logger.error({ err: e, code }, "SFU upgrade failed");
          socket.emit("error-msg", { message: "Failed to upgrade room mode." });
          return;
        }
      } else if (room.mode === "upgrading") {
        // Another peer triggered the upgrade — tell this client to use mesh for now
        socket.emit("room-joined", {
          code,
          myId: socket.id,
          peers: existing,
          mode: "mesh",
        });
      } else if (room.mode === "sfu") {
        // Room is already in SFU mode
        const router = sfu.getRouter(code);
        if (!router) {
          socket.emit("error-msg", { message: "Room SFU not ready. Try again." });
          return;
        }
        const rtpCapabilities = router.rtpCapabilities;

        socket.emit("room-joined", {
          code,
          myId: socket.id,
          peers: existing,
          mode: "sfu",
          rtpCapabilities,
        });
      } else {
        // Mesh mode (< SFU_THRESHOLD peers)
        socket.emit("room-joined", {
          code,
          myId: socket.id,
          peers: existing,
          mode: "mesh",
        });
      }

      socket.to(code).emit("peer-joined", {
        id: socket.id,
        name
      });

      logger.info({ code, socketId: socket.id, name, mode: room.mode }, "peer joined");
    }));

    // ---------------- SIGNALING (mesh) ----------------
    socket.on("offer", withMsgLimit(({ to, sdp }) => {
      if (!validRelay(socket, to)) return;
      io.to(to).emit("offer", { from: socket.id, sdp });
      metrics.inc("offersRelayed");
    }));

    socket.on("answer", withMsgLimit(({ to, sdp }) => {
      if (!validRelay(socket, to)) return;
      io.to(to).emit("answer", { from: socket.id, sdp });
      metrics.inc("answersRelayed");
    }));

    socket.on("ice-candidate", withMsgLimit(({ to, candidate }) => {
      if (!validRelay(socket, to)) return;
      io.to(to).emit("ice-candidate", {
        from: socket.id,
        candidate
      });
      metrics.inc("iceRelayed");
    }));

    // ---------------- SFU EVENTS ----------------

    socket.on("get-rtp-capabilities", withMsgLimit(async (callback) => {
      const code = socket.data.joinedRoom;
      if (!code) return;

      const router = await sfu.getOrCreateRouter(code);
      if (typeof callback === "function") {
        callback({ rtpCapabilities: router.rtpCapabilities });
      }
    }));

    socket.on("create-transport", withMsgLimit(async ({ direction }, callback) => {
      const code = socket.data.joinedRoom;
      if (!code || typeof callback !== "function") return;

      const room = rooms.get(code);
      if (!room) { callback({ error: "room not found" }); return; }

      const router = await sfu.getOrCreateRouter(code);
      const { transport, params } = await sfu.createWebRtcTransport(router);

      const peer = ensureSfuPeer(room, socket.id);

      if (direction === "send") {
        if (peer.sendTransport) {
          try { peer.sendTransport.close(); } catch (_) {}
        }
        peer.sendTransport = transport;
      } else {
        if (peer.recvTransport) {
          try { peer.recvTransport.close(); } catch (_) {}
        }
        peer.recvTransport = transport;
      }

      callback(params);
    }));

    socket.on("connect-transport", withMsgLimit(async ({ direction, dtlsParameters }, callback) => {
      const code = socket.data.joinedRoom;
      if (!code || typeof callback !== "function") return;

      if (!dtlsParameters || typeof dtlsParameters !== "object" || !dtlsParameters.role) {
        callback({ error: "invalid dtlsParameters" });
        return;
      }

      const room = rooms.get(code);
      if (!room) { callback({ error: "room not found" }); return; }

      const transport = getSfuTransport(room, socket.id, direction);
      if (!transport) { callback({ error: "transport not found" }); return; }

      await transport.connect({ dtlsParameters });
      callback({ ok: true });
    }));

    socket.on("produce", withMsgLimit(async ({ kind, rtpParameters, appData }, callback) => {
      const code = socket.data.joinedRoom;
      if (!code || typeof callback !== "function") return;

      if (kind !== "audio" && kind !== "video") {
        callback({ error: "invalid kind" });
        return;
      }
      if (!rtpParameters || typeof rtpParameters !== "object") {
        callback({ error: "invalid rtpParameters" });
        return;
      }

      const room = rooms.get(code);
      if (!room) { callback({ error: "room not found" }); return; }

      const transport = getSfuTransport(room, socket.id, "send");
      if (!transport) { callback({ error: "send transport not found" }); return; }

      // Don't trust client appData — use empty object
      const safeAppData = {};
      const producer = await transport.produce({ kind, rtpParameters, appData: safeAppData });

      const peer = ensureSfuPeer(room, socket.id);
      peer.producers.set(producer.id, producer);

      producer.on("transportclose", () => {
        peer.producers.delete(producer.id);
      });

      // Notify other peers to consume this new producer
      socket.to(code).emit("new-producer", {
        producerId: producer.id,
        peerId: socket.id,
        kind,
      });

      callback({ id: producer.id });
    }));

    socket.on("consume", withMsgLimit(async ({ producerId, rtpCapabilities }, callback) => {
      const code = socket.data.joinedRoom;
      if (!code || typeof callback !== "function") return;

      if (typeof producerId !== "string" || !producerId) {
        callback({ error: "invalid producerId" });
        return;
      }
      if (!rtpCapabilities || typeof rtpCapabilities !== "object") {
        callback({ error: "invalid rtpCapabilities" });
        return;
      }

      const room = rooms.get(code);
      if (!room) { callback({ error: "room not found" }); return; }

      const router = sfu.getRouter(code);
      if (!router) { callback({ error: "router not found" }); return; }

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        callback({ error: "cannot consume" });
        return;
      }

      const transport = getSfuTransport(room, socket.id, "recv");
      if (!transport) { callback({ error: "recv transport not found" }); return; }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      const peer = ensureSfuPeer(room, socket.id);
      peer.consumers.set(consumer.id, consumer);

      consumer.on("transportclose", () => {
        peer.consumers.delete(consumer.id);
      });

      consumer.on("producerclose", () => {
        peer.consumers.delete(consumer.id);
        socket.emit("producer-closed", { consumerId: consumer.id });
      });

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    }));

    socket.on("resume-consumer", withMsgLimit(async ({ consumerId }, callback) => {
      const code = socket.data.joinedRoom;
      if (!code || typeof callback !== "function") return;

      const room = rooms.get(code);
      if (!room) { callback({ error: "room not found" }); return; }

      const consumer = getConsumer(room, socket.id, consumerId);
      if (!consumer) { callback({ error: "consumer not found" }); return; }

      await consumer.resume();
      callback({ ok: true });
    }));

    // ---------------- CHAT ----------------
    socket.on("chat", withMsgLimit(async ({ body }) => {
      try {
        await limits.chatLimiter.consume(socket.id);
      } catch {
        metrics.inc("rateLimitHits");
        socket.emit("error-msg", {
          message: "Too many chat messages."
        });
        return;
      }

      const code = socket.data.joinedRoom;
      if (!code) return;

      body = String(body || "").slice(0, 500).trim();
      if (!body) return;

      const author = socket.data.name || "anonymous";

      let id;
      try {
        id = db.addMessage(code, author, body);
      } catch (e) {
        logger.error({ err: e }, "chat message failed");
        socket.emit("error-msg", { message: "Failed to send message." });
        return;
      }

      const payload = {
        id,
        author,
        body,
        createdAt: Date.now()
      };

      io.to(code).emit("chat", payload);
      metrics.inc("chatPersisted");
    }));

    socket.on("leave", () => cleanup(socket, io, "leave"));
    socket.on("disconnect", () => cleanup(socket, io, "disconnect"));
  });
}

// ---------------- HELPERS ----------------

function validRelay(socket, targetId) {
  if (!socket.data.joinedRoom) return false;

  const room = rooms.get(socket.data.joinedRoom);
  if (!room) return false;

  return room.peers.has(targetId) && targetId !== socket.id;
}

function cleanup(socket, io, reason) {
  // Idempotency guard
  if (socket.data?._cleanedUp) return;
  socket.data = socket.data || {};
  socket.data._cleanedUp = true;

  const ip = socket.data?.ip || "unknown";
  const code = socket.data?.joinedRoom;

  if (code) {
    const room = rooms.get(code);

    if (room) {
      // Collect producer IDs before closing, to notify other peers
      const sfuPeer = room.sfuPeers.get(socket.id);
      const producerIds = sfuPeer ? [...sfuPeer.producers.keys()] : [];

      // Close all SFU resources for this peer
      if (room.mode === "sfu") {
        closeSfuPeer(room, socket.id);
      }

      room.peers.delete(socket.id);

      // Notify remaining peers that this peer's producers are gone
      if (producerIds.length > 0) {
        for (const producerId of producerIds) {
          socket.to(code).emit("producer-closed", { producerId, peerId: socket.id });
        }
      }

      socket.to(code).emit("peer-left", { id: socket.id });

      if (room.peers.size === 0) {
        // Clean up SFU router if in SFU mode
        if (room.mode === "sfu") {
          sfu.deleteRouter(code);
        }

        rooms.delete(code);
        limits.releaseRoom(room.hostIp, code);
        metrics.inc("roomsDestroyed");
        logger.info({ code, reason }, "room destroyed (empty)");
      }

      metrics.setGauge("rooms", rooms.size);
      metrics.setGauge("peersInRooms", countPeers());
    }

    socket.data.joinedRoom = undefined;
    metrics.inc("peersLeft");
  }

  limits.decConnection(ip);

  setImmediate(() => {
    metrics.setGauge(
      "sockets",
      socket.nsp?.server?.engine?.clientsCount || 0
    );
  });
}

function scheduleCleanup() {
  const EVERY = 60 * 60 * 1000;

  setInterval(() => {
    const purged = db.cleanup();
    if (purged > 0) {
      logger.info({ purged }, "purged old rooms from DB");
    }
  }, EVERY);
}

async function init() {
  await sfu.createWorkers();
  logger.info("SFU workers initialized");
}

module.exports = {
  attach,
  scheduleCleanup,
  init,
  rooms,
  countRooms,
  countPeers
};
