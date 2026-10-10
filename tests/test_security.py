"""Demo authentication + spend protection — no network, no paid calls."""
from __future__ import annotations

import time
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.api.routes as routes
import app.main as main_module
from app import security
from app.config import Settings
from app.main import app
from app.models.schemas import RunRecord
from app.storage import store

PASSWORD = "correct-horse-battery-staple"
SECRET = "s" * 48
RUN = {"run_id": "r1", "status": "verified", "request": "q", "action": "search", "requirements": [], "candidate_count": 0}


def make_settings(tmp_path: Path, **kw) -> Settings:
    base = Settings(serpapi_api_key="", llm_api_key="", jev_api_key="", jev_endpoint="", db_path=str(tmp_path / "t.db"),
                    production=True, demo_password=PASSWORD, session_secret=SECRET)
    return replace(base, **kw)


@pytest.fixture()
def use(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def apply(**kw) -> TestClient:
        s = make_settings(tmp_path, **kw)
        monkeypatch.setattr(routes, "settings", s)
        monkeypatch.setattr(main_module, "settings", s)
        store.save_run(s.db_path, "r1", "2026-10-10T00:00:00+00:00", "q", RUN)
        return TestClient(app)
    return apply


def login(c: TestClient, password: str = PASSWORD):
    return c.post("/v1/auth/login", json={"password": password})


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_health_is_public_and_leaks_nothing(use) -> None:
    c = use()
    r = c.get("/health")
    assert r.status_code == 200 and r.json()["auth"] == "on"
    assert PASSWORD not in r.text and SECRET not in r.text
    assert c.get("/v1/auth/status").json() == {"auth_required": True, "configured": True}


def test_protected_endpoints_reject_missing_invalid_and_expired_tokens(use) -> None:
    c = use()
    for path in ("/v1/runs", "/v1/runs/r1", "/v1/runs/r1/evidence"):
        r = c.get(path)
        assert r.status_code == 401 and r.json()["detail"]["code"] == "auth_required"
        assert r.headers["www-authenticate"] == "Bearer"
    assert c.post("/v1/find-and-verify", json={"request": "x"}).status_code == 401
    assert c.get("/v1/agent/chat/stream", params={"message": "hi"}).status_code == 401
    good = login(c).json()["token"]
    payload, sig = good.split(".")
    for bad in ("garbage", f"{payload}.{sig[:-2]}AA", f"{payload[:-2]}AA.{sig}", good + "x"):
        assert c.get("/v1/runs", headers=auth(bad)).status_code == 401, bad
    s = make_settings(Path("."))
    expired, _, _ = security.issue_token(s, now=time.time() - s.session_ttl_min * 60 - 5)
    assert c.get("/v1/runs", headers=auth(expired)).status_code == 401
    foreign, _, _ = security.issue_token(replace(s, session_secret="x" * 48))
    assert c.get("/v1/runs", headers=auth(foreign)).status_code == 401


def test_correct_password_returns_a_short_lived_working_token(use) -> None:
    c = use(session_ttl_min=30)
    assert login(c, "wrong-password-here").status_code == 401
    r = login(c)
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer" and body["ttl_seconds"] == 1800
    assert abs(body["expires_at"] - (time.time() + 1800)) < 5
    assert c.get("/v1/runs", headers=auth(body["token"])).status_code == 200
    assert c.get("/v1/runs/r1", headers=auth(body["token"])).json()["run_id"] == "r1"


def test_logout_revokes_the_token(use) -> None:
    c = use()
    t = login(c).json()["token"]
    assert c.get("/v1/runs", headers=auth(t)).status_code == 200
    assert c.post("/v1/auth/logout", headers=auth(t)).json() == {"ok": True}
    assert c.get("/v1/runs", headers=auth(t)).status_code == 401


def test_failed_logins_are_throttled(use) -> None:
    c = use()
    for _ in range(security.LOGIN_FAILS_PER_CLIENT):
        assert login(c, "nope-nope-nope").status_code == 401
    blocked = login(c)                        # even the right password is refused while throttled
    assert blocked.status_code == 429 and blocked.json()["detail"]["code"] == "too_many_attempts"
    assert int(blocked.headers["retry-after"]) > 0


def test_one_client_cannot_lock_out_everyone(use) -> None:
    """Regression: no server-wide lockout. Many failing IPs never block a different visitor."""
    c = use(client_ip_header="true-client-ip")
    for n in range(30):                          # 30 attackers x 5 failures = 150 failures
        ip = {"True-Client-IP": f"203.0.113.{n}"}
        for _ in range(security.LOGIN_FAILS_PER_CLIENT):
            assert c.post("/v1/auth/login", json={"password": "nope-nope-nope"}, headers=ip).status_code == 401
        assert c.post("/v1/auth/login", json={"password": PASSWORD}, headers=ip).status_code == 429
    ok = c.post("/v1/auth/login", json={"password": PASSWORD}, headers={"True-Client-IP": "198.51.100.7"})
    assert ok.status_code == 200 and ok.json()["token"]
    assert not hasattr(security, "LOGIN_FAILS_GLOBAL")


def test_throttle_uses_trusted_ip_header_and_ignores_x_forwarded_for(use) -> None:
    c = use(client_ip_header="true-client-ip")
    edge = {"True-Client-IP": "198.51.100.9"}
    for n in range(security.LOGIN_FAILS_PER_CLIENT):  # rotating a spoofed X-Forwarded-For does not help
        r = c.post("/v1/auth/login", json={"password": "nope-nope-nope"}, headers={**edge, "X-Forwarded-For": f"10.0.0.{n}"})
        assert r.status_code == 401
    r = c.post("/v1/auth/login", json={"password": PASSWORD}, headers={**edge, "X-Forwarded-For": "10.9.9.9"})
    assert r.status_code == 429


def test_client_ip_header_is_ignored_unless_configured(use) -> None:
    c = use()                                    # no PROOFGATE_CLIENT_IP_HEADER: socket peer only
    for n in range(security.LOGIN_FAILS_PER_CLIENT):
        c.post("/v1/auth/login", json={"password": "nope-nope-nope"}, headers={"True-Client-IP": f"203.0.113.{n}"})
    assert c.post("/v1/auth/login", json={"password": PASSWORD}, headers={"True-Client-IP": "198.51.100.1"}).status_code == 429


def test_spend_endpoints_are_limited_per_session_with_429(use, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_run(*a, **k):
        calls.append(1)
        return RunRecord(**RUN)
    monkeypatch.setattr(routes, "run_find_and_verify", fake_run)
    c = use(spend_per_session=2, spend_global_max=100)
    t = login(c).json()["token"]
    for _ in range(2):
        assert c.post("/v1/find-and-verify", json={"request": "Hotel in Goa"}, headers=auth(t)).status_code == 200
    r = c.post("/v1/find-and-verify", json={"request": "Hotel in Goa"}, headers=auth(t))
    assert r.status_code == 429 and "live searches/verifications" in r.json()["detail"]["message"]
    assert len(calls) == 2                                  # the limited call never reached the pipeline
    assert c.get("/v1/runs", headers=auth(t)).status_code == 200   # read-only stays usable
    t2 = login(c).json()["token"]                           # a new session has its own allowance
    assert c.post("/v1/find-and-verify", json={"request": "Hotel"}, headers=auth(t2)).status_code == 200


def test_global_spend_cap(use, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes, "run_find_and_verify", lambda *a, **k: RunRecord(**RUN))
    c = use(spend_per_session=10, spend_global_max=3)
    tokens = [login(c).json()["token"] for _ in range(4)]
    codes = [c.post("/v1/find-and-verify", json={"request": "x"}, headers=auth(t)).status_code for t in tokens]
    assert codes == [200, 200, 200, 429]


def test_request_rate_limit_per_session(use) -> None:
    c = use(requests_per_min=10)
    t = login(c).json()["token"]
    codes = [c.get("/v1/runs", headers=auth(t)).status_code for _ in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429


@pytest.mark.parametrize("kw", [{"demo_password": ""}, {"demo_password": "short"}, {"session_secret": ""}, {"session_secret": "too-short"}])
def test_production_fails_closed_when_secrets_are_missing_or_weak(use, kw) -> None:
    c = use(**kw)
    assert c.get("/health").json()["auth"] == "misconfigured"
    assert c.get("/v1/auth/status").json() == {"auth_required": True, "configured": False}
    assert c.get("/v1/runs").status_code == 503
    assert login(c).status_code == 503


def test_local_development_needs_no_login(use) -> None:
    c = use(production=False, demo_password="", session_secret="")
    assert c.get("/health").json()["auth"] == "off"
    assert c.get("/v1/runs").status_code == 200
    assert login(c).status_code == 400


def test_cors_preflight_allows_authorization_from_allowed_origin_only(use) -> None:
    c = use()
    pre = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
    ok = c.options("/v1/runs", headers={"Origin": "http://localhost:5173", **pre})
    assert ok.status_code == 200 and "authorization" in ok.headers["access-control-allow-headers"].lower()
    bad = c.options("/v1/runs", headers={"Origin": "https://evil.example.com", **pre})
    assert "access-control-allow-origin" not in bad.headers
