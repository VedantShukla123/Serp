"""Verifier-logic tests — pure decision rules, no network.

The conservative local mock verifier was REMOVED (no dummy data in the
product). Requirement-level semantics now live in
app.services.jev_verifier.overall_status, tested here, plus loud-failure
guards on every service entrypoint without credentials.
"""
from __future__ import annotations

import pytest

from app.config import Settings
from app.models.schemas import Candidate, Requirement, RequirementVerdict
from app.services import jev_verifier, llm_matcher, requirement_parser, serpapi_service


def keyless() -> Settings:
    return Settings(serpapi_api_key="", llm_api_key="", jev_api_key="", jev_endpoint="")


def req(rid: str, importance: str = "required") -> Requirement:
    return Requirement(id=rid, description=rid, importance=importance)  # type: ignore[arg-type]


def v(rid: str, status: str) -> RequirementVerdict:
    return RequirementVerdict(requirement_id=rid, status=status)  # type: ignore[arg-type]


def test_all_required_satisfied_is_verified() -> None:
    r = [req("a"), req("b")]
    assert jev_verifier.overall_status(r, [v("a", "SATISFIED"), v("b", "SATISFIED")]) == "VERIFIED"


def test_required_contradicted_is_rejected() -> None:
    r = [req("a"), req("b")]
    assert jev_verifier.overall_status(r, [v("a", "SATISFIED"), v("b", "CONTRADICTED")]) == "REJECTED"


def test_required_unknown_is_unverified_not_rejected() -> None:
    r = [req("a"), req("b")]
    assert jev_verifier.overall_status(r, [v("a", "SATISFIED"), v("b", "UNKNOWN")]) == "UNVERIFIED"


def test_preferred_unknown_and_contradicted_are_non_blocking() -> None:
    r = [req("a"), req("p", "preferred")]
    assert jev_verifier.overall_status(r, [v("a", "SATISFIED"), v("p", "UNKNOWN")]) == "VERIFIED"
    assert jev_verifier.overall_status(r, [v("a", "SATISFIED"), v("p", "CONTRADICTED")]) == "VERIFIED"


def test_unknown_requirement_id_defaults_to_required() -> None:
    r = [req("a")]
    assert jev_verifier.overall_status(r, [v("a", "SATISFIED"), v("zzz", "UNKNOWN")]) == "UNVERIFIED"


def test_services_fail_loudly_without_credentials() -> None:
    s = keyless()
    cand = Candidate(candidate_id="c1", name="N")
    with pytest.raises(RuntimeError, match="SERPAPI_API_KEY"):
        serpapi_service.search_serpapi("hotels in Goa", "search", s)
    with pytest.raises(RuntimeError, match="LLM_API_KEY"):
        requirement_parser.parse_requirements("hotels in Goa", s)
    with pytest.raises(RuntimeError, match="LLM_API_KEY"):
        llm_matcher.rank_candidates("q", [req("a")], [cand], s)
    with pytest.raises(RuntimeError, match="[Ll]lm|JEV|verifier"):
        jev_verifier.verify_candidate([req("a")], cand, s)


def test_noul_threshold_mapping() -> None:
    f = jev_verifier.noul_to_status
    assert f(0.95, 0.75, 0.25) == "SATISFIED"
    assert f(0.75, 0.75, 0.25) == "SATISFIED"  # boundary inclusive
    assert f(0.50, 0.75, 0.25) == "UNKNOWN"  # middle band never contradicts
    assert f(0.25, 0.75, 0.25) == "CONTRADICTED"  # boundary inclusive
    assert f(0.05, 0.75, 0.25) == "CONTRADICTED"


def test_typesafe_jev_mapping_with_stubbed_http(monkeypatch: pytest.MonkeyPatch) -> None:
    """Official TypeSafe shape in/out: one call, parallel Noul answers."""
    seen: dict = {}

    class FakeResp:
        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict:
            return {
                "model": "jev-1.13.0",
                "answers": {
                    "budget": {"type": "noul", "noul": 0.97},
                    "beachfront": {"type": "noul", "noul": 0.50},
                    "spa": {"type": "noul", "noul": 0.04},
                },
            }

    class FakeClient:
        def __init__(self, *a: object, **k: object) -> None:
            pass

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *a: object) -> bool:
            return False

        def post(self, url: str, headers: dict, json: dict) -> FakeResp:
            seen["url"] = url
            seen["auth"] = headers["Authorization"]
            seen["body"] = json
            return FakeResp()

    monkeypatch.setattr(jev_verifier.httpx, "Client", FakeClient)
    s = Settings(serpapi_api_key="x", llm_api_key="", jev_api_key="ts-test",
                 jev_endpoint="https://api.typesafe.ai/v1/systemone")
    reqs = [req("budget"), req("beachfront"), req("spa", "preferred")]
    cand = Candidate(candidate_id="c1", name="Bay Resort",
                     description="Beachfront resort, Rs 9000 per night.")
    res = jev_verifier.verify_candidate(reqs, cand, s)

    assert seen["url"] == "https://api.typesafe.ai/v1/systemone"
    assert seen["auth"] == "Bearer ts-test"
    assert set(seen["body"]["questions"]) == {"budget", "beachfront", "spa"}
    assert all(q["type"] == "noul" for q in seen["body"]["questions"].values())
    by_id = {x.requirement_id: x for x in res.requirements}
    assert by_id["budget"].status == "SATISFIED" and by_id["budget"].confidence == 0.97
    assert by_id["beachfront"].status == "UNKNOWN"
    assert by_id["spa"].status == "CONTRADICTED"  # preferred: non-blocking
    assert res.overall_status == "UNVERIFIED"  # required beachfront UNKNOWN
    assert res.verifier.startswith("typesafe-jev:")
