"""Simulated product orders — DEMO ONLY.

The product, its listed price and its Jev status are resolved server-side from
the stored run by candidate_id; the client only supplies buyer details. No real
purchase is made, no payment is taken, no card data is collected, and nothing is
sent to the seller.

Price honesty: the price is shown exactly as listed. A currency code is used only
when the search gave one, or the listed price carries an unambiguous symbol
(₹/Rs/INR, €, £, US$). A bare "$" is ambiguous (USD, CAD, AUD…) so the code stays
unknown and no subtotal is calculated. Nothing is ever converted between currencies.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from app.models.schemas import OrderRequest
from app.services.actions import candidate_target_type
from app.services.booking import _EMAIL, BookingError, _find_candidate, verification_summary
from app.storage import store

DISCLAIMER = "SIMULATED ORDER — NO REAL PURCHASE — NO PAYMENT CHARGED"
MAX_QUANTITY = 10

# (marker in the listed price, ISO code); checked in order, longest first.
_MARKERS = [("US$", "USD"), ("USD", "USD"), ("INR", "INR"), ("Rs", "INR"), ("₹", "INR"),
            ("EUR", "EUR"), ("€", "EUR"), ("GBP", "GBP"), ("£", "GBP")]


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def product_price(cand: dict) -> dict:
    listed = cand.get("price")
    listed_s = str(listed) if listed not in (None, "") else None
    code = (cand.get("currency") or "").strip().upper() or None
    source = "search" if code else None
    if not code and listed_s:
        for marker, iso in _MARKERS:
            if marker in listed_s:
                code, source = iso, "symbol"
                break
    ambiguous = bool(listed_s and not code and "$" in listed_s)
    value = _num(cand.get("price_value"))
    return {
        "listed_display": listed_s,
        "value": value,
        "currency": code,
        "currency_source": source,            # "search" | "symbol" | None
        "currency_reliable": value is not None and code is not None,
        "note": ("Listed with “$” only — the search did not say which dollar currency. "
                 "No total is calculated and nothing is converted." if ambiguous else
                 None if code else "Currency not provided by the search."),
    }


def order_context(run: dict, candidate_id: str) -> dict:
    cand = _find_candidate(run, candidate_id)
    kind = candidate_target_type(run, cand)
    if kind != "product":
        raise BookingError(409, "wrong_action_type",
                           f"Candidate {candidate_id} is a {kind} result, not a product — it cannot be ordered.")
    summary = verification_summary(run, candidate_id)
    attrs = cand.get("attributes") or {}
    delivery = attrs.get("delivery") if isinstance(attrs, dict) else None
    return {
        "run_id": run.get("run_id"),
        "candidate_id": candidate_id,
        "target_type": "product",
        "product": {
            "title": cand.get("name") or cand.get("title") or None,
            "seller": cand.get("seller") or None,
            "rating": cand.get("rating"),
            "review_count": cand.get("review_count"),
            "source_url": cand.get("source_url") or None,
            "delivery_info": str(delivery) if delivery not in (None, "", []) else None,
        },
        "price": product_price(cand),
        **summary,
        "orderable": summary["verification_status"] != "REJECTED",
        "disclaimer": DISCLAIMER,
    }


def validate_buyer(req: OrderRequest) -> dict:
    errors: dict[str, str] = {}
    name = req.buyer_name.strip()
    if not name:
        errors["buyer_name"] = "Buyer name is required."
    elif len(name) > 100:
        errors["buyer_name"] = "Buyer name is too long."
    email = req.email.strip()
    if not _EMAIL.match(email):
        errors["email"] = "Enter a valid email address."
    if req.quantity is None or not 1 <= req.quantity <= MAX_QUANTITY:
        errors["quantity"] = f"Quantity must be between 1 and {MAX_QUANTITY}."
    address = req.delivery_address.strip()
    if len(address) < 5:
        errors["delivery_address"] = "Enter delivery details (demo only — never sent anywhere)."
    elif len(address) > 300:
        errors["delivery_address"] = "Delivery details are too long."
    if errors:
        raise BookingError(422, "invalid_order_details", "Please fix the highlighted fields.", errors)
    return {"buyer_name": name, "email": email, "quantity": req.quantity, "delivery_address": address}


def preview_order(run: dict, req: OrderRequest) -> dict:
    ctx = order_context(run, req.candidate_id)
    if not ctx["orderable"]:
        raise BookingError(409, "candidate_rejected",
                           "This product was REJECTED by Jev (a required point was contradicted) and cannot be ordered.")
    buyer = validate_buyer(req)
    p = ctx["price"]
    subtotal = round(p["value"] * buyer["quantity"], 2) if p["currency_reliable"] else None
    return {**ctx, "buyer": buyer, "subtotal": subtotal,
            "subtotal_note": (f"Listed price × quantity, in {p['currency']}. Not a quote; taxes and shipping unknown."
                              if subtotal is not None else
                              "Not calculated — the listed price or its currency is not reliable enough.")}


def create_order(db_path: str, run: dict, req: OrderRequest, owner_id: str | None = None) -> dict:
    preview = preview_order(run, req)
    if preview["requires_acknowledgement"] and not req.acknowledge_unverified:
        raise BookingError(409, "acknowledgement_required",
                           "This product is not VERIFIED. Review the open points and confirm the human-review "
                           "acknowledgement before simulating.")
    order = {
        **preview,
        "order_id": "SIM-ORDER-" + uuid.uuid4().hex[:8].upper(),
        "status": "SIMULATED_ORDER_CONFIRMED",
        "simulated": True,
        "acknowledged_unverified": bool(req.acknowledge_unverified and preview["requires_acknowledgement"]),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    store.save_order(db_path, order, owner_id)
    return order
