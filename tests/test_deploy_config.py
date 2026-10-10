"""Deployment configuration: CORS origins and secrets stay server-side — no network."""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.config import DEV_ORIGINS, parse_origins
from app.main import app

REPO = Path(__file__).resolve().parents[1]


def test_parse_origins() -> None:
    assert parse_origins("https://app.example.com/, https://b.example.com") == ("https://app.example.com", "https://b.example.com")
    assert parse_origins("https://a.example.com,*") == ("*",)
    assert parse_origins("") == ()
    assert "http://localhost:5173" in parse_origins(DEV_ORIGINS)


def test_cors_allows_dev_origin_and_rejects_others() -> None:
    c = TestClient(app)
    ok = c.get("/health", headers={"Origin": "http://localhost:5173"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    other = c.get("/health", headers={"Origin": "https://evil.example.com"})
    assert "access-control-allow-origin" not in other.headers


def test_frontend_never_reads_server_secrets() -> None:
    src = "\n".join(p.read_text(encoding="utf-8") for p in (REPO / "frontend" / "src").glob("*.ts*"))
    for secret in ("SERPAPI_API_KEY", "LLM_API_KEY", "JEV_API_KEY", "PROOFGATE_API_KEY"):
        assert f"VITE_{secret}" not in src
    envs = set(__import__("re").findall(r"VITE_[A-Z_]+", src))
    assert envs <= {"VITE_API_BASE_URL"}, envs
