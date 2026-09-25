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


def decide(
    requirements: list[Requirement],
    ranked: list[RankedCandidate],
    by_id: dict[str, Candidate],
    verify_fn: Callable[[Candidate], VerificationResult],
) -> tuple[Candidate | None, VerificationResult | None, list[AttemptRecord], str]:
    """Returns (selected, verification, attempts, status).

    status is 'verified' | 'no_verified_match'. Technical errors from
    verify_fn propagate (never converted into verification).
    """
    attempts: list[AttemptRecord] = []
    for rc in ranked:
        cand = by_id.get(rc.candidate_id)
        if cand is None:
            continue
        verification = verify_fn(cand)  # may raise -> caller maps to error status
        attempts.append(AttemptRecord(
            candidate_id=cand.candidate_id, candidate_name=cand.name, verification=verification))
        if verification.overall_status == "VERIFIED":
            return cand, verification, attempts, "verified"
        # REJECTED or UNVERIFIED -> try next ranked candidate
        continue
    if not attempts:
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
