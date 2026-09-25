# ProofGate — Search finds candidates. ProofGate finds the one that actually fits.

Locked workflow: `USER → API → requirements → SerpApi → complete candidates → LLM rank → Jev verify (#1, then fallback) → VERIFIED / NO VERIFIED MATCH`.

Works for any constraint-heavy live-search task — hotels, laptops, flights, products — the SerpApi engine is auto-picked per request (`google_hotels` / `google_shopping` / `google_flights` / `google`, overridable per call).

## Setup (real keys required)

There is no demo/mock data anywhere in the product. Without credentials the
pipeline fails loudly with a clear system error instead of a fake result.

```bash
pip install -r requirements.txt
cp .env.example .env   # set SERPAPI_API_KEY + LLM_API_KEY (required)
```

## Use it

```bash
python run.py "Find me the best hotel in Goa under Rs 10000 for 2 people, beachfront, breakfast included and free cancellation."
python run.py --action buy_laptop "Find me a laptop under Rs 90000 with 32GB RAM, 1TB SSD, OLED, RTX 4060 and under 2kg."
python run.py --serve   # API on :8000
cd frontend && npm install && npm run dev  # UI on :5173, proxies /v1
```

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
