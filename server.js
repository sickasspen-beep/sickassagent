"use strict";

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const cookieParser = require("cookie-parser");

const db = require("./db");
const sleeper = require("./sleeper");

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

// Behind a reverse proxy / load balancer (Render, Fly, Heroku, nginx…), trust
// the X-Forwarded-* headers so secure cookies are set over the proxied HTTPS.
if (IS_PROD) app.set("trust proxy", 1);

if (!sleeper.isConfigured()) {
  console.warn(
    "[warning] SLEEPER_LEAGUE_ID is not set. Voting requires it so members can be " +
      "verified against your Sleeper league. Set SLEEPER_LEAGUE_ID in your environment " +
      "(find it in your league URL: sleeper.com/leagues/<LEAGUE_ID>/...)."
  );
}

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET && IS_PROD) {
  console.warn(
    "[warning] SESSION_SECRET is not set. A random one is being generated, which " +
      "logs everyone out on restart and breaks multi-instance deployments. Set a " +
      "fixed SESSION_SECRET in production."
  );
}

const ALLOWED_DURATIONS = new Set([3, 7, 10]);
const MAX_OPTIONS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use(
  session({
    store: new SqliteStore({
      client: db,
      // Periodically purge expired sessions from the database.
      expired: { clear: true, intervalMs: 24 * 60 * 60 * 1000 },
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD,
      maxAge: 30 * DAY_MS,
    },
  })
);

// ---- Auth ----------------------------------------------------------------
// There is no shared password. People log in with their Sleeper username, which
// we verify against the configured league. The resulting league identity (team
// name + Sleeper user_id) is stored in the session and used as the voter.

function requireAuth(req, res, next) {
  if (req.session && req.session.voter) return next();
  return res.status(401).json({ error: "Not logged in" });
}

app.post("/api/login", async (req, res) => {
  let voter;
  try {
    voter = await sleeper.resolveVoter((req.body || {}).username);
  } catch (e) {
    return res.status(sleeper.statusForCode(e.code)).json({ error: e.message });
  }
  req.session.voter = {
    userId: voter.userId,
    teamName: voter.teamName,
    displayName: voter.displayName,
  };
  res.json({ teamName: voter.teamName, displayName: voter.displayName });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", (req, res) => {
  const voter = req.session && req.session.voter;
  if (!voter) return res.json({ authed: false });
  res.json({
    authed: true,
    teamName: voter.teamName,
    displayName: voter.displayName,
  });
});

// ---- Helpers -------------------------------------------------------------

// `voterUserId` is the viewer's Sleeper user_id (or null), used to flag their own vote.
function serializePoll(poll, voterUserId) {
  const options = db
    .prepare(
      `SELECT o.id, o.label,
              (SELECT COUNT(*) FROM votes v WHERE v.option_id = o.id) AS votes
       FROM options o WHERE o.poll_id = ? ORDER BY o.position ASC`
    )
    .all(poll.id);

  // Team names per option, in voting order, so results show who voted for what.
  const voterRows = db
    .prepare(
      "SELECT option_id, team_name FROM votes WHERE poll_id = ? ORDER BY created_at ASC"
    )
    .all(poll.id);
  const teamsByOption = new Map();
  for (const row of voterRows) {
    if (!teamsByOption.has(row.option_id)) teamsByOption.set(row.option_id, []);
    teamsByOption.get(row.option_id).push(row.team_name);
  }

  const totalVotes = options.reduce((sum, o) => sum + o.votes, 0);

  let votedOptionId = null;
  if (voterUserId) {
    const myVote = db
      .prepare("SELECT option_id FROM votes WHERE poll_id = ? AND voter_key = ?")
      .get(poll.id, voterUserId);
    if (myVote) votedOptionId = myVote.option_id;
  }

  return {
    id: poll.id,
    question: poll.question,
    createdAt: poll.created_at,
    expiresAt: poll.expires_at,
    closed: Date.now() >= poll.expires_at,
    totalVotes,
    votedOptionId,
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      votes: o.votes,
      teams: teamsByOption.get(o.id) || [],
    })),
  };
}

// The logged-in voter for this request (set at login).
function currentVoter(req) {
  return req.session.voter;
}

// ---- Poll API ------------------------------------------------------------

app.get("/api/polls", requireAuth, (req, res) => {
  const polls = db.prepare("SELECT * FROM polls ORDER BY created_at DESC").all();
  const userId = currentVoter(req).userId;
  res.json(polls.map((p) => serializePoll(p, userId)));
});

app.get("/api/polls/:id", requireAuth, (req, res) => {
  const poll = db.prepare("SELECT * FROM polls WHERE id = ?").get(req.params.id);
  if (!poll) return res.status(404).json({ error: "Poll not found" });
  res.json(serializePoll(poll, currentVoter(req).userId));
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
  res.status(201).json(serializePoll(poll, null));
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

  // The voter is the logged-in Sleeper identity from the session.
  const voter = currentVoter(req);

  const existing = db
    .prepare("SELECT option_id FROM votes WHERE poll_id = ? AND voter_key = ?")
    .get(poll.id, voter.userId);
  if (existing) {
    return res.status(409).json({
      error: `${voter.teamName} has already voted on this poll`,
      votedOptionId: existing.option_id,
    });
  }

  try {
    db.prepare(
      `INSERT INTO votes (poll_id, option_id, voter_key, team_name, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(poll.id, optionId, voter.userId, voter.teamName, voter.displayName, Date.now());
  } catch (err) {
    // UNIQUE constraint race — treat as already voted.
    return res
      .status(409)
      .json({ error: `${voter.teamName} has already voted on this poll` });
  }

  const result = serializePoll(poll, voter.userId);
  result.votedAs = voter.teamName;
  res.json(result);
});

// Health check for load balancers / uptime monitors.
app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---- Static frontend -----------------------------------------------------

app.use(express.static(path.join(__dirname, "public")));

const server = app.listen(PORT, () => {
  console.log(`Voting site running on port ${PORT}`);
});

// Graceful shutdown so the database closes cleanly.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => {
      try {
        db.close();
      } catch (_) {
        /* already closed */
      }
      process.exit(0);
    });
  });
}
