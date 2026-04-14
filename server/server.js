// TalkToFriend — Node reference signaling server.
//
// Components:
//   - Express: static + REST
//   - Socket.IO: signaling + chat
//   - SQLite: chat history + room metadata
//   - Rate limiting: per-IP, per-socket
//   - Metrics: /api/stats (JSON) + /metrics (Prometheus)
//   - Admin UI: /admin (@socket.io/admin-ui)

const path = require("path");
const http = require("http");
const express = require("express");
const pinoHttp = require("pino-http");
const { Server } = require("socket.io");

const logger = require("./logger").child({ module: "http" });
const limits = require("./limits");
const metrics = require("./metrics");
const db = require("./db");
const signaling = require("./signaling");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const app = express();
app.set("trust proxy", 1); // honor X-Forwarded-For
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: "32kb" }));

// ---------- Global HTTP rate limit (before static) ----------
app.use("/api", limits.httpLimiter);

// ---------- Static frontend ----------
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

// ---------- Health + stats ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/api/stats", (_req, res) => {
  const sfu = require("./sfu");
  res.json({
    ...metrics.snapshot(),
    db: db.stats(),
    limits: limits.LIMITS,
    sfu: sfu.sfuStats(),
  });
});

app.get("/metrics", (_req, res) => {
  res.type("text/plain").send(metrics.prometheus());
});

// ---------- Chat history REST ----------
app.get("/api/rooms/:code/chat", (req, res) => {
  const code = String(req.params.code || "").toLowerCase();
  const sinceId = parseInt(req.query.sinceId || "0", 10);
  const limit = Math.min(parseInt(req.query.limit || "200", 10), 500);

  if (!db.getRoom(code)) {
    return res.status(404).json({ error: "Room not found." });
  }
  const messages = db.listMessages(code, sinceId, limit);
  res.json({ messages });
});

// ---------- Boot ----------
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // allow same-origin
      const allowed = [
        /^http:\/\/localhost(:\d+)?$/,
        /^https:\/\/([a-z0-9-]+\.)?talktofriend\.com$/,
        /^https:\/\/([a-z0-9-]+\.)?talktofriend\.online$/,
      ];
      // Allow additional domains from env
      if (process.env.ALLOWED_ORIGINS) {
        process.env.ALLOWED_ORIGINS.split(",").forEach(d => {
          allowed.push(new RegExp(`^https?:\\/\\/${d.trim().replace(/\./g, "\\.")}$`));
        });
      }
      if (allowed.some(re => re.test(origin))) return callback(null, true);
      return callback(new Error("CORS blocked"), false);
    },
    credentials: true,
  },
  maxHttpBufferSize: 128 * 1024, // 128KB max WS message
});

signaling.attach(io);
signaling.scheduleCleanup();

signaling.init().then(() => {
  server.listen(PORT, () => {
    logger.info(
      { port: PORT, publicDir: PUBLIC_DIR, nodeEnv: process.env.NODE_ENV || "development" },
      "TalkToFriend signaling running"
    );
    logger.info(`🎥 http://localhost:${PORT}`);
    logger.info(`📊 http://localhost:${PORT}/api/stats  (live stats JSON)`);
    logger.info(`📈 http://localhost:${PORT}/metrics   (Prometheus format)`);
  });
}).catch((err) => {
  logger.error({ err }, "failed to initialize SFU workers");
  process.exit(1);
});

// Graceful shutdown
function shutdown() {
  logger.info("shutting down…");
  server.close();
  db.db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
