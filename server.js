"use strict";

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieSession = require("cookie-session");

const { db, initDb, usingTurso } = require("./db");
const sleeper = require("./sleeper");

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === "production";

// Behind a reverse proxy / load balancer (Render, Fly, Heroku, nginx…), trust
// the X-Forwarded-* headers so secure cookies are set over the proxied HTTPS.
if (IS_PROD) app.set("trust proxy", 1);

if (IS_PROD && !usingTurso) {
  console.warn(
    "[warning] TURSO_DATABASE_URL is not set, so data is stored on the local disk. " +
      "On hosts without a persistent disk this is wiped on restart. Set TURSO_DATABASE_URL " +
      "(+ TURSO_AUTH_TOKEN) to keep polls and votes."
  );
}

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET && IS_PROD) {
  console.warn(
    "[warning] SESSION_SECRET is not set. A random one is being generated, which " +
      "logs everyone out on restart. Set a fixed SESSION_SECRET in production."
  );
}

const ALLOWED_DURATIONS = new Set([3, 7, 10]);
const MAX_OPTIONS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

app.use(express.json({ limit: "64kb" }));

// Stateless, signed cookie session — no server-side session store needed.
app.use(
  cookieSession({
    name: "votebox",
    keys: [SESSION_SECRET],
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    maxAge: 30 * DAY_MS,
  })
);

// Wrap async route handlers so rejected promises reach the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Small DB helpers ----------------------------------------------------
async function get(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows[0] || null;
}
async function all(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows;
}
async function run(sql, args = []) {
  return db.execute({ sql, args });
}

// ---- Auth ----------------------------------------------------------------
// There is no shared password. People log in with their Sleeper username, which
// we verify against the configured league. The resulting league identity (team
// name + Sleeper user_id) is stored in the signed session cookie and used as the
// voter.

function requireAuth(req, res, next) {
  if (req.session && req.session.voter) return next();
  return res.status(401).json({ error: "Not logged in" });
}

function currentVoter(req) {
  return req.session.voter;
}

app.post(
  "/api/login",
  wrap(async (req, res) => {
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
  })
);

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  const voter = req.session && req.session.voter;
  if (!voter) return res.json({ authed: false });
  res.json({ authed: true, teamName: voter.teamName, displayName: voter.displayName });
});

// ---- Helpers -------------------------------------------------------------

// `voterUserId` is the viewer's Sleeper user_id (or null), used to flag their own vote.
async function serializePoll(poll, voterUserId) {
  const options = await all(
    `SELECT o.id, o.label,
            (SELECT COUNT(*) FROM votes v WHERE v.option_id = o.id) AS votes
     FROM options o WHERE o.poll_id = ? ORDER BY o.position ASC`,
    [poll.id]
  );

  // Team names per option, in voting order, so results show who voted for what.
  const voterRows = await all(
    "SELECT option_id, team_name FROM votes WHERE poll_id = ? ORDER BY created_at ASC",
    [poll.id]
  );
  const teamsByOption = new Map();
  for (const row of voterRows) {
    const oid = Number(row.option_id);
    if (!teamsByOption.has(oid)) teamsByOption.set(oid, []);
    teamsByOption.get(oid).push(row.team_name);
  }

  const opts = options.map((o) => ({
    id: Number(o.id),
    label: o.label,
    votes: Number(o.votes),
  }));
  const totalVotes = opts.reduce((sum, o) => sum + o.votes, 0);

  let votedOptionId = null;
  if (voterUserId) {
    const myVote = await get(
      "SELECT option_id FROM votes WHERE poll_id = ? AND voter_key = ?",
      [poll.id, voterUserId]
    );
    if (myVote) votedOptionId = Number(myVote.option_id);
  }

  return {
    id: poll.id,
    question: poll.question,
    createdAt: Number(poll.created_at),
    expiresAt: Number(poll.expires_at),
    closed: Date.now() >= Number(poll.expires_at),
    totalVotes,
    votedOptionId,
    options: opts.map((o) => ({ ...o, teams: teamsByOption.get(o.id) || [] })),
  };
}

// ---- Poll API ------------------------------------------------------------

app.get(
  "/api/polls",
  requireAuth,
  wrap(async (req, res) => {
    const polls = await all("SELECT * FROM polls ORDER BY created_at DESC");
    const userId = currentVoter(req).userId;
    res.json(await Promise.all(polls.map((p) => serializePoll(p, userId))));
  })
);

app.get(
  "/api/polls/:id",
  requireAuth,
  wrap(async (req, res) => {
    const poll = await get("SELECT * FROM polls WHERE id = ?", [req.params.id]);
    if (!poll) return res.status(404).json({ error: "Poll not found" });
    res.json(await serializePoll(poll, currentVoter(req).userId));
  })
);

app.post(
  "/api/polls",
  requireAuth,
  wrap(async (req, res) => {
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

    await db.batch(
      [
        {
          sql: "INSERT INTO polls (id, question, created_at, expires_at) VALUES (?, ?, ?, ?)",
          args: [id, question.trim(), now, expiresAt],
        },
        ...cleaned.map((label, idx) => ({
          sql: "INSERT INTO options (poll_id, label, position) VALUES (?, ?, ?)",
          args: [id, label, idx],
        })),
      ],
      "write"
    );

    const poll = await get("SELECT * FROM polls WHERE id = ?", [id]);
    res.status(201).json(await serializePoll(poll, null));
  })
);

app.post(
  "/api/polls/:id/vote",
  requireAuth,
  wrap(async (req, res) => {
    const poll = await get("SELECT * FROM polls WHERE id = ?", [req.params.id]);
    if (!poll) return res.status(404).json({ error: "Poll not found" });

    if (Date.now() >= Number(poll.expires_at)) {
      return res.status(403).json({ error: "Voting has closed for this poll" });
    }

    const optionId = Number((req.body || {}).optionId);
    const option = await get("SELECT id FROM options WHERE id = ? AND poll_id = ?", [
      optionId,
      poll.id,
    ]);
    if (!option) {
      return res.status(400).json({ error: "Invalid option" });
    }

    // The voter is the logged-in Sleeper identity from the session.
    const voter = currentVoter(req);

    const existing = await get(
      "SELECT option_id FROM votes WHERE poll_id = ? AND voter_key = ?",
      [poll.id, voter.userId]
    );
    if (existing) {
      return res.status(409).json({
        error: `${voter.teamName} has already voted on this poll`,
        votedOptionId: Number(existing.option_id),
      });
    }

    try {
      await run(
        `INSERT INTO votes (poll_id, option_id, voter_key, team_name, display_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [poll.id, optionId, voter.userId, voter.teamName, voter.displayName || null, Date.now()]
      );
    } catch (err) {
      // UNIQUE constraint race — treat as already voted.
      return res
        .status(409)
        .json({ error: `${voter.teamName} has already voted on this poll` });
    }

    const result = await serializePoll(poll, voter.userId);
    result.votedAs = voter.teamName;
    res.json(result);
  })
);

// Health check for load balancers / uptime monitors.
app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---- Static frontend -----------------------------------------------------

app.use(express.static(path.join(__dirname, "public")));

// Error handler for anything thrown in async routes.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status === 400 ? "Invalid request body" : "Server error",
  });
});

// ---- Boot ----------------------------------------------------------------
(async () => {
  try {
    await initDb();
  } catch (e) {
    console.error("Failed to initialize the database:", e.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Voting site running on port ${PORT}`);
  });
})();
