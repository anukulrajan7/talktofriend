// Lightweight metrics collector.
//
// Two output formats:
//  - JSON via /api/stats    (for admin dashboard)
//  - Prometheus text via /metrics  (for Grafana)
//
// Includes Node.js process metrics (memory, CPU, event loop)
// and SFU worker/router gauges.

const STATE = {
  startedAt: Date.now(),
  totals: {
    roomsCreated: 0,
    roomsDestroyed: 0,
    peersJoined: 0,
    peersLeft: 0,
    offersRelayed: 0,
    answersRelayed: 0,
    iceRelayed: 0,
    chatPersisted: 0,
    rateLimitHits: 0,
    errors: 0,
  },
  gauges: {
    rooms: 0,
    sockets: 0,
    peersInRooms: 0,
    sfuWorkers: 0,
    sfuRouters: 0,
  },
};

function inc(key, n = 1) {
  if (STATE.totals[key] !== undefined) STATE.totals[key] += n;
}

function setGauge(key, v) {
  if (STATE.gauges[key] !== undefined) STATE.gauges[key] = v;
}

function snapshot() {
  return {
    uptimeSec: Math.round((Date.now() - STATE.startedAt) / 1000),
    ...STATE.gauges,
    totals: { ...STATE.totals },
  };
}

function prometheus() {
  const lines = [];
  const push = (name, help, type, value) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name} ${value}`);
  };

  // ── Uptime ──
  push("ttf_uptime_seconds", "Process uptime in seconds", "gauge",
    Math.round((Date.now() - STATE.startedAt) / 1000));

  // ── Application gauges ──
  push("ttf_rooms_active", "Concurrent active rooms", "gauge", STATE.gauges.rooms);
  push("ttf_sockets_active", "Concurrent WebSocket connections", "gauge", STATE.gauges.sockets);
  push("ttf_peers_in_rooms", "Peers currently in rooms", "gauge", STATE.gauges.peersInRooms);

  // ── SFU gauges ──
  push("ttf_sfu_workers", "Active mediasoup workers", "gauge", STATE.gauges.sfuWorkers);
  push("ttf_sfu_routers", "Active mediasoup routers (rooms in SFU mode)", "gauge", STATE.gauges.sfuRouters);

  // ── Application counters ──
  for (const [key, val] of Object.entries(STATE.totals)) {
    push(`ttf_${key}_total`, `Total ${key}`, "counter", val);
  }

  // ── Node.js process metrics ──
  const mem = process.memoryUsage();
  push("process_resident_memory_bytes", "Resident memory size in bytes", "gauge", mem.rss);
  push("process_heap_used_bytes", "V8 heap used in bytes", "gauge", mem.heapUsed);
  push("process_heap_total_bytes", "V8 heap total in bytes", "gauge", mem.heapTotal);
  push("process_external_memory_bytes", "V8 external memory in bytes", "gauge", mem.external);

  // CPU usage (user + system time in seconds)
  const cpu = process.cpuUsage();
  push("process_cpu_user_seconds_total", "CPU user time in seconds", "counter",
    (cpu.user / 1e6).toFixed(3));
  push("process_cpu_system_seconds_total", "CPU system time in seconds", "counter",
    (cpu.system / 1e6).toFixed(3));

  // Event loop lag (approximate via hrtime delta)
  push("nodejs_active_handles_total", "Number of active handles", "gauge",
    process._getActiveHandles?.().length || 0);
  push("nodejs_active_requests_total", "Number of active requests", "gauge",
    process._getActiveRequests?.().length || 0);

  return lines.join("\n") + "\n";
}

module.exports = { inc, setGauge, snapshot, prometheus };
