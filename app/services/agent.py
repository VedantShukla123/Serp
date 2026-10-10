"""Chat agent orchestration layer on top of the locked core pipeline.

Orchestration only: route -> (optionally) run_find_and_verify -> compose.
Never reimplements search/rank/verify; never fabricates verification.
"""
from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import httpx

from app.config import Settings
from app.services import pipeline as _pipeline
from app.storage import store

# Exposed for test stubbing: monkeypatch either
# app.services.agent.run_find_and_verify or
# app.services.pipeline.run_find_and_verify — both are honoured.
run_find_and_verify = _pipeline.run_find_and_verify


def _call_pipeline(
    request: str,
    action: str,
    settings: Settings,
    max_candidates: int = 15,
    engine: str | None = None,
    on_event: Callable[[dict], None] | None = None,
):
    override = globals().get("run_find_and_verify")
    base = _pipeline.run_find_and_verify
    fn = override if (override is not None and override is not base) else base
    try:
        return fn(request, action, settings, max_candidates, engine, on_event)
    except TypeError:
        # Back-compat with stubs that don't accept on_event.
        return fn(request, action, settings, max_candidates, engine)


def _sanitize(text: str, settings: Settings) -> str:
    safe = text
    for secret in (settings.serpapi_api_key, settings.llm_api_key, settings.jev_api_key):
        if secret:
            safe = safe.replace(secret, "***")
    return safe


def _history_messages(history: list[Any]) -> list[dict]:
    out: list[dict] = []
    for h in history or []:
        if isinstance(h, dict):
            role = str(h.get("role", "user"))
            content = str(h.get("content", ""))
            if role in ("user", "assistant", "system"):
                out.append({"role": role, "content": content})
        elif isinstance(h, (list, tuple)) and len(h) == 2:
            out.append({"role": str(h[0]), "content": str(h[1])})
    return out


_ROUTER_SYSTEM = """You route a chat assistant. Reply with ONLY valid JSON: {"needs_search": true|false, "action": "...", "engine": "..."|null, "note": "..."}.
Rules:
- needs_search=true when the task needs live internet data (hotels, products, flights, prices, availability, availability/prices/specs that change over time).
- action examples: book_hotel, buy_laptop, search. Pick book_hotel for hotel stays, buy_laptop for laptop/product shopping, search as the generic default. Map other shopping to buy_laptop-style actions only if clearly a product; else search.
- engine: google_hotels for hotels/stays, google_shopping for products/laptops, google_flights for flights, google_maps for restaurants/food/venues/places/cafes (real venues with ratings, never listicles), google as generic, or null to auto-pick.
- Direct chit-chat / how-it-works questions (hello, hi, what can you do, how does this work, explain verification) -> needs_search=false, action "search", engine null."""


def router_llm(message: str, history: list[Any], settings: Settings) -> dict:
    """Route a chat turn. Raises RuntimeError without LLM_API_KEY."""
    if not settings.has_llm:
        raise RuntimeError(
            "LLM_API_KEY is not set. Chat routing needs a real LLM — "
            "set LLM_API_KEY (and optionally LLM_BASE_URL / LLM_MODEL) in .env."
        )
    messages = [{"role": "system", "content": _ROUTER_SYSTEM}]
    messages.extend(_history_messages(history))
    messages.append({"role": "user", "content": message})
    try:
        with httpx.Client(timeout=settings.llm_timeout_s) as client:
            r = client.post(
                settings.llm_base_url.rstrip("/") + "/chat/completions",
                headers={"Authorization": f"Bearer {settings.llm_api_key}"},
                json={
                    "model": settings.llm_model,
                    "messages": messages,
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                },
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
        data = json.loads(content)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"router failed: {_sanitize(str(e), settings)}")
    try:
        needs = data.get("needs_search", False)
        if isinstance(needs, str):
            needs = needs.strip().lower() in ("true", "1", "yes")
        needs_search = bool(needs)
        action = str(data.get("action") or "search")
        engine = data.get("engine")
        engine = str(engine) if engine else None
        note = str(data.get("note") or "")
    except Exception as e:
        raise RuntimeError(f"router failed: bad router JSON: {_sanitize(str(e), settings)}")
    return {"needs_search": needs_search, "action": action, "engine": engine, "note": note}


