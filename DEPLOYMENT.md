# Deploying ProofGate

ProofGate is two parts: a FastAPI backend (`app/`) and a static Vite/React frontend (`frontend/`).
The recommended setup is **backend on Render** and **frontend on Vercel**.

> **⚠ Accounts are NOT persistent on Render's free plan.** Everything lives in one SQLite file
> (`PROOFGATE_DB_PATH`, default `./proofgate.db`): **user accounts**, runs, simulated bookings/orders
> and logged-out sessions. A free Render web service has an **ephemeral filesystem and cannot attach a
> persistent disk**, so that file is **deleted on every redeploy, restart and idle spin-down** (free
> services sleep after ~15 minutes without traffic). Users would have to sign up again and their
> history is gone. That is acceptable for a short live demo only. See **Persistence** below for the
> smallest change that makes accounts survive.

## Accounts and sign-in

Every person signs up with **name, email and password** and sees only their own data.

1. `POST /v1/auth/register` `{name, email, password}` → **201** with a session; the new account is signed in.
   Email is trimmed and lower-cased and must be unique (**409** `email_taken` otherwise). Name 1–100
   characters; password **10–128** characters. Bodies are size-capped before any work is done.
2. `POST /v1/auth/login` `{email, password}` → `{token, token_type, expires_at, ttl_seconds, user}`.
   A wrong email and a wrong password get the same **401** "Email or password is incorrect." (the
   password check runs either way, so timing does not reveal which accounts exist).
3. Passwords are hashed with **Argon2id** (`argon2-cffi`; 19 MiB, t=2, p=1 — OWASP's recommendation and
   light enough for a 512 MB instance). Plaintext passwords are never stored, logged or returned.
4. The token is `base64url({sid, uid, exp}).HMAC-SHA256` signed with `PROOFGATE_SESSION_SECRET`,
   default lifetime 120 minutes. It is tied to an existing account: tampered, expired, foreign-secret,
   logged-out or deleted-account tokens get **401**.
5. `POST /v1/auth/logout` revokes the session **in the database**, so a logged-out token stays dead
   after a restart (for as long as the database itself survives).
6. `GET /v1/auth/me` → `{user_id, name, email, created_at}` for the signed-in account.
7. Every other `/v1` endpoint requires `Authorization: Bearer <token>`. Public: `GET /health`,
   `GET /v1/auth/status`, `register`, `login`, `logout` (plus FastAPI's `/docs` schema page, which
   holds no secrets and cannot call protected routes without a token).
8. The frontend keeps the token and the public profile in `sessionStorage` (gone when the tab closes),
   never the password, and sends the token through one helper (`frontend/src/api.ts`). An expired
   session returns the user to *Sign in* with a "Your session has ended" notice and, after signing in,
   back to the screen they were on.

**Password reset is not implemented.** No email service is configured, so the *Forgot password* page
says exactly that and sends nothing.

### Data isolation

Runs, evidence, candidate action contexts, simulated bookings and simulated orders carry an
`owner_id` taken **only from the verified token**. Every read and write is scoped to the caller:

- `GET /v1/runs` lists only your runs; another user's run, evidence, action context, booking or order
  answers **404** — exactly like an id that does not exist, so nothing about it is revealed.
- You cannot preview or create a booking/order against another user's run or candidate.
- Chat history is stored per account, so a guessed `session_id` never reaches someone else's chat.
- Runs created before accounts existed are **kept** (owner empty) but are invisible to every account.
  They are still visible in local development without sign-in and to the local MCP server.

The existing action-safety rules still apply to the owner: REJECTED candidates can never be booked or
ordered, anything not VERIFIED needs the human-review acknowledgement, and a hotel result can only be
booked, a product result only ordered.

### Modes (`GET /health` → `"auth"`)

| Mode | When | Behaviour |
|---|---|---|
| `off` | `PROOFGATE_ENV` ≠ `production` **and** no `PROOFGATE_SESSION_SECRET` | local development only: one local workspace, no sign-in, all stored runs visible |
| `on` | session secret ≥ 32 characters | accounts required; data scoped per user |
| `misconfigured` | `PROOFGATE_ENV=production` without a ≥ 32-character secret | **fails closed**: every protected route and the account endpoints return **503** |

Production can never run in `off` mode. The old shared demo password (`PROOFGATE_DEMO_PASSWORD`)
**no longer exists**: the variable is ignored and grants nothing — remove it from your dashboard.

