"""MCP protocol-level tests for the ProofGate server — no paid calls.

Uses the official SDK's `mcp.Client`: in-process against `mcp_server` (full MCP
session: initialize, tools/list, tools/call) and over real stdio by launching
`run_mcp.py` as a subprocess from a different working directory.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest
from mcp import Client, StdioServerParameters

import app.mcp.adapter as adapter_mod
import app.mcp.server as server_mod
from app.config import Settings
from app.mcp.server import mcp_server, summarize_run
from app.models.schemas import (
    Candidate, ParsedRequest, RankedCandidate, RankingResult, Requirement, RequirementVerdict, VerificationResult,
)
from app.services import jev_verifier, pipeline
from app.storage import store

REPO = Path(__file__).resolve().parents[1]
RUN_MCP = REPO / "run_mcp.py"

STORED = {
    "run_id": "run-mcp-1", "status": "needs_human_review", "request": "Laptop under Rs 90,000, 32GB RAM", "action": "buy_laptop",
    "serpapi_meta": {"engine": "google_shopping"}, "candidate_count": 2,
    "requirements": [{"id": "budget", "description": "Total price must be <= Rs 90,000", "importance": "required"},
                     {"id": "ram", "description": "Must have 32GB RAM", "importance": "required"}],
    "candidates": [{"candidate_id": "c1", "name": "Laptop A", "price": "$899.00", "engine": "google_shopping"},
                   {"candidate_id": "c2", "name": "Laptop B", "price": "$1,299.00", "engine": "google_shopping"}],
    "ranked_candidates": [{"candidate_id": "c2", "rank": 1, "reason": "x"}, {"candidate_id": "c1", "rank": 2, "reason": "x"}],
    "attempts": [
        {"candidate_id": "c2", "candidate_name": "c2", "verification": {"candidate_id": "c2", "overall_status": "REJECTED",
         "requirements": [{"requirement_id": "budget", "status": "UNKNOWN"}, {"requirement_id": "ram", "status": "CONTRADICTED"}]}},
        {"candidate_id": "c1", "candidate_name": "c1", "verification": {"candidate_id": "c1", "overall_status": "UNVERIFIED",
         "requirements": [{"requirement_id": "budget", "status": "UNKNOWN"}, {"requirement_id": "ram", "status": "SATISFIED"}]}},
    ],
    "selected_candidate": {"candidate_id": "c1", "name": "Laptop A"},
    "verification": {"candidate_id": "c1", "overall_status": "UNVERIFIED", "requirements": []},
    "raw_serpapi": {"shopping_results": [{"title": "Laptop A"}, {"title": "Laptop B"}]},
    "errors": [],
}


def run(coro):
    return asyncio.run(coro)


@pytest.fixture()
def settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Keyless settings + isolated db, used by the adapter that every tool delegates to."""
    s = Settings(serpapi_api_key="", llm_api_key="", jev_api_key="", jev_endpoint="", db_path=str(tmp_path / "mcp.db"))
    store.save_run(s.db_path, STORED["run_id"], "2026-10-10T00:00:00+00:00", STORED["request"], STORED)
    monkeypatch.setattr(adapter_mod, "load_settings", lambda: s)
    monkeypatch.setattr(server_mod, "load_settings", lambda: s)
    return s


# 1 + 2: initialize and tools/list over a real MCP session
def test_initialize_and_list_tools() -> None:
    async def go():
        async with Client(mcp_server) as c:
            info = c.server_info if hasattr(c, "server_info") else None
            tools = {t.name: t for t in (await c.list_tools()).tools}
            return info, tools
    info, tools = run(go())
    assert set(tools) == {"find_and_verify", "verify_candidate", "get_run", "get_evidence"}
    schema = {n: t.input_schema for n, t in tools.items()}
    assert schema["find_and_verify"]["required"] == ["request"]
    assert set(schema["find_and_verify"]["properties"]) == {"request", "action", "max_candidates", "engine"}
    assert schema["find_and_verify"]["properties"]["max_candidates"]["maximum"] == 50
    assert set(schema["verify_candidate"]["required"]) == {"requirements", "candidate"}
    assert schema["get_run"]["required"] == ["run_id"]
    assert set(schema["get_evidence"]["properties"]) == {"run_id", "include_raw_serpapi"}
    for t in tools.values():
        assert t.output_schema is not None and t.description
    assert "CREDITS" in tools["find_and_verify"].description
    assert tools["get_run"].annotations.read_only_hint is True and tools["get_run"].annotations.open_world_hint is False
    assert tools["find_and_verify"].annotations.open_world_hint is True


