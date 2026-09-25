"""Jev: requirement-level adjudication per candidate.

For each requirement -> SATISFIED | CONTRADICTED | UNKNOWN.
UNKNOWN is never collapsed into CONTRADICTED.

Real paths only:
1. External Jev endpoint (JEV_ENDPOINT + JEV_API_KEY) when configured.
2. LLM-backed adjudicator (default when LLM_API_KEY set).
Without either credential, verification fails loudly — never fabricated.
"""
from __future__ import annotations

import json

import httpx

from app.config import Settings
from app.models.schemas import (
    Candidate,
    CandidateStatus,
    Requirement,
    RequirementVerdict,
    VerificationResult,
)

_JEV_SYSTEM = """You are a strict requirement adjudicator (Jev). For EACH requirement, decide:
- SATISFIED: candidate data clearly supports the requirement.
- CONTRADICTED: candidate data indicates the requirement is NOT met.
- UNKNOWN: not enough supplied data to decide. Prefer UNKNOWN over guessing.
Rules:
- Never invent facts. Cite the supporting_data span from the candidate text (or null).
- "5-minute walk to the beach" does NOT satisfy "beachfront". "Breakfast available as add-on" does NOT satisfy "breakfast included". "Free cancellation on select rates" without confirmation for this candidate's rate is UNKNOWN or needs the exact text quoted.
- Numeric constraints (budget/weight/rating): compare numbers explicitly; missing numbers -> UNKNOWN.
- Return ONLY valid JSON: {"verdicts": [{"requirement_id": "...", "status": "SATISFIED|CONTRADICTED|UNKNOWN", "reason": "...", "supporting_data": "...|null"}]}."""


def overall_status(requirements: list[Requirement], verdicts: list[RequirementVerdict]) -> CandidateStatus:
    by_id = {r.id: r for r in requirements}
    required = [v for v in verdicts if by_id.get(v.requirement_id, None) is None or by_id[v.requirement_id].importance == "required"]
    # unknown requirement ids default to required (strict)
    if any(v.status == "CONTRADICTED" for v in required):
        return "REJECTED"
    if any(v.status == "UNKNOWN" for v in required):
        return "UNVERIFIED"
    if required and all(v.status == "SATISFIED" for v in required):
        return "VERIFIED"
    return "UNVERIFIED" if not required else "VERIFIED"


def _llm_verify(requirements: list[Requirement], candidate: Candidate, settings: Settings) -> VerificationResult:
    payload = {
        "requirements": [r.model_dump() for r in requirements],
        "candidate": {"candidate_id": candidate.candidate_id, "evidence": candidate.evidence_text()},
    }
    try:
        with httpx.Client(timeout=settings.jev_timeout_s or settings.llm_timeout_s) as client:
            r = client.post(
                settings.llm_base_url.rstrip("/") + "/chat/completions",
                headers={"Authorization": f"Bearer {settings.llm_api_key}"},
                json={
                    "model": settings.llm_model,
                    "messages": [
                        {"role": "system", "content": _JEV_SYSTEM},
                        {"role": "user", "content": json.dumps(payload)},
                    ],
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                },
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
        data = json.loads(content)
        verdicts = [RequirementVerdict(**v) for v in data.get("verdicts", [])]
    except Exception as e:
        raise RuntimeError(f"jev adjudication failed: {e}")
    if len(verdicts) != len(requirements):
        raise RuntimeError(
            f"jev returned {len(verdicts)} verdicts for {len(requirements)} requirements"
        )
    return VerificationResult(
        candidate_id=candidate.candidate_id,
        overall_status=overall_status(requirements, verdicts),
        requirements=verdicts,
        verifier=f"llm-jev:{settings.llm_model}",
        mocked=False,
    )


def noul_to_status(p: float, satisfied_at: float, contradicted_below: float) -> RequirementStatus:
    """Map a TypeSafe Noul probability onto the tri-state model.

    Conservative by design: the middle band is UNKNOWN (unproven),
    never CONTRADICTED. Thresholds scale with risk — tune via
    JEV_SATISFIED_AT / JEV_CONTRADICTED_BELOW.
    """
    if p >= satisfied_at:
        return "SATISFIED"
    if p <= contradicted_below:
        return "CONTRADICTED"
    return "UNKNOWN"


def _external_jev(requirements: list[Requirement], candidate: Candidate, settings: Settings) -> VerificationResult:
    """Official TypeSafe Jev integration (https://docs.typesafe.ai).

    One POST to {JEV_ENDPOINT} per candidate with ALL requirements as
    parallel Noul questions against the candidate's complete evidence
    as state. Noul probabilities are decision-support signals mapped
    onto SATISFIED/CONTRADICTED/UNKNOWN — never quoted as truth %.
    """
    state = candidate.evidence_text().strip() or candidate.name
    questions = {
        r.id: {
            "type": "noul",
            "instructions": (
                "Given the candidate described in the state, is the following "
                f"requirement satisfied? Requirement: {r.description} "
                "Answer with a score near 1 only if the state clearly shows it is met, "
                "near 0 only if the state clearly shows it is NOT met. If the state "
                "says nothing conclusive either way, give a middling score around 0.5."
            ),
            "criteria": {
                "true": f"The state clearly shows the candidate meets this: {r.description}",
                "false": f"The state clearly shows the candidate does NOT meet this: {r.description}",
            },
        }
        for r in requirements
    }
    try:
        with httpx.Client(timeout=settings.jev_timeout_s) as client:
            r = client.post(
                settings.jev_endpoint,
                headers={"Authorization": f"Bearer {settings.jev_api_key}", "Content-Type": "application/json"},
                json={"state": state, "model": settings.jev_model, "questions": questions},
            )
            r.raise_for_status()
            data = r.json()
        answers = data.get("answers", {})
        verdicts: list[RequirementVerdict] = []
        for req in requirements:
            entry = answers.get(req.id, {})
            p = entry.get("noul")
            if p is None:
                raise ValueError(f"no noul answer for requirement '{req.id}'")
            status = noul_to_status(float(p), settings.jev_satisfied_at, settings.jev_contradicted_below)
            verdicts.append(RequirementVerdict(
                requirement_id=req.id,
                status=status,
                reason=(
                    f"TypeSafe Jev noul={float(p):.2f} "
                    f"(SATISFIED ≥ {settings.jev_satisfied_at}, "
                    f"CONTRADICTED ≤ {settings.jev_contradicted_below})."
                ),
                supporting_data=state[:500] or None,
                confidence=float(p),
            ))
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"typesafe jev failed: {e}")
    return VerificationResult(candidate_id=candidate.candidate_id,
                              overall_status=overall_status(requirements, verdicts),
                              requirements=verdicts, verifier=f"typesafe-jev:{settings.jev_model}",
                              mocked=False)


def verify_candidate(requirements: list[Requirement], candidate: Candidate, settings: Settings) -> VerificationResult:
    """Real adjudication only. Raises RuntimeError when no Jev-capable
    credential is configured — never fabricates verdicts."""
    if settings.has_jev:
        return _external_jev(requirements, candidate, settings)
    if settings.has_llm:
        return _llm_verify(requirements, candidate, settings)
    raise RuntimeError(
        "No verifier credential set. Jev needs JEV_API_KEY (official TypeSafe Jev) "
        "or LLM_API_KEY (LLM-backed adjudication) in .env."
    )