_COMPOSER_SYSTEM = """You are ProofGate, a friendly shopping/travel chat assistant.
Rules:
- Explain what was done: how many candidates were searched, how they were ranked, and how Jev verified each requirement one by one. Mention any fallback (best available candidate returned for human review) when the trace summary says so.
- State VERIFIED only when the trace summary explicitly says the selected candidate is VERIFIED. Otherwise flag the unverified/contradicted points and ask the user to confirm before acting.
- Never call anything verified unless the trace says VERIFIED. Never invent prices, availability, or verdicts.
- The trace summary includes code-computed status counts. Use those exact numbers. Never say "all" or "none" of the candidates have a status unless the counts show it, and never describe only the top-ranked candidates as if they were the whole set. If any candidate is REJECTED, say how many and which requirement was contradicted.
- A code-generated verification status block is appended after your reply; never contradict it.
- For direct answers (no search), just answer helpfully and briefly offer to search when they are ready."""


def composer_llm(
    message: str, history: list[Any], trace_summary: str, settings: Settings
) -> str:
    """Compose the final chat reply. Raises RuntimeError without LLM_API_KEY."""
    if not settings.has_llm:
        raise RuntimeError(
            "LLM_API_KEY is not set. Chat replies need a real LLM — "
            "set LLM_API_KEY (and optionally LLM_BASE_URL / LLM_MODEL) in .env."
        )
    messages = [{"role": "system", "content": _COMPOSER_SYSTEM}]
    messages.extend(_history_messages(history))
    messages.append({
        "role": "user",
        "content": f"User message: {message}\n\nTrace summary:\n{trace_summary}",
    })
    try:
        with httpx.Client(timeout=settings.llm_timeout_s) as client:
            r = client.post(
                settings.llm_base_url.rstrip("/") + "/chat/completions",
                headers={"Authorization": f"Bearer {settings.llm_api_key}"},
                json={
                    "model": settings.llm_model,
                    "messages": messages,
                    "temperature": 0,
                },
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
        reply = str(content).strip()
        if not reply:
            raise ValueError("LLM returned an empty reply")
        return reply
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"composer failed: {_sanitize(str(e), settings)}")


_CANDIDATE_STATUSES = ("VERIFIED", "UNVERIFIED", "REJECTED")


def _status_counts(attempts: list[Any]) -> dict[str, int]:
    """Count Jev overall statuses across every verified attempt."""
    counts = dict.fromkeys(_CANDIDATE_STATUSES, 0)
    for a in attempts:
        ov = getattr(getattr(a, "verification", None), "overall_status", None)
        if ov in counts:
            counts[ov] += 1
    return counts


def _status_summary(rec: Any) -> str:
    """Deterministic status block built from the attempt records.

    Appended verbatim to the chat reply so status accuracy never depends
    on the composer LLM. Empty when no candidate was verified.
    """
    attempts = getattr(rec, "attempts", []) or []
    if not attempts:
        return ""
    counts = _status_counts(attempts)
    total = getattr(rec, "candidate_count", 0) or len(attempts)
    lines = [
        f"Verification status ({len(attempts)} of {total} candidates checked by Jev): "
        + ", ".join(f"{s} {counts[s]}" for s in _CANDIDATE_STATUSES) + "."
    ]
    rejected = [a for a in attempts
                if getattr(getattr(a, "verification", None), "overall_status", None) == "REJECTED"]
    if rejected:
        lines.append("Rejected (a required point was contradicted):")
        for a in rejected:
            reqs = getattr(a.verification, "requirements", []) or []
            contradicted = [getattr(x, "requirement_id", "?") for x in reqs
                            if getattr(x, "status", None) == "CONTRADICTED"]
            lines.append(
                f"- {getattr(a, 'candidate_name', '') or a.candidate_id} ({a.candidate_id}): "
                f"{', '.join(contradicted) or 'a required point'} contradicted"
            )
    return "\n".join(lines)