# 3: get_run returns the real stored run (raw payload omitted)
def test_get_run_returns_stored_run(settings: Settings) -> None:
    async def go():
        async with Client(mcp_server) as c:
            return await c.call_tool("get_run", {"run_id": "run-mcp-1"})
    r = run(go())
    assert r.is_error is False
    sc = r.structured_content
    assert sc["run_id"] == "run-mcp-1" and sc["status"] == "needs_human_review" and sc["target_type"] == "product"
    assert [a["candidate_id"] for a in sc["attempts"]] == ["c2", "c1"]
    assert "raw_serpapi" not in sc
    assert json.loads(r.content[0].text)["run_id"] == "run-mcp-1"


# 4: get_evidence returns actual stored evidence
def test_get_evidence_returns_stored_data(settings: Settings) -> None:
    async def go():
        async with Client(mcp_server) as c:
            return (await c.call_tool("get_evidence", {"run_id": "run-mcp-1"}),
                    await c.call_tool("get_evidence", {"run_id": "run-mcp-1", "include_raw_serpapi": True}))
    lean, full = run(go())
    assert lean.is_error is False and full.is_error is False
    assert [c["candidate_id"] for c in lean.structured_content["candidates"]] == ["c1", "c2"]
    assert len(lean.structured_content["attempts"]) == 2
    assert lean.structured_content["raw_serpapi_stored"] is True and "raw_serpapi" not in lean.structured_content
    assert full.structured_content["raw_serpapi"] == STORED["raw_serpapi"]


# 5: unknown run ids are clear errors, never results
def test_unknown_run_is_a_clear_error(settings: Settings) -> None:
    async def go():
        async with Client(mcp_server) as c:
            return await c.call_tool("get_run", {"run_id": "does-not-exist"}), await c.call_tool("get_evidence", {"run_id": "does-not-exist"})
    for r in run(go()):
        assert r.is_error is True and r.structured_content is None
        assert "Run 'does-not-exist' was not found" in r.content[0].text


