"""SerpApi discovery: request -> COMPLETE meaningful candidate data.

Real path only: live SerpApi HTTP (engine auto-picked per request:
google_hotels / google_shopping / google_flights / google). Without
SERPAPI_API_KEY the pipeline fails loudly — no fabricated candidates.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

import httpx

from app.config import Settings
from app.models.schemas import Candidate

_NOISE_KEYS = {
    "serpapi_pagination",
    "search_metadata",
    "search_parameters",
    "search_information",
    "pagination",
    "credits",
}


def pick_engine(action: str, request: str, override: str | None = None) -> str:
    if override:
        return override
    a = (action or "").lower()
    if "hotel" in a or "stay" in a:
        return "google_hotels"
    if "flight" in a:
        return "google_flights"
    if "restaurant" in a or "food" in a or "dining" in a:
        return "google_maps"
    if "laptop" in a or "shop" in a or "buy" in a or "product" in a:
        return "google_shopping"
    low = request.lower()
    if "hotel" in low or "goa" in low or "stay" in low or "beach" in low:
        return "google_hotels"
    if "laptop" in low or "rtx" in low or "oled" in low or "ram" in low:
        return "google_shopping"
    if "flight" in low:
        return "google_flights"
    if any(w in low for w in ("restaurant", "restaurants", "food", "dining", "eat out",
                              "cafe", "cafes", "bar ", "bars ", "pub ")):
        return "google_maps"
    return "google"


def _strip_noise(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _strip_noise(v) for k, v in obj.items() if k not in _NOISE_KEYS}
    if isinstance(obj, list):
        return [_strip_noise(x) for x in obj]
    return obj


def _num(text: Any) -> float | None:
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return float(text)
    s = str(text).replace(",", "")
    m = re.search(r"[\d]+(?:\.\d+)?", s)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def normalize_hotel(item: dict, idx: int) -> Candidate:
    price_raw = item.get("rate_per_night") or item.get("price") or item.get("extracted_price")
    if isinstance(price_raw, dict):
        price_raw = price_raw.get("lowest") or price_raw.get("extracted_lowest")
    amenities: list[str] = []
    for k in ("amenities", "highlighted_amenities", "essential_amenities"):
        v = item.get(k)
        if isinstance(v, list):
            amenities.extend(str(x) for x in v)
    return Candidate(
        candidate_id=f"c{idx + 1}",
        name=str(item.get("name") or item.get("title") or f"Hotel {idx + 1}"),
        title=str(item.get("title") or ""),
        price=price_raw,
        price_value=_num(item.get("extracted_price") or price_raw),
        currency=str(item.get("currency") or "INR"),
        rating=_num(item.get("rating") or item.get("overall_rating")),
        review_count=item.get("reviews") if isinstance(item.get("reviews"), int) else _num_to_int(item.get("reviews")),
        location=str(item.get("location") or item.get("area") or ""),
        address=str(item.get("address") or ""),
        description=str(item.get("description") or item.get("snippet") or ""),
        amenities=amenities,
        attributes={k: v for k, v in item.items() if k in ("type", "class", "stars", "area", "gps_coordinates", "check_in_time", "check_out_time")},
        offer_details={k: v for k, v in item.items() if k in ("prices", "rate_per_night", "total_rate", "nearby_places", "deal", "deal_description")},
        cancellation_info=str(item.get("free_cancellation") or item.get("cancellation") or ""),
        seller=str(item.get("source") or ""),
        snippet=str(item.get("snippet") or ""),
        source_url=str(item.get("link") or ""),
        booking_url=str(item.get("link") or ""),
        engine="google_hotels",
        engine_metadata=_strip_noise({k: v for k, v in item.items() if k not in ("name", "title")}),
        raw=_strip_noise(item),
    )


def _num_to_int(v: Any) -> int | None:
    n = _num(v)
    return int(n) if n is not None else None


def normalize_shopping(item: dict, idx: int) -> Candidate:
    return Candidate(
        candidate_id=f"c{idx + 1}",
        name=str(item.get("title") or f"Product {idx + 1}"),
        title=str(item.get("title") or ""),
        price=item.get("price"),
        price_value=_num(item.get("extracted_price") or item.get("price")),
        currency="INR" if "₹" in str(item.get("price", "")) else str(item.get("currency") or ""),
        rating=_num(item.get("rating")),
        review_count=_num_to_int(item.get("reviews")),
        description=str(item.get("snippet") or item.get("description") or ""),
        snippet=str(item.get("snippet") or ""),
        seller=str(item.get("source") or item.get("seller") or ""),
        source_url=str(item.get("link") or item.get("product_link") or ""),
        booking_url=str(item.get("product_link") or item.get("link") or ""),
        attributes={k: v for k, v in item.items() if k in ("brand", "condition", "extensions", "tag", "delivery")},
        engine="google_shopping",
        engine_metadata=_strip_noise(item),
        raw=_strip_noise(item),
    )


def normalize_maps(item: dict, idx: int) -> Candidate:
    """Google Maps place: real venue with rating, reviews, address, hours."""
    hours = item.get("hours") or item.get("operating_hours") or ""
    if isinstance(hours, dict):
        hours = hours.get("weekday_text") or str(hours)
    return Candidate(
        candidate_id=f"c{idx + 1}",
        name=str(item.get("title") or f"Place {idx + 1}"),
        title=str(item.get("title") or ""),
        rating=_num(item.get("rating")),
        review_count=_num_to_int(item.get("reviews")),
        location=str(item.get("address") or ""),
        address=str(item.get("address") or ""),
        description=str(item.get("description") or item.get("snippet") or ""),
        snippet=str(item.get("snippet") or ""),
        attributes={k: v for k, v in item.items()
                    if k in ("type", "types", "price", "phone", "website", "place_id",
                             "gps_coordinates", "service_options")},
        availability_details={"hours": hours} if hours else {},
        source_url=str(item.get("link") or item.get("website") or ""),
        booking_url=str(item.get("website") or item.get("link") or ""),
        engine="google_maps",
        engine_metadata=_strip_noise(item),
        raw=_strip_noise(item),
    )


def normalize_generic(item: dict, idx: int, engine: str) -> Candidate:    return Candidate(
        candidate_id=f"c{idx + 1}",
        name=str(item.get("title") or item.get("name") or f"Result {idx + 1}"),
        title=str(item.get("title") or ""),
        description=str(item.get("snippet") or item.get("description") or ""),
        snippet=str(item.get("snippet") or ""),
        source_url=str(item.get("link") or ""),
        booking_url=str(item.get("link") or ""),
        attributes={k: v for k, v in item.items() if k in ("price", "rating", "source", "extensions")},
        price=item.get("price"),
        price_value=_num(item.get("price")),
        rating=_num(item.get("rating")),
        engine=engine,
        engine_metadata=_strip_noise(item),
        raw=_strip_noise(item),
    )


def normalize_results(engine: str, results: list[dict]) -> list[Candidate]:
    out: list[Candidate] = []
    for i, item in enumerate(results):
        if not isinstance(item, dict):
            continue
        if engine == "google_hotels":
            out.append(normalize_hotel(item, i))
        elif engine == "google_shopping":
            out.append(normalize_shopping(item, i))
        elif engine == "google_maps":
            out.append(normalize_maps(item, i))
        else:
            out.append(normalize_generic(item, i, engine))
    return out


def search_serpapi(
    request: str, action: str, settings: Settings, max_candidates: int = 15,
    engine_override: str | None = None,
) -> tuple[list[Candidate], dict, Any]:
    """Returns (candidates, serpapi_meta, raw_response).

    Raises RuntimeError when SERPAPI_API_KEY is missing or the request fails.
    """
    engine = pick_engine(action, request, engine_override)
    if not settings.has_serpapi:
        raise RuntimeError(
            "SERPAPI_API_KEY is not set. Live discovery needs a real SerpApi key — "
            "set SERPAPI_API_KEY in .env. ProofGate never fabricates candidates."
        )
    params: dict[str, Any] = {
        "engine": engine,
        "q": request,
        "api_key": settings.serpapi_api_key,
    }
    if engine == "google_hotels":
        params.setdefault("hl", "en")
        params.setdefault("gl", "in")
        params.setdefault("currency", "INR")
        # google_hotels REQUIRES check-in/out dates. Sensible default:
        # 2 weeks out, 2-night stay (override per call if ever needed).
        check_in = date.today() + timedelta(days=14)
        params.setdefault("check_in_date", check_in.isoformat())
        params.setdefault("check_out_date", (check_in + timedelta(days=2)).isoformat())
    try:
        with httpx.Client(timeout=30) as client:
            r = client.get("https://serpapi.com/search.json", params=params)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        # Never leak the API key (httpx embeds params in the URL).
        safe = str(e).replace(settings.serpapi_api_key, "***") if settings.serpapi_api_key else str(e)
        raise RuntimeError(f"serpapi request failed (engine={engine}): {safe}")
    items: list[dict] = []
    for key in ("properties", "shopping_results", "local_results", "organic_results",
                "flights_results", "results"):
        v = data.get(key)
        if isinstance(v, list) and v:
            items = [x for x in v if isinstance(x, dict)]
            break
    if not items and isinstance(data.get("hotels_results"), list):
        items = data["hotels_results"]
    candidates = normalize_results(engine, items[:max_candidates])
    meta = {"engine": engine, "result_count": len(candidates)}
    return candidates, meta, _strip_noise(data)
