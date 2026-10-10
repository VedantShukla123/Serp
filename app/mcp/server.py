"""ProofGate MCP server (official MCP Python SDK v2, `mcp.server.mcpserver.MCPServer`).

Registers four tools that delegate to `app.mcp.adapter` — the same functions the
rest of ProofGate uses — so there is no second copy of the business logic:

  find_and_verify   live search + Jev verification (uses external API credits)
  verify_candidate  Jev verdicts for one caller-supplied candidate (uses credits)
  get_run           a stored run, read from the local store (free, read-only)
  get_evidence      stored evidence for a run (free, read-only)

Anticipated failures (unknown run, missing credentials, upstream errors) raise
`ToolError`, which the client receives as `is_error=True` with a clear message.
A failure is never turned into a verification result.

Launch over stdio with `run_mcp.py` (anchors the repo, keeps stdout for protocol).
"""
from __future__ import annotations

import logging
from typing import Annotated, Any

from pydantic import BaseModel, Field

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from app.config import load_settings
from app.mcp import adapter
from app.models.schemas import Candidate, Requirement, VerificationResult

log = logging.getLogger("proofgate.mcp")

INSTRUCTIONS = (
    "ProofGate checks whether a proposed action (e.g. booking a hotel, buying a product) is supported "
    "by evidence before it proceeds. find_and_verify runs a live search and verifies each requirement "
    "with TypeSafe Jev (uses external API credits). get_run and get_evidence read stored runs for free. "
    "Statuses: VERIFIED = every required condition satisfied; UNVERIFIED = some required condition "
    "unknown, needs human review; REJECTED = a required condition was contradicted. Never present an "
    "UNVERIFIED or REJECTED result as verified."
)

mcp_server = MCPServer(name="proofgate", title="ProofGate", version="0.1.0", instructions=INSTRUCTIONS)


# ------------------------------------------------------------------ helpers

def _safe(message: str) -> str:
    """Strip any configured secret from an error message before it leaves the server."""
    s = load_settings()
    for secret in (s.serpapi_api_key, s.llm_api_key, s.jev_api_key, s.proofgate_api_key):
        if secret:
            message = message.replace(secret, "***")
    return message


class CandidateSummary(BaseModel):
    candidate_id: str
    name: str
    rank: int | None = Field(None, description="LLM ranking position (1 = most relevant); null if not ranked.")
    status: str = Field(description="VERIFIED, UNVERIFIED, REJECTED, or NOT_CHECKED (Jev stopped after an earlier VERIFIED candidate).")
    price: str | None = Field(None, description="Price exactly as listed by the search; null when not provided. Never converted.")
    contradicted: list[str] = Field(default_factory=list, description="Requirement ids the evidence contradicts.")
    unknown: list[str] = Field(default_factory=list, description="Requirement ids the evidence could not confirm.")


class RunSummary(BaseModel):
    run_id: str
    status: str = Field(description="verified | needs_human_review | no_verified_match")
    target_type: str | None = Field(None, description="hotel | product | place | generic (from the search engine).")
    request: str
    requirements: list[dict[str, Any]]
    candidate_count: int
    counts: dict[str, int] = Field(description="Candidates per Jev status.")
    selected_candidate_id: str | None = Field(None, description="The candidate ProofGate returned; check its status before acting.")
    selected_status: str | None = None
    candidates: list[CandidateSummary] = Field(description="In ranked order, joined to Jev verdicts by candidate_id.")
    errors: list[str] = Field(default_factory=list)
    note: str = "Use get_run or get_evidence with this run_id for the full stored record and evidence."


def summarize_run(run: dict[str, Any]) -> RunSummary:
    """Compact, faithful summary of a stored/returned run (no new data is invented)."""
    attempts = {a["candidate_id"]: a for a in run.get("attempts") or []}
    cands = {c["candidate_id"]: c for c in run.get("candidates") or []}
    order = [rc["candidate_id"] for rc in sorted(run.get("ranked_candidates") or [], key=lambda r: r["rank"])]
    order += [cid for cid in attempts if cid not in order]
    ranks = {rc["candidate_id"]: rc["rank"] for rc in run.get("ranked_candidates") or []}
    rows: list[CandidateSummary] = []
    counts = {"VERIFIED": 0, "UNVERIFIED": 0, "REJECTED": 0, "NOT_CHECKED": 0}
    for cid in order:
        a = attempts.get(cid)
        verdicts = (a or {}).get("verification", {}).get("requirements") or []
        status = (a or {}).get("verification", {}).get("overall_status") or "NOT_CHECKED"
        counts[status] = counts.get(status, 0) + 1
        c = cands.get(cid, {})
        price = c.get("price")
        rows.append(CandidateSummary(
            candidate_id=cid, rank=ranks.get(cid), status=status,
            name=str(c.get("name") or c.get("title") or (a or {}).get("candidate_name") or cid),
            price=str(price) if price not in (None, "") else None,
            contradicted=[v["requirement_id"] for v in verdicts if v.get("status") == "CONTRADICTED"],
            unknown=[v["requirement_id"] for v in verdicts if v.get("status") == "UNKNOWN"],
        ))
    sel = run.get("selected_candidate") or None
    return RunSummary(
        run_id=run["run_id"], status=run["status"], target_type=run.get("target_type"), request=run.get("request", ""),
        requirements=[{k: r.get(k) for k in ("id", "description", "importance")} for r in run.get("requirements") or []],
        candidate_count=run.get("candidate_count", len(cands)), counts=counts,
        selected_candidate_id=sel.get("candidate_id") if sel else None,
        selected_status=(run.get("verification") or {}).get("overall_status") if sel else None,
        candidates=rows, errors=list(run.get("errors") or []),
    )


