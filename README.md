# ProofGate — Search finds candidates. ProofGate finds the one that actually fits.

Locked workflow: `USER → API → requirements → SerpApi → complete candidates → LLM rank → Jev verify (#1, then fallback) → VERIFIED / human-review best match`.

Works for any constraint-heavy live-search task — hotels, laptops, flights, restaurants, products — the SerpApi engine is auto-picked per request (`google_hotels` / `google_shopping` / `google_flights` / `google_maps` / `google`, overridable per call).

## Run it locally (5 minutes)

**1. Clone + backend deps** (Python 3.10+):

```bash
git clone git@github.com:atharvb7/serpapi-hackthon.git
cd serpapi-hackthon
pip install -r requirements.txt
```

**2. Add API keys** — copy the template and fill 3 keys:

```bash
cp .env.example .env
```

| Key | Where to get it | Required? |
|---|---|---|
| `SERPAPI_API_KEY` | [serpapi.com/dashboard](https://serpapi.com/dashboard) (free: 100 searches/month) | Yes |
| `LLM_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) (any OpenAI-compatible key works via `LLM_BASE_URL`) | Yes |
| `JEV_API_KEY` | [console.typesafe.ai/keys](https://console.typesafe.ai/keys) | Yes (official TypeSafe Jev adjudication) |

`.env` is gitignored — keys never leave your machine.

**3. Start the API** (http://localhost:8000):

```bash
python run.py --serve
```

Check `GET /health` → `"ready": true`. If a key is missing it tells you exactly which one.

**4. Start the UI** (http://localhost:5173, new terminal):

```bash
cd frontend && npm install && npm run dev
```

That's it — ask anything that needs a verified answer and watch the search → rank → verify trace stream live.

**Prefer the terminal?** Skip step 4 and run:

```bash
python run.py "Find me the best hotel in Goa under Rs 10000 for 2 people, beachfront, breakfast included and free cancellation."
```

## Notes

There is no demo/mock data anywhere. Without credentials the pipeline fails
loudly with a clear system error instead of a fake result.

## API

- `POST /v1/find-and-verify` `{request, action?, max_candidates?, engine?}`
- `POST /v1/verify` `{requirements, candidate}`
- `GET /v1/runs/{run_id}`, `GET /v1/runs/{run_id}/evidence`, `GET /v1/runs`, `GET /health`

`GET /health` reports `ready` plus any `missing_credentials`. Upstream failures
surface as 502 system errors — never as verification results.

Statuses: candidate `VERIFIED` (all required SATISFIED) / `REJECTED` (any required CONTRADICTED) / `UNVERIFIED` (else, i.e. required UNKNOWN). Run `verified` / `needs_human_review` (best match returned with flagged points, never labeled verified) / `no_verified_match` (nothing retrieved to return) / `error`. UNKNOWN is never collapsed into CONTRADICTED.

## Agent chat

Conversational front-end over the same pipeline (`app/services/pipeline.py` + `app/storage/store.py` stay the source of truth).

How chat routing works:

- `router_llm` classifies each turn: **direct-answer** when no live data is
  needed (greetings, general knowledge, follow-ups answerable from history)
  vs **search** when the user needs something in the world right now.
- **Search mode** runs the locked pipeline: SerpApi discovers candidates
  when live data is needed, LLM ranks them, and **Jev verifies the decision**
  per requirement before anything is presented as fitting. A best match that
  cannot be fully verified is returned flagged for human review — never
  labeled verified.
- `composer_llm` turns the turn outcome (direct answer or pipeline record)
  into the user-facing reply.

Endpoints:

```bash
# One chat turn (200: {reply, session_id, mode, ...}; 422 on empty message;
# 502 on upstream failure)
curl -s localhost:8000/v1/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "Hotel in Goa under Rs 10000, beachfront, free cancellation"}'

# Follow-up in the same session
curl -s localhost:8000/v1/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "Does it include breakfast?", "session_id": "<session_id>"}'

# Streaming trace (Server-Sent Events)
curl -N 'localhost:8000/v1/agent/chat/stream?message=Hotel%20in%20Goa%20under%20Rs%2010000'
```

SSE event list (in order): `status`, `requirements`, `searching`,
`candidates`, `ranking`, `verifying`, `verdict`, `final` (plus `error` when
the turn fails upstream).

Session behavior: every reply carries a `session_id`. Pass it back on the
next turn to continue the conversation (history + follow-ups resolve against
it); omit it to start a fresh session.

## SerpApi hackathon

What to demo: ask anything ("laptop under Rs 90000 with 32GB RAM and OLED",
"beachfront hotel in Goa under Rs 10000") → watch the live
search → rank → verify trace stream back over SSE → get back the **verified
or flagged best match** with per-requirement verdicts. The punchline vs plain
search: SerpApi finds candidates, ProofGate proves which one actually fits —
`VERIFIED` means every required constraint was checked, anything else is
explicitly flagged for a human instead of silently passed through.
