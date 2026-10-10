"""Action type follows the search engine: hotels book, products order, others review.

Regression for run 5b051ed2235f ("Laptop under Rs 90,000, 32GB RAM, OLED display",
google_shopping) which opened the hotel booking form. No network calls.
"""
from __future__ import annotations

import copy
import random
from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.api.routes as routes
import app.main as main_module
from app.config import Settings
from app.main import app
from app.services import actions
from app.storage import store

IN_7 = (date.today() + timedelta(days=7)).isoformat()
IN_9 = (date.today() + timedelta(days=9)).isoformat()


def _att(cid: str, overall: str, pairs: dict[str, str]) -> dict:
    return {"candidate_id": cid, "candidate_name": cid, "verification": {
        "candidate_id": cid, "overall_status": overall,
        "requirements": [{"requirement_id": k, "status": v} for k, v in pairs.items()]}}


def _laptop(cid: str, name: str, price: str, value: float, seller: str, **extra) -> dict:
    return {"candidate_id": cid, "name": name, "price": price, "price_value": value, "currency": "",
            "seller": seller, "engine": "google_shopping", "source_url": f"https://shop.example/{cid}",
            "attributes": {"delivery": "Free delivery"}, "offer_details": {}, "cancellation_info": "", **extra}


# Shaped like stored run 5b051ed2235f (values copied from it).
SHOP_RUN = {
    "run_id": "5b051ed2235f", "status": "needs_human_review", "action": "buy_laptop",
    "request": "Laptop under Rs 90,000, 32GB RAM, OLED display",
    "serpapi_meta": {"engine": "google_shopping", "result_count": 3},
    "requirements": [{"id": "budget", "description": "Total price must be <= Rs 90,000"},
                     {"id": "ram", "description": "Must have 32GB RAM"},
                     {"id": "display", "description": "Must have an OLED display"}],
    "candidates": [
        _laptop("c1", 'New Asus Vivobook S 14 S5406S 14" Core Ultra 7 258V 32gb RAM 1TB SSD', "$1,286.01", 1286.01, "Best Buy"),
        _laptop("c4", "Laptop with LCD display", "$984.99", 984.99, "Walmart"),
        _laptop("c5", "ASUS Zenbook 14 OLED 32GB", "$899.00", 899.0, "Amazon"),
    ],
    "ranked_candidates": [{"candidate_id": "c5", "rank": 1}, {"candidate_id": "c4", "rank": 2}, {"candidate_id": "c1", "rank": 3}],
    "attempts": [
        _att("c5", "UNVERIFIED", {"budget": "UNKNOWN", "ram": "SATISFIED", "display": "SATISFIED"}),
        _att("c4", "REJECTED", {"budget": "UNKNOWN", "ram": "SATISFIED", "display": "CONTRADICTED"}),
        _att("c1", "UNVERIFIED", {"budget": "UNKNOWN", "ram": "SATISFIED", "display": "UNKNOWN"}),
    ],
}

HOTEL_RUN = {
    "run_id": "c28bb2b65036", "status": "needs_human_review", "action": "search",   # router action was "search"
    "request": "Hotel in Goa", "serpapi_meta": {"engine": "google_hotels"},
    "requirements": [{"id": "budget", "description": "Total price must be <= Rs 10,000"}],
    "candidates": [{"candidate_id": "c3", "name": "Silver Sands Holiday Village", "price": "₹1,694", "price_value": 1694,
                    "currency": "INR", "engine": "google_hotels", "cancellation_info": "",
                    "offer_details": {"rate_per_night": {"lowest": "₹1,694", "extracted_lowest": 1694}}}],
    "attempts": [_att("c3", "UNVERIFIED", {"budget": "SATISFIED"})],
}

MAPS_RUN = {"run_id": "maps1", "status": "needs_human_review", "action": "search", "request": "cafes",
            "serpapi_meta": {"engine": "google_maps"}, "requirements": [],
            "candidates": [{"candidate_id": "c1", "name": "Cafe", "engine": "google_maps"}], "attempts": []}
WEB_RUN = {**MAPS_RUN, "run_id": "web1", "serpapi_meta": {"engine": "google"},
           "candidates": [{"candidate_id": "c1", "name": "Some page", "engine": "google"}]}
LEGACY_RUN = {**MAPS_RUN, "run_id": "legacy1", "serpapi_meta": {}, "action": "search",
              "candidates": [{"candidate_id": "c1", "name": "Mystery"}]}   # no engine anywhere


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    s = Settings(serpapi_api_key="", llm_api_key="", jev_api_key="", jev_endpoint="", db_path=str(tmp_path / "t.db"))
    monkeypatch.setattr(routes, "settings", s)
    monkeypatch.setattr(main_module, "settings", s)
    for run in (SHOP_RUN, HOTEL_RUN, MAPS_RUN, WEB_RUN, LEGACY_RUN):
        store.save_run(s.db_path, run["run_id"], "2026-10-10T00:00:00+00:00", run["request"], run)
    return TestClient(app)