def _load_run(run_id: str) -> dict[str, Any]:
    try:
        return adapter.get_run(run_id)
    except KeyError:
        raise ToolError(f"Run '{run_id}' was not found in the local ProofGate store. "
                        "Use a run_id returned by find_and_verify or listed by GET /v1/runs.") from None


# ------------------------------------------------------------------ tools

@mcp_server.tool(
    name="find_and_verify",
    title="Find and verify (live, uses API credits)",
    description=(
        "Run ProofGate's full pipeline for a request: an LLM extracts the hard requirements, SerpApi searches live, "
        "candidates are ranked, and TypeSafe Jev rules on every requirement. Returns the run_id, decision status, "
        "and each candidate's Jev status with contradicted/unknown requirement ids. USES EXTERNAL API CREDITS "
        "(SerpApi, LLM and Jev) on every call — only call it when the user wants a new live search."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=True),
)
def find_and_verify(
    request: Annotated[str, Field(min_length=3, description="What to find, including its hard requirements, e.g. 'Hotel in Goa under Rs 10,000 for 2 people, beachfront'.")],
    action: Annotated[str, Field(description="Router hint: 'search' (default), 'book_hotel', or 'buy_<product>' (e.g. 'buy_laptop'). Picks the search engine.")] = "search",
    max_candidates: Annotated[int, Field(ge=1, le=50, description="Maximum candidates to retrieve and verify (default 15).")] = 15,
    engine: Annotated[str | None, Field(description="Optional SerpApi engine override, e.g. 'google_hotels' or 'google_shopping'.")] = None,
) -> RunSummary:
    log.info("find_and_verify called (live search)")
    try:
        rec = adapter.find_and_verify(request, action, max_candidates, engine)
    except RuntimeError as e:   # missing credentials or upstream failure — never a fake result
        raise ToolError(f"ProofGate could not complete the run: {_safe(str(e))}. No verification result was produced.") from None
    except Exception as e:
        raise ToolError(f"Unexpected pipeline failure ({type(e).__name__}): {_safe(str(e))}. No verification result was produced.") from None
    return summarize_run(rec.model_dump())


@mcp_server.tool(
    name="verify_candidate",
    title="Verify one candidate (uses Jev/LLM credits)",
    description=(
        "Ask TypeSafe Jev to rule on each requirement for ONE candidate you already have (no search). Returns "
        "overall_status (VERIFIED / UNVERIFIED / REJECTED) and a verdict per requirement (SATISFIED / UNKNOWN / "
        "CONTRADICTED) with reasons. Uses verification API credits (TypeSafe Jev, or the configured LLM fallback)."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=False, open_world_hint=True),
)
def verify_candidate(
    requirements: Annotated[list[Requirement], Field(min_length=1, description="Requirements: {id, description, importance?: 'required' | 'preferred'}.")],
    candidate: Annotated[Candidate, Field(description="The candidate: at least candidate_id and name; add any facts (price, description, amenities…) as evidence.")],
) -> VerificationResult:
    try:
        return adapter.verify_candidate(requirements, candidate)
    except RuntimeError as e:
        raise ToolError(f"Verification failed: {_safe(str(e))}. No verdict was produced.") from None
    except Exception as e:
        raise ToolError(f"Unexpected verification failure ({type(e).__name__}): {_safe(str(e))}. No verdict was produced.") from None


@mcp_server.tool(
    name="get_run",
    title="Get a stored run (free)",
    description=(
        "Read a stored ProofGate run by run_id from the local store: request, requirements, ranked candidates, "
        "every Jev verdict, the decision and the selected candidate. Free and read-only — never starts a search. "
        "The raw SerpApi payload is omitted; use get_evidence with include_raw_serpapi=true for it."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False),
)
def get_run(run_id: Annotated[str, Field(min_length=1, max_length=64, description="Run id, e.g. 'c28bb2b65036'.")]) -> dict[str, Any]:
    run = _load_run(run_id)
    run.pop("raw_serpapi", None)
    return run


@mcp_server.tool(
    name="get_evidence",
    title="Get stored evidence (free)",
    description=(
        "Return the evidence stored for a run: the normalized search candidates and every Jev attempt with its "
        "per-requirement verdicts. Free and read-only. Set include_raw_serpapi=true to also get the original "
        "SerpApi payload (can be large). Nothing is fetched or re-verified."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False),
)
def get_evidence(
    run_id: Annotated[str, Field(min_length=1, max_length=64, description="Run id, e.g. 'c28bb2b65036'.")],
    include_raw_serpapi: Annotated[bool, Field(description="Include the raw SerpApi payload (large).")] = False,
) -> dict[str, Any]:
    _load_run(run_id)  # clear not-found error before reading evidence
    ev = adapter.get_evidence(run_id)
    raw = ev.pop("raw_serpapi", None)
    ev["raw_serpapi_stored"] = raw is not None
    if include_raw_serpapi:
        ev["raw_serpapi"] = raw
    return ev
