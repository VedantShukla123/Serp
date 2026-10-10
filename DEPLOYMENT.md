# Deploying ProofGate

ProofGate is two parts: a FastAPI backend (`app/`) and a static Vite/React frontend (`frontend/`).
The recommended public demo setup is **backend on Render** (free web service) and **frontend on Vercel**.

> **⚠ Storage is not durable on Render's free plan.** ProofGate stores runs, simulated bookings and
> simulated orders in SQLite (`PROOFGATE_DB_PATH`, default `./proofgate.db`). A free Render web
> service has an **ephemeral filesystem and cannot attach a persistent disk**, so **all stored runs
> are deleted on every redeploy, restart and idle spin-down** (free services sleep after ~15 minutes
> without traffic). The deployed database also starts empty — the illustrative run linked from the
> landing page exists only on the machine that created it. This is fine for a live demo; it is not
> fine for anything that must be kept. Durable storage would need a paid Render disk or an external
> database (a code change) — decide that before relying on stored history.

## Access control (demo password)

ProofGate has **no user accounts**. A deployed demo is protected by one shared password:

1. The browser calls `POST /v1/auth/login` with the demo password. The server compares it in
   constant time and returns a **short-lived signed bearer token** (HMAC-SHA256 with
   `PROOFGATE_SESSION_SECRET`, default lifetime 120 minutes).
2. Every other `/v1` endpoint requires `Authorization: Bearer <token>` — runs, evidence, agent chat
   (including the SSE stream), verification, simulated bookings/orders. Missing, invalid, tampered,
   expired or logged-out tokens get **401**.
3. Public: `GET /health`, `GET /v1/auth/status`, `POST /v1/auth/login`, `POST /v1/auth/logout`
   (plus FastAPI's `/docs` schema page, which contains no secrets and cannot call protected routes
   without a token).
4. The frontend keeps the token in `sessionStorage` (gone when the tab closes) and sends it on every
   API call through one helper (`frontend/src/api.ts`). **Sign out** revokes it on the server.
5. Failed logins are throttled **per client IP**: after 5 failures in 15 minutes that IP gets **429**.
   There is deliberately no server-wide login lockout, so one person cannot block every demo user.
   Behind Render the IP comes from `PROOFGATE_CLIENT_IP_HEADER=True-Client-IP` (set by the edge);
   `X-Forwarded-For` is not trusted because Render appends to it without clearing client-sent values.

Modes (`GET /health` → `"auth"`):

| Mode | When | Behaviour |
|---|---|---|
| `off` | no `PROOFGATE_DEMO_PASSWORD` and `PROOFGATE_ENV` ≠ `production` | local development — no sign-in |
| `on` | password ≥ 12 chars and session secret ≥ 32 chars | sign-in required |
| `misconfigured` | `PROOFGATE_ENV=production` (or a password is set) but the password/secret is missing or too short | **fails closed**: every protected route and login return **503** |

Passwords and tokens are never logged or returned by `/health`. CORS is **not** authentication: it only
controls which browser origins may read responses; the token is what protects the API.

## Spend protection

Endpoints that spend SerpApi / LLM / Jev credits — `POST /v1/find-and-verify`, `POST /v1/verify`,
`POST /v1/agent/chat`, `GET /v1/agent/chat/stream` — are limited per session **and** server-wide.
Over a limit the API returns **429** with a clear message and `Retry-After`; nothing is spent.
Read-only endpoints (stored runs, evidence, action previews) stay usable.

| Variable | Default | Meaning |
|---|---|---|
| `PROOFGATE_SPEND_PER_SESSION` | `10` | live searches/verifications per session per window |
| `PROOFGATE_SPEND_GLOBAL_MAX` | `60` | live searches/verifications for the whole server per window |
| `PROOFGATE_SPEND_WINDOW_MIN` | `60` | window length in minutes |
| `PROOFGATE_REQUESTS_PER_MIN` | `120` | any `/v1` request, per session |

**These limits are in memory.** They reset whenever the process restarts (on free Render: every
deploy and spin-down) and are per instance, so they bound abuse of a demo but are **not a permanent
cost cap**. Also set hard spending limits / budgets with your providers: SerpApi plan search quota,
your LLM provider's monthly usage limit, and TypeSafe Jev's account limits.

## Backend on Render

Two equivalent options — use one:

- **Blueprint:** Render dashboard → *New* → *Blueprint* → pick this repository. `render.yaml` defines a
  **free** web service; Render will prompt for every `sync: false` value and generate the session secret.
- **Manual:** *New* → *Web Service* → this repository, then:

