"""REST routes. API is the source of truth; UI/MCP are thin clients."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import settings
from app.models.schemas import (
    Candidate,
    FindAndVerifyRequest,
    FindAndVerifyResponse,
    VerifyRequest,
)
from app.services import jev_verifier
from app.services.agent import run_agent_turn, sse_turn
from app.services.pipeline import run_find_and_verify
from app.storage import store

router = APIRouter()


@router.post("/find-and-verify", response_model=FindAndVerifyResponse)
def find_and_verify(body: FindAndVerifyRequest):
    try:
        rec = run_find_and_verify(body.request, body.action, settings,
                                  body.max_candidates, body.engine)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"pipeline_failed: {e}")
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
        raise HTTPException(status_code=502, detail=f"jev_failed: {e}")
    return result.model_dump()


@router.get("/runs/{run_id}")
def get_run(run_id: str):
    data = store.get_run(settings.db_path, run_id)
    if data is None:
        raise HTTPException(status_code=404, detail="run not found")
    return data


@router.get("/runs/{run_id}/evidence")
def get_evidence(run_id: str):
    data = store.get_run(settings.db_path, run_id)
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
def list_runs(limit: int = 50):
    return store.list_runs(settings.db_path, min(max(limit, 1), 200))


# ---- Chat agent routes (append-only; existing routes untouched) ----

class AgentChatRequest(BaseModel):
    message: str
    session_id: str | None = None


@router.post("/agent/chat")
def agent_chat(body: AgentChatRequest):
    if not body.message or not body.message.strip():
        raise HTTPException(status_code=422, detail="message must not be empty")
    try:
        return run_agent_turn(body.message, body.session_id, settings)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"agent_failed: {e}")


@router.get("/agent/chat/stream")
def agent_chat_stream(message: str = Query(...), session_id: str | None = Query(None)):
    if not message or not message.strip():
        raise HTTPException(status_code=422, detail="message must not be empty")

    def gen():
        for ev in sse_turn(message, session_id, settings):
            if isinstance(ev, str):
                yield ev if ev.endswith("\n\n") else ev + "\n"
            else:
                yield f"data: {json.dumps(ev, default=str)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
