"""Deterministic chat status summary — no network calls.

Regression for a run where the composer LLM claimed "all the candidates
are UNVERIFIED" while 4 of 15 were REJECTED: the status block is now
computed from the attempt records and appended to the reply verbatim.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings
from app.models.schemas import (
    AttemptRecord,
    Candidate,
    RankedCandidate,
    RequirementVerdict,
    RunRecord,
    VerificationResult,
)
from app.services import agent
from app.storage import store


def _attempt(cid: str, overall: str, pairs: list[tuple[str, str]]) -> AttemptRecord:
    v = [RequirementVerdict(requirement_id=k, status=s) for k, s in pairs]  # type: ignore[arg-type]
    return AttemptRecord(candidate_id=cid, candidate_name=f"Hotel {cid}",
                         verification=VerificationResult(candidate_id=cid, overall_status=overall,  # type: ignore[arg-type]
                                                         requirements=v))


def _record(attempts: list[AttemptRecord], status: str = "needs_human_review") -> RunRecord:
    first = attempts[0]
    return RunRecord(
        run_id="run1", status=status, request="q", action="book_hotel",  # type: ignore[arg-type]
        requirements=[], candidate_count=len(attempts),
        ranked_candidates=[RankedCandidate(candidate_id=a.candidate_id, rank=i + 1)
                           for i, a in enumerate(attempts)],
        selected_candidate=Candidate(candidate_id=first.candidate_id, name=first.candidate_name),
        verification=first.verification, attempts=attempts,
    )


UNV = [("budget", "SATISFIED"), ("beachfront", "UNKNOWN")]


def test_mixed_statuses_produce_exact_counts() -> None:
    rec = _record([
        _attempt("c1", "UNVERIFIED", UNV),
        _attempt("c2", "REJECTED", [("budget", "SATISFIED"), ("breakfast_included", "CONTRADICTED")]),
        _attempt("c3", "UNVERIFIED", UNV),
    ])
    assert agent._status_counts(rec.attempts) == {"VERIFIED": 0, "UNVERIFIED": 2, "REJECTED": 1}
    block = agent._status_summary(rec)
    assert "3 of 3 candidates checked by Jev): VERIFIED 0, UNVERIFIED 2, REJECTED 1." in block
    assert "- Hotel c2 (c2): breakfast_included contradicted" in block
    assert "c1" not in block.split("Rejected")[1]  # only rejected candidates listed


def test_counts_cover_only_checked_candidates_when_verified_early() -> None:
    rec = _record([_attempt("c1", "VERIFIED", [("budget", "SATISFIED")])], status="verified")
    rec.candidate_count = 15
    block = agent._status_summary(rec)
    assert block == "Verification status (1 of 15 candidates checked by Jev): VERIFIED 1, UNVERIFIED 0, REJECTED 0."


def test_no_attempts_gives_no_status_block() -> None:
    rec = RunRecord(run_id="r", status="no_verified_match", request="q", action="a",
                    requirements=[], candidate_count=0)
    assert agent._status_summary(rec) == ""
    assert agent._with_status_summary("reply", rec) == "reply"


def _seven_with_rejected_last() -> RunRecord:
    attempts = [_attempt(f"c{i}", "UNVERIFIED", UNV) for i in range(1, 7)]
    attempts.append(_attempt("c7", "REJECTED", [("budget", "CONTRADICTED"), ("beachfront", "UNKNOWN")]))
    return _record(attempts)


def test_rejected_candidate_outside_top_five_is_in_trace_summary() -> None:
    summary = agent._trace_summary_for_record(_seven_with_rejected_last())
    assert "Rank order (top): c1, c2, c3, c4, c5." in summary  # c7 is not in the top 5 ...
    assert "UNVERIFIED 6, REJECTED 1" in summary                # ... but is counted
    assert "- Hotel c7 (c7): budget contradicted" in summary
    assert "Jev verified c7 (Hotel c7): REJECTED" in summary


@pytest.fixture()
def stubbed_agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Stub router/composer/pipeline; the composer repeats the original false claim."""
    settings = Settings(serpapi_api_key="", llm_api_key="", jev_api_key="", jev_endpoint="",
                        db_path=str(tmp_path / "test.db"))
    store.init_db(settings.db_path)
    rec = _seven_with_rejected_last()
    monkeypatch.setattr(agent, "router_llm", lambda *a, **k: {
        "needs_search": True, "action": "book_hotel", "engine": "google_hotels", "note": ""})
    monkeypatch.setattr(agent, "composer_llm",
                        lambda *a, **k: "All the candidates returned are UNVERIFIED.")
    monkeypatch.setattr(agent, "run_find_and_verify", lambda *a, **k: rec)
    return settings


def test_reply_carries_deterministic_counts_despite_llm_generalization(stubbed_agent: Settings) -> None:
    out = agent.run_agent_turn("hotel in Goa", None, stubbed_agent)
    assert out["reply"].startswith("All the candidates returned are UNVERIFIED.")
    assert "VERIFIED 0, UNVERIFIED 6, REJECTED 1." in out["reply"]
    assert "- Hotel c7 (c7): budget contradicted" in out["reply"]
    assert out["status"] == "needs_human_review"


def test_stream_final_reply_carries_deterministic_counts(stubbed_agent: Settings) -> None:
    final = [ev for ev in agent.sse_turn("hotel in Goa", None, stubbed_agent)
             if isinstance(ev, dict) and ev.get("type") == "final"]
    assert len(final) == 1
    assert "VERIFIED 0, UNVERIFIED 6, REJECTED 1." in final[0]["reply"]
    assert "- Hotel c7 (c7): budget contradicted" in final[0]["reply"]
