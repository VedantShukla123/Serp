"""Dynamic Booking Simulator — simulated bookings only, no network, no payment."""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.api.routes as routes
import app.main as main_module
from app.config import Settings
from app.main import app
from app.models.schemas import BookingRequest
from app.services import booking
from app.storage import store

IN_7 = (date.today() + timedelta(days=7)).isoformat()
IN_10 = (date.today() + timedelta(days=10)).isoformat()


def _cand(cid: str, name: str, per_night: int | None, total: int | None) -> dict:
    offer = {}
    if per_night is not None:
        offer["rate_per_night"] = {"lowest": f"₹{per_night:,}", "extracted_lowest": per_night}
    if total is not None:
        offer["total_rate"] = {"lowest": f"₹{total:,}", "extracted_lowest": total}
    return {"candidate_id": cid, "name": name, "price": f"₹{per_night:,}" if per_night else None,
            "price_value": per_night, "currency": "INR", "address": "", "location": "",
            "cancellation_info": "", "source_url": f"https://example.test/{cid}", "booking_url": "",
            "offer_details": offer}


def _attempt(cid: str, overall: str, pairs: list[tuple[str, str]]) -> dict:
    return {"candidate_id": cid, "candidate_name": cid, "verification": {
        "candidate_id": cid, "overall_status": overall,
        "requirements": [{"requirement_id": k, "status": v} for k, v in pairs]}}


# Shaped like stored run 12c1b202e909 (google_hotels). c4 is never checked.
RUN = {
    "run_id": "run-goa",
    "status": "verified",
    "requirements": [
        {"id": "budget", "description": "Total price must be <= Rs 10,000", "importance": "required"},
        {"id": "guests", "description": "Must sleep at least 2 guests", "importance": "required"},
        {"id": "beachfront", "description": "Must be beachfront", "importance": "required"},
    ],
    "candidates": [
        _cand("c1", "Cocos Beach comfort", 5079, 10157),
        _cand("c2", "Ocean Paradise Homestay", 1119, 2238),
        _cand("c3", "Silver Sands Holiday Village", 4200, None),
        _cand("c4", "Hotel Linda Goa", None, None),
    ],
    "attempts": [
        _attempt("c1", "REJECTED", [("budget", "CONTRADICTED"), ("guests", "SATISFIED"), ("beachfront", "UNKNOWN")]),
        _attempt("c3", "UNVERIFIED", [("budget", "SATISFIED"), ("guests", "UNKNOWN"), ("beachfront", "UNKNOWN")]),
        _attempt("c2", "VERIFIED", [("budget", "SATISFIED"), ("guests", "SATISFIED"), ("beachfront", "SATISFIED")]),
    ],
}


def _req(cid: str, **kw) -> BookingRequest:
    base = dict(run_id="run-goa", candidate_id=cid, guest_name="Asha Rao", email="asha@example.com",
                guests=2, check_in=IN_7, check_out=IN_10)
    base.update(kw)
    return BookingRequest(**base)


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    s = Settings(serpapi_api_key="", llm_api_key="", jev_api_key="", jev_endpoint="",
                 db_path=str(tmp_path / "test.db"))
    monkeypatch.setattr(routes, "settings", s)
    monkeypatch.setattr(main_module, "settings", s)
    store.save_run(s.db_path, "run-goa", "2026-10-10T00:00:00+00:00", "goa", RUN)
    return TestClient(app)


# ---- candidate -> booking mapping ----

def test_context_resolves_hotel_and_prices_by_candidate_id() -> None:
    ctx = booking.booking_context(RUN, "c2")
    assert ctx["candidate_id"] == "c2" and ctx["hotel"]["name"] == "Ocean Paradise Homestay"
    assert ctx["price"]["per_night"] == 1119 and ctx["price"]["per_night_display"] == "₹1,119"
    assert ctx["price"]["listed_total"] == 2238 and "not your dates" in ctx["price"]["listed_total_note"]
    assert ctx["verification_status"] == "VERIFIED" and ctx["bookable"] and not ctx["requires_acknowledgement"]
    assert "NO PAYMENT CHARGED" in ctx["disclaimer"]


def test_missing_price_information_stays_unknown() -> None:
    p = booking.booking_context(RUN, "c4")["price"]
    assert p["per_night"] is None and p["listed_total"] is None and p["listed_total_note"] is None
    p3 = booking.booking_context(RUN, "c3")["price"]
    assert p3["per_night"] == 4200 and p3["listed_total"] is None


def test_client_supplied_hotel_and_price_are_ignored(client: TestClient) -> None:
    body = {**_req("c2").model_dump(), "name": "Fake Palace", "price": 1, "per_night": 1}
    out = client.post("/v1/bookings/preview", json=body).json()
    assert out["hotel"]["name"] == "Ocean Paradise Homestay" and out["price"]["per_night"] == 1119


