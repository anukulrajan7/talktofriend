// Rate limiting + abuse prevention.
//
// HTTP: express-rate-limit
// WebSocket: rate-limiter-flexible
//
// All limits tunable via env vars. Defaults are conservative.

const rateLimit = require("express-rate-limit");
const { RateLimiterMemory } = require("rate-limiter-flexible");

const envInt = (key, def) => (process.env[key] ? parseInt(process.env[key], 10) : def);

const LIMITS = {
  // HTTP
  globalWindowMs: envInt("HTTP_WINDOW_MS", 60 * 1000),
  globalMax: envInt("HTTP_MAX_PER_WINDOW", 120), // 120 req / min / IP

  // WS signaling — per IP
  wsConnectionsPerIp: envInt("WS_MAX_CONN_PER_IP", 5),

  // WS messages — per socket
  wsMessagesPerSecond: envInt("WS_MSG_PER_SEC", 100),

  // Chat messages — per socket per 10s
  chatMessagesPer10s: envInt("CHAT_MAX_PER_10S", 30),

  // Room creation — per IP per hour
  roomCreatePerHour: envInt("ROOM_CREATE_PER_HOUR", 10),

  // Rooms held concurrently — per IP
  concurrentRoomsPerIp: envInt("CONCURRENT_ROOMS_PER_IP", 3),

  // Global server limits
  maxTotalRooms: envInt("MAX_TOTAL_ROOMS", 500),
  maxTotalSockets: envInt("MAX_TOTAL_SOCKETS", 2000),

  // Per-room
  maxPeoplePerRoom: envInt("MAX_PEOPLE_PER_ROOM", 20),
  maxRoomDurationMs: envInt("MAX_ROOM_DURATION_MS", 4 * 60 * 60 * 1000),
};

// HTTP-level middleware
const httpLimiter = rateLimit({
  windowMs: LIMITS.globalWindowMs,
  max: LIMITS.globalMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." },
});

// WS message flood protection (per-socket)
const wsMessageLimiter = new RateLimiterMemory({
  points: LIMITS.wsMessagesPerSecond,
  duration: 1,
});

// Chat flood protection (per-socket, longer window)
const chatLimiter = new RateLimiterMemory({
  points: LIMITS.chatMessagesPer10s,
  duration: 10,
});

// Room create — per IP
const roomCreateLimiter = new RateLimiterMemory({
  points: LIMITS.roomCreatePerHour,
  duration: 3600,
});

// Concurrent WS connections — per IP (manual tracking)
const connectionsPerIp = new Map(); // ip -> count
const roomsHeldPerIp = new Map(); // ip -> Set<roomCode>

function incConnection(ip) {
  const n = (connectionsPerIp.get(ip) || 0) + 1;
  connectionsPerIp.set(ip, n);
  return n;
}

function decConnection(ip) {
  const n = Math.max(0, (connectionsPerIp.get(ip) || 0) - 1);
  if (n === 0) connectionsPerIp.delete(ip);
  else connectionsPerIp.set(ip, n);
}

function ipOverLimit(ip) {
  return (connectionsPerIp.get(ip) || 0) >= LIMITS.wsConnectionsPerIp;
}

function holdRoom(ip, roomCode) {
  if (!roomsHeldPerIp.has(ip)) roomsHeldPerIp.set(ip, new Set());
  roomsHeldPerIp.get(ip).add(roomCode);
}

function releaseRoom(ip, roomCode) {
  const s = roomsHeldPerIp.get(ip);
  if (s) {
    s.delete(roomCode);
    if (s.size === 0) roomsHeldPerIp.delete(ip);
  }
}

function tooManyRoomsHeld(ip) {
  const s = roomsHeldPerIp.get(ip);
  return s ? s.size >= LIMITS.concurrentRoomsPerIp : false;
}

module.exports = {
  LIMITS,
  httpLimiter,
  wsMessageLimiter,
  chatLimiter,
  roomCreateLimiter,
  incConnection,
  decConnection,
  ipOverLimit,
  holdRoom,
  releaseRoom,
  tooManyRoomsHeld,
};
