"""Multi-user data isolation: user B can never read, book or order against user A's records.

Runs are created through the real endpoints (pipeline / agent stubbed: no network, no paid calls), so
ownership is assigned exactly as in production — from the verified token, never from the request."""
from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.api.routes as routes
import app.main as main_module
from app.config import Settings
from app.models.schemas import RunRecord
from app.main import app
from app.storage import store

IN_7 = (date.today() + timedelta(days=7)).isoformat()
IN_9 = (date.today() + timedelta(days=9)).isoformat()


def _attempt(cid: str, overall: str, statuses: list[str]) -> dict:
    return {"candidate_id": cid, "candidate_name": cid, "verification": {
        "candidate_id": cid, "overall_status": overall,
        "requirements": [{"requirement_id": f"r{i}", "status": st} for i, st in enumerate(statuses)]}}


def _run(run_id: str, engine: str, action: str) -> dict:
    reqs = [{"id": "r0", "description": "budget", "importance": "required"},
            {"id": "r1", "description": "beachfront", "importance": "required"}]
    cand = lambda cid: {"candidate_id": cid, "name": f"{engine} {cid}", "price": "₹4,000", "price_value": 4000,
                        "currency": "INR", "engine": engine, "source_url": f"https://example.test/{cid}"}
    return {"run_id": run_id, "status": "needs_human_review", "request": "q", "action": action,
            "requirements": reqs, "candidate_count": 3, "candidates": [cand("ok"), cand("unv"), cand("rej")],
            "serpapi_meta": {"engine": engine},
            "attempts": [_attempt("ok", "VERIFIED", ["SATISFIED", "SATISFIED"]),
                         _attempt("unv", "UNVERIFIED", ["SATISFIED", "UNKNOWN"]),
                         _attempt("rej", "REJECTED", ["CONTRADICTED", "SATISFIED"])]}


@pytest.fixture()
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    s = Settings(serpapi_api_key="", llm_api_key="", jev_api_key="", jev_endpoint="", db_path=str(tmp_path / "t.db"),
                 production=True, session_secret="s" * 48)
    monkeypatch.setattr(routes, "settings", s)
    monkeypatch.setattr(main_module, "settings", s)
    pending: list[dict] = []

    def fake_pipeline(request, action, settings, *a, **k):
        data = pending.pop(0)
        store.save_run(settings.db_path, data["run_id"], "2026-10-12T00:00:00+00:00", request, data)
        return RunRecord(**{k2: v for k2, v in data.items() if k2 != "attempts"})
    monkeypatch.setattr(routes, "run_find_and_verify", fake_pipeline)
    c = TestClient(app)

    def account(email: str) -> dict:
        r = c.post("/v1/auth/register", json={"name": email.split("@")[0], "email": email, "password": "a-long-password"})
        assert r.status_code == 201
        return {"Authorization": f"Bearer {r.json()['token']}"}

    a, b = account("alice@example.com"), account("bob@example.com")
    for run_id, engine, action in (("hotelA", "google_hotels", "book_hotel"), ("prodA", "google_shopping", "buy_laptop")):
        pending.append(_run(run_id, engine, action))
        assert c.post("/v1/find-and-verify", json={"request": "Something in Goa"}, headers=a).status_code == 200
    return c, a, b, s


def booking_body(run_id: str = "hotelA", cid: str = "ok", **kw) -> dict:
    return {"run_id": run_id, "candidate_id": cid, "guest_name": "Alice", "email": "alice@example.com",
            "guests": 2, "check_in": IN_7, "check_out": IN_9, **kw}


def order_body(run_id: str = "prodA", cid: str = "ok", **kw) -> dict:
    return {"run_id": run_id, "candidate_id": cid, "buyer_name": "Alice", "email": "alice@example.com",
            "quantity": 1, "delivery_address": "1 Beach Road, Goa", **kw}


