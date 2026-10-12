"""REST routes. API is the source of truth; UI/MCP are thin clients.

Every route receives the caller's Session (app/security.py; router-level dependency, cached per
request). Runs, evidence, action contexts, bookings and orders are read through `session.scope`, so a
signed-in user only ever sees their own records; another user's ids answer 404 (nothing about the
record is revealed). Ownership comes from the verified token, never from the request body.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.security import Session, require_session
from app.models.schemas import (
    MAX_REQUEST_CHARS,
    BookingRequest,
    Candidate,
    FindAndVerifyRequest,
    FindAndVerifyResponse,
    OrderRequest,
    VerifyRequest,
)
from app.services import actions, booking, jev_verifier, orders, rank_reasons
from app.services.agent import run_agent_turn, sse_turn
from app.services.pipeline import run_find_and_verify
from app.storage import store

router = APIRouter()
Caller = Depends(require_session)


def _claim(run_id: object, session: Session) -> None:
    """Give the run this request just created to the signed-in user (no-op in local development)."""
    if session.user_id and run_id:
        store.claim_run(settings.db_path, str(run_id), session.user_id)


@router.post("/find-and-verify", response_model=FindAndVerifyResponse)
def find_and_verify(body: FindAndVerifyRequest, session: Session = Caller):
    try:
        rec = run_find_and_verify(body.request, body.action, settings,
                                  body.max_candidates, body.engine)
        _claim(getattr(rec, "run_id", None), session)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=settings.redact(str(e)))
    except Exception as e:
        raise HTTPException(status_code=500, detail=settings.redact(f"pipeline_failed: {e}"))
    data = rec.model_dump()
    data.pop("candidates", None)
    data.pop("raw_serpapi", None)
    return data


@router.post("/verify")
def verify(body: VerifyRequest):
    """Direct candidate verification (caller supplies requirements + candidate)."""
    try:
        result = jev_verifier.verify_candidate(body.requirements, body.candidate, settings)
    except Exception as e:
        raise HTTPException(status_code=502, detail=settings.redact(f"jev_failed: {e}"))
    return result.model_dump()


@router.get("/runs/{run_id}")
def get_run(run_id: str, session: Session = Caller):
    data = store.get_run(settings.db_path, run_id, session.scope)
    if data is None:
        raise HTTPException(status_code=404, detail="run not found")
    data = rank_reasons.relabel_run_dict(data)
    data["target_type"] = actions.run_target_type(data)   # derived for runs stored before the field existed
    return data


@router.get("/runs/{run_id}/evidence")
def get_evidence(run_id: str, session: Session = Caller):
    data = store.get_run(settings.db_path, run_id, session.scope)
    if data is None:
        raise HTTPException(status_code=404, detail="run not found")
    cands = data.get("candidates", [])
    return {
        "run_id": run_id,
        "candidates": cands,
        "raw_serpapi": data.get("raw_serpapi"),
        "attempts": data.get("attempts", []),
    }


@router.get("/runs")
def list_runs(limit: int = 50, session: Session = Caller):
    return store.list_runs(settings.db_path, min(max(limit, 1), 200), session.scope)


# ---- Chat agent routes (append-only; existing routes untouched) ----

class AgentChatRequest(BaseModel):
    message: str = Field(max_length=MAX_REQUEST_CHARS)
    session_id: str | None = Field(None, max_length=64)


@router.post("/agent/chat")
def agent_chat(body: AgentChatRequest, session: Session = Caller):
    if not body.message or not body.message.strip():
        raise HTTPException(status_code=422, detail="message must not be empty")
    try:
        out = run_agent_turn(body.message, body.session_id, settings, owner=session.scope)
        _claim(out.get("run_id") if isinstance(out, dict) else None, session)
        return out
    except ValueError as e:
        raise HTTPException(status_code=422, detail=settings.redact(str(e)))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=settings.redact(str(e)))
    except Exception as e:
        raise HTTPException(status_code=500, detail=settings.redact(f"agent_failed: {e}"))


@router.get("/agent/chat/stream")
def agent_chat_stream(message: str = Query(..., max_length=MAX_REQUEST_CHARS),
                      session_id: str | None = Query(None, max_length=64), session: Session = Caller):
    if not message or not message.strip():
        raise HTTPException(status_code=422, detail="message must not be empty")

    def gen():
        for ev in sse_turn(message, session_id, settings, owner=session.scope):
            if isinstance(ev, str):
                yield ev if ev.endswith("\n\n") else ev + "\n"
            else:
                if ev.get("type") == "final":
                    _claim(ev.get("run_id"), session)
                yield f"data: {json.dumps(ev, default=str)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---- Simulated booking (demo only: no real reservation, no payment) ----

def _stored_run(run_id: str, session: Session) -> dict:
    data = store.get_run(settings.db_path, run_id, session.scope)
    if data is None:
        raise HTTPException(status_code=404, detail={"code": "run_not_found", "message": "run not found", "errors": {}})
    return data


@router.get("/runs/{run_id}/candidates/{candidate_id}/booking-context")
def booking_context(run_id: str, candidate_id: str, session: Session = Caller):
    try:
        return booking.booking_context(_stored_run(run_id, session), candidate_id)
    except booking.BookingError as e:
        raise HTTPException(status_code=e.status, detail=e.detail())


@router.post("/bookings/preview")
def booking_preview(body: BookingRequest, session: Session = Caller):
    try:
        return booking.preview_booking(_stored_run(body.run_id, session), body)
    except booking.BookingError as e:
        raise HTTPException(status_code=e.status, detail=e.detail())


@router.post("/bookings")
def booking_create(body: BookingRequest, session: Session = Caller):
    try:
        return booking.create_booking(settings.db_path, _stored_run(body.run_id, session), body, owner_id=session.user_id)
    except booking.BookingError as e:
        raise HTTPException(status_code=e.status, detail=e.detail())


@router.get("/bookings/{booking_id}")
def booking_get(booking_id: str, session: Session = Caller):
    data = store.get_booking(settings.db_path, booking_id, session.scope)
    if data is None:
        raise HTTPException(status_code=404, detail={"code": "booking_not_found", "message": "booking not found", "errors": {}})
    return data


# ---- Action dispatch: which simulation (if any) fits this candidate ----

@router.get("/runs/{run_id}/candidates/{candidate_id}/action-context")
def action_context(run_id: str, candidate_id: str, session: Session = Caller):
    """Classifies the candidate by the engine that produced it and returns the
    matching context. Never defaults to a hotel booking."""
    run = _stored_run(run_id, session)
    try:
        cand = booking._find_candidate(run, candidate_id)
        kind = actions.candidate_target_type(run, cand)
        base = {"target_type": kind, "action": actions.ACTIONS[kind]}
        if kind == "hotel":
            return {**base, **booking.booking_context(run, candidate_id)}
        if kind == "product":
            return {**base, **orders.order_context(run, candidate_id)}
        return {
            **base, "run_id": run.get("run_id"), "candidate_id": candidate_id,
            "item": {"name": cand.get("name") or cand.get("title") or None,
                     "source_url": cand.get("source_url") or None,
                     "engine": cand.get("engine") or actions.run_engine(run)},
            **booking.verification_summary(run, candidate_id),
            "message": "ProofGate has no simulated action for this kind of result yet — review only.",
        }
    except booking.BookingError as e:
        raise HTTPException(status_code=e.status, detail=e.detail())


# ---- Simulated product orders (demo only: no purchase, no payment) ----

@router.post("/orders/preview")
def order_preview(body: OrderRequest, session: Session = Caller):
    try:
        return orders.preview_order(_stored_run(body.run_id, session), body)
    except booking.BookingError as e:
        raise HTTPException(status_code=e.status, detail=e.detail())


@router.post("/orders")
def order_create(body: OrderRequest, session: Session = Caller):
    try:
        return orders.create_order(settings.db_path, _stored_run(body.run_id, session), body, owner_id=session.user_id)
    except booking.BookingError as e:
        raise HTTPException(status_code=e.status, detail=e.detail())


@router.get("/orders/{order_id}")
def order_get(order_id: str, session: Session = Caller):
    data = store.get_order(settings.db_path, order_id, session.scope)
    if data is None:
        raise HTTPException(status_code=404, detail={"code": "order_not_found", "message": "order not found", "errors": {}})
    return data