def _order(cid: str, **kw) -> dict:
    return {"run_id": "5b051ed2235f", "candidate_id": cid, "buyer_name": "Asha Rao", "email": "asha@example.com",
            "quantity": 2, "delivery_address": "12 MG Road, Bengaluru 560001", **kw}


HOTEL_ONLY_KEYS = {"hotel", "guest", "nights", "estimated_total", "per_night", "check_in", "check_out"}


def _all_keys(obj) -> set[str]:
    if isinstance(obj, dict):
        return set(obj) | {k for v in obj.values() for k in _all_keys(v)}
    if isinstance(obj, list):
        return {k for v in obj for k in _all_keys(v)}
    return set()


# 1. hotel run keeps the hotel flow
def test_saved_hotel_run_opens_hotel_booking(client: TestClient) -> None:
    ctx = client.get("/v1/runs/c28bb2b65036/candidates/c3/action-context").json()
    assert ctx["target_type"] == "hotel"
    assert ctx["action"] == {"kind": "hotel_booking", "label": "Simulate hotel booking", "supported": True}
    assert ctx["hotel"]["name"] == "Silver Sands Holiday Village" and ctx["price"]["per_night"] == 1694
    r = client.post("/v1/bookings/preview", json={"run_id": "c28bb2b65036", "candidate_id": "c3", "guest_name": "A",
                    "email": "a@b.co", "guests": 2, "check_in": IN_7, "check_out": IN_9})
    assert r.status_code == 200 and r.json()["guest"]["nights"] == 2


# 2. laptop run opens the product order, with no hotel fields
def test_saved_shopping_run_opens_product_order_without_hotel_fields(client: TestClient) -> None:
    ctx = client.get("/v1/runs/5b051ed2235f/candidates/c1/action-context").json()
    assert ctx["target_type"] == "product"
    assert ctx["action"] == {"kind": "product_order", "label": "Simulate order", "supported": True}
    assert ctx["product"]["title"].startswith("New Asus Vivobook S 14")
    assert ctx["product"]["seller"] == "Best Buy" and ctx["product"]["delivery_info"] == "Free delivery"
    assert not (_all_keys(ctx) & HOTEL_ONLY_KEYS)
    assert "ORDER" in ctx["disclaimer"] and "BOOKING" not in ctx["disclaimer"]


def test_hotel_endpoints_refuse_a_product(client: TestClient) -> None:
    for r in (client.get("/v1/runs/5b051ed2235f/candidates/c1/booking-context"),
              client.post("/v1/bookings", json={"run_id": "5b051ed2235f", "candidate_id": "c1", "guest_name": "A",
                          "email": "a@b.co", "guests": 2, "check_in": IN_7, "check_out": IN_9, "acknowledge_unverified": True})):
        assert r.status_code == 409 and r.json()["detail"]["code"] == "wrong_action_type"


# 3. the order is for the exact product, with its listed price untouched
def test_order_references_exact_candidate_and_preserves_source_price(client: TestClient) -> None:
    r = client.post("/v1/orders", json=_order("c1", acknowledge_unverified=True))
    assert r.status_code == 200
    o = r.json()
    assert o["order_id"].startswith("SIM-ORDER-") and o["status"] == "SIMULATED_ORDER_CONFIRMED" and o["simulated"] is True
    assert o["candidate_id"] == "c1" and o["product"]["title"].startswith("New Asus Vivobook S 14")
    assert o["price"]["listed_display"] == "$1,286.01" and o["price"]["value"] == 1286.01
    # "$" alone is ambiguous: no currency code invented, nothing converted, no subtotal
    assert o["price"]["currency"] is None and o["price"]["currency_reliable"] is False
    assert o["subtotal"] is None and "converted" in o["price"]["note"]
    assert o["buyer"]["quantity"] == 2
    assert client.get(f"/v1/orders/{o['order_id']}").json() == o


def test_subtotal_only_with_reliable_currency(client: TestClient) -> None:
    run = copy.deepcopy(SHOP_RUN)
    run["run_id"] = "inr1"
    run["candidates"][0].update(price="₹89,990", price_value=89990.0)
    store.save_run(routes.settings.db_path, "inr1", "2026-10-10T00:00:00+00:00", "x", run)
    o = client.post("/v1/orders/preview", json=_order("c1", run_id="inr1")).json()
    assert o["price"]["currency"] == "INR" and o["price"]["currency_source"] == "symbol"
    assert o["subtotal"] == 179980.0 and "INR" in o["subtotal_note"]


# 4. REJECTED products are blocked
def test_rejected_product_cannot_be_ordered(client: TestClient) -> None:
    ctx = client.get("/v1/runs/5b051ed2235f/candidates/c4/action-context").json()
    assert ctx["orderable"] is False and ctx["contradicted_requirements"][0]["requirement_id"] == "display"
    for path in ("/v1/orders/preview", "/v1/orders"):
        r = client.post(path, json=_order("c4", acknowledge_unverified=True))
        assert r.status_code == 409 and r.json()["detail"]["code"] == "candidate_rejected"


