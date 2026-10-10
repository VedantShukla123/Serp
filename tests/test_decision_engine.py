"""Core decision-logic tests (§18). Deterministic, no network."""
from __future__ import annotations

import pytest

from app.models.schemas import (
    Candidate,
    RankedCandidate,
    Requirement,
    RequirementVerdict,
    VerificationResult,
)
from app.services import decision_engine
from app.services.jev_verifier import overall_status


def reqs(ids=("budget", "guests", "beachfront"), preferred=("rating",)):
    out = [Requirement(id=i, description=i, importance="required") for i in ids]
    out += [Requirement(id=p, description=p, importance="preferred") for p in preferred]
    return out


def vr(cid, pairs: list[tuple[str, str]]) -> VerificationResult:
    v = [RequirementVerdict(requirement_id=k, status=s) for k, s in pairs]  # type: ignore[arg-type]
    return VerificationResult(candidate_id=cid, overall_status="UNVERIFIED", requirements=v)


def test_1_all_required_satisfied_is_verified():
    r = reqs()
    v = vr("c1", [("budget", "SATISFIED"), ("guests", "SATISFIED"), ("beachfront", "SATISFIED"), ("rating", "SATISFIED")])
    assert overall_status(r, v.requirements) == "VERIFIED"


def test_2_one_required_contradicted_is_rejected():
    r = reqs()
    v = vr("c1", [("budget", "SATISFIED"), ("guests", "SATISFIED"), ("beachfront", "CONTRADICTED"), ("rating", "SATISFIED")])
    assert overall_status(r, v.requirements) == "REJECTED"


def test_3_one_required_unknown_is_unverified():
    r = reqs()
    v = vr("c1", [("budget", "SATISFIED"), ("guests", "SATISFIED"), ("beachfront", "UNKNOWN"), ("rating", "SATISFIED")])
    assert overall_status(r, v.requirements) == "UNVERIFIED"


def _cand(cid, name="N"):
    return Candidate(candidate_id=cid, name=name)


def test_4_unknown_then_verified_falls_through():
    r = reqs()
    cands = {"c1": _cand("c1", "A"), "c2": _cand("c2", "C")}
    ranked = [RankedCandidate(candidate_id="c1", rank=1), RankedCandidate(candidate_id="c2", rank=2)]
    table = {
        "c1": VerificationResult(candidate_id="c1", overall_status="UNVERIFIED",
                                 requirements=[RequirementVerdict(requirement_id="budget", status="SATISFIED"),
                                               RequirementVerdict(requirement_id="guests", status="SATISFIED"),
                                               RequirementVerdict(requirement_id="beachfront", status="UNKNOWN")]),
        "c2": VerificationResult(candidate_id="c2", overall_status="VERIFIED",
                                 requirements=[RequirementVerdict(requirement_id="budget", status="SATISFIED"),
                                               RequirementVerdict(requirement_id="guests", status="SATISFIED"),
                                               RequirementVerdict(requirement_id="beachfront", status="SATISFIED")]),
    }
    sel, ver, attempts, status = decision_engine.decide(r, ranked, cands, lambda c: table[c.candidate_id])
    assert status == "verified" and sel and sel.candidate_id == "c2"
    assert [a.candidate_id for a in attempts] == ["c1", "c2"]


def test_5_rejected_then_verified_returns_second():
    r = reqs()
    cands = {"c1": _cand("c1", "A"), "c2": _cand("c2", "C")}
    ranked = [RankedCandidate(candidate_id="c1", rank=1), RankedCandidate(candidate_id="c2", rank=2)]
    table = {
        "c1": VerificationResult(candidate_id="c1", overall_status="REJECTED",
                                 requirements=[RequirementVerdict(requirement_id="budget", status="CONTRADICTED")]),
        "c2": VerificationResult(candidate_id="c2", overall_status="VERIFIED",
                                 requirements=[RequirementVerdict(requirement_id="budget", status="SATISFIED"),
                                               RequirementVerdict(requirement_id="guests", status="SATISFIED"),
                                               RequirementVerdict(requirement_id="beachfront", status="SATISFIED")]),
    }
    sel, ver, attempts, status = decision_engine.decide(r, ranked, cands, lambda c: table[c.candidate_id])
    assert status == "verified" and sel.candidate_id == "c2"


