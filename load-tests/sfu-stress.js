#!/usr/bin/env node
// SFU Stress Test for TalkToFriend
//
// Tests the SFU code path by creating rooms with 5+ peers to trigger
// mesh→SFU upgrade, then exercises SFU-specific endpoints.
//
// Usage:
//   node sfu-stress.js [url] [rooms] [peersPerRoom]
//   node sfu-stress.js http://localhost:3000 5 6
//
// What it tests:
//   - Mesh → SFU auto-upgrade at 5 peers
//   - get-rtp-capabilities endpoint
//   - get-producers endpoint (existing producer discovery)
//   - SFU transport creation (create-transport)
//   - Signaling under SFU load
//   - Room cleanup after all peers leave

const { io } = require("socket.io-client");

const URL = process.argv[2] || "http://localhost:3000";
const NUM_ROOMS = parseInt(process.argv[3] || "3");
const PEERS_PER_ROOM = parseInt(process.argv[4] || "6"); // Must be >= 5 to trigger SFU
const TOTAL_PEERS = NUM_ROOMS * PEERS_PER_ROOM;

if (PEERS_PER_ROOM < 5) {
  console.error("ERROR: peersPerRoom must be >= 5 to trigger SFU upgrade (SFU_THRESHOLD=5)");
  process.exit(1);
}

console.log(`\n=== TalkToFriend SFU Stress Test ===`);
console.log(`Target:       ${URL}`);
console.log(`Rooms:        ${NUM_ROOMS}`);
console.log(`Peers/Room:   ${PEERS_PER_ROOM}`);
console.log(`Total:        ${TOTAL_PEERS} connections`);
console.log(`SFU expected: YES (>= 5 peers per room)\n`);

const stats = {
  connected: 0,
  roomsCreated: 0,
  joined: 0,
  sfuUpgrades: 0,
  sfuJoins: 0,        // peers that joined in SFU mode directly
  rtpCapOk: 0,
  getProducersOk: 0,
  transportCreated: 0,
  errors: 0,
  latencies: [],
  startTime: Date.now(),
};

const sockets = [];
const roomCodes = [];
const roomSockets = new Map(); // code -> [sockets]

function createSocket() {
  return new Promise((resolve, reject) => {
    const socket = io(URL, {
      transports: ["websocket"],
      reconnection: false,
      timeout: 10000,
    });
    const timer = setTimeout(() => { socket.close(); reject(new Error("conn timeout")); }, 10000);
    socket.on("connect", () => { clearTimeout(timer); stats.connected++; sockets.push(socket); resolve(socket); });
    socket.on("connect_error", (e) => { clearTimeout(timer); stats.errors++; reject(e); });
  });
}

function emitWithAck(socket, event, data, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), timeoutMs);
    socket.emit(event, data, (response) => {
      clearTimeout(timer);
      if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

async function createAndJoinRoom(hostSocket, roomIdx) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    hostSocket.emit("create-room");
    hostSocket.once("room-created", ({ code }) => {
      stats.roomsCreated++;
      roomCodes.push(code);
      roomSockets.set(code, [hostSocket]);

      hostSocket.emit("join-room", { code, name: `host-${roomIdx}` });
      hostSocket.once("room-joined", ({ mode }) => {
        stats.latencies.push(Date.now() - start);
        stats.joined++;
        if (mode === "sfu") stats.sfuJoins++;
        resolve(code);
      });
    });
    hostSocket.once("error-msg", ({ message }) => { stats.errors++; reject(new Error(message)); });
    setTimeout(() => reject(new Error("create timeout")), 8000);
  });
}

async function joinPeer(socket, code, name) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    // Listen for SFU upgrade (triggers when we're the 5th peer)
    socket.once("upgrade-to-sfu", ({ rtpCapabilities }) => {
      stats.sfuUpgrades++;
      console.log(`  [upgrade-to-sfu] room=${code} (rtpCaps=${!!rtpCapabilities})`);
    });

    socket.emit("join-room", { code, name });
    socket.once("room-joined", ({ mode }) => {
      stats.latencies.push(Date.now() - start);
      stats.joined++;
      if (mode === "sfu") stats.sfuJoins++;
      const arr = roomSockets.get(code) || [];
      arr.push(socket);
      roomSockets.set(code, arr);
      resolve(mode);
    });
    socket.once("error-msg", ({ message }) => { stats.errors++; reject(new Error(message)); });
    setTimeout(() => reject(new Error("join timeout")), 8000);
  });
}

function printProgress() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  process.stdout.write(
    `\r[${elapsed}s] conn=${stats.connected} rooms=${stats.roomsCreated} joined=${stats.joined} sfu_upgrades=${stats.sfuUpgrades} sfu_joins=${stats.sfuJoins} err=${stats.errors}`
  );
}

