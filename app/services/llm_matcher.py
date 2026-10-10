"""LLM matcher: semantic comparison over ALL candidates -> ranked list.

The LLM NEVER declares a candidate verified. It only ranks.
Pydantic-validated, machine-readable output. Controlled retry on
invalid structure. No keyword fallback — without LLM_API_KEY the
pipeline fails loudly.
"""
from __future__ import annotations

import json

import httpx

from app.config import Settings
from app.models.schemas import Candidate, RankedCandidate, RankingResult, Requirement

_MATCH_SYSTEM = """You rank search candidates against a user's request. You are the SEMANTIC MATCHER, not the verifier.
Rules:
- Understand actual intent; distinguish hard constraints from preferences.
- Compare candidates using ONLY their supplied data; never invent facts.
- Consider the whole candidate, not isolated keywords. Example: "located directly along the coast / private beach access" is stronger beachfront evidence than "5-minute walk to the beach".
- Prefer candidates supported by available data.
- Return ONLY valid JSON: {"ranked_candidates": [{"candidate_id": "...", "rank": 1, "reason": "..."}]}.
- Rank ALL candidates provided, best match first. Do NOT declare anything verified.
- Each "reason" explains only why the candidate looks relevant or promising. Never state that it meets, satisfies or includes a requirement, and never say it "meets all requirements" — a separate verifier decides that."""


def _candidate_payload(c: Candidate) -> dict:
    return {
        "candidate_id": c.candidate_id,
        "name": c.name,
        "title": c.title,
        "price": c.price,
        "price_value": c.price_value,
        "currency": c.currency,
        "rating": c.rating,
        "review_count": c.review_count,
        "location": c.location,
        "address": c.address,
        "description": c.description,
        "amenities": c.amenities,
        "cancellation_info": c.cancellation_info,
        "seller": c.seller,
        "snippet": c.snippet,
        "source_url": c.source_url,
    }


def rank_candidates(
    request: str,
    requirements: list[Requirement],
    candidates: list[Candidate],
    settings: Settings,
) -> tuple[RankingResult, dict]:
    if not candidates:
        return RankingResult(ranked_candidates=[], model="none", mocked=False), {}
    if not settings.has_llm:
        raise RuntimeError(
            "LLM_API_KEY is not set. Semantic ranking needs a real LLM — "
            "set LLM_API_KEY (and optionally LLM_BASE_URL / LLM_MODEL) in .env. "
            "ProofGate never ranks with keyword heuristics."
        )

    user_payload = {
        "request": request,
        "requirements": [r.model_dump() for r in requirements],
        "candidates": [_candidate_payload(c) for c in candidates],
    }
    last_err = ""
    for attempt in range(2):  # initial + 1 controlled retry on invalid structure
        try:
            with httpx.Client(timeout=settings.llm_timeout_s) as client:
                r = client.post(
                    settings.llm_base_url.rstrip("/") + "/chat/completions",
                    headers={"Authorization": f"Bearer {settings.llm_api_key}"},
                    json={
                        "model": settings.llm_model,
                        "messages": [
                            {"role": "system", "content": _MATCH_SYSTEM},
                            {"role": "user", "content": json.dumps(user_payload)},
                        ],
                        "temperature": 0,
                        "response_format": {"type": "json_object"},
                    },
                )
                r.raise_for_status()
                content = r.json()["choices"][0]["message"]["content"]
            data = json.loads(content)
            items = data.get("ranked_candidates", [])
            ranked = [RankedCandidate(**x) for x in items]
            # validate ids
            valid_ids = {c.candidate_id for c in candidates}
            for rc in ranked:
                if rc.candidate_id not in valid_ids:
                    raise ValueError(f"unknown candidate_id {rc.candidate_id}")
            ranked_sorted = sorted(ranked, key=lambda x: x.rank)
            return RankingResult(ranked_candidates=ranked_sorted, model=settings.llm_model, mocked=False), {"model": settings.llm_model, "attempts": attempt + 1}
        except Exception as e:  # validation error / API failure -> controlled retry, then raise
            last_err = str(e)
            continue
    raise RuntimeError(f"LLM matcher failed after retry: {last_err}")
