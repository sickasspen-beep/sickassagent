# 🗳️ VoteBox

A simple, **password-protected voting site**. No accounts — visitors just enter
the one shared password you give them. Once inside, anyone can:

- **Create a poll**: a question, 2–10 options, and a voting period of **3, 7, or 10 days**.
- **Vote** on any open poll (one vote per browser session).
- **See live results** with vote counts and percentages once they've voted or the poll closes.

Polls automatically close when their voting period ends.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure the password
cp .env.example .env
#    then edit .env and set SITE_PASSWORD

# 3. Run it
npm start
```

Open <http://localhost:3000> and enter your password.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable         | Default        | Purpose                                                        |
| ---------------- | -------------- | -------------------------------------------------------------- |
| `SITE_PASSWORD`  | `letmein` ⚠️   | The shared password people enter. **Set this!**                |
| `SESSION_SECRET` | random         | Signs session cookies. Set a fixed value so restarts don't log everyone out. |
| `PORT`           | `3000`         | Port to listen on.                                             |
| `NODE_ENV`       | `development`  | Set to `production` (behind HTTPS) to enable secure cookies.   |
| `DATA_DIR`       | `./data`       | Where the SQLite database file is stored.                      |

> ⚠️ If you don't set `SITE_PASSWORD`, the app falls back to the insecure
> default `letmein` and prints a warning. Always set your own before sharing.

## How it works

- **Backend**: Node.js + [Express](https://expressjs.com/), with data stored in
  a local [SQLite](https://www.sqlite.org/) file via `better-sqlite3`.
- **Auth**: A single shared password. A correct password sets a signed session
  cookie; all poll APIs require it. There are no user accounts.
- **One vote per poll**: Enforced per browser session (the session ID is the
  voter key). This keeps things friction-free without logins; it is not intended
  to be vote-fraud-proof.
- **Frontend**: Plain HTML/CSS/JS in `public/` — no build step.

## Project layout

```
server.js        Express app: auth + poll/vote API + static hosting
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
| POST   | `/api/login`           | `{ password }`                         | Authenticate.            |
| POST   | `/api/logout`          | —                                      | End the session.         |
| GET    | `/api/session`         | —                                      | `{ authed: boolean }`.   |
| GET    | `/api/polls`           | —                                      | List all polls.          |
| GET    | `/api/polls/:id`       | —                                      | One poll with results.   |
| POST   | `/api/polls`           | `{ question, options[], durationDays }`| Create a poll.           |
| POST   | `/api/polls/:id/vote`  | `{ optionId }`                         | Cast a vote.             |

## Notes & limits

- Data lives in `./data/voting.db`. Back up or persist that directory to keep polls.
- One vote per browser session means clearing cookies / using another browser
  allows another vote — acceptable for casual/team polls, not for high-stakes elections.