def test_runs_belong_to_the_user_who_created_them(world) -> None:
    c, a, b, s = world
    assert {r["run_id"] for r in c.get("/v1/runs", headers=a).json()} == {"hotelA", "prodA"}
    assert c.get("/v1/runs", headers=b).json() == []
    for path in ("/v1/runs/hotelA", "/v1/runs/hotelA/evidence", "/v1/runs/prodA",
                 "/v1/runs/hotelA/candidates/ok/action-context", "/v1/runs/hotelA/candidates/ok/booking-context",
                 "/v1/runs/prodA/candidates/ok/action-context"):
        assert c.get(path, headers=a).status_code == 200, path
        theirs = c.get(path, headers=b)
        assert theirs.status_code == 404, path                     # same answer as a run that doesn't exist
        assert "beachfront" not in theirs.text and "google_" not in theirs.text
    nonexistent = c.get("/v1/runs/nope", headers=b)
    assert nonexistent.status_code == c.get("/v1/runs/hotelA", headers=b).status_code


def test_bookings_cannot_be_made_or_read_across_accounts(world) -> None:
    c, a, b, s = world
    assert c.post("/v1/bookings/preview", json=booking_body(), headers=b).status_code == 404
    assert c.post("/v1/bookings", json=booking_body(), headers=b).status_code == 404
    mine = c.post("/v1/bookings", json=booking_body(), headers=a)
    assert mine.status_code == 200 and mine.json()["simulated"] is True
    bid = mine.json()["booking_id"]
    assert c.get(f"/v1/bookings/{bid}", headers=a).status_code == 200
    assert c.get(f"/v1/bookings/{bid}", headers=b).status_code == 404


def test_orders_cannot_be_made_or_read_across_accounts(world) -> None:
    c, a, b, s = world
    assert c.post("/v1/orders/preview", json=order_body(), headers=b).status_code == 404
    assert c.post("/v1/orders", json=order_body(), headers=b).status_code == 404
    mine = c.post("/v1/orders", json=order_body(), headers=a)
    assert mine.status_code == 200 and mine.json()["simulated"] is True
    oid = mine.json()["order_id"]
    assert c.get(f"/v1/orders/{oid}", headers=a).status_code == 200
    assert c.get(f"/v1/orders/{oid}", headers=b).status_code == 404


def test_owner_still_gets_every_action_safety_check(world) -> None:
    c, a, b, s = world
    rej = c.post("/v1/bookings", json=booking_body(cid="rej", acknowledge_unverified=True), headers=a)
    assert rej.status_code == 409 and rej.json()["detail"]["code"] == "candidate_rejected"
    unv = c.post("/v1/bookings", json=booking_body(cid="unv"), headers=a)
    assert unv.status_code == 409 and unv.json()["detail"]["code"] == "acknowledgement_required"
    assert c.post("/v1/bookings", json=booking_body(cid="unv", acknowledge_unverified=True), headers=a).status_code == 200
    wrong = c.post("/v1/orders", json=order_body(run_id="hotelA"), headers=a)      # hotel result can't be ordered
    assert wrong.status_code == 409 and wrong.json()["detail"]["code"] == "wrong_action_type"
    assert c.post("/v1/orders", json=order_body(cid="rej", acknowledge_unverified=True), headers=a).status_code == 409


def test_ownership_comes_from_the_token_not_the_request(world) -> None:
    c, a, b, s = world
    alice_id = c.get("/v1/auth/me", headers=a).json()["user_id"]
    # extra owner fields in the body are ignored; the run stays invisible to Bob
    r = c.post("/v1/bookings", json={**booking_body(), "owner_id": alice_id, "user_id": alice_id}, headers=b)
    assert r.status_code == 404
    assert c.get("/v1/runs", headers={**b, "X-User-Id": alice_id}).json() == []


