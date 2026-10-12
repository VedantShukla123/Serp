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


def test_ranker_prompt_forbids_requirement_claims_in_reasons(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ranking reasons are written before Jev runs, so the ranker is told
    not to claim requirements are met (display is gated in the UI too)."""
    seen: dict = {}

    class FakeResp:
        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict:
            return {"choices": [{"message": {"content":
                '{"ranked_candidates": [{"candidate_id": "c1", "rank": 1, "reason": "relevant"}]}'}}]}

    class FakeClient:
        def __init__(self, *a: object, **k: object) -> None:
            pass

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *a: object) -> bool:
            return False

        def post(self, url: str, headers: dict, json: dict) -> FakeResp:
            seen["system"] = json["messages"][0]["content"]
            return FakeResp()

    monkeypatch.setattr(llm_matcher.httpx, "Client", FakeClient)
    s = Settings(serpapi_api_key="", llm_api_key="test-key", jev_api_key="", jev_endpoint="")
    ranking, _ = llm_matcher.rank_candidates("q", [req("a")], [Candidate(candidate_id="c1", name="A")], s)
    assert [rc.candidate_id for rc in ranking.ranked_candidates] == ["c1"]
    assert 'never say it "meets all requirements"' in seen["system"]
    assert "Never state that it meets, satisfies or includes a requirement" in seen["system"]


def test_verified_requires_a_verdict_for_every_required_requirement() -> None:
    """Regression: a verdict list that skips a requirement (duplicate or mislabelled ids, same
    count) must never yield VERIFIED."""
    reqs = [Requirement(id="r1", description="budget"), Requirement(id="r2", description="beachfront"),
            Requirement(id="r3", description="nice view", importance="preferred")]
    V = RequirementVerdict
    dup = [V(requirement_id="r1", status="SATISFIED"), V(requirement_id="r1", status="SATISFIED")]
    wrong_ids = [V(requirement_id="1", status="SATISFIED"), V(requirement_id="2", status="SATISFIED")]
    assert jev_verifier.overall_status(reqs, dup) == "UNVERIFIED"
    assert jev_verifier.overall_status(reqs, wrong_ids) == "UNVERIFIED"
    complete = [V(requirement_id="r1", status="SATISFIED"), V(requirement_id="r2", status="SATISFIED")]
    assert jev_verifier.overall_status(reqs, complete) == "VERIFIED"      # preferred r3 may stay unjudged
    assert jev_verifier.overall_status(reqs, complete[:1] + [V(requirement_id="r2", status="CONTRADICTED")]) == "REJECTED"


def test_llm_verifier_marks_skipped_requirements_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    import json as _json

    import httpx
    reqs = [Requirement(id="r1", description="budget"), Requirement(id="r2", description="beachfront")]
    content = _json.dumps({"verdicts": [{"requirement_id": "r1", "status": "SATISFIED", "reason": "x"},
                                        {"requirement_id": "r1", "status": "SATISFIED", "reason": "dup"}]})
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"choices": [{"message": {"content": content}}]}))
    real = httpx.Client
    monkeypatch.setattr(jev_verifier.httpx, "Client", lambda **kw: real(transport=transport, **kw))
    s = Settings(serpapi_api_key="", llm_api_key="k", jev_api_key="", jev_endpoint="")
    res = jev_verifier.verify_candidate(reqs, Candidate(candidate_id="c1", name="Hotel"), s)
    assert res.overall_status == "UNVERIFIED"
    r2 = [v for v in res.requirements if v.requirement_id == "r2"]
    assert len(r2) == 1 and r2[0].status == "UNKNOWN"


def _mock_llm(monkeypatch: pytest.MonkeyPatch, module, payload: dict, calls: list | None = None) -> None:
    import json as _json

    import httpx
    content = _json.dumps(payload)

    def handler(req):
        if calls is not None:
            calls.append(1)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})
    real = httpx.Client
    monkeypatch.setattr(module.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))


def test_ranking_drops_duplicate_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: an LLM ranking that lists a candidate twice made the pipeline verify (and pay for) it twice."""
    _mock_llm(monkeypatch, llm_matcher, {"ranked_candidates": [
        {"candidate_id": "c2", "rank": 3}, {"candidate_id": "c1", "rank": 1}, {"candidate_id": "c1", "rank": 2}]})
    s = Settings(serpapi_api_key="", llm_api_key="k", jev_api_key="", jev_endpoint="")
    cands = [Candidate(candidate_id="c1", name="A"), Candidate(candidate_id="c2", name="B")]
    ranking, _ = llm_matcher.rank_candidates("q", [Requirement(id="r", description="d")], cands, s)
    assert [r.candidate_id for r in ranking.ranked_candidates] == ["c1", "c2"]


def test_empty_ranking_is_invalid_output_not_a_no_match(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: an empty ranking for real candidates ended the run as no_verified_match with
    nothing verified. It is now retried once, then fails loudly."""
    calls: list = []
    _mock_llm(monkeypatch, llm_matcher, {"ranked_candidates": []}, calls)
    s = Settings(serpapi_api_key="", llm_api_key="k", jev_api_key="", jev_endpoint="")
    with pytest.raises(RuntimeError, match="empty ranking"):
        llm_matcher.rank_candidates("q", [Requirement(id="r", description="d")], [Candidate(candidate_id="c1", name="A")], s)
    assert len(calls) == 2


def test_duplicate_requirement_ids_cannot_share_a_verdict(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: two parsed requirements with the same id sent ONE Jev question, and its answer
    was recorded for both (an unchecked 'beachfront' came out SATISFIED)."""
    import json as _json

    import httpx
    parsed = _json.dumps({"requirements": [
        {"id": "r1", "description": "under Rs 10,000"}, {"id": "r1", "description": "beachfront"}, {"id": " ", "description": "2 guests"}]})
    asked: list[list[str]] = []

    def handler(req):
        if req.url.host == "jev.test":
            q = _json.loads(req.content)["questions"]
            asked.append(list(q))
            return httpx.Response(200, json={"answers": {k: {"noul": 0.95 if k == "r1" else 0.5} for k in q}})
        return httpx.Response(200, json={"choices": [{"message": {"content": parsed}}]})
    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    s = Settings(serpapi_api_key="", llm_api_key="k", jev_api_key="j", jev_endpoint="https://jev.test")
    reqs = requirement_parser.parse_requirements("hotel", s).requirements
    assert len({r.id for r in reqs}) == 3 and all(r.id.strip() for r in reqs)
    res = jev_verifier.verify_candidate(reqs, Candidate(candidate_id="c", name="Inland hotel"), s)
    assert asked == [[r.id for r in reqs]]
    assert res.overall_status == "UNVERIFIED"
    with pytest.raises(ValueError, match="unique"):
        jev_verifier.verify_candidate([Requirement(id="a", description="x"), Requirement(id="a", description="y")],
                                      Candidate(candidate_id="c", name="n"), s)


@pytest.mark.parametrize("accounts", [False, True], ids=["local", "accounts"])
def test_rest_verify_rejects_duplicate_requirement_ids(accounts: bool, tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Pinned settings: the result must not depend on the developer's local .env (e.g. a session secret).
    from fastapi.testclient import TestClient

    from app import main as main_module
    from app.api import routes
    from app.main import app
    from app.storage import store
    s = Settings(serpapi_api_key="", llm_api_key="", jev_api_key="", jev_endpoint="", db_path=str(tmp_path / "t.db"),
                 production=accounts, session_secret="s" * 48 if accounts else "")
    monkeypatch.setattr(routes, "settings", s)
    monkeypatch.setattr(main_module, "settings", s)
    store.init_db(s.db_path)
    c = TestClient(app)
    headers = {}
    if accounts:
        r = c.post("/v1/auth/register", json={"name": "a", "email": "a@example.com", "password": "a-long-password"})
        headers = {"Authorization": f"Bearer {r.json()['token']}"}
    body = {"requirements": [{"id": "a", "description": "x"}, {"id": "a", "description": "y"}],
            "candidate": {"candidate_id": "c", "name": "n"}}
    assert c.post("/v1/verify", json=body, headers=headers).status_code == 422
