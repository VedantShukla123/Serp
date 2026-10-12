"""Status-aware ranking reasons for every public response.

The LLM ranker writes its reason BEFORE Jev verification, so the raw text
can claim requirements are met when Jev later finds them UNKNOWN or
CONTRADICTED. Public responses (REST, MCP, SSE, stored runs) therefore
carry only these deterministic reasons, derived from the actual Jev
overall_status. Ranking order is untouched. Wording matches
frontend/src/traceEvents.ts rankReasonFor.
"""
from __future__ import annotations

from typing import Any

from app.models.schemas import AttemptRecord, RankedCandidate

NOT_CHECKED = "Ranked as a relevant candidate; not yet verified."
_BY_STATUS = {
    "VERIFIED": "Ranked as a relevant candidate; all required points verified.",
    "UNVERIFIED": "Ranked as a relevant candidate; some required points remain unverified.",
    "REJECTED": "Ranked as a relevant candidate; rejected because at least one required point was contradicted.",
}


def reason_for(overall_status: str | None) -> str:
    return _BY_STATUS.get((overall_status or "").upper(), NOT_CHECKED)


def relabel(ranked: list[RankedCandidate], attempts: list[AttemptRecord]) -> list[RankedCandidate]:
    """Copy of `ranked` (same order) with reasons replaced by Jev-status text."""
    status = {a.candidate_id: a.verification.overall_status for a in attempts}
    return [rc.model_copy(update={"reason": reason_for(status.get(rc.candidate_id))}) for rc in ranked]


def relabel_run_dict(data: dict[str, Any]) -> dict[str, Any]:
    """Same as `relabel` for a persisted run dict (covers runs stored before this fix)."""
    status = {
        a.get("candidate_id"): (a.get("verification") or {}).get("overall_status")
        for a in data.get("attempts") or [] if isinstance(a, dict)
    }
    ranked = data.get("ranked_candidates")
    if isinstance(ranked, list):
        data["ranked_candidates"] = [
            {**rc, "reason": reason_for(status.get(rc.get("candidate_id")))} if isinstance(rc, dict) else rc
            for rc in ranked
        ]
    return data
