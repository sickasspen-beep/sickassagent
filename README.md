# 🗳️ VoteBox

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sickasspen-beep/sickassagent)

> **One-tap deploy:** tap the button above, sign into Render with GitHub, and
> confirm. The included `render.yaml` provisions the server, a 1 GB persistent
> disk, HTTPS, and a health check, and auto-generates `SESSION_SECRET` — so
> there's nothing to paste. (Render's persistent disk needs the paid Starter
> instance, so you'll add a payment method.) When it's live, open the URL and
> log in with your Sleeper username.

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
| `SLEEPER_LEAGUE_ID` | `1365139935241191424` | Sleeper league that logins are verified against. Defaults to the configured league; override only to point at a different one. |
| `SESSION_SECRET`    | random       | Signs session cookies. Set a fixed value so restarts don't log everyone out. |
| `SLEEPER_CACHE_TTL_MS` | `300000`  | How long to cache Sleeper lookups (ms).                        |
| `PORT`              | `3000`       | Port to listen on.                                             |
| `NODE_ENV`          | `development`| Set to `production` (behind HTTPS) to enable secure cookies.   |
| `DATA_DIR`          | `./data`     | Where the SQLite database (polls **and** sessions) is stored.  |

## Deploy / launch

The app is a single Node process that serves both the API and the frontend, with
all state in one SQLite file. To go live:

1. **Set the required environment variables:**
   ```bash
   SESSION_SECRET=<long random string>   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   NODE_ENV=production
   # SLEEPER_LEAGUE_ID is already baked in (1365139935241191424); only set it to use a different league.
   ```
2. **Give it persistent storage.** Polls *and* login sessions live in
   `DATA_DIR` (`./data` by default). Point it at a persistent disk/volume so a
   restart or redeploy doesn't wipe polls or log everyone out.
3. **Allow outbound access to `api.sleeper.app`** — required for login.
4. **Run it behind HTTPS.** In `production` the app sets `trust proxy` and
   issues `Secure` cookies, so it expects a TLS-terminating proxy (the norm on
   Render/Fly/Railway/Heroku/nginx). A health check is exposed at `/healthz`.

### Docker

```bash
docker build -t votebox .
docker run -p 3000:3000 \
  -e SLEEPER_LEAGUE_ID=<your league id> \
  -e SESSION_SECRET=<long random string> \
  -v votebox-data:/data \
  votebox
```

The image sets `NODE_ENV=production`, stores data in the `/data` volume, and has
a built-in `HEALTHCHECK`. Put it behind your platform's HTTPS router.

### PaaS (Render / Railway / Fly / Heroku, etc.)

A `Procfile` (`web: node server.js`) is included. Set the env vars above in the
platform dashboard, attach a persistent disk mounted where `DATA_DIR` points,
and deploy. These platforms terminate HTTPS for you, which satisfies step 4.

## How it works

- **Backend**: Node.js + [Express](https://expressjs.com/), with data stored in
  a local [SQLite](https://www.sqlite.org/) file via `better-sqlite3`.
- **Login & identity (Sleeper)**: A person logs in with their Sleeper username.
  The server calls Sleeper's public API (`api.sleeper.app`) to look up the
  account, confirm it's a member of your `SLEEPER_LEAGUE_ID`, and read their
  league **team name**. That identity (Sleeper **user_id** + team name) is stored
  in a signed session cookie and gates all poll APIs — there's no shared password.
  Votes are keyed by `user_id`, so each account gets **one vote per poll**
  regardless of browser or device. Lookups are cached briefly. The server needs
  **outbound internet access to `api.sleeper.app`**.
- **Frontend**: Plain HTML/CSS/JS in `public/` — no build step.

## Project layout

```
server.js        Express app: auth + poll/vote API + static hosting
sleeper.js       Sleeper API client: resolve username -> league team name
db.js            SQLite setup and schema (polls, options, votes)
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

- Data lives in `./data/voting.db`. Back up or persist that directory to keep polls.
- Login requires the server to reach `api.sleeper.app`. If it can't (no internet
  / blocked), logging in fails with a clear error.
- Login is **trust-based**: Sleeper usernames are public, so a member could log
  in as a teammate by typing their username — fine for a friendly league, not an
  anti-impersonation guarantee.
