"""Public ranking reasons are Jev-status text, never the raw ranker claim — no network.

The LLM ranker writes its reason before Jev runs ("meets all requirements")
and Jev can later find requirements UNKNOWN or CONTRADICTED. These tests run
the REAL pipeline/routes/MCP adapter with the four external services stubbed.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.api.routes as routes
import app.main as main_module
from app.config import Settings
from app.main import app
from app.mcp import adapter
from app.models.schemas import (
    Candidate,
    ParsedRequest,
    RankedCandidate,
    RankingResult,
    Requirement,
    RequirementVerdict,
    VerificationResult,
)
from app.services import pipeline, rank_reasons
from app.storage import store

RAW = "meets all requirements"
VERIFIED_TEXT = "Ranked as a relevant candidate; all required points verified."
UNVERIFIED_TEXT = "Ranked as a relevant candidate; some required points remain unverified."
REJECTED_TEXT = "Ranked as a relevant candidate; rejected because at least one required point was contradicted."
UNCHECKED_TEXT = "Ranked as a relevant candidate; not yet verified."

REQS = [Requirement(id="budget", description="Price <= 10000"),
        Requirement(id="beachfront", description="Beachfront")]
# rank order c1..c4; c4 is never checked because c3 is VERIFIED first
VERDICTS = {
    "c1": ("REJECTED", [("budget", "CONTRADICTED"), ("beachfront", "UNKNOWN")]),
    "c2": ("UNVERIFIED", [("budget", "SATISFIED"), ("beachfront", "UNKNOWN")]),
    "c3": ("VERIFIED", [("budget", "SATISFIED"), ("beachfront", "SATISFIED")]),
}
EXPECTED = {"c1": REJECTED_TEXT, "c2": UNVERIFIED_TEXT, "c3": VERIFIED_TEXT, "c4": UNCHECKED_TEXT}


@pytest.fixture()
def settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    s = Settings(serpapi_api_key="", llm_api_key="", jev_api_key="", jev_endpoint="",
                 db_path=str(tmp_path / "test.db"))
    store.init_db(s.db_path)
    cands = [Candidate(candidate_id=f"c{i}", name=f"Hotel {i}") for i in range(1, 5)]
    m = pipeline
    monkeypatch.setattr(m.requirement_parser, "parse_requirements",
                        lambda req, st: ParsedRequest(request=req, requirements=REQS))
    monkeypatch.setattr(m.serpapi_service, "search_serpapi",
                        lambda *a, **k: (cands, {"engine": "google_hotels"}, {}))
    monkeypatch.setattr(m.llm_matcher, "rank_candidates", lambda *a, **k: (RankingResult(ranked_candidates=[
        RankedCandidate(candidate_id=c.candidate_id, rank=i + 1, reason=f"{c.name} {RAW}: beachfront, breakfast.")
        for i, c in enumerate(cands)]), {"model": "stub"}))

    def fake_verify(requirements, c, st):
        overall, pairs = VERDICTS[c.candidate_id]
        return VerificationResult(candidate_id=c.candidate_id, overall_status=overall,
                                  requirements=[RequirementVerdict(requirement_id=k, status=v) for k, v in pairs])

    monkeypatch.setattr(m.jev_verifier, "verify_candidate", fake_verify)
    # API + MCP use the same isolated settings
    monkeypatch.setattr(routes, "settings", s)
    monkeypatch.setattr(main_module, "settings", s)
    monkeypatch.setattr(adapter, "load_settings", lambda: s)
    return s


def _reasons(ranked: list) -> dict[str, str]:
    return {rc["candidate_id"]: rc["reason"] for rc in ranked}


def _assert_status_reasons(ranked: list) -> None:
    assert [rc["candidate_id"] for rc in ranked] == ["c1", "c2", "c3", "c4"]  # order preserved
    assert [rc["rank"] for rc in ranked] == [1, 2, 3, 4]
    assert _reasons(ranked) == EXPECTED


def test_reason_for_each_status() -> None:
    assert rank_reasons.reason_for("VERIFIED") == VERIFIED_TEXT
    assert rank_reasons.reason_for("UNVERIFIED") == UNVERIFIED_TEXT
    assert rank_reasons.reason_for("REJECTED") == REJECTED_TEXT
    assert rank_reasons.reason_for(None) == UNCHECKED_TEXT
    assert rank_reasons.reason_for("bogus") == UNCHECKED_TEXT


def test_pipeline_record_and_stream_events(settings: Settings) -> None:
    events: list[dict] = []
    rec = pipeline.run_find_and_verify("goa", "book_hotel", settings, on_event=events.append)
    # decision and verdicts unchanged
    assert rec.status == "verified" and rec.selected_candidate.candidate_id == "c3"
    assert [(a.candidate_id, a.verification.overall_status) for a in rec.attempts] == [
        ("c1", "REJECTED"), ("c2", "UNVERIFIED"), ("c3", "VERIFIED")]
    _assert_status_reasons([rc.model_dump() for rc in rec.ranked_candidates])
    # the ranking SSE event fires before any verification -> all unchecked
    ranking = [e for e in events if e["type"] == "ranking"]
    assert len(ranking) == 1
    assert {rc["reason"] for rc in ranking[0]["ranked_candidates"]} == {UNCHECKED_TEXT}
    assert RAW not in json.dumps(events)


def test_api_responses_never_expose_raw_ranker_reason(settings: Settings) -> None:
    client = TestClient(app)
    resp = client.post("/v1/find-and-verify", json={"request": "goa"})
    assert resp.status_code == 200
    body = resp.json()
    _assert_status_reasons(body["ranked_candidates"])
    run_id = body["run_id"]

    run = client.get(f"/v1/runs/{run_id}")
    _assert_status_reasons(run.json()["ranked_candidates"])
    evidence = client.get(f"/v1/runs/{run_id}/evidence")
    for r in (resp, run, evidence):
        assert RAW not in r.text


def test_mcp_adapter_never_exposes_raw_ranker_reason(settings: Settings) -> None:
    rec = adapter.find_and_verify("goa", "book_hotel")
    _assert_status_reasons([rc.model_dump() for rc in rec.ranked_candidates])
    _assert_status_reasons(adapter.get_run(rec.run_id)["ranked_candidates"])
    for out in (rec.model_dump(), adapter.get_run(rec.run_id), adapter.get_evidence(rec.run_id)):
        assert RAW not in json.dumps(out, default=str)


def test_runs_stored_before_fix_are_relabelled_on_read(settings: Settings) -> None:
    """Legacy rows in the db still hold raw ranker text; reads must relabel them."""
    def attempt(cid: str) -> dict:
        overall, pairs = VERDICTS[cid]
        return {"candidate_id": cid, "candidate_name": cid, "verification": {
            "candidate_id": cid, "overall_status": overall,
            "requirements": [{"requirement_id": k, "status": v} for k, v in pairs]}}

    legacy = {"run_id": "legacy1", "status": "verified",
              "ranked_candidates": [{"candidate_id": f"c{i}", "rank": i, "reason": f"Hotel {i} {RAW}"}
                                    for i in range(1, 5)],
              "attempts": [attempt(c) for c in ("c1", "c2", "c3")]}
    store.save_run(settings.db_path, "legacy1", "2026-01-01T00:00:00+00:00", "goa", legacy)

    api = TestClient(app).get("/v1/runs/legacy1")
    _assert_status_reasons(api.json()["ranked_candidates"])
    assert RAW not in api.text
    _assert_status_reasons(adapter.get_run("legacy1")["ranked_candidates"])
