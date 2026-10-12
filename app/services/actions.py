"""Target / action classification for simulated actions.

The target type of a candidate comes from the search engine that produced it
(every normalized candidate records `engine`), falling back to the run's
serpapi_meta.engine, then the router action. It is never guessed from the UI.

  google_hotels   -> hotel    -> hotel_booking  (simulated, booking.py)
  google_shopping -> product  -> product_order  (simulated, orders.py)
  google_maps     -> place    -> review_only    (no reservation flow exists)
  anything else   -> generic  -> review_only    (never silently a hotel)
"""
from __future__ import annotations

from typing import Any, Literal

TargetType = Literal["hotel", "product", "place", "generic"]

_ENGINE_TARGET: dict[str, TargetType] = {
    "google_hotels": "hotel",
    "google_shopping": "product",
    "google_maps": "place",
}

ACTIONS: dict[str, dict[str, Any]] = {
    "hotel": {"kind": "hotel_booking", "label": "Simulate hotel booking", "supported": True},
    "product": {"kind": "product_order", "label": "Simulate order", "supported": True},
    "place": {"kind": "review_only", "label": "Review result", "supported": False},
    "generic": {"kind": "review_only", "label": "Review result", "supported": False},
}


def target_type(engine: str | None, action: str | None = None) -> TargetType:
    if engine:
        return _ENGINE_TARGET.get(engine, "generic")
    a = (action or "").lower()
    if a == "book_hotel":
        return "hotel"
    if a.startswith("buy_"):
        return "product"
    return "generic"


def run_engine(run: dict) -> str | None:
    meta = run.get("serpapi_meta") or {}
    return meta.get("engine") if isinstance(meta, dict) else None


def run_target_type(run: dict) -> TargetType:
    """Works for runs stored before target_type existed (derived, not stored)."""
    stored = run.get("target_type")
    if stored in ACTIONS:
        return stored  # type: ignore[return-value]
    return target_type(run_engine(run), run.get("action"))


def candidate_target_type(run: dict, cand: dict) -> TargetType:
    return target_type(cand.get("engine") or run_engine(run), run.get("action"))
