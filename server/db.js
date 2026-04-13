// SQLite — using Node's built-in `node:sqlite` (experimental in 22+, 24).
// Requires --experimental-sqlite flag on node startup.

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "talktofriend.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    host_ip TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_code, created_at);
  CREATE INDEX IF NOT EXISTS idx_rooms_activity ON rooms(last_activity);
`);

// Prepared statements
const stmt = {
  insertRoom: db.prepare(
    "INSERT OR IGNORE INTO rooms (code, created_at, last_activity, host_ip) VALUES (?, ?, ?, ?)"
  ),
  touchRoom: db.prepare("UPDATE rooms SET last_activity = ? WHERE code = ?"),
  deleteRoom: db.prepare("DELETE FROM rooms WHERE code = ?"),
  cleanupOld: db.prepare("DELETE FROM rooms WHERE last_activity < ?"),
  getRoom: db.prepare("SELECT * FROM rooms WHERE code = ?"),

  insertMessage: db.prepare(
    "INSERT INTO messages (room_code, author, body, created_at) VALUES (?, ?, ?, ?)"
  ),
  listMessages: db.prepare(
    "SELECT id, author, body, created_at AS createdAt FROM messages WHERE room_code = ? AND id > ? ORDER BY id ASC LIMIT ?"
  ),
  countMessages: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_code = ?"),

  stats: db.prepare(
    "SELECT (SELECT COUNT(*) FROM rooms) AS rooms, (SELECT COUNT(*) FROM messages) AS messages"
  ),
};

const MAX_MESSAGES_PER_ROOM = 1000;

function createRoom(code, hostIp) {
  const now = Date.now();
  stmt.insertRoom.run(code, now, now, hostIp || null);
}

function touchRoom(code) {
  stmt.touchRoom.run(Date.now(), code);
}

function deleteRoom(code) {
  stmt.deleteRoom.run(code);
}

function getRoom(code) {
  return stmt.getRoom.get(code);
}

function addMessage(roomCode, author, body) {
  const count = stmt.countMessages.get(roomCode).n;
  if (count >= MAX_MESSAGES_PER_ROOM) {
    throw new Error(`Chat limit reached (${MAX_MESSAGES_PER_ROOM} messages).`);
  }
  const info = stmt.insertMessage.run(roomCode, author, body, Date.now());
  touchRoom(roomCode);
  return Number(info.lastInsertRowid);
}

function listMessages(roomCode, sinceId = 0, limit = 200) {
  return stmt.listMessages.all(roomCode, sinceId, limit);
}

function cleanup(olderThanMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - olderThanMs;
  const info = stmt.cleanupOld.run(cutoff);
  return info.changes;
}

function stats() {
  return stmt.stats.get();
}

module.exports = {
  db,
  createRoom,
  touchRoom,
  deleteRoom,
  getRoom,
  addMessage,
  listMessages,
  cleanup,
  stats,
  MAX_MESSAGES_PER_ROOM,
};