| Setting | Value |
|---|---|
| Runtime | Python 3 |
| Branch | the branch you deploy (e.g. `main`) |
| Root directory | *(empty — repository root)* |
| Build command | `pip install -r requirements.txt` |
| Start command | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` |
| Instance type | Free |
| Health check path | `/health` |

Do **not** add `--proxy-headers --forwarded-allow-ips "*"`: uvicorn would then take the client IP from
the first `X-Forwarded-For` entry, which the client controls.

Environment variables (Render → service → *Environment*). Enter values only in the dashboard:

| Variable | Required | Value |
|---|---|---|
| `PROOFGATE_ENV` | yes | `production` |
| `PROOFGATE_DEMO_PASSWORD` | yes | the shared demo password, **12+ characters** |
| `PROOFGATE_SESSION_SECRET` | yes | **32+ random characters** (Blueprint generates it; manually: `python -c "import secrets; print(secrets.token_urlsafe(48))"`) |
| `PROOFGATE_CLIENT_IP_HEADER` | yes on Render | `True-Client-IP` — per-IP login throttling; unset = the connection's peer address (all Render visitors would share one IP) |
| `PROOFGATE_ALLOWED_ORIGINS` | yes | your Vercel URL, e.g. `https://proofgate.vercel.app` (comma-separate several; no trailing slash) |
| `SERPAPI_API_KEY` | yes | SerpApi key |
| `LLM_API_KEY` | yes | LLM key (`LLM_BASE_URL`, `LLM_MODEL` optional; default OpenAI `gpt-4o-mini`) |
| `JEV_API_KEY` | recommended | TypeSafe Jev key (otherwise the LLM adjudicator is used) |
| `PYTHON_VERSION` | recommended | `3.12.2` (the version the tests run on) |
| `PROOFGATE_SESSION_TTL_MIN`, spend limits above | no | tune if needed |

Changing `PROOFGATE_SESSION_SECRET` signs everyone out. Changing the password does not end existing
sessions until they expire — rotate the secret too if you need that.

**Health check:** `GET https://<service>.onrender.com/health` →
`{"ok": true, "ready": true, "missing_credentials": [], "auth": "on"}`.
`ready: false` lists missing key *names* (never values); `"auth": "misconfigured"` means the API is
closed until the password/secret are fixed.

## Frontend on Vercel

Vercel → *Add New* → *Project* → this repository:

| Setting | Value |
|---|---|
| Framework preset | Vite |
| Root directory | `frontend` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Install command | `npm ci` (default is fine) |
| Environment variable | `VITE_API_BASE_URL` = `https://<service>.onrender.com` (no trailing slash) |

`VITE_API_BASE_URL` is **public** (baked into the JavaScript) and holds only the backend URL. Never
put the demo password, session secret or any API key in a `VITE_` variable. Routing is hash-based
(`#/app/...`), so no rewrite rules are needed. Changing `VITE_API_BASE_URL` requires a redeploy.

**Preview deployments** get their own `*.vercel.app` URLs; they can only reach the API if that exact
origin is added to `PROOFGATE_ALLOWED_ORIGINS` (wildcards are not supported; `*` allows every origin
and is not recommended).

## End-to-end check after deploying

1. `https://<service>.onrender.com/health` → `"ready": true`, `"auth": "on"`. (The first request after
   idling can take ~1 minute while the free instance wakes.)
2. Open the Vercel URL → *Sign in* → enter the demo password → the workspace loads and the top bar
   shows **API ready**. A wrong password shows an error; repeated wrong passwords show a 429 message.
3. Without signing in, `curl https://<service>.onrender.com/v1/runs` → **401**.
   Throttle check: 5 wrong passwords from one network → 429 there, while a different network (e.g. a
   phone on mobile data) can still sign in. If both are blocked, `True-Client-IP` is not reaching the
   app — check the header name and redeploy.
4. Run one search in the Assistant; open **Developers → Trace Inspector** for that run.
5. **Sign out** → you return to the landing page; the old token no longer works.

If the browser console shows a CORS error, `PROOFGATE_ALLOWED_ORIGINS` does not exactly match the
Vercel origin (scheme + host, no path, no trailing slash).

## Local development (unchanged)

```bash
pip install -r requirements.txt
cp .env.example .env            # fill in the keys (server-side only); leave PROOFGATE_DEMO_PASSWORD empty
python run.py --serve           # http://127.0.0.1:8000, no sign-in
cd frontend && npm ci && npm run dev    # http://localhost:5173 (Vite proxies /v1 and /health)
```

To try the sign-in flow locally, set `PROOFGATE_DEMO_PASSWORD` (12+ chars) and
`PROOFGATE_SESSION_SECRET` (32+ chars) in your local `.env`.

Other server variables: `PROOFGATE_DB_PATH` (SQLite file), `PROOFGATE_HOST` (default `127.0.0.1`),
`PROOFGATE_PORT` / `PORT` (default `8000`), `PROOFGATE_RELOAD` (`1` in dev; `0` when deploying).
Calling the API from scripts: `ProofGateClient(base_url, token=...)` or `client.login(password)`.

## MCP server

`run_mcp.py` is a **local stdio** server for MCP hosts on the same machine. It has no network
transport, does not use the demo password, and is not part of a web deployment.

## Checklist

- [ ] Render: `PROOFGATE_ENV=production`, demo password (12+), session secret (32+), provider keys.
- [ ] Render: `PROOFGATE_ALLOWED_ORIGINS` = exact Vercel origin.
- [ ] Vercel: `VITE_API_BASE_URL` = Render URL; root `frontend`.
- [ ] `/health` shows `"auth": "on"` and `"ready": true`.
- [ ] Provider-side spending limits set at SerpApi, the LLM provider and Jev.
- [ ] Everyone understands stored runs vanish on restart (free Render, ephemeral SQLite).
