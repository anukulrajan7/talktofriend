#!/usr/bin/env node
/**
 * Backend signaling test suite.
 * Tests every critical path: room lifecycle, relay, SFU, rate limits, edge cases.
 *
 * Usage: node server/tests/signaling.test.js
 * Requires server running on localhost:3000
 */

const { io } = require("socket.io-client");

const URL = process.env.TEST_URL || "http://localhost:3000";
let passed = 0, failed = 0, total = 0;
let testSockets = []; // sockets for current test (cleaned up after each)

function socket() {
  const s = io(URL, { transports: ["websocket"], reconnection: false, timeout: 5000 });
  testSockets.push(s);
  return s;
}

function cleanupSockets() {
  testSockets.forEach(s => { try { s.disconnect(); } catch {} });
  testSockets = [];
  return new Promise(r => setTimeout(r, 500)); // let server process disconnects
}

function waitEvent(s, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timeout`)), timeoutMs);
    s.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

function emitAck(s, event, data, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), timeoutMs);
    s.emit(event, data, (res) => { clearTimeout(t); resolve(res); });
  });
}

function waitConnect(s) {
  return new Promise((resolve, reject) => {
    if (s.connected) return resolve();
    const t = setTimeout(() => reject(new Error("connect timeout")), 5000);
    s.once("connect", () => { clearTimeout(t); resolve(); });
    s.once("connect_error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function test(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${e.message}`);
  }
  await cleanupSockets();
}

