"""Request understanding: NL request -> structured requirements.

Real path only: an LLM converts the request into REQUIRED vs PREFERRED
requirements. No heuristic fallback — without LLM_API_KEY the pipeline
fails loudly instead of fabricating structure.
"""
from __future__ import annotations

import json

import httpx

from app.config import Settings
from app.models.schemas import ParsedRequest, Requirement


_LLM_SYSTEM = """You convert a user's natural-language shopping/travel request into structured requirements.
Return ONLY valid JSON: {"requirements": [{"id": "...", "description": "...", "type": "...", "importance": "required|preferred"}]}.
Rules:
- Every description must be CONCRETE and self-contained: preserve ALL numbers, amounts, currencies, units, and place names exactly (e.g. "Total price must be <= Rs 10,000", "Must sleep at least 2 guests", "Must be located in Goa"). Never write vague text like "Maximum budget for hotel stay" — the amount is mandatory.
- One requirement per distinct constraint; never merge different constraints.
- ids are short snake_case slugs naming the constraint (budget, guests, beachfront, breakfast_included, free_cancellation, location, rating, weight, ram, gpu...).
- types: numeric|capacity|semantic|inclusion|policy|location|spec. "beachfront" is semantic, not location; "location" is only for the where-place.
- Every hard constraint (budget, capacity, must-have feature/policy) is "required". Wishes ("preferably", "ideally", "4.5+ rated" phrased as preference) are "preferred".
- Do not invent constraints not stated. Keep descriptions faithful to the request."""


def parse_requirements(request: str, settings: Settings) -> ParsedRequest:
    """LLM-backed parsing. Raises RuntimeError when credentials are missing
    or the provider fails — never fabricates requirements."""
    if not settings.has_llm:
        raise RuntimeError(
            "LLM_API_KEY is not set. Requirement understanding needs a real LLM — "
            "set LLM_API_KEY (and optionally LLM_BASE_URL / LLM_MODEL) in .env."
        )
    try:
        payload = {
            "model": settings.llm_model,
            "messages": [
                {"role": "system", "content": _LLM_SYSTEM},
                {"role": "user", "content": request},
            ],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
        headers = {"Authorization": f"Bearer {settings.llm_api_key}"}
        with httpx.Client(timeout=settings.llm_timeout_s) as client:
            r = client.post(
                settings.llm_base_url.rstrip("/") + "/chat/completions",
                json=payload,
                headers=headers,
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
        data = json.loads(content)
        reqs = [Requirement(**x) for x in data.get("requirements", [])]
        if not reqs:
            raise ValueError("LLM returned no requirements")
        return ParsedRequest(request=request, requirements=reqs)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"requirement parsing failed: {e}")