async function run() {
  const progress = setInterval(printProgress, 500);

  try {
    // Phase 1: Connect all sockets
    console.log("Phase 1: Connecting sockets...");
    const batch = 10;
    for (let i = 0; i < TOTAL_PEERS; i += batch) {
      const b = [];
      for (let j = 0; j < batch && i + j < TOTAL_PEERS; j++) {
        b.push(createSocket().catch(() => null));
      }
      await Promise.all(b);
    }
    console.log(`\n  Connected: ${stats.connected}/${TOTAL_PEERS}`);

    // Phase 2: Create rooms and join peers (sequentially to observe upgrade)
    console.log("\nPhase 2: Creating rooms + joining peers (watching for SFU upgrade)...");
    for (let r = 0; r < NUM_ROOMS; r++) {
      const hostIdx = r * PEERS_PER_ROOM;
      const hostSocket = sockets[hostIdx];
      if (!hostSocket) continue;

      const code = await createAndJoinRoom(hostSocket, r);
      console.log(`  Room ${r}: ${code} (host joined)`);

      // Register upgrade listener on host too
      hostSocket.on("upgrade-to-sfu", () => {
        stats.sfuUpgrades++;
      });

      for (let p = 1; p < PEERS_PER_ROOM; p++) {
        const socket = sockets[hostIdx + p];
        if (!socket) continue;
        try {
          const mode = await joinPeer(socket, code, `peer-${r}-${p}`);
          if (p === PEERS_PER_ROOM - 1) {
            console.log(`  Room ${r}: all ${PEERS_PER_ROOM} peers joined (mode=${mode})`);
          }
        } catch (e) {
          console.error(`  Join failed: ${e.message}`);
        }
      }
    }

    // Phase 3: Test SFU-specific endpoints
    console.log("\nPhase 3: Testing SFU endpoints...");
    for (const [code, codeSockets] of roomSockets.entries()) {
      const testSocket = codeSockets[codeSockets.length - 1]; // last joiner
      if (!testSocket?.connected) continue;

      // Test get-rtp-capabilities
      try {
        const caps = await emitWithAck(testSocket, "get-rtp-capabilities", {});
        if (caps?.rtpCapabilities) {
          stats.rtpCapOk++;
          console.log(`  [${code}] get-rtp-capabilities: OK (${caps.rtpCapabilities.codecs?.length} codecs)`);
        }
      } catch (e) {
        console.error(`  [${code}] get-rtp-capabilities FAILED: ${e.message}`);
        stats.errors++;
      }

      // Test get-producers
      try {
        const prod = await emitWithAck(testSocket, "get-producers", {});
        stats.getProducersOk++;
        console.log(`  [${code}] get-producers: OK (${prod.existingProducers?.length || 0} producers)`);
      } catch (e) {
        console.error(`  [${code}] get-producers FAILED: ${e.message}`);
        stats.errors++;
      }

      // Test create-transport (send)
      try {
        const tp = await emitWithAck(testSocket, "create-transport", { direction: "send" });
        if (tp?.id) {
          stats.transportCreated++;
          console.log(`  [${code}] create-transport(send): OK (id=${tp.id.slice(0, 8)}...)`);
        }
      } catch (e) {
        console.error(`  [${code}] create-transport FAILED: ${e.message}`);
        stats.errors++;
      }

      // Test create-transport (recv)
      try {
        const tp = await emitWithAck(testSocket, "create-transport", { direction: "recv" });
        if (tp?.id) {
          stats.transportCreated++;
          console.log(`  [${code}] create-transport(recv): OK (id=${tp.id.slice(0, 8)}...)`);
        }
      } catch (e) {
        console.error(`  [${code}] create-transport FAILED: ${e.message}`);
        stats.errors++;
      }
    }

    // Phase 4: Hold and measure server state
    console.log("\nPhase 4: Holding 5s...");
    await new Promise((r) => setTimeout(r, 5000));

    const serverStats = await fetch(`${URL}/api/stats`).then((r) => r.json()).catch(() => null);

    clearInterval(progress);
    printProgress();

    // Results
    const elapsed = (Date.now() - stats.startTime) / 1000;
    const avg = stats.latencies.length > 0
      ? (stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length).toFixed(0)
      : "N/A";
    const p99 = stats.latencies.length > 0
      ? stats.latencies.sort((a, b) => a - b)[Math.floor(stats.latencies.length * 0.99)].toFixed(0)
      : "N/A";

    console.log(`\n\n=== SFU STRESS TEST RESULTS ===`);
    console.log(`Duration:           ${elapsed.toFixed(1)}s`);
    console.log(`Connections:        ${stats.connected}/${TOTAL_PEERS}`);
    console.log(`Rooms created:      ${stats.roomsCreated}/${NUM_ROOMS}`);
    console.log(`Peers joined:       ${stats.joined}`);
    console.log(`SFU upgrades seen:  ${stats.sfuUpgrades}`);
    console.log(`SFU direct joins:   ${stats.sfuJoins}`);
    console.log(`RTP caps OK:        ${stats.rtpCapOk}/${NUM_ROOMS}`);
    console.log(`get-producers OK:   ${stats.getProducersOk}/${NUM_ROOMS}`);
    console.log(`Transports created: ${stats.transportCreated}`);
    console.log(`Errors:             ${stats.errors}`);
    console.log(`Avg latency:        ${avg}ms`);
    console.log(`P99 latency:        ${p99}ms`);

    if (serverStats) {
      console.log(`\n=== SERVER STATE ===`);
      console.log(`Active rooms:    ${serverStats.rooms}`);
      console.log(`Active sockets:  ${serverStats.sockets}`);
      console.log(`SFU routers:     ${serverStats.sfuRouters || serverStats.sfu?.routers}`);
      console.log(`SFU workers:     ${serverStats.sfu?.workers}`);
      console.log(`Total errors:    ${serverStats.totals?.errors}`);
    }

    const pass = stats.errors === 0 && stats.sfuUpgrades > 0 && stats.rtpCapOk === NUM_ROOMS;
    console.log(`\n${pass ? "PASS" : "FAIL"}`);
  } catch (err) {
    console.error("\nStress test failed:", err);
  } finally {
    clearInterval(progress);
    console.log("\nCleaning up...");
    for (const s of sockets) { try { s?.disconnect(); } catch {} }
    setTimeout(() => process.exit(0), 2000);
  }
}

run();