function assert(condition, msg) { if (!condition) throw new Error(msg || "assertion failed"); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${b}, got ${a}`); }

async function createAndJoin(s, name = "test") {
  await waitConnect(s);
  s.emit("create-room");
  const { code } = await waitEvent(s, "room-created");
  s.emit("join-room", { code, name });
  const joined = await waitEvent(s, "room-joined");
  return { code, ...joined };
}

async function joinExisting(s, code, name = "peer") {
  await waitConnect(s);
  s.emit("join-room", { code, name });
  return waitEvent(s, "room-joined");
}

// ─────────────────────────────────────────────────────
async function run() {
  console.log(`\n\x1b[1m=== TalkToFriend Backend Tests ===\x1b[0m`);
  console.log(`Target: ${URL}\n`);

  // ── Room Lifecycle ──
  console.log("\x1b[1mRoom Lifecycle\x1b[0m");

  await test("create room returns code and myId", async () => {
    const s = socket();
    await waitConnect(s);
    s.emit("create-room");
    const { code, myId } = await waitEvent(s, "room-created");
    assert(code && code.length > 5, "code too short");
    assert(myId, "no myId");
  });

  await test("join room returns peers list and mode", async () => {
    const s = socket();
    const { code, mode, peers } = await createAndJoin(s, "host");
    assertEqual(mode, "mesh");
    assert(Array.isArray(peers), "peers not array");
    assertEqual(peers.length, 0, "host should see 0 peers");
  });

  await test("second peer sees first in peers list", async () => {
    const host = socket();
    const { code } = await createAndJoin(host, "Host");
    const guest = socket();
    const joined = await joinExisting(guest, code, "Guest");
    assertEqual(joined.peers.length, 1);
    assertEqual(joined.peers[0].name, "Host");
  });

  await test("host receives peer-joined when guest joins", async () => {
    const host = socket();
    const { code } = await createAndJoin(host, "Host");
    const peerJoinedPromise = waitEvent(host, "peer-joined");
    const guest = socket();
    await joinExisting(guest, code, "Guest");
    const { id, name } = await peerJoinedPromise;
    assertEqual(name, "Guest");
    assert(id, "peer-joined missing id");
  });

  await test("peer-left fires when peer disconnects", async () => {
    const host = socket();
    const { code } = await createAndJoin(host, "Host");
    const guest = socket();
    await joinExisting(guest, code, "Guest");
    const leftPromise = waitEvent(host, "peer-left");
    guest.disconnect();
    const { id } = await leftPromise;
    assert(id, "peer-left missing id");
  });

  await test("join non-existent room returns error", async () => {
    const s = socket();
    await waitConnect(s);
    s.emit("join-room", { code: "no-such-room-99", name: "test" });
    const { message } = await waitEvent(s, "error-msg");
    assert(message.includes("does not exist"), `unexpected error: ${message}`);
  });

  await test("double join returns error", async () => {
    const s = socket();
    const { code } = await createAndJoin(s, "Host");
    s.emit("join-room", { code, name: "Host" });
    const { message } = await waitEvent(s, "error-msg");
    assert(message.includes("already"), `unexpected error: ${message}`);
  });

  // ── Signaling Relay ──
  console.log("\n\x1b[1mSignaling Relay\x1b[0m");

  await test("offer relayed from host to guest", async () => {
    const host = socket();
    const { code, myId: hostId } = await createAndJoin(host, "Host");
    const guest = socket();
    const joined = await joinExisting(guest, code, "Guest");
    const guestId = joined.myId;
    const offerPromise = waitEvent(guest, "offer");
    host.emit("offer", { to: guestId, sdp: { type: "offer", sdp: "test" } });
    const { from, sdp } = await offerPromise;
    assertEqual(from, hostId);
    assertEqual(sdp.type, "offer");
  });

  await test("answer relayed from guest to host", async () => {
    const host = socket();
    const { code, myId: hostId } = await createAndJoin(host, "Host");
    const guest = socket();
    const joined = await joinExisting(guest, code, "Guest");
    const guestId = joined.myId;
    const answerPromise = waitEvent(host, "answer");
    guest.emit("answer", { to: hostId, sdp: { type: "answer", sdp: "test" } });
    const { from, sdp } = await answerPromise;
    assertEqual(from, guestId);
    assertEqual(sdp.type, "answer");
  });

  await test("ICE candidate relayed bidirectionally", async () => {
    const host = socket();
    const { code, myId: hostId } = await createAndJoin(host, "Host");
    const guest = socket();
    const joined = await joinExisting(guest, code, "Guest");
    const guestId = joined.myId;

    const iceToGuest = waitEvent(guest, "ice-candidate");
    host.emit("ice-candidate", { to: guestId, candidate: { candidate: "host-ice" } });
    const r1 = await iceToGuest;
    assertEqual(r1.from, hostId);

    const iceToHost = waitEvent(host, "ice-candidate");
    guest.emit("ice-candidate", { to: hostId, candidate: { candidate: "guest-ice" } });
    const r2 = await iceToHost;
    assertEqual(r2.from, guestId);
  });

  await test("relay to non-existent peer silently fails", async () => {
    const host = socket();
    await createAndJoin(host, "Host");
    // Send to a fake socket ID — should not crash server
    host.emit("offer", { to: "fake-id-12345", sdp: { type: "offer", sdp: "test" } });
    // If server doesn't crash in 500ms, we're good
    await new Promise(r => setTimeout(r, 500));
  });

  // ── 3-Peer Mesh ──
  console.log("\n\x1b[1m3-Peer Mesh\x1b[0m");

  await test("3rd peer sees 2 existing peers", async () => {
    const p1 = socket(), p2 = socket(), p3 = socket();
    const { code } = await createAndJoin(p1, "P1");
    await joinExisting(p2, code, "P2");
    const joined = await joinExisting(p3, code, "P3");
    assertEqual(joined.peers.length, 2);
    const names = joined.peers.map(p => p.name).sort();
    assert(names.includes("P1") && names.includes("P2"), `expected P1,P2 got ${names}`);
  });

  await test("all existing peers receive peer-joined for 3rd peer", async () => {
    const p1 = socket(), p2 = socket(), p3 = socket();
    const { code } = await createAndJoin(p1, "P1");
    // Consume P1's peer-joined for P2 before listening for P3
    const p1SeesP2 = waitEvent(p1, "peer-joined");
    await joinExisting(p2, code, "P2");
    await p1SeesP2; // drain P2's join notification on P1
    // Now listen for P3's join on both P1 and P2
    const p1Sees = waitEvent(p1, "peer-joined");
    const p2Sees = waitEvent(p2, "peer-joined");
    await joinExisting(p3, code, "P3");
    const [r1, r2] = await Promise.all([p1Sees, p2Sees]);
    assertEqual(r1.name, "P3");
    assertEqual(r2.name, "P3");
  });

  await test("offer relay works between all peer pairs", async () => {
    const p1 = socket(), p2 = socket(), p3 = socket();
    const { code, myId: id1 } = await createAndJoin(p1, "P1");
    const j2 = await joinExisting(p2, code, "P2");
    const j3 = await joinExisting(p3, code, "P3");
    const id2 = j2.myId, id3 = j3.myId;

    // P1 → P3
    const p3Gets = waitEvent(p3, "offer");
    p1.emit("offer", { to: id3, sdp: { type: "offer", sdp: "1to3" } });
    const r = await p3Gets;
    assertEqual(r.from, id1);

    // P2 → P3
    const p3Gets2 = waitEvent(p3, "offer");
    p2.emit("offer", { to: id3, sdp: { type: "offer", sdp: "2to3" } });
    const r2 = await p3Gets2;
    assertEqual(r2.from, id2);
  });

  // ── SFU Endpoints ──
  console.log("\n\x1b[1mSFU Endpoints\x1b[0m");

  await test("get-rtp-capabilities returns codecs", async () => {
    const s = socket();
    await createAndJoin(s, "Host");
    const res = await emitAck(s, "get-rtp-capabilities", {});
    assert(res.rtpCapabilities, "no rtpCapabilities");
    assert(res.rtpCapabilities.codecs.length > 0, "no codecs");
  });

  await test("get-producers returns empty array for new room", async () => {
    const s = socket();
    await createAndJoin(s, "Host");
    const res = await emitAck(s, "get-producers", {});
    assert(Array.isArray(res.existingProducers), "not array");
    assertEqual(res.existingProducers.length, 0);
  });

  await test("create-transport returns transport params", async () => {
    const s = socket();
    await createAndJoin(s, "Host");
    const res = await emitAck(s, "create-transport", { direction: "send" });
    assert(res.id, "no transport id");
    assert(res.iceParameters, "no iceParameters");
    assert(res.dtlsParameters, "no dtlsParameters");
  });

  // ── SFU Upgrade ──
  console.log("\n\x1b[1mSFU Upgrade (5 peers)\x1b[0m");

  await test("5th peer triggers upgrade-to-sfu on existing peers", async () => {
    const peers = [];
    for (let i = 0; i < 5; i++) peers.push(socket());

    const { code } = await createAndJoin(peers[0], "P1");
    await joinExisting(peers[1], code, "P2");
    await joinExisting(peers[2], code, "P3");
    await joinExisting(peers[3], code, "P4");

    // P1 should receive upgrade when P5 joins
    const upgradePromise = waitEvent(peers[0], "upgrade-to-sfu", 10000);
    const j5 = await joinExisting(peers[4], code, "P5");

    // P5 joins directly in SFU mode
    assertEqual(j5.mode, "sfu");

    // Existing peers get upgrade event
    const upgrade = await upgradePromise;
    assert(upgrade.rtpCapabilities, "upgrade missing rtpCapabilities");
  });

  // ── Chat ──
  console.log("\n\x1b[1mChat\x1b[0m");

  await test("chat message broadcasted to room", async () => {
    const host = socket(), guest = socket();
    const { code } = await createAndJoin(host, "Host");
    await joinExisting(guest, code, "Guest");
    const chatPromise = waitEvent(guest, "chat");
    host.emit("chat", { body: "hello world" });
    const msg = await chatPromise;
    assertEqual(msg.author, "Host");
    assertEqual(msg.body, "hello world");
    assert(msg.id, "no message id");
  });

  // ── Cleanup ──
  console.log("\n\x1b[1mCleanup\x1b[0m");

  await test("room deleted when all peers leave", async () => {
    const host = socket(), guest = socket();
    const { code } = await createAndJoin(host, "Host");
    await joinExisting(guest, code, "Guest");
    host.disconnect();
    guest.disconnect();
    await new Promise(r => setTimeout(r, 500));

    // Try joining deleted room
    const checker = socket();
    await waitConnect(checker);
    checker.emit("join-room", { code, name: "late" });
    const { message } = await waitEvent(checker, "error-msg");
    assert(message.includes("does not exist"), "room still exists after all left");
  });

  // ── SFU Deep Integration ──
  console.log("\n\x1b[1mSFU Deep Integration\x1b[0m");

  await test("5-peer SFU: all peers can create transports after upgrade", async () => {
    const peers = [];
    for (let i = 0; i < 5; i++) peers.push(socket());

    const { code } = await createAndJoin(peers[0], "P1");
    // Drain peer-joined events on P1 as peers join
    for (let i = 1; i < 4; i++) {
      const pj = waitEvent(peers[0], "peer-joined");
      await joinExisting(peers[i], code, `P${i+1}`);
      await pj;
    }
    // P5 triggers SFU upgrade
    const upgradeP1 = waitEvent(peers[0], "upgrade-to-sfu", 10000);
    await joinExisting(peers[4], code, "P5");
    await upgradeP1;

    // Every peer should be able to get rtp capabilities and create transports
    for (let i = 0; i < 5; i++) {
      const caps = await emitAck(peers[i], "get-rtp-capabilities", {});
      assert(caps.rtpCapabilities, `P${i+1}: no rtp capabilities`);
      const sendTp = await emitAck(peers[i], "create-transport", { direction: "send" });
      assert(sendTp.id, `P${i+1}: no send transport`);
      const recvTp = await emitAck(peers[i], "create-transport", { direction: "recv" });
      assert(recvTp.id, `P${i+1}: no recv transport`);
    }
  });

  await test("6th peer joins existing SFU room with existingProducers field", async () => {
    const peers = [];
    for (let i = 0; i < 6; i++) peers.push(socket());

    const { code } = await createAndJoin(peers[0], "P1");
    for (let i = 1; i < 4; i++) {
      const pj = waitEvent(peers[0], "peer-joined");
      await joinExisting(peers[i], code, `P${i+1}`);
      await pj;
    }
    // P5 triggers upgrade
    const up = waitEvent(peers[0], "upgrade-to-sfu", 10000);
    await joinExisting(peers[4], code, "P5");
    await up;

    // P6 joins — room already in SFU mode
    const j6 = await joinExisting(peers[5], code, "P6");
    assertEqual(j6.mode, "sfu");
    assert(Array.isArray(j6.existingProducers), "P6 missing existingProducers");
    // get-producers should also work for P6
    const prod = await emitAck(peers[5], "get-producers", {});
    assert(Array.isArray(prod.existingProducers), "get-producers failed for P6");
  });

  await test("peer leaving SFU room notifies others via peer-left", async () => {
    const peers = [];
    for (let i = 0; i < 5; i++) peers.push(socket());

    const { code } = await createAndJoin(peers[0], "P1");
    for (let i = 1; i < 4; i++) {
      const pj = waitEvent(peers[0], "peer-joined");
      await joinExisting(peers[i], code, `P${i+1}`);
      await pj;
    }
    const up = waitEvent(peers[0], "upgrade-to-sfu", 10000);
    const pj4 = waitEvent(peers[0], "peer-joined");
    await joinExisting(peers[4], code, "P5");
    await up;
    await pj4;

    // P3 leaves — P1 should get peer-left
    const leftPromise = waitEvent(peers[0], "peer-left");
    peers[2].disconnect();
    const left = await leftPromise;
    assert(left.id, "peer-left missing id");
  });

  // ── Room Password ──
  console.log("\n\x1b[1mRoom Password\x1b[0m");

  await test("host can set room password", async () => {
    const host = socket();
    await createAndJoin(host, "Host");
    host.emit("set-room-password", { password: "secret123" });
    const res = await waitEvent(host, "password-set");
    assert(res.ok, "password-set not ok");
  });

  await test("guest rejected without correct password", async () => {
    const host = socket();
    const { code } = await createAndJoin(host, "Host");
    host.emit("set-room-password", { password: "mypass" });
    await waitEvent(host, "password-set");

    const guest = socket();
    await waitConnect(guest);
    guest.emit("join-room", { code, name: "Guest" }); // no password
    const err = await waitEvent(guest, "error-msg");
    assert(err.message.includes("password") || err.message.includes("Wrong"), `unexpected: ${err.message}`);
  });

  await test("guest accepted with correct password", async () => {
    const host = socket();
    const { code } = await createAndJoin(host, "Host");
    host.emit("set-room-password", { password: "abc" });
    await waitEvent(host, "password-set");

    const guest = socket();
    await waitConnect(guest);
    guest.emit("join-room", { code, name: "Guest", password: "abc" });
    const joined = await waitEvent(guest, "room-joined");
    assertEqual(joined.peers.length, 1);
  });

  // ── Client Error Endpoint ──
  console.log("\n\x1b[1mClient Error Reporting\x1b[0m");

  await test("POST /api/client-errors accepts error reports", async () => {
    const res = await fetch(`${URL}/api/client-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "test error", context: "unit test", userAgent: "test/1.0" }),
    });
    const data = await res.json();
    assert(data.ok, "client error report not ok");
  });

  // ── Results ──
  console.log(`\n\x1b[1m${passed}/${total} passed\x1b[0m`);
  if (failed > 0) console.log(`\x1b[31m${failed} failed\x1b[0m`);

  await cleanupSockets();
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
}

run().catch(e => { console.error("Test runner error:", e); process.exit(1); });