### Abuse protection

- Failed sign-ins: 5 per client IP per 15 minutes → **429**. No server-wide or per-account lockout,
  so one person cannot lock others out.
- Sign-ups: 5 per client IP per hour → **429**.
- Behind Render the client IP comes from `PROOFGATE_CLIENT_IP_HEADER=True-Client-IP` (set by the edge).
  `X-Forwarded-For` is not trusted because Render appends to it without clearing client-sent values.

CORS is **not** authentication: it only controls which browser origins may read responses.

## Spend protection

Endpoints that spend SerpApi / LLM / Jev credits — `POST /v1/find-and-verify`, `POST /v1/verify`,
`POST /v1/agent/chat`, `GET /v1/agent/chat/stream` — are limited **per account** and server-wide
(signing in again does not reset an account's allowance). Over a limit the API returns **429** with a
clear message and `Retry-After`; nothing is spent. Read-only endpoints stay usable.

| Variable | Default | Meaning |
|---|---|---|
| `PROOFGATE_SPEND_PER_SESSION` | `10` | live searches/verifications **per account** per window |
| `PROOFGATE_SPEND_GLOBAL_MAX` | `60` | live searches/verifications for the whole server per window |
| `PROOFGATE_SPEND_WINDOW_MIN` | `60` | window length in minutes |
| `PROOFGATE_REQUESTS_PER_MIN` | `120` | any `/v1` request, per account |

**These limits are in memory.** They reset whenever the process restarts and are per instance, so they
bound abuse but are **not a permanent cost cap**. Because anyone can create an account, also set hard
spending limits with your providers: SerpApi plan quota, your LLM provider's monthly limit, TypeSafe
Jev's account limits.

## Persistence

| Option | Accounts survive restarts? | Cost | Code change |
|---|---|---|---|
| Free Render web service (current `render.yaml`) | **No** — deleted on every redeploy/restart/spin-down | free | none |
| **Render paid instance + persistent disk** (smallest safe change) | **Yes** | paid instance type + disk (see Render's pricing page) | none — set `PROOFGATE_DB_PATH=/var/data/proofgate.db` and mount a disk at `/var/data` (commented block in `render.yaml`) |
| External database (e.g. Postgres via a `DATABASE_URL`) | Yes | depends on provider | **yes** — the store is SQLite-only today; not implemented |

A disk-backed SQLite file supports a **single instance** only (don't scale the service horizontally).
Back the disk up (Render disk snapshots) if accounts matter. Nothing in this repository creates paid
resources; switching to the disk is a decision for the account owner.

## Backend on Render

- **Blueprint:** Render dashboard → *New* → *Blueprint* → this repository. `render.yaml` defines a
  **free** web service; Render prompts for every `sync: false` value and generates the session secret.
- **Manual:** *New* → *Web Service* → this repository:

| Setting | Value |
|---|---|
| Runtime | Python 3 |
| Root directory | *(empty — repository root)* |
| Build command | `pip install -r requirements.txt` |
| Start command | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` |
| Instance type | Free (ephemeral) — or a paid type with a disk for persistent accounts |
| Health check path | `/health` |

Do **not** add `--proxy-headers --forwarded-allow-ips "*"`: uvicorn would then take the client IP from
the first `X-Forwarded-For` entry, which the client controls.

Environment variables (Render → service → *Environment*). Enter values only in the dashboard:

| Variable | Required | Value |
|---|---|---|
| `PROOFGATE_ENV` | yes | `production` |
| `PROOFGATE_SESSION_SECRET` | yes | **32+ random characters** (Blueprint generates it; manually: `python -c "import secrets; print(secrets.token_urlsafe(48))"`). Changing it signs everyone out. |
| `PROOFGATE_CLIENT_IP_HEADER` | yes on Render | `True-Client-IP` |
| `PROOFGATE_ALLOWED_ORIGINS` | yes | your Vercel URL, e.g. `https://proofgate.vercel.app` (comma-separate several; no trailing slash) |
| `PROOFGATE_DB_PATH` | for persistence | `/var/data/proofgate.db` on a mounted disk; default `./proofgate.db` is ephemeral on Render |
| `SERPAPI_API_KEY` | yes | SerpApi key |
| `LLM_API_KEY` | yes | LLM key (`LLM_BASE_URL`, `LLM_MODEL` optional; default OpenAI `gpt-4o-mini`) |
| `JEV_API_KEY` | recommended | TypeSafe Jev key (otherwise the LLM adjudicator is used) |
| `PYTHON_VERSION` | recommended | `3.12.2` (the version the tests run on) |
| `PROOFGATE_SESSION_TTL_MIN`, spend limits above | no | tune if needed |
| ~~`PROOFGATE_DEMO_PASSWORD`~~ | **remove** | no longer used |

**Health check:** `GET https://<service>.onrender.com/health` →
`{"ok": true, "ready": true, "missing_credentials": [], "auth": "on"}`. `ready: false` lists missing key
*names* (never values); `"auth": "misconfigured"` means the API is closed until the secret is fixed.

## Frontend on Vercel

Vercel → *Add New* → *Project* → this repository:

| Setting | Value |
|---|---|
| Framework preset | Vite |
| Root directory | `frontend` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Environment variable | `VITE_API_BASE_URL` = `https://<service>.onrender.com` (no trailing slash) |

`VITE_API_BASE_URL` is **public** (baked into the JavaScript) and holds only the backend URL. Never put
the session secret or any API key in a `VITE_` variable. Routing is hash-based (`#/app/...`), so no
rewrite rules are needed. Changing `VITE_API_BASE_URL` requires a redeploy.

**Preview deployments** get their own `*.vercel.app` URLs; they can only reach the API if that exact
origin is added to `PROOFGATE_ALLOWED_ORIGINS` (wildcards are not supported).

## End-to-end check after deploying

1. `https://<service>.onrender.com/health` → `"ready": true`, `"auth": "on"`. (The first request after
   idling can take ~1 minute while a free instance wakes.)
2. Open the Vercel URL → *Create an account* → you land in the workspace with your name in the top bar.
3. *Sign out*, then *Sign in* with the same email and password. A wrong password shows
   "Email or password is incorrect."; signing up again with the same email shows that it is taken.
4. Without a token, `curl https://<service>.onrender.com/v1/runs` → **401**.
5. Create a second account in a private window: it sees **none** of the first account's runs, and the
   first account's run URL shows "Run not found".
6. Throttle check: 5 wrong passwords from one network → 429 there, while a different network (e.g. a
   phone on mobile data) can still sign in. If both are blocked, `True-Client-IP` is not reaching the app.
7. On the free plan, redeploy once and confirm you understand the result: the accounts are gone.

If the browser console shows a CORS error, `PROOFGATE_ALLOWED_ORIGINS` does not exactly match the
Vercel origin (scheme + host, no path, no trailing slash).

## Local development

```bash
pip install -r requirements.txt
cp .env.example .env            # fill in the keys (server-side only); leave PROOFGATE_SESSION_SECRET empty
python run.py --serve           # http://127.0.0.1:8000 — one local workspace, no sign-in
cd frontend && npm ci && npm run dev    # http://localhost:5173 (Vite proxies /v1 and /health)
```

To try accounts locally, set `PROOFGATE_SESSION_SECRET` (32+ characters) in your local `.env` and restart.

Other server variables: `PROOFGATE_DB_PATH` (SQLite file), `PROOFGATE_HOST` (default `127.0.0.1`),
`PROOFGATE_PORT` / `PORT` (default `8000`), `PROOFGATE_RELOAD` (`1` in dev; `0` when deploying).
Calling the API from scripts: `ProofGateClient(base_url).login(email, password)` (or `token=...`).

## MCP server

`run_mcp.py` is a **local stdio** server for MCP hosts on the same machine. It has no network transport,
no accounts, reads the local store unscoped, and is not part of a web deployment.

## Checklist

- [ ] Render: `PROOFGATE_ENV=production`, session secret (32+), `PROOFGATE_CLIENT_IP_HEADER`, provider keys.
- [ ] Render: `PROOFGATE_DEMO_PASSWORD` removed.
- [ ] Render: `PROOFGATE_ALLOWED_ORIGINS` = exact Vercel origin.
- [ ] Decide persistence: free (accounts lost on restart) **or** paid instance + disk + `PROOFGATE_DB_PATH`.
- [ ] Vercel: `VITE_API_BASE_URL` = Render URL; root `frontend`.
- [ ] `/health` shows `"auth": "on"` and `"ready": true`.
- [ ] Provider-side spending limits set at SerpApi, the LLM provider and Jev.
