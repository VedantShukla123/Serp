# Deploying ProofGate

> **Not ready for public exposure.** The API has **no authentication**: `PROOFGATE_API_KEY`
> exists in the configuration but no route checks it. Anyone who can reach the API can call
> `POST /v1/find-and-verify`, `POST /v1/verify`, `POST /v1/agent/chat` and
> `GET /v1/agent/chat/stream` — each spends **your** SerpApi / LLM / Jev credits — and can write
> demo booking/order records. There is also no rate limiting.
> Until authentication exists, run it only on `localhost`, a private network/VPN, or behind a
> reverse proxy that authenticates users. Do not bind it to a public interface.

ProofGate is two parts: a FastAPI backend (`app/`) and a static Vite/React frontend (`frontend/`).

## Backend

```bash
pip install -r requirements.txt
cp .env.example .env            # then fill in the keys (server-side only)
PROOFGATE_RELOAD=0 python run.py --serve        # or, equivalently:
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

| Variable | Required | Purpose |
|---|---|---|
| `SERPAPI_API_KEY` | yes | live search |
| `LLM_API_KEY` | yes | requirement parsing, ranking, chat (`LLM_BASE_URL`, `LLM_MODEL` optional) |
| `JEV_API_KEY` | recommended | TypeSafe Jev verification (falls back to the LLM adjudicator) |
| `PROOFGATE_DB_PATH` | no | SQLite file, default `./proofgate.db` — put it on persistent storage |
| `PROOFGATE_HOST` | no | bind address, default `127.0.0.1` (this machine only) |
| `PROOFGATE_PORT` / `PORT` | no | default `8000` |
| `PROOFGATE_RELOAD` | no | `1` (dev auto-reload) by default; set `0` when deploying |
| `PROOFGATE_ALLOWED_ORIGINS` | no | comma-separated CORS origins; default = local dev/preview origins. Set it to your frontend's origin. `*` is not recommended |

Secrets live only in the backend environment / `.env` (git-ignored). Nothing secret is sent to the browser.

**Health check:** `GET /health` → `{"ok": true, "ready": true, "missing_credentials": []}`.
`ready: false` lists the missing key *names* (never values). Use it as the host's health probe.

## Frontend

```bash
cd frontend
npm ci
VITE_API_BASE_URL=https://your-api.example.internal npm run build    # PowerShell: $env:VITE_API_BASE_URL="..."; npm run build
# output: frontend/dist/ — static files, serve with any static host or reverse proxy
npm run preview      # local check of the built site on http://localhost:4173
```

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Origin of the API, baked in at build time. **Public** — never put keys in `VITE_` variables. Leave unset if the same origin serves the API (e.g. a reverse proxy forwarding `/v1` and `/health` to the backend). |

Routing is hash-based (`#/app/...`), so the static host needs no rewrite rules.
If frontend and API are on different origins, add the frontend origin to `PROOFGATE_ALLOWED_ORIGINS`.

## MCP server

`run_mcp.py` is a **local stdio** server for MCP hosts on the same machine. It has no network
transport and is not part of a web deployment.

## Before exposing anything beyond a private network

- [ ] Add authentication (e.g. enforce `PROOFGATE_API_KEY` or an authenticating proxy) for every `/v1` route.
- [ ] Add rate limiting / spend limits for the credit-consuming endpoints.
- [ ] Set `PROOFGATE_ALLOWED_ORIGINS` to the exact frontend origin(s).
- [ ] Serve over HTTPS; keep `PROOFGATE_RELOAD=0`.
- [ ] Back up `PROOFGATE_DB_PATH` (SQLite; single instance only).
