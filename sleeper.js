"use strict";

// Thin wrapper around Sleeper's public read-only API.
// Docs: https://docs.sleeper.com/  (no auth required for these endpoints)

const API = process.env.SLEEPER_API_BASE || "https://api.sleeper.app/v1";
// Defaults to the configured league; override with SLEEPER_LEAGUE_ID if needed.
const DEFAULT_LEAGUE_ID = "1365139935241191424";
const LEAGUE_ID = (process.env.SLEEPER_LEAGUE_ID || DEFAULT_LEAGUE_ID).trim();
const TTL_MS = Number(process.env.SLEEPER_CACHE_TTL_MS || 5 * 60 * 1000);

// Simple in-memory caches so we don't hammer Sleeper on every request.
let leagueCache = { at: 0, byId: null };
const userCache = new Map(); // username(lowercased) -> { at, user }

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw err("Could not reach Sleeper. Check the server's internet access.", "UPSTREAM");
  }
  if (res.status === 404) return null; // Sleeper returns 404/empty for unknown users
  if (!res.ok) throw err(`Sleeper API returned ${res.status}`, "UPSTREAM");
  return res.json();
}

function isConfigured() {
  return Boolean(LEAGUE_ID);
}

// Map of user_id -> { userId, displayName, teamName } for everyone in the league.
async function getLeagueMembers() {
  if (!LEAGUE_ID) throw err("SLEEPER_LEAGUE_ID is not configured on the server.", "NO_LEAGUE");

  const now = Date.now();
  if (leagueCache.byId && now - leagueCache.at < TTL_MS) return leagueCache.byId;

  const users = await fetchJson(`${API}/league/${encodeURIComponent(LEAGUE_ID)}/users`);
  if (!Array.isArray(users)) throw err("Could not load this league's members from Sleeper.", "NO_LEAGUE");

  const byId = new Map();
  for (const u of users) {
    const custom = u.metadata && typeof u.metadata.team_name === "string" ? u.metadata.team_name.trim() : "";
    byId.set(u.user_id, {
      userId: u.user_id,
      displayName: u.display_name || "",
      // Sleeper shows the display name as the team when no custom name is set.
      teamName: custom || u.display_name || "Unknown team",
    });
  }
  leagueCache = { at: now, byId };
  return byId;
}

async function getUserByUsername(username) {
  const key = username.toLowerCase();
  const cached = userCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.user;

  const user = await fetchJson(`${API}/user/${encodeURIComponent(username)}`);
  userCache.set(key, { at: now, user });
  return user;
}

// Resolve a typed Sleeper username to a league member.
// Returns { userId, teamName, displayName } or throws an Error with a `.code`.
async function resolveVoter(rawUsername) {
  if (!LEAGUE_ID) throw err("SLEEPER_LEAGUE_ID is not configured on the server.", "NO_LEAGUE");

  const username = String(rawUsername || "").trim();
  if (!username) throw err("Enter your Sleeper username.", "EMPTY");

  const user = await getUserByUsername(username);
  if (!user || !user.user_id) {
    throw err(`No Sleeper account found for "${username}".`, "NO_USER");
  }

  const members = await getLeagueMembers();
  const member = members.get(user.user_id);
  if (!member) {
    throw err(`"${user.display_name || username}" isn't a member of this league.`, "NOT_MEMBER");
  }
  return member;
}

// Maps a resolver error code to an HTTP status.
function statusForCode(code) {
  switch (code) {
    case "EMPTY":
      return 400;
    case "NO_USER":
      return 404;
    case "NOT_MEMBER":
      return 403;
    case "NO_LEAGUE":
      return 503;
    case "UPSTREAM":
    default:
      return 502;
  }
}

module.exports = {
  API,
  LEAGUE_ID,
  isConfigured,
  resolveVoter,
  getLeagueMembers,
  statusForCode,
};
