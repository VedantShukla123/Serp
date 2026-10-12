# proofgate_client — local Python client

A small REST client for a **locally running** ProofGate API. It lives in this
repository and is **not published** to PyPI. It needs only `httpx`, which is
already in `requirements.txt`.

```python
# run from the repository root (or add the repo to PYTHONPATH)
from proofgate_client import ProofGateClient, ProofGateNotFound

with ProofGateClient("http://localhost:8000") as pg:
    print(pg.health()["ready"])              # free
    for r in pg.list_runs(limit=5):          # free
        print(r["run_id"], r["request"])
    run = pg.get_run("c28bb2b65036")         # free; ProofGateNotFound if unknown
    print(run["status"], len(run["attempts"]))
    ev = pg.get_evidence(run["run_id"])      # free

    # Uses external API credits (SerpApi + LLM + Jev):
    # result = pg.find_and_verify("Hotel in Goa under Rs 10,000 for 2 people", action="book_hotel")
```

| Method | Endpoint | Cost |
|---|---|---|
| `health()` | `GET /health` | free |
| `list_runs(limit=50)` | `GET /v1/runs` | free |
| `get_run(run_id)` | `GET /v1/runs/{run_id}` | free |
| `get_evidence(run_id)` | `GET /v1/runs/{run_id}/evidence` | free |
| `find_and_verify(request, action="search", max_candidates=15, engine=None)` | `POST /v1/find-and-verify` | uses credits |
| `verify(requirements, candidate)` | `POST /v1/verify` | uses credits |

Errors: `ProofGateConnectionError` (not running / timeout), `ProofGateNotFound`
(404), `ProofGateHTTPError` (any other non-2xx; `.status_code`, `.detail`).
Upstream failures (e.g. a missing API key → 502) are raised, never returned as results.

No authentication is sent: the local API does not check any key. Keep it on your machine.
Tests: `python -m pytest tests/test_python_client.py` (mocked HTTP, no network).
