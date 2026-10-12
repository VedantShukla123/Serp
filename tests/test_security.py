"""User accounts, sessions and spend protection — no network, no paid calls."""
from __future__ import annotations

import json
import sqlite3
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

SECRET = "s" * 48
PASSWORD = "correct-horse-battery"
RUN = {"run_id": "r1", "status": "verified", "request": "q", "action": "search", "requirements": [], "candidate_count": 0}


def make_settings(tmp_path: Path, **kw) -> Settings:
    base = Settings(serpapi_api_key="", llm_api_key="", jev_api_key="", jev_endpoint="", db_path=str(tmp_path / "t.db"),
                    production=True, session_secret=SECRET)
    return replace(base, **kw)


@pytest.fixture()
def use(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    def apply(**kw) -> TestClient:
        s = make_settings(tmp_path, **kw)
        monkeypatch.setattr(routes, "settings", s)
        monkeypatch.setattr(main_module, "settings", s)
        return TestClient(app)
    return apply


def register(c: TestClient, email: str = "ada@example.com", password: str = PASSWORD, name: str = "Ada", **headers):
    return c.post("/v1/auth/register", json={"name": name, "email": email, "password": password}, headers=headers)


def login(c: TestClient, email: str = "ada@example.com", password: str = PASSWORD, **headers):
    return c.post("/v1/auth/login", json={"email": email, "password": password}, headers=headers)


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def signed_up(c: TestClient, email: str = "ada@example.com") -> str:
    r = register(c, email)
    assert r.status_code == 201, r.text
    return r.json()["token"]


# ------------------------------------------------------------------ registration / login

def test_register_returns_a_session_for_the_new_user_and_me_works(use) -> None:
    c = use(session_ttl_min=30)
    r = register(c, "  Ada@Example.COM ", name="  Ada   Lovelace ")
    assert r.status_code == 201
    body = r.json()
    assert body["token_type"] == "bearer" and body["ttl_seconds"] == 1800
    assert abs(body["expires_at"] - (time.time() + 1800)) < 5
    assert body["user"]["email"] == "ada@example.com" and body["user"]["name"] == "Ada Lovelace"
    assert "password" not in r.text and "hash" not in r.text and PASSWORD not in r.text
    me = c.get("/v1/auth/me", headers=auth(body["token"]))
    assert me.status_code == 200 and me.json()["user_id"] == body["user"]["user_id"]
    assert c.get("/v1/runs", headers=auth(body["token"])).json() == []


def test_login_with_email_and_password(use) -> None:
    c = use()
    uid = register(c).json()["user"]["user_id"]
    r = login(c, " ADA@example.com ")
    assert r.status_code == 200 and r.json()["user"]["user_id"] == uid
    assert c.get("/v1/auth/me", headers=auth(r.json()["token"])).json()["email"] == "ada@example.com"


def test_duplicate_email_is_rejected_case_insensitively(use) -> None:
    c = use()
    signed_up(c, "ada@example.com")
    r = register(c, "ADA@example.com ")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "email_taken"
    assert "email" in r.json()["detail"]["errors"]


def test_invalid_credentials_are_generic(use) -> None:
    c = use()
    signed_up(c)
    wrong_pw, no_user = login(c, password="not-the-password"), login(c, "nobody@example.com")
    assert wrong_pw.status_code == no_user.status_code == 401
    assert wrong_pw.json() == no_user.json()             # same answer: no account probing
    assert wrong_pw.json()["detail"]["message"] == "Email or password is incorrect."


@pytest.mark.parametrize("body,field", [
    ({"name": "", "email": "a@b.co", "password": PASSWORD}, "name"),
    ({"name": "A", "email": "not-an-email", "password": PASSWORD}, "email"),
    ({"name": "A", "email": "a@b.co", "password": "short"}, "password"),
    ({"name": "A", "email": "a@b.co", "password": " " * 12}, "password"),
    ({"name": "A", "email": "a@b.co", "password": "x" * 129}, "password"),
    ({"name": "A" * 101, "email": "a@b.co", "password": PASSWORD}, "name"),
])
def test_registration_is_validated_on_the_server(use, body, field) -> None:
    r = use().post("/v1/auth/register", json=body)
    assert r.status_code == 422 and field in r.json()["detail"]["errors"]


def test_oversized_inputs_are_rejected_before_any_work(use) -> None:
    c = use()
    assert c.post("/v1/auth/register", json={"name": "A", "email": "a@b.co", "password": "x" * 5000}).status_code == 422
    assert c.post("/v1/auth/login", json={"email": "a@b.co", "password": "x" * 5000}).status_code == 422


def test_passwords_are_stored_as_argon2id_hashes_only(use, tmp_path: Path) -> None:
    c = use()
    signed_up(c)
    con = sqlite3.connect(tmp_path / "t.db")
    stored = con.execute("SELECT password_hash FROM users").fetchone()[0]
    con.close()
    assert stored.startswith("$argon2id$") and PASSWORD not in stored
    assert PASSWORD.encode() not in (tmp_path / "t.db").read_bytes()
    assert security.check_password(stored, PASSWORD) and not security.check_password(stored, PASSWORD + "x")
    assert not security.check_password(None, PASSWORD)


# ------------------------------------------------------------------ tokens

def test_protected_endpoints_reject_missing_invalid_tampered_expired_and_foreign_tokens(use) -> None:
    c = use()
    for path in ("/v1/runs", "/v1/runs/r1", "/v1/runs/r1/evidence", "/v1/auth/me"):
        r = c.get(path)
        assert r.status_code == 401 and r.json()["detail"]["code"] == "auth_required", path
        assert r.headers["www-authenticate"] == "Bearer"
    assert c.post("/v1/find-and-verify", json={"request": "Hotel in Goa"}).status_code == 401
    assert c.get("/v1/agent/chat/stream", params={"message": "hi"}).status_code == 401
    good = signed_up(c)
    uid = c.get("/v1/auth/me", headers=auth(good)).json()["user_id"]
    payload, sig = good.split(".")
    for bad in ("garbage", f"{payload}.{sig[:-2]}AA", f"{payload[:-2]}AA.{sig}", good + "x"):
        assert c.get("/v1/runs", headers=auth(bad)).status_code == 401, bad
    s = make_settings(Path("."))
    expired, _, _ = security.issue_token(s, uid, now=time.time() - s.session_ttl_min * 60 - 5)
    assert c.get("/v1/runs", headers=auth(expired)).status_code == 401
    foreign, _, _ = security.issue_token(replace(s, session_secret="x" * 48), uid)
    assert c.get("/v1/runs", headers=auth(foreign)).status_code == 401
    ghost, _, _ = security.issue_token(s, "no-such-user")          # correctly signed, but no such account
    assert c.get("/v1/runs", headers=auth(ghost)).status_code == 401
    # editing the payload to claim another user's id breaks the signature
    forged = security._b64(json.dumps({"sid": "x", "uid": "someone-else", "exp": 2**40}).encode())
    assert c.get("/v1/runs", headers=auth(f"{forged}.{sig}")).status_code == 401


def test_logout_revokes_the_token_persistently(use) -> None:
    c = use()
    t = signed_up(c)
    assert c.get("/v1/runs", headers=auth(t)).status_code == 200
    assert c.post("/v1/auth/logout", headers=auth(t)).json() == {"ok": True}
    assert c.get("/v1/runs", headers=auth(t)).status_code == 401
    security._revoked.reset()                                # simulate a restart: memory cache gone
    assert c.get("/v1/auth/me", headers=auth(t)).status_code == 401
    t2 = login(c).json()["token"]                            # other sessions are unaffected
    assert c.get("/v1/auth/me", headers=auth(t2)).status_code == 200


# ------------------------------------------------------------------ abuse protection

def test_failed_logins_are_throttled(use) -> None:
    c = use()
    signed_up(c)
    for _ in range(security.LOGIN_FAILS_PER_CLIENT):
        assert login(c, password="nope-nope-nope").status_code == 401
    blocked = login(c)                        # even the right password is refused while throttled
    assert blocked.status_code == 429 and blocked.json()["detail"]["code"] == "too_many_attempts"
    assert int(blocked.headers["retry-after"]) > 0


def test_one_client_cannot_lock_out_everyone(use) -> None:
    """No server-wide or per-account lockout: many failing IPs never block a different visitor."""
    c = use(client_ip_header="true-client-ip")
    signed_up(c)
    for n in range(30):
        ip = {"True-Client-IP": f"203.0.113.{n}"}
        for _ in range(security.LOGIN_FAILS_PER_CLIENT):
            assert login(c, password="nope-nope-nope", **ip).status_code == 401
        assert login(c, **ip).status_code == 429
    ok = login(c, **{"True-Client-IP": "198.51.100.7"})
    assert ok.status_code == 200 and ok.json()["token"]
    assert not hasattr(security, "LOGIN_FAILS_GLOBAL")


def test_throttle_uses_trusted_ip_header_and_ignores_x_forwarded_for(use) -> None:
    c = use(client_ip_header="true-client-ip")
    signed_up(c)
    edge = {"True-Client-IP": "198.51.100.9"}
    for n in range(security.LOGIN_FAILS_PER_CLIENT):  # rotating a spoofed X-Forwarded-For does not help
        assert login(c, password="nope-nope-nope", **edge, **{"X-Forwarded-For": f"10.0.0.{n}"}).status_code == 401
    assert login(c, **edge, **{"X-Forwarded-For": "10.9.9.9"}).status_code == 429


def test_client_ip_header_is_ignored_unless_configured(use) -> None:
    c = use()                                    # no PROOFGATE_CLIENT_IP_HEADER: socket peer only
    signed_up(c)
    for n in range(security.LOGIN_FAILS_PER_CLIENT):
        login(c, password="nope-nope-nope", **{"True-Client-IP": f"203.0.113.{n}"})
    assert login(c, **{"True-Client-IP": "198.51.100.1"}).status_code == 429


def test_registrations_are_throttled_per_client(use) -> None:
    c = use()
    for i in range(security.REGISTRATIONS_PER_CLIENT):
        assert register(c, f"u{i}@example.com").status_code == 201
    r = register(c, "one-more@example.com")
    assert r.status_code == 429 and r.json()["detail"]["code"] == "too_many_signups"


def test_spend_limits_are_per_account_and_signing_in_again_does_not_reset_them(use, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_run(*a, **k):
        calls.append(1)
        return RunRecord(**{**RUN, "run_id": f"r{len(calls)}"})
    monkeypatch.setattr(routes, "run_find_and_verify", fake_run)
    c = use(spend_per_session=2, spend_global_max=100)
    t = signed_up(c)
    for _ in range(2):
        assert c.post("/v1/find-and-verify", json={"request": "Hotel in Goa"}, headers=auth(t)).status_code == 200
    r = c.post("/v1/find-and-verify", json={"request": "Hotel in Goa"}, headers=auth(t))
    assert r.status_code == 429 and "live searches/verifications" in r.json()["detail"]["message"]
    assert len(calls) == 2                                  # the limited call never reached the pipeline
    assert c.get("/v1/runs", headers=auth(t)).status_code == 200   # read-only stays usable
    t_again = login(c).json()["token"]                      # same account, new session: still limited
    assert c.post("/v1/find-and-verify", json={"request": "Hotel"}, headers=auth(t_again)).status_code == 429
    other = signed_up(c, "bob@example.com")                  # a different account has its own allowance
    assert c.post("/v1/find-and-verify", json={"request": "Hotel"}, headers=auth(other)).status_code == 200


def test_global_spend_cap(use, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes, "run_find_and_verify", lambda *a, **k: RunRecord(**RUN))
    c = use(spend_per_session=10, spend_global_max=3)
    tokens = [signed_up(c, f"u{i}@example.com") for i in range(4)]
    codes = [c.post("/v1/find-and-verify", json={"request": "Hotel in Goa"}, headers=auth(t)).status_code for t in tokens]
    assert codes == [200, 200, 200, 429]


def test_request_rate_limit_per_account(use) -> None:
    c = use(requests_per_min=10)
    t = signed_up(c)
    codes = [c.get("/v1/runs", headers=auth(t)).status_code for _ in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429


# ------------------------------------------------------------------ configuration gating

def test_health_is_public_and_leaks_nothing(use) -> None:
    c = use()
    r = c.get("/health")
    assert r.status_code == 200 and r.json()["auth"] == "on"
    assert SECRET not in r.text
    assert c.get("/v1/auth/status").json() == {"auth_required": True, "configured": True, "accounts": True}


@pytest.mark.parametrize("secret", ["", "too-short"])
def test_production_fails_closed_without_a_strong_session_secret(use, secret) -> None:
    c = use(session_secret=secret)
    assert c.get("/health").json()["auth"] == "misconfigured"
    assert c.get("/v1/auth/status").json() == {"auth_required": True, "configured": False, "accounts": False}
    assert c.get("/v1/runs").status_code == 503
    assert register(c).status_code == 503 and login(c).status_code == 503


def test_production_can_never_run_without_sign_in() -> None:
    """The local no-sign-in mode needs BOTH non-production and no secret; production is never open."""
    here = Path(".")
    assert security.auth_mode(make_settings(here, production=True, session_secret="")) == "misconfigured"
    assert security.auth_mode(make_settings(here, production=False, session_secret=SECRET)) == "on"
    assert security.auth_mode(make_settings(here, production=False, session_secret="")) == "off"


def test_shared_demo_password_no_longer_exists(use, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.config as config
    monkeypatch.setenv("PROOFGATE_DEMO_PASSWORD", "an-old-shared-password")
    assert not hasattr(config.load_settings(), "demo_password")
    c = use()
    assert c.post("/v1/auth/login", json={"password": "an-old-shared-password"}).status_code == 401
    assert c.get("/v1/runs").status_code == 401


def test_local_development_needs_no_login(use) -> None:
    c = use(production=False, session_secret="")
    assert c.get("/health").json()["auth"] == "off"
    assert c.get("/v1/runs").status_code == 200
    assert register(c).status_code == 400 and login(c).status_code == 400
    assert c.get("/v1/auth/status").json()["accounts"] is False


def test_cors_preflight_allows_authorization_from_allowed_origin_only(use) -> None:
    c = use()
    pre = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
    ok = c.options("/v1/runs", headers={"Origin": "http://localhost:5173", **pre})
    assert ok.status_code == 200 and "authorization" in ok.headers["access-control-allow-headers"].lower()
    bad = c.options("/v1/runs", headers={"Origin": "https://evil.example.com", **pre})
    assert "access-control-allow-origin" not in bad.headers


def test_migration_keeps_existing_rows(tmp_path: Path) -> None:
    """Databases from before accounts gain owner_id columns; no stored run or booking is lost."""
    db = tmp_path / "old.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE runs (run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, request TEXT NOT NULL, data TEXT NOT NULL)")
    con.execute("CREATE TABLE bookings (booking_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, run_id TEXT NOT NULL, candidate_id TEXT NOT NULL, data TEXT NOT NULL)")
    con.execute("INSERT INTO runs VALUES ('old1', '2026-01-01', 'q', ?)", (json.dumps({"run_id": "old1"}),))
    con.execute("INSERT INTO bookings VALUES ('SIM-1', '2026-01-01', 'old1', 'c1', '{\"booking_id\": \"SIM-1\"}')")
    con.commit()
    con.close()
    assert store.get_run(str(db), "old1") == {"run_id": "old1"}                 # unscoped (local) still sees it
    assert store.get_booking(str(db), "SIM-1") == {"booking_id": "SIM-1"}
    assert store.get_run(str(db), "old1", scope="some-user") is None          # never shown to an account
    assert [r["run_id"] for r in store.list_runs(str(db))] == ["old1"]
