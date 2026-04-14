// SFU layer — mediasoup integration.
//
// Architecture:
//   - N workers (1 per CPU core)
//   - 1 Router per room (handles codec negotiation)
//   - 1 WebRtcTransport pair per peer (send + recv)
//   - Producers (peer sends media) + Consumers (peer receives others' media)
//
// This file exposes: createWorkers(), getRouter(), createTransport(), etc.
// signaling.js orchestrates the room-level logic on top.

const mediasoup = require("mediasoup");
const os = require("os");
const logger = require("./logger").child({ module: "sfu" });
const metrics = require("./metrics");

// How many CPU cores to dedicate to media processing.
const NUM_WORKERS = process.env.MS_WORKERS
  ? Math.max(1, parseInt(process.env.MS_WORKERS, 10))
  : os.cpus().length;

// mediasoup config
const MEDIA_CODECS = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
  {
    kind: "video",
    mimeType: "video/VP9",
    clockRate: 90000,
    parameters: {
      "profile-id": 2,
      "x-google-start-bitrate": 1000,
    },
  },
];

// WebRTC transport settings
const WEBRTC_TRANSPORT_OPTIONS = {
  listenInfos: [
    {
      protocol: "udp",
      ip: "0.0.0.0",
      announcedAddress: process.env.ANNOUNCED_IP || undefined,
    },
    {
      protocol: "tcp",
      ip: "0.0.0.0",
      announcedAddress: process.env.ANNOUNCED_IP || undefined,
    },
  ],
  initialAvailableOutgoingBitrate: 1000000,
  maxIncomingBitrate: 3000000,
  minimumAvailableOutgoingBitrate: 600000,
};

// ---- Worker pool ----
const workers = [];
let workerIdx = 0;

async function createWorkers() {
  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: "warn",
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
      rtcMinPort: parseInt(process.env.RTC_MIN_PORT || "40000", 10),
      rtcMaxPort: parseInt(process.env.RTC_MAX_PORT || "49999", 10),
    });

    worker.on("died", () => {
      logger.error({ pid: worker.pid }, "mediasoup worker died");
      // Remove from pool
      const idx = workers.indexOf(worker);
      if (idx !== -1) workers.splice(idx, 1);
      metrics.setGauge("sfuWorkers", workers.length);
      // If no workers left, exit
      if (workers.length === 0) {
        logger.error("all workers dead — exiting");
        setTimeout(() => process.exit(1), 2000);
      }
    });

    workers.push(worker);
    metrics.setGauge("sfuWorkers", workers.length);
    logger.info({ pid: worker.pid, index: i, total: NUM_WORKERS }, "mediasoup worker created");
  }
}

function getNextWorker() {
  if (workers.length === 0) throw new Error("no mediasoup workers available");
  const w = workers[workerIdx % workers.length];
  workerIdx++;
  return w;
}

// ---- Router (one per room) ----
const routers = new Map(); // roomCode -> Router

async function getOrCreateRouter(roomCode) {
  if (routers.has(roomCode)) return routers.get(roomCode);
  const worker = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  routers.set(roomCode, router);
  metrics.setGauge("sfuRouters", routers.size);
  logger.info({ roomCode, workerId: worker.pid }, "router created");
  return router;
}

function deleteRouter(roomCode) {
  const router = routers.get(roomCode);
  if (router) {
    router.close();
    routers.delete(roomCode);
    metrics.setGauge("sfuRouters", routers.size);
    logger.info({ roomCode }, "router closed");
  }
}

function getRouter(roomCode) {
  return routers.get(roomCode);
}

// ---- Transport helpers ----

async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS);

  // Auto-close after 30s of no DTLS connection (stale)
  transport.on("dtlsstatechange", (state) => {
    if (state === "closed" || state === "failed") {
      transport.close();
    }
  });

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
}

// ---- Stats for monitoring ----

function sfuStats() {
  return {
    workers: workers.length,
    routers: routers.size,
    workerPids: workers.map((w) => w.pid),
  };
}

module.exports = {
  createWorkers,
  getOrCreateRouter,
  deleteRouter,
  getRouter,
  createWebRtcTransport,
  sfuStats,
  MEDIA_CODECS,
};
