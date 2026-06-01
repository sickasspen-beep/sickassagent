"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "voting.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS polls (
    id          TEXT PRIMARY KEY,
    question    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS options (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id   TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    label     TEXT NOT NULL,
    position  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS votes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id    TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id  INTEGER NOT NULL REFERENCES options(id) ON DELETE CASCADE,
    voter_key  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (poll_id, voter_key)
  );

  CREATE INDEX IF NOT EXISTS idx_options_poll ON options(poll_id);
  CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes(poll_id);
`);

module.exports = db;