def _with_status_summary(reply: str, rec: Any) -> str:
    block = _status_summary(rec)
    return f"{reply}\n\n{block}" if block else reply


def _trace_summary_for_record(rec: Any) -> str:
    try:
        status = getattr(rec, "status", "?")
        count = getattr(rec, "candidate_count", 0)
        ranked = getattr(rec, "ranked_candidates", []) or []
        attempts = getattr(rec, "attempts", []) or []
        selected = getattr(rec, "selected_candidate", None)
        verification = getattr(rec, "verification", None)
        lines = [
            f"Pipeline status: {status}.",
            f"Searched {count} candidates; ranked {len(ranked)} with the LLM ranker.",
        ]
        status_block = _status_summary(rec)
        if status_block:
            lines.append(status_block)
        order = ", ".join(getattr(rc, "candidate_id", "?") for rc in ranked[:5])
        if order:
            lines.append(f"Rank order (top): {order}.")
        for a in attempts:
            v = getattr(a, "verification", None)
            ov = getattr(v, "overall_status", "?") if v is not None else "?"
            reqs = getattr(v, "requirements", []) if v is not None else []
            detail = ", ".join(
                f"{getattr(x, 'requirement_id', '?')}={getattr(x, 'status', '?')}" for x in reqs
            )
            lines.append(
                f"Jev verified {getattr(a, 'candidate_id', '?')} "
                f"({getattr(a, 'candidate_name', '')}): {ov} [{detail}]."
            )
        if selected is not None:
            vover = getattr(verification, "overall_status", "?") if verification is not None else "?"
            lines.append(
                f"Selected: {getattr(selected, 'candidate_id', '?')} "
                f"({getattr(selected, 'name', '')}) with overall {vover}."
            )
        else:
            lines.append("No candidate selected.")
        if status == "needs_human_review":
            lines.append("Fallback: nothing VERIFIED — best available returned for human review.")
        elif status == "no_verified_match":
            lines.append("No verified match found.")
        return "\n".join(lines)
    except Exception:
        return f"Pipeline finished with status {getattr(rec, 'status', '?')}."


def run_agent_turn(
    message: str,
    session_id: str | None,
    settings: Settings,
    emit: Callable[[dict], None] | None = None,
) -> dict:
    """Run one chat turn. Returns {reply, status, run_id, selected_candidate, verification, attempts, session_id}."""
    if not message or not message.strip():
        raise ValueError("message must not be empty")
    sid = session_id or uuid.uuid4().hex[:12]

    def _emit(ev: dict) -> None:
        if emit is None:
            return
        try:
            emit(ev)
        except Exception:
            pass

    history = store.get_history(settings.db_path, sid, limit=8)
    _emit({"type": "status", "stage": "routing", "message": "Routing your request..."})
    try:
        route = router_llm(message, history, settings)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"router failed: {_sanitize(str(e), settings)}")

    needs_search = bool(route.get("needs_search", False))
    action = str(route.get("action") or "search")
    engine = route.get("engine")
    engine = str(engine) if engine else None

    if not needs_search:
        trace_summary = (
            "Direct answer (no search performed). "
            f"Router note: {route.get('note', '')}"
        )
        reply = composer_llm(message, history, trace_summary, settings)
        store.save_turn(settings.db_path, sid, "user", message)
        store.save_turn(settings.db_path, sid, "assistant", reply)
        return {
            "reply": reply,
            "status": "direct",
            "run_id": None,
            "selected_candidate": None,
            "verification": None,
            "attempts": [],
            "session_id": sid,
        }

    _emit({"type": "status", "stage": "understanding",
           "message": "Understanding requirements..."})
    rec = _call_pipeline(message, action, settings, 15, engine, _emit)
    trace_summary = _trace_summary_for_record(rec)
    reply = _with_status_summary(composer_llm(message, history, trace_summary, settings), rec)
    store.save_turn(settings.db_path, sid, "user", message)
    store.save_turn(settings.db_path, sid, "assistant", reply)

    selected = getattr(rec, "selected_candidate", None)
    verification = getattr(rec, "verification", None)
    attempts = getattr(rec, "attempts", []) or []
    return {
        "reply": reply,
        "status": getattr(rec, "status", "error"),
        "run_id": getattr(rec, "run_id", None),
        "selected_candidate": selected.model_dump() if selected is not None else None,
        "verification": verification.model_dump() if verification is not None else None,
        "attempts": [a.model_dump() for a in attempts],
        "session_id": sid,
    }


