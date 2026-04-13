// Lightweight metrics collector. Tracks things the admin dashboard
// and /metrics endpoint surface. No external deps.
//
// Two output formats:
//  - JSON via /api/stats    (for dashboard)
//  - Prometheus text via /metrics

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
  const push = (name, help, type, value, labels = {}) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
    lines.push(`${name}${labelStr ? `{${labelStr}}` : ""} ${value}`);
  };

  push("ttf_uptime_seconds", "Process uptime in seconds", "gauge",
    Math.round((Date.now() - STATE.startedAt) / 1000));
  push("ttf_rooms_active", "Concurrent active rooms", "gauge", STATE.gauges.rooms);
  push("ttf_sockets_active", "Concurrent WebSocket connections", "gauge", STATE.gauges.sockets);
  push("ttf_peers_in_rooms", "Peers currently in rooms", "gauge", STATE.gauges.peersInRooms);

  for (const [key, val] of Object.entries(STATE.totals)) {
    push(`ttf_${key}_total`, `Total ${key}`, "counter", val);
  }
  return lines.join("\n") + "\n";
}

module.exports = { inc, setGauge, snapshot, prometheus };
