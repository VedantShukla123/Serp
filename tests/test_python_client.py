"""Local Python client — mocked HTTP only (httpx.MockTransport); no network, no paid calls."""
from __future__ import annotations

import json

import httpx
import pytest

from app.main import app
from proofgate_client import (
    ProofGateClient, ProofGateConnectionError, ProofGateError, ProofGateHTTPError, ProofGateNotFound,
)


def make(handler) -> tuple[ProofGateClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def wrapped(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return handler(req)

    return ProofGateClient("http://pg.test/", transport=httpx.MockTransport(wrapped)), seen


def test_read_endpoints_hit_the_real_paths() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        routes = {
            "/health": {"ok": True, "ready": True, "missing_credentials": []},
            "/v1/runs": [{"run_id": "r1", "created_at": "2026-10-10T00:00:00+00:00", "request": "q"}],
            "/v1/runs/r1": {"run_id": "r1", "status": "verified", "attempts": []},
            "/v1/runs/r1/evidence": {"run_id": "r1", "candidates": [], "raw_serpapi": None, "attempts": []},
        }
        return httpx.Response(200, json=routes[req.url.path])

    pg, seen = make(handler)
    assert pg.health()["ready"] is True
    assert pg.list_runs(limit=5)[0]["run_id"] == "r1"
    assert pg.get_run("r1")["status"] == "verified"
    assert pg.get_evidence("r1")["candidates"] == []
    assert [(r.method, r.url.path) for r in seen] == [("GET", "/health"), ("GET", "/v1/runs"), ("GET", "/v1/runs/r1"), ("GET", "/v1/runs/r1/evidence")]
    assert seen[1].url.params["limit"] == "5"
    assert str(seen[0].url).startswith("http://pg.test/health")       # trailing slash in base_url handled
    assert "authorization" not in {k.lower() for k in seen[0].headers}   # no auth is claimed or sent


def test_find_and_verify_and_verify_send_the_schema_fields() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        if req.url.path == "/v1/find-and-verify":
            return httpx.Response(200, json={"run_id": "new", "status": "needs_human_review", "echo": body})
        return httpx.Response(200, json={"candidate_id": "c1", "overall_status": "UNVERIFIED", "requirements": [], "echo": body})

    pg, seen = make(handler)
    out = pg.find_and_verify("Hotel in Goa", action="book_hotel", max_candidates=5)
    assert out["echo"] == {"request": "Hotel in Goa", "action": "book_hotel", "max_candidates": 5, "engine": None}
    v = pg.verify([{"id": "beachfront", "description": "Must be beachfront"}], {"candidate_id": "c1", "name": "A"})
    assert v["echo"] == {"requirements": [{"id": "beachfront", "description": "Must be beachfront"}], "candidate": {"candidate_id": "c1", "name": "A"}}
    assert [(r.method, r.url.path) for r in seen] == [("POST", "/v1/find-and-verify"), ("POST", "/v1/verify")]
    assert seen[0].extensions["timeout"]["read"] == 300.0                # long timeout for live calls


def test_http_errors_are_raised_with_the_server_detail() -> None:
    responses = {
        "/v1/runs/missing": httpx.Response(404, json={"detail": "run not found"}),
        "/v1/find-and-verify": httpx.Response(502, json={"detail": "LLM_API_KEY is not set"}),
        "/v1/verify": httpx.Response(422, json={"detail": [{"loc": ["body", "candidate"], "msg": "Field required"}]}),
        "/v1/runs/x/evidence": httpx.Response(500, text="Internal Server Error"),
    }
    pg, _ = make(lambda req: responses[req.url.path])
    with pytest.raises(ProofGateNotFound) as nf:
        pg.get_run("missing")
    assert nf.value.status_code == 404 and nf.value.detail == "run not found"
    with pytest.raises(ProofGateHTTPError) as bad:
        pg.find_and_verify("Hotel in Goa")
    assert bad.value.status_code == 502 and "LLM_API_KEY is not set" in str(bad.value)
    assert not isinstance(bad.value, ProofGateNotFound)
    with pytest.raises(ProofGateHTTPError, match=r"body\.candidate: Field required"):
        pg.verify([], {})
    with pytest.raises(ProofGateHTTPError, match="Internal Server Error"):
        pg.get_evidence("x")


def test_network_failures_and_timeouts() -> None:
    def refused(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=req)

    def slow(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=req)

    pg, _ = make(refused)
    with pytest.raises(ProofGateConnectionError, match="python run.py --serve"):
        pg.health()
    pg, _ = make(slow)
    with pytest.raises(ProofGateConnectionError, match="timed out"):
        pg.get_run("r1")
    assert issubclass(ProofGateConnectionError, ProofGateError) and issubclass(ProofGateNotFound, ProofGateHTTPError)


def test_run_ids_are_encoded_as_one_path_segment() -> None:
    pg, seen = make(lambda req: httpx.Response(404, json={"detail": "run not found"}))
    with pytest.raises(ProofGateNotFound):
        pg.get_run("../health")
    assert seen[0].url.raw_path == b"/v1/runs/..%2Fhealth"


def test_client_paths_exist_in_the_real_api() -> None:
    paths = set(app.openapi()["paths"])
    for p in ("/health", "/v1/runs", "/v1/runs/{run_id}", "/v1/runs/{run_id}/evidence", "/v1/find-and-verify", "/v1/verify"):
        assert p in paths, p