# 5. UNVERIFIED products need the acknowledgement
def test_unverified_product_requires_acknowledgement(client: TestClient) -> None:
    ctx = client.get("/v1/runs/5b051ed2235f/candidates/c1/action-context").json()
    assert ctx["requires_acknowledgement"] is True
    assert {u["requirement_id"] for u in ctx["unresolved_requirements"]} == {"budget", "display"}
    r = client.post("/v1/orders", json=_order("c1"))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "acknowledgement_required"


def test_order_form_validation(client: TestClient) -> None:
    r = client.post("/v1/orders/preview", json=_order("c1", buyer_name=" ", email="x", quantity=0, delivery_address="x"))
    assert r.status_code == 422
    assert set(r.json()["detail"]["errors"]) == {"buyer_name", "email", "quantity", "delivery_address"}


# 6. ranking / attempt order never changes which product or status is used
def test_candidate_order_does_not_change_selection(client: TestClient) -> None:
    base = client.get("/v1/runs/5b051ed2235f/candidates/c5/action-context").json()
    run = copy.deepcopy(SHOP_RUN)
    run["run_id"] = "shuffled"
    rng = random.Random(7)
    for key in ("candidates", "ranked_candidates", "attempts"):
        rng.shuffle(run[key])
    run["ranked_candidates"] = [{"candidate_id": c, "rank": i + 1} for i, c in enumerate(["c1", "c4", "c5"])]
    store.save_run(routes.settings.db_path, "shuffled", "2026-10-10T00:00:00+00:00", "x", run)
    moved = client.get("/v1/runs/shuffled/candidates/c5/action-context").json()
    for k in ("candidate_id", "product", "price", "verification_status", "unresolved_requirements"):
        assert moved[k] == base[k]
    assert moved["product"]["title"] == "ASUS Zenbook 14 OLED 32GB" and moved["verification_status"] == "UNVERIFIED"


# 7. unknown / unsupported types never become hotel bookings
@pytest.mark.parametrize("run_id,kind", [("maps1", "place"), ("web1", "generic"), ("legacy1", "generic")])
def test_unsupported_types_are_review_only(client: TestClient, run_id: str, kind: str) -> None:
    ctx = client.get(f"/v1/runs/{run_id}/candidates/c1/action-context").json()
    assert ctx["target_type"] == kind and ctx["action"]["kind"] == "review_only" and ctx["action"]["supported"] is False
    assert "hotel" not in ctx
    assert client.get(f"/v1/runs/{run_id}/candidates/c1/booking-context").json()["detail"]["code"] == "wrong_action_type"
    r = client.post("/v1/orders/preview", json=_order("c1", run_id=run_id))
    assert r.json()["detail"]["code"] == "wrong_action_type"


def test_target_type_classification() -> None:
    assert actions.target_type("google_hotels") == "hotel"
    assert actions.target_type("google_shopping") == "product"
    assert actions.target_type("google_maps") == "place"
    assert actions.target_type("google_flights") == "generic"     # no flight flow exists
    assert actions.target_type(None, "book_hotel") == "hotel"
    assert actions.target_type(None, "buy_laptop") == "product"
    assert actions.target_type(None, "search") == "generic"       # never a default hotel
    assert actions.target_type("google_shopping", "book_hotel") == "product"   # engine wins


def test_stored_runs_report_target_type(client: TestClient) -> None:
    assert client.get("/v1/runs/5b051ed2235f").json()["target_type"] == "product"
    assert client.get("/v1/runs/c28bb2b65036").json()["target_type"] == "hotel"
    assert client.get("/v1/runs/legacy1").json()["target_type"] == "generic"


# 8. both confirmations are clearly simulated and distinguishable
def test_hotel_and_order_confirmations_are_distinct_and_simulated(client: TestClient) -> None:
    b = client.post("/v1/bookings", json={"run_id": "c28bb2b65036", "candidate_id": "c3", "guest_name": "A", "email": "a@b.co",
                    "guests": 2, "check_in": IN_7, "check_out": IN_9, "acknowledge_unverified": True}).json()
    o = client.post("/v1/orders", json=_order("c5", acknowledge_unverified=True)).json()
    assert b["booking_id"].startswith("SIM-") and not b["booking_id"].startswith("SIM-ORDER-")
    assert o["order_id"].startswith("SIM-ORDER-")
    assert b["status"] == "SIMULATED_CONFIRMED" and o["status"] == "SIMULATED_ORDER_CONFIRMED"
    assert b["disclaimer"] == "SIMULATED BOOKING — NO REAL RESERVATION CREATED — NO PAYMENT CHARGED"
    assert o["disclaimer"] == "SIMULATED ORDER — NO REAL PURCHASE — NO PAYMENT CHARGED"
    assert b["simulated"] is True and o["simulated"] is True
