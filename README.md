# 🗳️ VoteBox

A simple, **password-protected voting site** for a **Sleeper fantasy league**.
No accounts — visitors just enter the one shared password you give them. Once
inside, anyone can:

- **Create a poll**: a question, 2–10 options, and a voting period of **3, 7, or 10 days**.
- **Vote** on any open poll. To vote, you enter your **Sleeper username**; the
  server verifies you're a member of the configured league and records the vote
  under your **league team name** (one vote per Sleeper account).
- **See live results** with vote counts, percentages, and **which teams voted
  for what**, once they've voted or the poll closes.

Polls automatically close when their voting period ends.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure the password and your Sleeper league
cp .env.example .env
#    then edit .env and set SITE_PASSWORD and SLEEPER_LEAGUE_ID

# 3. Run it
npm start
```

Open <http://localhost:3000> and enter your password.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable         | Default        | Purpose                                                        |
| ---------------- | -------------- | -------------------------------------------------------------- |
| `SITE_PASSWORD`     | `letmein` ⚠️ | The shared password people enter. **Set this!**                |
| `SLEEPER_LEAGUE_ID` | _none_       | Your Sleeper league ID — voters are verified against it. **Set this!** Find it in your league URL: `sleeper.com/leagues/<LEAGUE_ID>/...` |
| `SESSION_SECRET`    | random       | Signs session cookies. Set a fixed value so restarts don't log everyone out. |
| `SLEEPER_CACHE_TTL_MS` | `300000`  | How long to cache Sleeper lookups (ms).                        |
| `PORT`              | `3000`       | Port to listen on.                                             |
| `NODE_ENV`          | `development`| Set to `production` (behind HTTPS) to enable secure cookies.   |
| `DATA_DIR`          | `./data`     | Where the SQLite database file is stored.                      |

> ⚠️ If you don't set `SITE_PASSWORD`, the app falls back to the insecure
> default `letmein` and prints a warning. Always set your own before sharing.

## How it works

- **Backend**: Node.js + [Express](https://expressjs.com/), with data stored in
  a local [SQLite](https://www.sqlite.org/) file via `better-sqlite3`.
- **Auth**: A single shared password. A correct password sets a signed session
  cookie; all poll APIs require it. There are no user accounts.
- **Voter identity (Sleeper)**: To vote, a person enters their Sleeper username.
  The server calls Sleeper's public API (`api.sleeper.app`) to look up the
  account, confirm it's a member of your `SLEEPER_LEAGUE_ID`, and read their
  league **team name**. The vote is stored keyed by the Sleeper **user_id**, so
  each account gets **one vote per poll** regardless of browser or device.
  Lookups are cached briefly to avoid hammering the API. The server therefore
  needs **outbound internet access to `api.sleeper.app`**.
- **Frontend**: Plain HTML/CSS/JS in `public/` — no build step. Your Sleeper
  username is remembered in the browser (localStorage) so you only type it once.

## Project layout

```
server.js        Express app: auth + poll/vote API + static hosting
sleeper.js       Sleeper API client: resolve username -> league team name
db.js            SQLite setup and schema (polls, options, votes)
public/
  index.html     Login gate + app shell
  styles.css     Styling
  app.js         Frontend logic (login, create, vote, results)
.env.example     Configuration template
```

## API reference

All `/api/polls*` routes require an authenticated session.

| Method | Route                  | Body                                   | Description              |
| ------ | ---------------------- | -------------------------------------- | ------------------------ |
| POST   | `/api/login`           | `{ password }`                          | Authenticate.            |
| POST   | `/api/logout`          | —                                       | End the session.         |
| GET    | `/api/session`         | —                                       | `{ authed: boolean }`.   |
| GET    | `/api/sleeper/me`      | `?username=`                            | Verify a Sleeper username is in the league; returns its team name. |
| GET    | `/api/polls`           | `?sleeper=` (optional)                   | List polls; flags the viewer's own votes. |
| GET    | `/api/polls/:id`       | `?sleeper=` (optional)                   | One poll with results.   |
| POST   | `/api/polls`           | `{ question, options[], durationDays }` | Create a poll.           |
| POST   | `/api/polls/:id/vote`  | `{ optionId, sleeperUsername }`         | Cast a vote.             |

## Notes & limits

- Data lives in `./data/voting.db`. Back up or persist that directory to keep polls.
- Voting requires the server to reach `api.sleeper.app`. If it can't (no internet
  / blocked), voting fails with a clear error; browsing and creating polls still work.
- One vote per **Sleeper account** is enforced server-side by `user_id`. Anyone
  can vote on behalf of a teammate if they type that teammate's username, since
  Sleeper usernames are public — fine for a friendly league, not anti-fraud-proof.