def sse_turn(
    message: str,
    session_id: str | None,
    settings: Settings,
) -> Iterator[dict]:
    """Yield SSE event dicts: status -> [status] -> requirements -> searching -> candidates -> ranking -> verifying* -> verdict -> final; error on failure."""
    if not message or not message.strip():
        yield {"type": "error", "error": "message must not be empty",
               "session_id": session_id}
        return
    sid = session_id or uuid.uuid4().hex[:12]
    yield {"type": "status", "stage": "routing",
           "message": "Routing your request...", "session_id": sid}
    try:
        history = store.get_history(settings.db_path, sid, limit=8)
        route = router_llm(message, history, settings)
    except RuntimeError as e:
        yield {"type": "error", "error": _sanitize(str(e), settings), "session_id": sid}
        return
    except Exception as e:
        yield {"type": "error", "error": _sanitize(f"router failed: {e}", settings),
               "session_id": sid}
        return

    needs_search = bool(route.get("needs_search", False))
    action = str(route.get("action") or "search")
    engine = route.get("engine")
    engine = str(engine) if engine else None

    if not needs_search:
        try:
            trace_summary = (
                "Direct answer (no search performed). "
                f"Router note: {route.get('note', '')}"
            )
            reply = composer_llm(message, history, trace_summary, settings)
            store.save_turn(settings.db_path, sid, "user", message)
            store.save_turn(settings.db_path, sid, "assistant", reply)
            yield {"type": "final", "reply": reply, "status": "direct",
                   "run_id": None, "selected_candidate": None,
                   "verification": None, "attempts": [], "session_id": sid}
        except RuntimeError as e:
            yield {"type": "error", "error": _sanitize(str(e), settings), "session_id": sid}
        except Exception as e:
            yield {"type": "error", "error": _sanitize(f"composer failed: {e}", settings),
                   "session_id": sid}
        return

    yield {"type": "status", "stage": "understanding",
           "message": "Understanding requirements...", "session_id": sid}
    buffered: list[dict] = []

    def _collect(ev: dict) -> None:
        buffered.append(ev)

    try:
        rec = _call_pipeline(message, action, settings, 15, engine, _collect)
    except RuntimeError as e:
        for ev in buffered:
            ev.setdefault("session_id", sid)
            yield ev
        yield {"type": "error", "error": _sanitize(str(e), settings), "session_id": sid}
        return
    except Exception as e:
        for ev in buffered:
            ev.setdefault("session_id", sid)
            yield ev
        yield {"type": "error", "error": _sanitize(f"pipeline_failed: {e}", settings),
               "session_id": sid}
        return

    for ev in buffered:
        ev.setdefault("session_id", sid)
        yield ev
    try:
        trace_summary = _trace_summary_for_record(rec)
        reply = _with_status_summary(composer_llm(message, history, trace_summary, settings), rec)
        store.save_turn(settings.db_path, sid, "user", message)
        store.save_turn(settings.db_path, sid, "assistant", reply)
    except RuntimeError as e:
        yield {"type": "error", "error": _sanitize(str(e), settings), "session_id": sid}
        return
    except Exception as e:
        yield {"type": "error", "error": _sanitize(f"composer failed: {e}", settings),
               "session_id": sid}
        return

    selected = getattr(rec, "selected_candidate", None)
    verification = getattr(rec, "verification", None)
    attempts = getattr(rec, "attempts", []) or []
    yield {
        "type": "final",
        "reply": reply,
        "status": getattr(rec, "status", "error"),
        "run_id": getattr(rec, "run_id", None),
        "selected_candidate": selected.model_dump() if selected is not None else None,
        "verification": verification.model_dump() if verification is not None else None,
        "attempts": [a.model_dump() for a in attempts],
        "session_id": sid,
    }
