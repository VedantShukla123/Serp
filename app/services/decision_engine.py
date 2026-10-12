"""Final decision engine — deterministic control flow.

for candidate in ranked_candidates:
    verification = verify_with_jev(candidate, requirements)
    if all_required_satisfied -> return VERIFIED
    if any_required_contradicted -> continue
    if any_required_unknown -> continue
return NO_VERIFIED_MATCH

Free-form LLM output never controls final status; only the
structured Jev verdicts + this code do.
"""
from __future__ import annotations

from collections.abc import Callable

from app.models.schemas import (
    AttemptRecord,
    Candidate,
    RankedCandidate,
    Requirement,
    VerificationResult,
)

MAX_CONSECUTIVE_FAILURES = 2   # verifier errors in a row before giving up on the rest


def decide(
    requirements: list[Requirement],
    ranked: list[RankedCandidate],
    by_id: dict[str, Candidate],
    verify_fn: Callable[[Candidate], VerificationResult],
) -> tuple[Candidate | None, VerificationResult | None, list[AttemptRecord], str]:
    """Returns (selected, verification, attempts, status).

    status is 'verified' | 'needs_human_review' | 'no_verified_match'. A technical error
    on one candidate is never converted into a verdict: that candidate is skipped (it
    stays unchecked, so any action on it needs human review; the caller records the
    error) and the next one is tried. After MAX_CONSECUTIVE_FAILURES in a row the verifier is
    treated as down and the loop stops. If no candidate could be checked at all, the error propagates.
    """
    attempts: list[AttemptRecord] = []
    failure: Exception | None = None
    consecutive = 0
    for rc in ranked:
        cand = by_id.get(rc.candidate_id)
        if cand is None:
            continue
        try:
            verification = verify_fn(cand)
        except Exception as e:
            failure, consecutive = e, consecutive + 1
            if consecutive >= MAX_CONSECUTIVE_FAILURES:
                break
            continue
        consecutive = 0
        attempts.append(AttemptRecord(
            candidate_id=cand.candidate_id, candidate_name=cand.name, verification=verification))
        if verification.overall_status == "VERIFIED":
            return cand, verification, attempts, "verified"
        # REJECTED or UNVERIFIED -> try next ranked candidate
        continue
    if not attempts:
        if failure is not None:
            raise failure
        return None, None, attempts, "no_verified_match"
    # Human-in-the-loop fallback: nothing verified. Return the best
    # available candidate WITHOUT labeling it verified — prefer the
    # highest-ranked UNVERIFIED candidate (unproven, not disproven),
    # otherwise rank #1 with its contradicted points flagged.
    best = next(
        (a for a in attempts if a.verification.overall_status == "UNVERIFIED"),
        attempts[0],
    )
    return by_id.get(best.candidate_id), best.verification, attempts, "needs_human_review"
