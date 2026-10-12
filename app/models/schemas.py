"""Pydantic models — the typed contract for the whole pipeline."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

# Input bounds for the credit-spending endpoints (same limits as the MCP tools in app/mcp/server.py).
MAX_REQUEST_CHARS = 2000
MAX_CANDIDATES = 50
MAX_REQUIREMENTS = 30

RequirementImportance = Literal["required", "preferred"]
RequirementStatus = Literal["SATISFIED", "CONTRADICTED", "UNKNOWN"]
CandidateStatus = Literal["VERIFIED", "REJECTED", "UNVERIFIED"]
RunStatus = Literal["verified", "needs_human_review", "no_verified_match", "error"]


class Requirement(BaseModel):
    id: str
    description: str
    type: str = "semantic"
    importance: RequirementImportance = "required"


class ParsedRequest(BaseModel):
    request: str
    requirements: list[Requirement]


class Candidate(BaseModel):
    """Normalized candidate preserving complete MEANINGFUL SerpApi data."""

    candidate_id: str
    name: str = ""
    title: str = ""
    price: Any = None
    price_value: float | None = None
    currency: str = ""
    rating: float | None = None
    review_count: int | None = None
    location: str = ""
    address: str = ""
    description: str = ""
    amenities: list[str] = Field(default_factory=list)
    attributes: dict[str, Any] = Field(default_factory=dict)
    offer_details: dict[str, Any] = Field(default_factory=dict)
    availability_details: dict[str, Any] = Field(default_factory=dict)
    cancellation_info: str = ""
    seller: str = ""
    provider: str = ""
    snippet: str = ""
    source_url: str = ""
    booking_url: str = ""
    engine: str = ""
    engine_metadata: dict[str, Any] = Field(default_factory=dict)
    raw: dict[str, Any] = Field(default_factory=dict)

    def evidence_text(self) -> str:
        """Flatten meaningful fields into one adjudication text blob."""
        parts: list[str] = []
        for label, val in [
            ("name", self.name),
            ("title", self.title),
            ("description", self.description),
            ("snippet", self.snippet),
            ("location", self.location),
            ("address", self.address),
            ("cancellation", self.cancellation_info),
            ("seller", self.seller),
            ("provider", self.provider),
        ]:
            if val:
                parts.append(f"{label}: {val}")
        if self.price is not None:
            parts.append(f"price: {self.price}")
        if self.price_value is not None:
            parts.append(f"price_value: {self.price_value} {self.currency}")
        if self.rating is not None:
            parts.append(f"rating: {self.rating}")
        if self.review_count is not None:
            parts.append(f"review_count: {self.review_count}")
        if self.amenities:
            parts.append("amenities: " + ", ".join(self.amenities))
        for k, v in self.attributes.items():
            parts.append(f"{k}: {v}")
        for k, v in self.offer_details.items():
            parts.append(f"offer.{k}: {v}")
        for k, v in self.availability_details.items():
            parts.append(f"availability.{k}: {v}")
        return "\n".join(parts)


class RankedCandidate(BaseModel):
    candidate_id: str
    rank: int
    reason: str = ""


class RankingResult(BaseModel):
    ranked_candidates: list[RankedCandidate]
    model: str = ""
    mocked: bool = False


class RequirementVerdict(BaseModel):
    requirement_id: str
    status: RequirementStatus
    reason: str = ""
    supporting_data: str | None = None
    confidence: float | None = None  # decision-support only, never objective truth


class VerificationResult(BaseModel):
    candidate_id: str
    overall_status: CandidateStatus
    requirements: list[RequirementVerdict]
    verifier: str = ""
    mocked: bool = False


class AttemptRecord(BaseModel):
    candidate_id: str
    candidate_name: str = ""
    verification: VerificationResult


class FindAndVerifyRequest(BaseModel):
    request: str = Field(min_length=3, max_length=MAX_REQUEST_CHARS)
    action: str = Field("search", max_length=64)
    max_candidates: int = Field(15, ge=1, le=MAX_CANDIDATES)
    engine: str | None = Field(None, pattern=r"^[a-z_]{1,40}$")

    @field_validator("request")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if len(v.strip()) < 3:
            raise ValueError("request must contain at least 3 non-space characters")
        return v.strip()


class VerifyRequest(BaseModel):
    requirements: list[Requirement] = Field(min_length=1, max_length=MAX_REQUIREMENTS)
    candidate: Candidate

    @field_validator("requirements")
    @classmethod
    def _unique_ids(cls, v: list[Requirement]) -> list[Requirement]:
        ids = [r.id for r in v]
        if len(set(ids)) != len(ids):
            raise ValueError("requirement ids must be unique")
        return v


class FindAndVerifyResponse(BaseModel):
    run_id: str
    status: RunStatus
    request: str
    action: str
    requirements: list[Requirement]
    candidate_count: int
    ranked_candidates: list[RankedCandidate] = Field(default_factory=list)
    selected_candidate: Candidate | None = None
    verification: VerificationResult | None = None
    attempts: list[AttemptRecord] = Field(default_factory=list)
    serpapi_meta: dict[str, Any] = Field(default_factory=dict)
    llm_meta: dict[str, Any] = Field(default_factory=dict)
    timing_ms: dict[str, int] = Field(default_factory=dict)
    errors: list[str] = Field(default_factory=list)
    mocked: bool = False
    created_at: str = ""
    # hotel | product | place | generic — from the search engine (see app/services/actions.py).
    # Optional so runs stored before this field existed still load.
    target_type: str | None = None


class RunRecord(FindAndVerifyResponse):
    candidates: list[Candidate] = Field(default_factory=list)
    raw_serpapi: Any = None


class BookingRequest(BaseModel):
    """Simulated booking input. Hotel identity and price are resolved server-side
    from the stored run by candidate_id — the client never supplies them."""
    run_id: str
    candidate_id: str
    guest_name: str = ""
    email: str = ""
    guests: int | None = None
    check_in: str = ""
    check_out: str = ""
    acknowledge_unverified: bool = False


class OrderRequest(BaseModel):
    """Simulated product order input. Product identity and price are resolved
    server-side from the stored run by candidate_id — never taken from the client."""
    run_id: str
    candidate_id: str
    buyer_name: str = ""
    email: str = ""
    quantity: int | None = None
    delivery_address: str = ""
    acknowledge_unverified: bool = False
