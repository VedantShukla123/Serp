"""Dynamic Booking Simulator — DEMO ONLY.

Creates a simulated booking record for a candidate from a stored run.
No real reservation is made, no payment is taken, no card data is
collected. The hotel identity, price and verification status are always
resolved server-side from the stored run by candidate_id; the client
only supplies guest details.

Rules:
- REJECTED candidates (a required point contradicted) can never be booked.
- Anything not VERIFIED (UNVERIFIED, or never checked by Jev) needs an
  explicit human-review acknowledgement before the simulation is created.
- Prices are shown exactly as listed by the search; unavailable values
  stay None ("unknown"). The only computed figure is a clearly labelled
  per-night x nights estimate.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timezone
from typing import Any

from app.models.schemas import BookingRequest
from app.storage import store

DISCLAIMER = "SIMULATED BOOKING — NO REAL RESERVATION CREATED — NO PAYMENT CHARGED"
NOT_CHECKED = "NOT_CHECKED"
MAX_GUESTS = 10
MAX_NIGHTS = 30
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class BookingError(Exception):
    def __init__(self, status: int, code: str, message: str, errors: dict[str, str] | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.errors = status, code, message, errors or {}

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message, "errors": self.errors}


def _num(v: Any) -> float | None:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    return None


def _rate(offer: dict, key: str) -> tuple[float | None, str | None]:
    """(value, display) for a SerpApi google_hotels rate block like
    {"lowest": "₹5,079", "extracted_lowest": 5079}."""
    block = offer.get(key)
    if not isinstance(block, dict):
        return None, None
    display = block.get("lowest")
    return _num(block.get("extracted_lowest")), str(display) if display else None


def price_info(cand: dict) -> dict:
    offer = cand.get("offer_details") or {}
    per_night, per_night_display = _rate(offer, "rate_per_night")
    total, total_display = _rate(offer, "total_rate")
    listed = cand.get("price")
    return {
        "currency": cand.get("currency") or None,
        "per_night": per_night,
        "per_night_display": per_night_display,
        "listed_total": total,
        "listed_total_display": total_display,
        "listed_total_note": ("Total listed by the search for its own sample stay dates — not your dates."
                              if total is not None else None),
        # price as listed when no per-night breakdown exists (basis unknown)
        "listed_price_display": str(listed) if listed not in (None, "") and per_night is None else None,
    }


def _find_candidate(run: dict, candidate_id: str) -> dict:
    for c in run.get("candidates") or []:
        if isinstance(c, dict) and c.get("candidate_id") == candidate_id:
            return c
    raise BookingError(404, "candidate_not_found", f"Candidate {candidate_id} is not in run {run.get('run_id')}.")


def _attempt(run: dict, candidate_id: str) -> dict | None:
    for a in run.get("attempts") or []:
        if isinstance(a, dict) and a.get("candidate_id") == candidate_id:
            return a
    return None


def booking_context(run: dict, candidate_id: str) -> dict:
    """Everything the booking form/review needs, resolved from the stored run."""
    cand = _find_candidate(run, candidate_id)
    attempt = _attempt(run, candidate_id)
    verification = (attempt or {}).get("verification") or {}
    status = verification.get("overall_status") or NOT_CHECKED
    descriptions = {r.get("id"): r.get("description") for r in run.get("requirements") or [] if isinstance(r, dict)}

    def _with(st: str) -> list[dict]:
        return [{"requirement_id": v.get("requirement_id"),
                 "description": descriptions.get(v.get("requirement_id")) or v.get("requirement_id"),
                 "status": st}
                for v in verification.get("requirements") or [] if v.get("status") == st]

    unresolved = _with("UNKNOWN")
    if status == NOT_CHECKED:
        unresolved = [{"requirement_id": rid, "description": d, "status": "NOT_CHECKED"}
                      for rid, d in descriptions.items()]
    return {
        "run_id": run.get("run_id"),
        "candidate_id": candidate_id,
        "hotel": {
            "name": cand.get("name") or cand.get("title") or None,
            "address": cand.get("address") or cand.get("location") or None,
            "rating": cand.get("rating"),
            "source_url": cand.get("booking_url") or cand.get("source_url") or None,
            "cancellation_info": cand.get("cancellation_info") or None,
        },
        "price": price_info(cand),
        "verification_status": status,
        "unresolved_requirements": unresolved,
        "contradicted_requirements": _with("CONTRADICTED"),
        "bookable": status != "REJECTED",
        "requires_acknowledgement": status != "VERIFIED",
        "disclaimer": DISCLAIMER,
    }


def validate_guest_details(req: BookingRequest, today: date | None = None) -> dict:
    """Returns cleaned guest details or raises BookingError(422) with per-field errors."""
    today = today or date.today()
    errors: dict[str, str] = {}
    name = req.guest_name.strip()
    if not name:
        errors["guest_name"] = "Guest name is required."
    elif len(name) > 100:
        errors["guest_name"] = "Guest name is too long."
    email = req.email.strip()
    if not _EMAIL.match(email):
        errors["email"] = "Enter a valid email address."
    if req.guests is None or not 1 <= req.guests <= MAX_GUESTS:
        errors["guests"] = f"Guests must be between 1 and {MAX_GUESTS}."
    ci = co = None
    try:
        ci = date.fromisoformat(req.check_in)
    except ValueError:
        errors["check_in"] = "Check-in date is required (YYYY-MM-DD)."
    try:
        co = date.fromisoformat(req.check_out)
    except ValueError:
        errors["check_out"] = "Check-out date is required (YYYY-MM-DD)."
    if ci and ci < today:
        errors["check_in"] = "Check-in cannot be in the past."
    if ci and co:
        if co <= ci:
            errors["check_out"] = "Check-out must be after check-in."
        elif (co - ci).days > MAX_NIGHTS:
            errors["check_out"] = f"Stays are limited to {MAX_NIGHTS} nights."
    if errors:
        raise BookingError(422, "invalid_booking_details", "Please fix the highlighted fields.", errors)
    assert ci and co
    return {"guest_name": name, "email": email, "guests": req.guests,
            "check_in": ci.isoformat(), "check_out": co.isoformat(), "nights": (co - ci).days}


def preview_booking(run: dict, req: BookingRequest, today: date | None = None) -> dict:
    ctx = booking_context(run, req.candidate_id)
    if not ctx["bookable"]:
        raise BookingError(409, "candidate_rejected",
                           "This hotel was REJECTED by Jev (a required point was contradicted) and cannot be booked.")
    guest = validate_guest_details(req, today)
    per_night = ctx["price"]["per_night"]
    estimate = round(per_night * guest["nights"], 2) if per_night is not None else None
    return {**ctx, "guest": guest, "estimated_total": estimate,
            "estimated_total_note": ("Estimate only: listed per-night rate × nights. Not a quote."
                                     if estimate is not None else None)}


def create_booking(db_path: str, run: dict, req: BookingRequest, today: date | None = None) -> dict:
    preview = preview_booking(run, req, today)
    if preview["requires_acknowledgement"] and not req.acknowledge_unverified:
        raise BookingError(409, "acknowledgement_required",
                           "This hotel is not VERIFIED. Review the open points and confirm the human-review "
                           "acknowledgement before simulating.")
    booking = {
        **preview,
        "booking_id": "SIM-" + uuid.uuid4().hex[:8].upper(),
        "status": "SIMULATED_CONFIRMED",
        "simulated": True,
        "acknowledged_unverified": bool(req.acknowledge_unverified and preview["requires_acknowledgement"]),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    store.save_booking(db_path, booking)
    return booking
