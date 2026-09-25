"""Agent chat tests — no network calls.

Contract under test (teammate-owned, not yet landed at time of writing):
  app/services/agent.py defines router_llm, composer_llm, run_agent_turn
  and sse_turn (emitting status/requirements/searching/candidates/
  ranking/verifying/verdict/final/error events), and app/api/routes.py
  exposes them as POST /v1/agent/chat and GET /v1/agent/chat/stream.

These tests stub the agent functions via monkeypatch on the
app.api.routes namespace (same pattern as tests/test_api.py), so no
LLM/SerpApi/Jev call is ever made. If the agent module/routes have not
landed yet, these tests fail with an explicit CONTRACT message — that
is intentional: do NOT "fix" them by editing app/ files.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.api.routes as routes
import app.main as main_module
from app.config import Settings
from app.main import app
from app.storage import store

CHAT_MESSAGE: str = (
    "Find me a hotel in Goa under Rs 10000 for 2 people, "
    "beachfront, breakfast included and free cancellation."
)


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """TestClient with empty credentials and an isolated SQLite db."""
    keyless = Settings(
        serpapi_api_key="",
        llm_api_key="",
        jev_api_key="",
        jev_endpoint="",
        db_path=str(tmp_path / "test.db"),
    )
    monkeypatch.setattr(routes, "settings", keyless)
    monkeypatch.setattr(main_module, "settings", keyless)
    store.init_db(keyless.db_path)
    return TestClient(app)


def _require_agent_contract() -> None:
    """Fail loudly (not with a bare AttributeError) if the teammate's
    agent wiring has not landed in app.api.routes yet."""
    missing = [
        name for name in ("run_agent_turn", "sse_turn")
        if not hasattr(routes, name)
    ]
    assert not missing, (
        "AGENT CONTRACT MISSING (teammate still working?): "
        f"app.api.routes has no {missing}; expected run_agent_turn/sse_turn "
        "imported from app/services/agent.py plus routes "
        "POST /v1/agent/chat and GET /v1/agent/chat/stream."
    )


def test_chat_rejects_empty_message(client: TestClient) -> None:
    resp = client.post("/v1/agent/chat", json={"message": ""})
    assert resp.status_code == 422, (
        f"empty chat message must be rejected with 422, got {resp.status_code}: "
        f"{resp.text[:200]} (is POST /v1/agent/chat registered?)"
    )


def test_chat_direct_answer_mode(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """router_llm decides no live data is needed -> composer_llm answers directly."""
    _require_agent_contract()

    def fake_run_agent_turn(*args, **kwargs):
        return {
            "mode": "direct",
            "reply": "Paris is the capital of France.",
            "session_id": "sess-direct-1",
            "selected_candidate": None,
        }

    monkeypatch.setattr(routes, "run_agent_turn", fake_run_agent_turn)
    resp = client.post("/v1/agent/chat", json={"message": "What is the capital of France?"})
    assert resp.status_code == 200, f"got {resp.status_code}: {resp.text[:200]}"
    body = resp.json()
    assert body["reply"] == "Paris is the capital of France."
    assert body["session_id"] == "sess-direct-1"


def test_chat_search_mode_verified_match(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """router_llm routes to the pipeline; verified record shape comes back
    with a selected_candidate the client can render/act on."""
    _require_agent_contract()

    def fake_run_agent_turn(*args, **kwargs):
        return {
            "mode": "search",
            "reply": "Verified: C satisfies budget and beachfront.",
            "session_id": "sess-search-1",
            "status": "verified",
            "selected_candidate": {
                "candidate_id": "c2",
                "name": "C",
                "price_value": 8000.0,
            },
            "verification": {
                "candidate_id": "c2",
                "overall_status": "VERIFIED",
                "requirements": [
                    {"requirement_id": "budget", "status": "SATISFIED"},
                    {"requirement_id": "beachfront", "status": "SATISFIED"},
                ],
            },
        }

    monkeypatch.setattr(routes, "run_agent_turn", fake_run_agent_turn)
    resp = client.post("/v1/agent/chat", json={"message": CHAT_MESSAGE})
    assert resp.status_code == 200, f"got {resp.status_code}: {resp.text[:200]}"
    body = resp.json()
    assert body["session_id"] == "sess-search-1"
    assert body["selected_candidate"] is not None
    assert body["selected_candidate"]["candidate_id"] == "c2"


def test_chat_stream_emits_sse_with_final_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _require_agent_contract()

    def fake_sse_turn(*args, **kwargs):
        yield 'event: status\ndata: {"phase": "searching"}\n\n'
        yield 'event: final\ndata: {"reply": "done", "session_id": "sess-sse-1"}\n\n'

    monkeypatch.setattr(routes, "sse_turn", fake_sse_turn)
    resp = client.get("/v1/agent/chat/stream", params={"message": CHAT_MESSAGE})
    assert resp.status_code == 200, f"got {resp.status_code}: {resp.text[:200]}"
    assert "text/event-stream" in resp.headers.get("content-type", ""), (
        f"stream must be text/event-stream, got {resp.headers.get('content-type')!r}"
    )
    assert "event: final" in resp.text


def test_chat_upstream_error_is_502(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Upstream failure (e.g. missing SERPAPI_API_KEY) surfaces as a 502
    system error, never as a chat answer."""
    _require_agent_contract()

    def fake_run_agent_turn(*args, **kwargs):
        raise RuntimeError("SERPAPI_API_KEY is not set")

    monkeypatch.setattr(routes, "run_agent_turn", fake_run_agent_turn)
    resp = client.post("/v1/agent/chat", json={"message": CHAT_MESSAGE})
    assert resp.status_code == 502
    assert "SERPAPI_API_KEY" in resp.json()["detail"]
