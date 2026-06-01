"use strict";

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");

const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

// The single shared password users enter to access the site.
const SITE_PASSWORD = process.env.SITE_PASSWORD || "letmein";
if (!process.env.SITE_PASSWORD) {
  console.warn(
    "[warning] SITE_PASSWORD is not set. Using the insecure default 'letmein'. " +
      "Set SITE_PASSWORD in your environment (or a .env file) before sharing this site."
  );
}

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const ALLOWED_DURATIONS = new Set([3, 7, 10]);
const MAX_OPTIONS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * DAY_MS,
    },
  })
);

// ---- Auth ----------------------------------------------------------------

// Constant-time password comparison to avoid timing leaks.
function passwordMatches(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(SITE_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: "Not authenticated" });
}

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== "string" || !passwordMatches(password)) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  req.session.authed = true;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", (req, res) => {
  res.json({ authed: Boolean(req.session && req.session.authed) });
});

// ---- Helpers -------------------------------------------------------------

function serializePoll(poll, voterKey) {
  const options = db
    .prepare(
      `SELECT o.id, o.label,
              (SELECT COUNT(*) FROM votes v WHERE v.option_id = o.id) AS votes
       FROM options o WHERE o.poll_id = ? ORDER BY o.position ASC`
    )
    .all(poll.id);

  const totalVotes = options.reduce((sum, o) => sum + o.votes, 0);

  const myVote = db
    .prepare("SELECT option_id FROM votes WHERE poll_id = ? AND voter_key = ?")
    .get(poll.id, voterKey);

  return {
    id: poll.id,
    question: poll.question,
    createdAt: poll.created_at,
    expiresAt: poll.expires_at,
    closed: Date.now() >= poll.expires_at,
    totalVotes,
    votedOptionId: myVote ? myVote.option_id : null,
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      votes: o.votes,
    })),
  };
}

// A per-session identifier used to enforce one vote per browser session.
function voterKeyFor(req) {
  return req.sessionID;
}

// ---- Poll API ------------------------------------------------------------

app.get("/api/polls", requireAuth, (req, res) => {
  const polls = db.prepare("SELECT * FROM polls ORDER BY created_at DESC").all();
  const voterKey = voterKeyFor(req);
  res.json(polls.map((p) => serializePoll(p, voterKey)));
});

app.get("/api/polls/:id", requireAuth, (req, res) => {
  const poll = db.prepare("SELECT * FROM polls WHERE id = ?").get(req.params.id);
  if (!poll) return res.status(404).json({ error: "Poll not found" });
  res.json(serializePoll(poll, voterKeyFor(req)));
});

app.post("/api/polls", requireAuth, (req, res) => {
  const { question, options, durationDays } = req.body || {};

  if (typeof question !== "string" || question.trim().length === 0) {
    return res.status(400).json({ error: "A question is required" });
  }
  if (question.trim().length > 280) {
    return res.status(400).json({ error: "Question must be 280 characters or fewer" });
  }

  const days = Number(durationDays);
  if (!ALLOWED_DURATIONS.has(days)) {
    return res.status(400).json({ error: "Duration must be 3, 7, or 10 days" });
  }

  if (!Array.isArray(options)) {
    return res.status(400).json({ error: "Options must be a list" });
  }
  const cleaned = options
    .map((o) => (typeof o === "string" ? o.trim() : ""))
    .filter((o) => o.length > 0);

  if (cleaned.length < 2) {
    return res.status(400).json({ error: "Provide at least 2 options" });
  }
  if (cleaned.length > MAX_OPTIONS) {
    return res.status(400).json({ error: `Provide at most ${MAX_OPTIONS} options` });
  }
  if (cleaned.some((o) => o.length > 200)) {
    return res.status(400).json({ error: "Each option must be 200 characters or fewer" });
  }

  const id = crypto.randomBytes(9).toString("base64url");
  const now = Date.now();
  const expiresAt = now + days * DAY_MS;

  const insertPoll = db.prepare(
    "INSERT INTO polls (id, question, created_at, expires_at) VALUES (?, ?, ?, ?)"
  );
  const insertOption = db.prepare(
    "INSERT INTO options (poll_id, label, position) VALUES (?, ?, ?)"
  );

  const tx = db.transaction(() => {
    insertPoll.run(id, question.trim(), now, expiresAt);
    cleaned.forEach((label, idx) => insertOption.run(id, label, idx));
  });
  tx();

  const poll = db.prepare("SELECT * FROM polls WHERE id = ?").get(id);
  res.status(201).json(serializePoll(poll, voterKeyFor(req)));
});

app.post("/api/polls/:id/vote", requireAuth, (req, res) => {
  const poll = db.prepare("SELECT * FROM polls WHERE id = ?").get(req.params.id);
  if (!poll) return res.status(404).json({ error: "Poll not found" });

  if (Date.now() >= poll.expires_at) {
    return res.status(403).json({ error: "Voting has closed for this poll" });
  }

  const optionId = Number((req.body || {}).optionId);
  const option = db
    .prepare("SELECT * FROM options WHERE id = ? AND poll_id = ?")
    .get(optionId, poll.id);
  if (!option) {
    return res.status(400).json({ error: "Invalid option" });
  }

  const voterKey = voterKeyFor(req);
  const existing = db
    .prepare("SELECT id FROM votes WHERE poll_id = ? AND voter_key = ?")
    .get(poll.id, voterKey);
  if (existing) {
    return res.status(409).json({ error: "You have already voted on this poll" });
  }

  try {
    db.prepare(
      "INSERT INTO votes (poll_id, option_id, voter_key, created_at) VALUES (?, ?, ?, ?)"
    ).run(poll.id, optionId, voterKey, Date.now());
  } catch (err) {
    // UNIQUE constraint race — treat as already voted.
    return res.status(409).json({ error: "You have already voted on this poll" });
  }

  res.json(serializePoll(poll, voterKey));
});

// ---- Static frontend -----------------------------------------------------

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Voting site running at http://localhost:${PORT}`);
});
