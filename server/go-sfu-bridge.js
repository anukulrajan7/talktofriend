// Bridge between Node.js signaling and Go SFU.
//
// Node.js remains the signaling brain. This module translates
// Socket.IO SFU events into HTTP calls to the Go SFU service.
//
// Enable via env: SFU_BACKEND=go (default: mediasoup)

const http = require("http");
const logger = require("./logger").child({ module: "go-sfu-bridge" });

const SFU_URL = process.env.GO_SFU_URL || "http://127.0.0.1:3200";

// HTTP helper — calls Go SFU API
function sfuRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SFU_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { "Content-Type": "application/json" },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Go SFU request timeout"));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Create a room in Go SFU
async function createRoom(code) {
  const res = await sfuRequest("POST", `/rooms/${code}`);
  logger.info({ code, status: res.status }, "Go SFU room created");
  return res.body;
}

// Delete a room in Go SFU
async function deleteRoom(code) {
  try {
    await sfuRequest("DELETE", `/rooms/${code}`);
    logger.info({ code }, "Go SFU room deleted");
  } catch (err) {
    logger.warn({ code, err: err.message }, "Go SFU room delete failed (may already be gone)");
  }
}

// Join a peer to a room — creates PeerConnection in Go SFU
async function joinPeer(code, peerId) {
  const res = await sfuRequest("POST", `/rooms/${code}/peers/${peerId}/join`);
  if (res.status !== 200) {
    throw new Error(res.body?.error || "join failed");
  }
  return res.body;
}

// Remove a peer
async function removePeer(code, peerId) {
  try {
    await sfuRequest("DELETE", `/rooms/${code}/peers/${peerId}`);
  } catch (err) {
    logger.warn({ code, peerId, err: err.message }, "peer remove failed");
  }
}

// Send SDP offer to Go SFU, get answer back
async function offer(code, peerId, sdp) {
  const res = await sfuRequest("POST", `/rooms/${code}/peers/${peerId}/offer`, {
    sdp: sdp.sdp,
    type: sdp.type,
  });
  if (res.status !== 200) {
    throw new Error(res.body?.error || "offer failed");
  }
  return res.body;
}

// Send SDP answer to Go SFU
async function answer(code, peerId, sdp) {
  const res = await sfuRequest("POST", `/rooms/${code}/peers/${peerId}/answer`, {
    sdp: sdp.sdp,
    type: sdp.type,
  });
  return res.body;
}

// Send ICE candidate to Go SFU
async function addICECandidate(code, peerId, candidate) {
  const res = await sfuRequest("POST", `/rooms/${code}/peers/${peerId}/ice`, {
    candidate,
  });
  return res.body;
}

// Health check
async function isHealthy() {
  try {
    const res = await sfuRequest("GET", "/health");
    return res.status === 200 && res.body?.ok === true;
  } catch {
    return false;
  }
}

module.exports = {
  createRoom,
  deleteRoom,
  joinPeer,
  removePeer,
  offer,
  answer,
  addICECandidate,
  isHealthy,
  SFU_URL,
};