def test_6_all_fail_returns_best_for_human_review():
    r = reqs()
    cands = {"c1": _cand("c1", "A")}
    ranked = [RankedCandidate(candidate_id="c1", rank=1)]
    table = {"c1": VerificationResult(candidate_id="c1", overall_status="REJECTED",
                                      requirements=[RequirementVerdict(requirement_id="budget", status="CONTRADICTED")])}
    sel, ver, attempts, status = decision_engine.decide(r, ranked, cands, lambda c: table[c.candidate_id])
    assert status == "needs_human_review" and sel is not None and sel.candidate_id == "c1"
    assert ver is not None and ver.overall_status == "REJECTED"  # never labeled verified


def test_6b_higher_ranked_rejected_not_selected_over_unverified():
    r = reqs()
    cands = {"c1": _cand("c1", "A"), "c2": _cand("c2", "B")}
    ranked = [RankedCandidate(candidate_id="c1", rank=1), RankedCandidate(candidate_id="c2", rank=2)]
    table = {
        "c1": VerificationResult(candidate_id="c1", overall_status="REJECTED",
                                 requirements=[RequirementVerdict(requirement_id="budget", status="CONTRADICTED")]),
        "c2": VerificationResult(candidate_id="c2", overall_status="UNVERIFIED",
                                 requirements=[RequirementVerdict(requirement_id="budget", status="UNKNOWN")]),
    }
    sel, ver, attempts, status = decision_engine.decide(r, ranked, cands, lambda c: table[c.candidate_id])
    assert status == "needs_human_review"
    assert sel is not None and sel.candidate_id == "c2"  # unproven beats disproven
    assert ver is not None and ver.overall_status == "UNVERIFIED"
    assert [a.candidate_id for a in attempts] == ["c1", "c2"]


def test_7_preferred_unknown_still_verified():
    r = reqs()
    v = vr("c1", [("budget", "SATISFIED"), ("guests", "SATISFIED"), ("beachfront", "SATISFIED"), ("rating", "UNKNOWN")])
    assert overall_status(r, v.requirements) == "VERIFIED"


def test_8_invalid_llm_structure_rejected_by_pydantic():
    with pytest.raises(Exception):
        RankedCandidate(candidate_id="c1", rank="first")  # type: ignore[arg-type]


def test_9_missing_noncritical_fields_dont_crash():
    c = Candidate(candidate_id="c9")  # everything else defaults
    assert c.evidence_text() == ""
    r = [Requirement(id="general", description="anything", importance="required")]
    v = vr("c9", [("general", "UNKNOWN")])
    assert overall_status(r, v.requirements) == "UNVERIFIED"


def test_10_no_candidate_satisfies_all_required():
    r = reqs()
    cands = {f"c{i}": _cand(f"c{i}") for i in range(1, 4)}
    ranked = [RankedCandidate(candidate_id=f"c{i}", rank=i) for i in range(1, 4)]
    def vf(c):
        return VerificationResult(candidate_id=c.candidate_id, overall_status="UNVERIFIED",
                                  requirements=[RequirementVerdict(requirement_id="budget", status="SATISFIED"),
                                                RequirementVerdict(requirement_id="guests", status="UNKNOWN"),
                                                RequirementVerdict(requirement_id="beachfront", status="SATISFIED")])
    sel, ver, attempts, status = decision_engine.decide(r, ranked, cands, vf)
    assert status == "needs_human_review" and len(attempts) == 3
    assert sel is not None and sel.candidate_id == "c1"  # highest-ranked UNVERIFIED
    assert ver is not None and ver.overall_status == "UNVERIFIED"


def test_unknown_not_collapsed_into_contradicted():
    r = [Requirement(id="x", description="x", importance="required")]
    assert overall_status(r, [RequirementVerdict(requirement_id="x", status="UNKNOWN")]) == "UNVERIFIED"