def test_chat_history_and_chat_runs_are_per_account(world, monkeypatch: pytest.MonkeyPatch) -> None:
    c, a, b, s = world
    seen: list[tuple] = []

    def fake_turn(message, session_id, settings, emit=None, owner=None):
        seen.append((session_id, owner))
        rid = f"chat{len(seen)}"                                # each turn's pipeline makes a new run
        store.save_run(settings.db_path, rid, "2026-10-12T01:00:00+00:00", message, _run(rid, "google_hotels", "book_hotel"))
        return {"reply": "ok", "run_id": rid, "session_id": session_id or "sess1"}
    monkeypatch.setattr(routes, "run_agent_turn", fake_turn)
    assert c.post("/v1/agent/chat", json={"message": "Hotel in Goa", "session_id": "sess1"}, headers=a).status_code == 200
    assert c.post("/v1/agent/chat", json={"message": "hi", "session_id": "sess1"}, headers=b).status_code == 200
    alice_id, bob_id = (c.get("/v1/auth/me", headers=h).json()["user_id"] for h in (a, b))
    assert seen == [("sess1", alice_id), ("sess1", bob_id)]    # same session_id, different owners
    assert c.get("/v1/runs/chat1", headers=a).status_code == 200
    assert c.get("/v1/runs/chat1", headers=b).status_code == 404
    assert c.get("/v1/runs/chat2", headers=b).status_code == 200
    assert c.get("/v1/runs/chat2", headers=a).status_code == 404

    from app.services.agent import _history_key
    store.save_turn(s.db_path, _history_key("sess1", alice_id), "user", "my secret plans")
    assert store.get_history(s.db_path, _history_key("sess1", bob_id)) == []


def test_streamed_chat_runs_are_claimed_by_the_caller(world, monkeypatch: pytest.MonkeyPatch) -> None:
    c, a, b, s = world

    def fake_sse(message, session_id, settings, owner=None):
        store.save_run(settings.db_path, "streamA", "2026-10-12T02:00:00+00:00", message, _run("streamA", "google_hotels", "book_hotel"))
        yield {"type": "final", "run_id": "streamA", "status": "needs_human_review"}
    monkeypatch.setattr(routes, "sse_turn", fake_sse)
    with c.stream("GET", "/v1/agent/chat/stream", params={"message": "Hotel in Goa"}, headers=a) as r:
        assert r.status_code == 200 and "streamA" in "".join(r.iter_text())
    assert c.get("/v1/runs/streamA", headers=a).status_code == 200
    assert c.get("/v1/runs/streamA", headers=b).status_code == 404


def test_a_claim_never_moves_someone_elses_run(world) -> None:
    c, a, b, s = world
    alice_id, bob_id = (c.get("/v1/auth/me", headers=h).json()["user_id"] for h in (a, b))
    store.claim_run(s.db_path, "hotelA", bob_id)              # e.g. a stale/duplicate claim
    assert store.get_run(s.db_path, "hotelA", alice_id) is not None
    assert store.get_run(s.db_path, "hotelA", bob_id) is None


def test_legacy_unowned_runs_are_kept_but_hidden_from_accounts(world) -> None:
    c, a, b, s = world
    store.save_run(s.db_path, "legacy", "2025-01-01T00:00:00+00:00", "old", _run("legacy", "google_hotels", "book_hotel"))
    assert c.get("/v1/runs/legacy", headers=a).status_code == 404
    assert store.get_run(s.db_path, "legacy") is not None     # still stored, visible to local tooling
    local = replace(s, production=False, session_secret="")
    routes.settings = local                                     # local development (no sign-in) sees everything
    assert c.get("/v1/runs/legacy").status_code == 200


def test_resaving_a_run_never_changes_its_owner(world) -> None:
    c, a, b, s = world
    alice_id = c.get("/v1/auth/me", headers=a).json()["user_id"]
    store.save_run(s.db_path, "hotelA", "2026-10-12T03:00:00+00:00", "q", _run("hotelA", "google_hotels", "book_hotel"))
    assert store.get_run(s.db_path, "hotelA", alice_id) is not None
    assert c.get("/v1/runs/hotelA", headers=b).status_code == 404