def test_unknown_candidate_and_run_are_404(client: TestClient) -> None:
    assert client.get("/v1/runs/run-goa/candidates/c99/booking-context").status_code == 404
    assert client.get("/v1/runs/nope/candidates/c1/booking-context").status_code == 404


# ---- REJECTED / UNVERIFIED / unchecked ----

def test_rejected_candidate_cannot_be_previewed_or_booked(client: TestClient) -> None:
    ctx = client.get("/v1/runs/run-goa/candidates/c1/booking-context").json()
    assert ctx["bookable"] is False
    assert ctx["contradicted_requirements"][0]["requirement_id"] == "budget"
    for path in ("/v1/bookings/preview", "/v1/bookings"):
        r = client.post(path, json=_req("c1", acknowledge_unverified=True).model_dump())
        assert r.status_code == 409 and r.json()["detail"]["code"] == "candidate_rejected"


def test_unverified_requires_acknowledgement_and_lists_uncertainties(client: TestClient) -> None:
    ctx = client.get("/v1/runs/run-goa/candidates/c3/booking-context").json()
    assert ctx["requires_acknowledgement"] is True
    assert [u["requirement_id"] for u in ctx["unresolved_requirements"]] == ["guests", "beachfront"]
    assert ctx["unresolved_requirements"][0]["description"] == "Must sleep at least 2 guests"
    r = client.post("/v1/bookings", json=_req("c3").model_dump())
    assert r.status_code == 409 and r.json()["detail"]["code"] == "acknowledgement_required"
    ok = client.post("/v1/bookings", json=_req("c3", acknowledge_unverified=True).model_dump())
    assert ok.status_code == 200 and ok.json()["acknowledged_unverified"] is True


def test_unchecked_candidate_is_treated_as_unverified() -> None:
    ctx = booking.booking_context(RUN, "c4")
    assert ctx["verification_status"] == "NOT_CHECKED" and ctx["requires_acknowledgement"]
    assert {u["status"] for u in ctx["unresolved_requirements"]} == {"NOT_CHECKED"}


# ---- form validation ----

@pytest.mark.parametrize("field,kw", [
    ("guest_name", {"guest_name": "   "}),
    ("email", {"email": "not-an-email"}),
    ("guests", {"guests": 0}),
    ("guests", {"guests": None}),
    ("check_in", {"check_in": ""}),
    ("check_in", {"check_in": (date.today() - timedelta(days=1)).isoformat()}),
    ("check_out", {"check_out": IN_7}),  # same day as check-in
    ("check_out", {"check_out": (date.today() + timedelta(days=60)).isoformat()}),
])
def test_validation_errors(field: str, kw: dict) -> None:
    with pytest.raises(booking.BookingError) as e:
        booking.validate_guest_details(_req("c2", **kw))
    assert e.value.status == 422 and field in e.value.errors


def test_preview_estimates_total_from_per_night_rate(client: TestClient) -> None:
    out = client.post("/v1/bookings/preview", json=_req("c2").model_dump()).json()
    assert out["guest"]["nights"] == 3 and out["estimated_total"] == 1119 * 3
    assert "Estimate only" in out["estimated_total_note"]
    assert booking.preview_booking(RUN, _req("c4"))["estimated_total"] is None  # no rate -> unknown


def test_invalid_details_return_field_errors(client: TestClient) -> None:
    r = client.post("/v1/bookings/preview", json=_req("c2", email="x", guests=0).model_dump())
    assert r.status_code == 422 and set(r.json()["detail"]["errors"]) == {"email", "guests"}


# ---- confirmation ----

def test_verified_booking_is_stored_and_retrievable(client: TestClient) -> None:
    r = client.post("/v1/bookings", json=_req("c2").model_dump())
    assert r.status_code == 200
    b = r.json()
    assert b["booking_id"].startswith("SIM-") and b["status"] == "SIMULATED_CONFIRMED" and b["simulated"] is True
    assert b["candidate_id"] == "c2" and b["hotel"]["name"] == "Ocean Paradise Homestay"
    assert b["disclaimer"] == "SIMULATED BOOKING — NO REAL RESERVATION CREATED — NO PAYMENT CHARGED"
    assert b["acknowledged_unverified"] is False
    assert client.get(f"/v1/bookings/{b['booking_id']}").json() == b
    assert client.get("/v1/bookings/SIM-NOPE").status_code == 404
    # existing run routes untouched by the bookings table
    assert client.get("/v1/runs/run-goa").status_code == 200
