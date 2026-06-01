"use strict";

const path = require("path");
const fs = require("fs");
const { createClient } = require("@libsql/client");

// In production, point at a Turso database via TURSO_DATABASE_URL (+ token).
// Locally (no env set), fall back to an on-disk SQLite file so dev still works.
const TURSO_URL = (process.env.TURSO_DATABASE_URL || "").trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || "").trim();

let url;
if (TURSO_URL) {
  url = TURSO_URL;
} else {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  url = "file:" + path.join(DATA_DIR, "voting.db");
}

const db = createClient(TURSO_TOKEN ? { url, authToken: TURSO_TOKEN } : { url });

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS polls (
     id          TEXT PRIMARY KEY,
     question    TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     expires_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS options (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     poll_id   TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
     label     TEXT NOT NULL,
     position  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS votes (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     poll_id      TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
     option_id    INTEGER NOT NULL REFERENCES options(id) ON DELETE CASCADE,
     voter_key    TEXT NOT NULL,
     team_name    TEXT NOT NULL,
     display_name TEXT,
     created_at   INTEGER NOT NULL,
     UNIQUE (poll_id, voter_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_options_poll ON options(poll_id)`,
  `CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes(poll_id)`,
];

async function initDb() {
  for (const stmt of SCHEMA) {
    await db.execute(stmt);
  }
}

module.exports = { db, initDb, usingTurso: Boolean(TURSO_URL) };