# 6: verify_candidate passes the right arguments to the existing verifier
def test_verify_candidate_calls_existing_verifier(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    def fake_verify(requirements, candidate, s):
        seen.update(requirements=requirements, candidate=candidate, settings=s)
        return VerificationResult(candidate_id=candidate.candidate_id, overall_status="UNVERIFIED", verifier="stub",
                                  requirements=[RequirementVerdict(requirement_id="beachfront", status="UNKNOWN", reason="no evidence")])

    monkeypatch.setattr(jev_verifier, "verify_candidate", fake_verify)

    async def go():
        async with Client(mcp_server) as c:
            return await c.call_tool("verify_candidate", {
                "requirements": [{"id": "beachfront", "description": "Must be beachfront"}],
                "candidate": {"candidate_id": "h1", "name": "Sea View Hotel", "description": "5 minutes from the beach"}})
    r = run(go())
    assert r.is_error is False
    assert isinstance(seen["requirements"][0], Requirement) and seen["requirements"][0].id == "beachfront"
    assert seen["requirements"][0].importance == "required"
    assert isinstance(seen["candidate"], Candidate) and seen["candidate"].description == "5 minutes from the beach"
    assert seen["settings"] is settings
    assert r.structured_content["overall_status"] == "UNVERIFIED"
    assert r.structured_content["requirements"][0] == {"requirement_id": "beachfront", "status": "UNKNOWN", "reason": "no evidence",
                                                      "supporting_data": None, "confidence": None}


# 7: find_and_verify runs the real pipeline (external services stubbed) and stores the run
def test_find_and_verify_routes_to_real_pipeline(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    reqs = [Requirement(id="budget", description="Price <= Rs 10,000"), Requirement(id="beachfront", description="Beachfront")]
    cands = [Candidate(candidate_id=f"c{i}", name=f"Hotel {i}", price=f"₹{i}000", engine="google_hotels") for i in (1, 2, 3)]
    calls: list[str] = []
    monkeypatch.setattr(pipeline.requirement_parser, "parse_requirements", lambda q, s: (calls.append("parse"), ParsedRequest(request=q, requirements=reqs))[1])
    monkeypatch.setattr(pipeline.serpapi_service, "search_serpapi", lambda *a, **k: (calls.append(f"search:{a[1]}:{a[3]}"), (cands, {"engine": "google_hotels"}, {}))[1])
    monkeypatch.setattr(pipeline.llm_matcher, "rank_candidates", lambda *a, **k: (RankingResult(ranked_candidates=[
        RankedCandidate(candidate_id=c, rank=i + 1, reason="raw") for i, c in enumerate(["c2", "c1", "c3"])]), {}))
    table = {"c2": ("REJECTED", "CONTRADICTED"), "c1": ("VERIFIED", "SATISFIED")}
    monkeypatch.setattr(pipeline.jev_verifier, "verify_candidate", lambda r, c, s: VerificationResult(
        candidate_id=c.candidate_id, overall_status=table[c.candidate_id][0],
        requirements=[RequirementVerdict(requirement_id=x.id, status=table[c.candidate_id][1]) for x in r]))

    async def go():
        async with Client(mcp_server) as c:
            res = await c.call_tool("find_and_verify", {"request": "Hotel in Goa under Rs 10,000, beachfront", "action": "book_hotel", "max_candidates": 3})
            again = await c.call_tool("get_run", {"run_id": res.structured_content["run_id"]})
            return res, again
    res, again = run(go())
    assert res.is_error is False
    s = res.structured_content
    assert calls == ["parse", "search:book_hotel:3"]
    assert s["status"] == "verified" and s["target_type"] == "hotel" and s["selected_candidate_id"] == "c1"
    assert [(c["candidate_id"], c["rank"], c["status"]) for c in s["candidates"]] == [("c2", 1, "REJECTED"), ("c1", 2, "VERIFIED"), ("c3", 3, "NOT_CHECKED")]
    assert s["candidates"][0]["contradicted"] == ["budget", "beachfront"]
    assert s["counts"] == {"VERIFIED": 1, "UNVERIFIED": 0, "REJECTED": 1, "NOT_CHECKED": 1}
    assert again.is_error is False and again.structured_content["run_id"] == s["run_id"]   # persisted to the store


# 8: upstream failures surface as errors — never a fabricated success
def test_failures_are_errors_not_results(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a, **k):
        raise RuntimeError("jev adjudication failed: upstream 503")
    monkeypatch.setattr(jev_verifier, "verify_candidate", boom)

    async def go():
        async with Client(mcp_server) as c:
            no_keys = await c.call_tool("find_and_verify", {"request": "Hotel in Goa under Rs 10,000"})    # keyless settings
            upstream = await c.call_tool("verify_candidate", {"requirements": [{"id": "x", "description": "x"}], "candidate": {"candidate_id": "c1"}})
            invalid = await c.call_tool("find_and_verify", {"request": "Hotel", "max_candidates": 0})
            return no_keys, upstream, invalid
    no_keys, upstream, invalid = run(go())
    assert no_keys.is_error is True and no_keys.structured_content is None
    assert "LLM_API_KEY is not set" in no_keys.content[0].text and "No verification result was produced" in no_keys.content[0].text
    assert upstream.is_error is True and "upstream 503" in upstream.content[0].text and "No verdict was produced" in upstream.content[0].text
    assert invalid.is_error is True and "max_candidates" in invalid.content[0].text


def test_secrets_are_scrubbed_from_errors(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    leaky = Settings(serpapi_api_key="sk-secret-123", llm_api_key="", jev_api_key="", jev_endpoint="", db_path=settings.db_path)
    monkeypatch.setattr(server_mod, "load_settings", lambda: leaky)
    monkeypatch.setattr(adapter_mod, "find_and_verify", lambda *a: (_ for _ in ()).throw(RuntimeError("serpapi failed with key sk-secret-123")))

    async def go():
        async with Client(mcp_server) as c:
            return await c.call_tool("find_and_verify", {"request": "Hotel in Goa"})
    r = run(go())
    assert r.is_error is True and "sk-secret-123" not in r.content[0].text and "***" in r.content[0].text


def test_summarize_run_is_faithful() -> None:
    s = summarize_run({**STORED, "target_type": "product"})
    assert [(c.candidate_id, c.status, c.price) for c in s.candidates] == [("c2", "REJECTED", "$1,299.00"), ("c1", "UNVERIFIED", "$899.00")]
    assert s.candidates[0].contradicted == ["ram"] and s.candidates[1].unknown == ["budget"]
    assert s.selected_candidate_id == "c1" and s.selected_status == "UNVERIFIED"


# 9: the stdio entry point starts from a foreign cwd and serves tools/list + calls
def test_stdio_entry_point_from_another_directory(tmp_path: Path) -> None:
    db = tmp_path / "stdio.db"
    store.save_run(str(db), STORED["run_id"], "2026-10-10T00:00:00+00:00", STORED["request"], STORED)
    params = StdioServerParameters(command=sys.executable, args=[str(RUN_MCP)], cwd=str(tmp_path),
                                   env={"PROOFGATE_DB_PATH": str(db)})

    async def go():
        async with Client(params) as c:
            names = sorted(t.name for t in (await c.list_tools()).tools)
            ok = await c.call_tool("get_run", {"run_id": "run-mcp-1"})
            missing = await c.call_tool("get_run", {"run_id": "nope"})
            return names, ok, missing
    names, ok, missing = run(go())
    assert names == ["find_and_verify", "get_evidence", "get_run", "verify_candidate"]
    assert ok.is_error is False and ok.structured_content["run_id"] == "run-mcp-1"
    assert missing.is_error is True


# 10: stdout carries only JSON-RPC; logs go to stderr
def test_stdout_is_protocol_only(tmp_path: Path) -> None:
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pytest", "version": "0"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_run", "arguments": {"run_id": "nope"}}},
    ]
    # Keep stdin open (as a real host does) until every response arrives; closing it
    # early is end-of-session, which cancels in-flight calls.
    p = subprocess.Popen([sys.executable, str(RUN_MCP)], cwd=str(tmp_path), stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env={**__import__("os").environ, "PROOFGATE_DB_PATH": str(tmp_path / "empty.db")})
    parsed: list[dict] = []
    try:
        for m in msgs:
            p.stdin.write((json.dumps(m) + "\n").encode())
            p.stdin.flush()
            if "id" in m:
                while True:
                    line = p.stdout.readline()
                    assert line, "server closed stdout early"
                    if not line.strip():
                        continue
                    msg = json.loads(line)              # any stray print would fail here
                    parsed.append(msg)
                    if msg.get("id") == m["id"]:
                        break
    finally:
        p.stdin.close()
        _, err = p.communicate(timeout=60)
    assert all(m.get("jsonrpc") == "2.0" for m in parsed)
    by_id = {m["id"]: m for m in parsed if "id" in m}
    assert by_id[1]["result"]["serverInfo"]["name"] == "proofgate"
    assert len(by_id[2]["result"]["tools"]) == 4
    assert by_id[3]["result"]["isError"] is True
    assert "ProofGate MCP server starting (stdio)" in err.decode(errors="replace")
