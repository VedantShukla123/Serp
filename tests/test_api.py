"""API tests — no network calls.

Without credentials the pipeline must FAIL LOUDLY (502 + credential
detail), never return a fabricated result. The happy-path wiring is
covered with stubbed service functions returning realistic,
in-test-constructed records.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.api.routes as routes
import app.main as main_module
from app.config import Settings
from app.main import app
from app.models.schemas import (
    AttemptRecord,
    Candidate,
    RankedCandidate,
    Requirement,
    RequirementVerdict,
    RunRecord,
    VerificationResult,
)
from app.storage import store

GOA_REQUEST: str = (
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


def test_health_reports_missing_credentials(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["ready"] is False
    assert "SERPAPI_API_KEY" in body["missing_credentials"]
    assert "LLM_API_KEY" in body["missing_credentials"]


def test_find_and_verify_without_keys_is_502(client: TestClient) -> None:
    resp = client.post("/v1/find-and-verify", json={"request": GOA_REQUEST, "action": "search"})
    assert resp.status_code == 502
    assert "SERPAPI_API_KEY" in resp.json()["detail"] or "LLM_API_KEY" in resp.json()["detail"]


def test_verify_without_keys_is_502(client: TestClient) -> None:
    resp = client.post(
        "/v1/verify",
        json={
            "requirements": [{"id": "x", "description": "X", "importance": "required"}],
            "candidate": {"candidate_id": "c1", "name": "N"},
        },
    )
    assert resp.status_code == 502
    assert "LLM_API_KEY" in resp.json()["detail"] or "JEV" in resp.json()["detail"]


def _stub_record() -> RunRecord:
    reqs = [
        Requirement(id="budget", description="Price <= 10000", importance="required"),
        Requirement(id="beachfront", description="Beachfront", importance="required"),
    ]
    cands = [
        Candidate(candidate_id="c1", name="A", price_value=9000.0),
        Candidate(candidate_id="c2", name="C", price_value=8000.0),
    ]
    ranked = [
        RankedCandidate(candidate_id="c1", rank=1, reason="stub"),
        RankedCandidate(candidate_id="c2", rank=2, reason="stub"),
    ]
    attempts = [
        AttemptRecord(candidate_id="c1", candidate_name="A", verification=VerificationResult(
            candidate_id="c1", overall_status="UNVERIFIED",
            requirements=[RequirementVerdict(requirement_id="budget", status="SATISFIED"),
                          RequirementVerdict(requirement_id="beachfront", status="UNKNOWN")])),
        AttemptRecord(candidate_id="c2", candidate_name="C", verification=VerificationResult(
            candidate_id="c2", overall_status="VERIFIED",
            requirements=[RequirementVerdict(requirement_id="budget", status="SATISFIED"),
                          RequirementVerdict(requirement_id="beachfront", status="SATISFIED")])),
    ]
    return RunRecord(
        run_id="stubrun123", status="verified", request=GOA_REQUEST, action="search",
        requirements=reqs, candidate_count=2, candidates=cands, ranked_candidates=ranked,
        selected_candidate=cands[1], verification=attempts[1].verification,
        attempts=attempts, created_at="2026-01-01T00:00:00+00:00",
    )


def test_pipeline_wiring_with_stubbed_services(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """API serialization + persistence wiring with a realistic record."""
    rec = _stub_record()

    def fake_run(request: str, action: str, settings: Settings,
                 max_candidates: int = 15, engine: str | None = None) -> RunRecord:
        store.save_run(settings.db_path, rec.run_id, rec.created_at, request, rec.model_dump())
        return rec

    monkeypatch.setattr(routes, "run_find_and_verify", fake_run)
    body = client.post("/v1/find-and-verify", json={"request": GOA_REQUEST}).json()
    assert body["run_id"] == "stubrun123"
    assert body["status"] == "verified"
    assert body["selected_candidate"]["candidate_id"] == "c2"
    assert len(body["attempts"]) == 2

    assert client.get("/v1/runs/stubrun123").json()["run_id"] == "stubrun123"
    ev = client.get("/v1/runs/stubrun123/evidence").json()
    assert ev["run_id"] == "stubrun123" and "candidates" in ev and "attempts" in ev


def test_unknown_run_404(client: TestClient) -> None:
    assert client.get("/v1/runs/does-not-exist").status_code == 404
    assert client.get("/v1/runs/does-not-exist/evidence").status_code == 404
