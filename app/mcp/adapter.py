"""MCP adapter — thin wrapper around the SAME core pipeline.

No duplicated logic and no server dependency (no fastapi import): each
function loads server-side settings and delegates to
app.services.pipeline / app.services.jev_verifier / app.storage.store.
"""
from __future__ import annotations

from app.config import load_settings
from app.models.schemas import (
    Candidate,
    Requirement,
    RunRecord,
    VerificationResult,
)
from app.services import jev_verifier, rank_reasons
from app.services.pipeline import run_find_and_verify
from app.storage import store


def find_and_verify(
    request: str,
    action: str = "search",
    max_candidates: int = 15,
    engine: str | None = None,
) -> RunRecord:
    """Run the full find-and-verify pipeline with server-side settings."""
    settings = load_settings()
    return run_find_and_verify(request, action, settings, max_candidates, engine)


def verify_candidate(
    requirements: list[Requirement],
    candidate: Candidate,
) -> VerificationResult:
    """Verify one caller-supplied candidate with server-side settings."""
    settings = load_settings()
    return jev_verifier.verify_candidate(requirements, candidate, settings)


def get_run(run_id: str) -> dict:
    """Return the persisted run record. Raises KeyError when unknown."""
    settings = load_settings()
    data = store.get_run(settings.db_path, run_id)
    if data is None:
        raise KeyError(f"run not found: {run_id}")
    return rank_reasons.relabel_run_dict(data)


def get_evidence(run_id: str) -> dict:
    """Return candidates + raw SerpApi payload + attempts for a run."""
    data = get_run(run_id)
    return {
        "run_id": run_id,
        "candidates": data.get("candidates", []),
        "raw_serpapi": data.get("raw_serpapi"),
        "attempts": data.get("attempts", []),
    }
