"""End-to-end pipeline: request -> SerpApi -> LLM rank -> Jev loop -> decision."""
from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone

from collections.abc import Callable

from app.config import Settings
from app.models.schemas import Candidate, RunRecord
from app.services import decision_engine, jev_verifier, llm_matcher, rank_reasons, requirement_parser, serpapi_service
from app.storage import store


def run_find_and_verify(
    request: str,
    action: str,
    settings: Settings,
    max_candidates: int = 15,
    engine: str | None = None,
    on_event: Callable[[dict], None] | None = None,
) -> RunRecord:
    t0 = time.perf_counter()
    timing: dict[str, int] = {}
    errors: list[str] = []

    run_id = uuid.uuid4().hex[:12]
    created_at = datetime.now(timezone.utc).isoformat()

    def _emit(ev: dict) -> None:
        if on_event is None:
            return
        try:
            on_event(ev)
        except Exception:
            pass

    # 1. understand / structure (real LLM; raises without LLM_API_KEY)
    t = time.perf_counter()
    try:
        parsed = requirement_parser.parse_requirements(request, settings)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"requirement_parse_failed: {e}")
    timing["parse_ms"] = int((time.perf_counter() - t) * 1000)
    requirements = parsed.requirements
    _emit({"type": "requirements",
           "requirements": [r.model_dump() for r in requirements]})

    # 2. discovery (live SerpApi; raises without SERPAPI_API_KEY)
    t = time.perf_counter()
    try:
        candidates, serp_meta, raw = serpapi_service.search_serpapi(
            request, action, settings, max_candidates, engine)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"serpapi_failed: {e}")
    timing["serpapi_ms"] = int((time.perf_counter() - t) * 1000)
    _emit({"type": "searching", "engine": serp_meta.get("engine") if isinstance(serp_meta, dict) else None,
           "meta": serp_meta if isinstance(serp_meta, dict) else {}})
    _emit({"type": "candidates", "count": len(candidates),
           "candidates": [{"candidate_id": c.candidate_id, "name": c.name,
                           "price": c.price, "price_value": c.price_value,
                           "rating": c.rating, "seller": c.seller} for c in candidates]})

    if not candidates:
        rec = RunRecord(run_id=run_id, status="no_verified_match", request=request, action=action,
                        requirements=requirements, candidate_count=0, candidates=[],
                        serpapi_meta=serp_meta, timing_ms=timing, errors=errors + ["no_candidates"],
                        mocked=False, created_at=created_at, raw_serpapi=raw)
        _emit({"type": "verdict", "status": "no_verified_match", "run_id": run_id,
               "selected_candidate_id": None, "attempts": 0})
        store.save_run(settings.db_path, run_id, created_at, request, rec.model_dump())
        return rec

    # 3. LLM global ranking (raises without LLM_API_KEY)
    t = time.perf_counter()
    llm_meta: dict = {}
    try:
        ranking, llm_meta = llm_matcher.rank_candidates(request, requirements, candidates, settings)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"llm_matcher_failed: {e}")
    timing["llm_ms"] = int((time.perf_counter() - t) * 1000)
    # Nothing is verified yet: raw ranker reasons never leave the pipeline.
    _emit({"type": "ranking",
           "ranked_candidates": [rc.model_dump() for rc in rank_reasons.relabel(ranking.ranked_candidates, [])],
           "model": llm_meta.get("model") if isinstance(llm_meta, dict) else None})

    # 4-5. sequential Jev verification + deterministic decision
    t = time.perf_counter()
    by_id = {c.candidate_id: c for c in candidates}
    jev_errors: list[str] = []

    def verify_fn(c: Candidate):
        _emit({"type": "verifying", "candidate_id": c.candidate_id,
               "candidate_name": c.name})
        try:
            result = jev_verifier.verify_candidate(requirements, c, settings)
        except Exception as e:
            jev_errors.append(f"jev_failed:{c.candidate_id}:{e}")
            raise
        try:
            _emit({"type": "verdict", "candidate_id": c.candidate_id,
                   "overall_status": result.overall_status,
                   "requirements": [v.model_dump() for v in result.requirements]})
        except Exception:
            pass
        return result

    try:
        selected, verification, attempts, status = decision_engine.decide(
            requirements, ranking.ranked_candidates, by_id, verify_fn)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"verification_failed: {e}")
    timing["jev_ms"] = int((time.perf_counter() - t) * 1000)
    errors.extend(jev_errors)
    timing["total_ms"] = int((time.perf_counter() - t0) * 1000)
    _emit({"type": "verdict", "status": status, "run_id": run_id,
           "selected_candidate_id": selected.candidate_id if selected is not None else None,
           "attempts": len(attempts)})

    rec = RunRecord(
        run_id=run_id, status=status,  # type: ignore[arg-type]
        request=request, action=action, requirements=requirements,
        candidate_count=len(candidates), candidates=candidates,
        ranked_candidates=rank_reasons.relabel(ranking.ranked_candidates, attempts),
        selected_candidate=selected, verification=verification, attempts=attempts,
        serpapi_meta=serp_meta, llm_meta=llm_meta, timing_ms=timing,
        errors=errors, mocked=False, created_at=created_at, raw_serpapi=raw,
    )
    try:
        store.save_run(settings.db_path, run_id, created_at, request, rec.model_dump())
    except Exception as e:
        rec.errors.append(f"persist_failed: {e}")
    return rec
