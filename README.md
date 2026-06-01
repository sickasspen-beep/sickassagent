# 🗳️ VoteBox

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sickasspen-beep/sickassagent)

> **Free one-tap deploy:** create a free database at
> [app.turso.tech](https://app.turso.tech) and copy its URL + token. Then tap the
> button above, sign into Render with GitHub, paste the two Turso values when
> asked, and confirm. The included `render.yaml` runs on Render's **free** plan,
> sets up HTTPS + a health check, and auto-generates `SESSION_SECRET`. When it's
> live, open the URL and log in with your Sleeper username. (Full steps below.)

A simple voting site for a **Sleeper fantasy league**. No accounts and no shared
password — people **log in with their Sleeper username**, which is verified
against your league. That login is also their voting identity. Once in, anyone can:

- **Create a poll**: a question, 2–10 options, and a voting period of **3, 7, or 10 days**.
- **Vote** on any open poll as their **league team** (one vote per team).
- **See live results** with vote counts, percentages, and **which teams voted
  for what**, once they've voted or the poll closes.

Polls automatically close when their voting period ends.

> **Why username login instead of OAuth?** Sleeper has no OAuth / "Login with
> Sleeper" for third-party apps — its API is read-only and unauthenticated. So
> login verifies that the typed username is a member of your league and starts a
> session. Since Sleeper usernames are public, this is **trust-based**: a member
> could log in as a teammate by typing their username. That's fine for a friendly
> league; it is not an anti-impersonation guarantee.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. (Optional) configure overrides — the Sleeper league is already baked in
cp .env.example .env

# 3. Run it
npm start
```

Open <http://localhost:3000> and log in with your Sleeper username.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable         | Default        | Purpose                                                        |
| ---------------- | -------------- | -------------------------------------------------------------- |
| `TURSO_DATABASE_URL` | _none_      | Free [Turso](https://turso.tech) database URL for storing polls/votes. Recommended for any real deploy. |
| `TURSO_AUTH_TOKEN`  | _none_       | Auth token for the Turso database above.                       |
| `SLEEPER_LEAGUE_ID` | `1365139935241191424` | Sleeper league that logins are verified against. Defaults to the configured league; override only to point at a different one. |
| `SESSION_SECRET`    | random       | Signs the session cookie. Set a fixed value so restarts don't log everyone out. |
| `SLEEPER_CACHE_TTL_MS` | `300000`  | How long to cache Sleeper lookups (ms).                        |
| `PORT`              | `3000`       | Port to listen on.                                             |
| `NODE_ENV`          | `development`| Set to `production` (behind HTTPS) to enable secure cookies.   |
| `DATA_DIR`          | `./data`     | Local SQLite file location, used only when Turso vars are unset (dev). |

## Deploy / launch (free)

The app stores its data in a **free [Turso](https://turso.tech) database** (a
hosted, SQLite-compatible DB), so it runs on free hosting tiers without a paid
persistent disk. Login sessions are stateless signed cookies, so nothing else
needs storage.

**Step 1 — create the free database (≈2 min, works on a phone):**

1. Go to [app.turso.tech](https://app.turso.tech) and sign up (free).
2. Create a database.
3. Copy its **Database URL** (looks like `libsql://...`) and create/copy an
   **auth token**.

**Step 2 — deploy on Render's free plan:**

1. Tap the **Deploy to Render** button at the top of this README.
2. Sign into Render with GitHub and let it read `render.yaml`.
3. When prompted, paste the two values: `TURSO_DATABASE_URL` and
   `TURSO_AUTH_TOKEN`. (`SESSION_SECRET` is auto-generated; the Sleeper league is
   baked in.)
4. Deploy. Render terminates HTTPS for you and pings `/healthz`. Open the URL and
   log in with your Sleeper username.

> Render's free web service sleeps after ~15 min of inactivity and takes a few
> seconds to wake on the next visit — fine for a casual league, and free. Your
> data is safe regardless, since it lives in Turso.

### Run it anywhere else (Docker / other PaaS)

A `Dockerfile` and `Procfile` are included. Set `NODE_ENV=production`,
`SESSION_SECRET`, `TURSO_DATABASE_URL`, and `TURSO_AUTH_TOKEN`, ensure outbound
access to `api.sleeper.app`, and run behind HTTPS:

```bash
docker build -t votebox .
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e SESSION_SECRET=<long random string> \
  -e TURSO_DATABASE_URL=<libsql://...> \
  -e TURSO_AUTH_TOKEN=<token> \
  votebox
```

## How it works

- **Backend**: Node.js + [Express](https://expressjs.com/). Data is stored in a
  [Turso](https://turso.tech) / [libSQL](https://github.com/tursodatabase/libsql)
  database (SQLite-compatible) in production, or a local SQLite file in dev.
- **Login & identity (Sleeper)**: A person logs in with their Sleeper username.
  The server calls Sleeper's public API (`api.sleeper.app`) to look up the
  account, confirm it's a member of your `SLEEPER_LEAGUE_ID`, and read their
  league **team name**. That identity (Sleeper **user_id** + team name) is stored
  in a **stateless signed cookie** and gates all poll APIs — there's no shared
  password and no server-side session store. Votes are keyed by `user_id`, so each
  account gets **one vote per poll** regardless of browser or device. Lookups are
  cached briefly. The server needs **outbound internet access to `api.sleeper.app`**.
- **Frontend**: Plain HTML/CSS/JS in `public/` — no build step.

## Project layout

```
server.js        Express app: auth + poll/vote API + static hosting
sleeper.js       Sleeper API client: resolve username -> league team name
db.js            libSQL/Turso (or local SQLite) client + schema (polls, options, votes)
public/
  index.html     Login gate + app shell
  styles.css     Styling
  app.js         Frontend logic (login, create, vote, results)
Dockerfile       Container image (production)
Procfile         Process definition for PaaS hosts
.env.example     Configuration template
```

## API reference

All `/api/polls*` routes require a logged-in session.

| Method | Route                  | Body                                   | Description              |
| ------ | ---------------------- | -------------------------------------- | ------------------------ |
| POST   | `/api/login`           | `{ username }`                          | Log in with a Sleeper username; verifies league membership and starts a session. |
| POST   | `/api/logout`          | —                                       | End the session.         |
| GET    | `/api/session`         | —                                       | `{ authed, teamName, displayName }`. |
| GET    | `/api/polls`           | —                                       | List polls; flags the viewer's own votes. |
| GET    | `/api/polls/:id`       | —                                       | One poll with results.   |
| POST   | `/api/polls`           | `{ question, options[], durationDays }` | Create a poll.           |
| POST   | `/api/polls/:id/vote`  | `{ optionId }`                          | Cast a vote as the logged-in team. |
| GET    | `/healthz`             | —                                       | Health check (no auth); `{ ok: true }`. |

## Notes & limits

- In production, data lives in your Turso database; in dev it's a local
  `./data/voting.db` file. Logins are stateless cookies, so they survive restarts
  as long as `SESSION_SECRET` is fixed.
- Login requires the server to reach `api.sleeper.app`. If it can't (no internet
  / blocked), logging in fails with a clear error.
- Login is **trust-based**: Sleeper usernames are public, so a member could log
  in as a teammate by typing their username — fine for a friendly league, not an
  anti-impersonation guarantee.
