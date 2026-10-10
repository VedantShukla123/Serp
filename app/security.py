"""Demo access control + spend protection (standard library only).

Modes (see auth_mode):
  off            no PROOFGATE_DEMO_PASSWORD and not production -> local development, no login
  on             demo password + session secret configured -> every /v1 route needs a bearer token
  misconfigured  production (PROOFGATE_ENV=production) or a password is set, but the password
                 or secret is missing/too weak -> fail closed: protected routes and login return 503

Tokens: base64url(JSON {sid, exp}) + "." + base64url(HMAC-SHA256(secret, payload)). Short-lived,
verified in constant time, revocable on logout (in memory). Passwords and tokens are never logged.

Limits are IN MEMORY: they reset when the process restarts and are per instance. They bound abuse
of a demo; they are not a permanent cost cap — set spending limits at SerpApi / your LLM provider too.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException, Request

from app.config import Settings

MIN_PASSWORD_LEN = 12
MIN_SECRET_LEN = 32
AuthMode = Literal["off", "on", "misconfigured"]

# Endpoints that can spend SerpApi / LLM / Jev credits.
SPEND_ROUTES = {("POST", "/v1/find-and-verify"), ("POST", "/v1/verify"), ("POST", "/v1/agent/chat"), ("GET", "/v1/agent/chat/stream")}


def _settings() -> Settings:
    # Resolved at call time so tests that patch app.api.routes.settings stay hermetic.
    from app.api import routes
    return routes.settings


def auth_mode(s: Settings) -> AuthMode:
    wants = s.production or bool(s.demo_password)
    if not wants:
        return "off"
    if len(s.demo_password) < MIN_PASSWORD_LEN or len(s.session_secret) < MIN_SECRET_LEN:
        return "misconfigured"
    return "on"


# ------------------------------------------------------------------ tokens

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(secret: str, payload: str) -> str:
    return _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def issue_token(s: Settings, now: float | None = None) -> tuple[str, int, str]:
    now = time.time() if now is None else now
    exp = int(now + s.session_ttl_min * 60)
    sid = secrets.token_urlsafe(12)
    payload = _b64(json.dumps({"sid": sid, "exp": exp}, separators=(",", ":")).encode())
    return f"{payload}.{_sign(s.session_secret, payload)}", exp, sid


def verify_token(s: Settings, token: str, now: float | None = None) -> str | None:
    """Session id for a valid, unexpired, unrevoked token; None otherwise."""
    try:
        payload, sig = token.split(".", 1)
        if not hmac.compare_digest(sig, _sign(s.session_secret, payload)):
            return None
        data = json.loads(_unb64(payload))
        sid, exp = str(data["sid"]), int(data["exp"])
    except Exception:
        return None
    if (time.time() if now is None else now) >= exp or _revoked.is_revoked(sid):
        return None
    return sid


def password_ok(s: Settings, supplied: str) -> bool:
    # hash both sides so the comparison is constant-time regardless of length
    a = hashlib.sha256(supplied.encode()).digest()
    b = hashlib.sha256(s.demo_password.encode()).digest()
    return hmac.compare_digest(a, b)


# ------------------------------------------------------------------ in-memory limiters

class SlidingWindow:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window_s: float, now: float | None = None) -> float | None:
        """Record a hit; returns seconds to wait if `limit` is exceeded (hit not recorded), else None."""
        now = time.time() if now is None else now
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and q[0] <= now - window_s:
                q.popleft()
            if len(q) >= limit:
                return max(1.0, q[0] + window_s - now)
            q.append(now)
            return None

    def count(self, key: str, window_s: float, now: float | None = None) -> int:
        now = time.time() if now is None else now
        with self._lock:
            return sum(1 for t in self._hits.get(key, ()) if t > now - window_s)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


class _Revoked:
    def __init__(self) -> None:
        self._sids: dict[str, float] = {}
        self._lock = threading.Lock()

    def add(self, sid: str, exp: float) -> None:
        with self._lock:
            now = time.time()
            self._sids = {k: v for k, v in self._sids.items() if v > now}
            self._sids[sid] = exp

    def is_revoked(self, sid: str) -> bool:
        with self._lock:
            return sid in self._sids

    def reset(self) -> None:
        with self._lock:
            self._sids.clear()


failed_logins = SlidingWindow()
requests_window = SlidingWindow()
spend_window = SlidingWindow()
_revoked = _Revoked()

LOGIN_WINDOW_S = 15 * 60
LOGIN_FAILS_PER_CLIENT = 5


def reset_limits() -> None:
    """For tests."""
    for w in (failed_logins, requests_window, spend_window):
        w.reset()
    _revoked.reset()


def client_key(request: Request) -> str:
    """Visitor IP for per-client throttling. Behind a proxy, set PROOFGATE_CLIENT_IP_HEADER to a header
    the proxy itself overwrites (Render/Cloudflare: True-Client-IP). X-Forwarded-For is NOT used:
    Render appends to it without clearing it, so its first entry is client-controlled."""
    header = _settings().client_ip_header
    if header:
        value = request.headers.get(header, "").split(",")[0].strip()
        if value:
            return value[:64]
    return request.client.host if request.client else "unknown"


def _too_many(message: str, retry: float) -> HTTPException:
    return HTTPException(status_code=429, detail={"code": "rate_limited", "message": message, "errors": {}},
                         headers={"Retry-After": str(int(retry))})


# ------------------------------------------------------------------ FastAPI dependency

@dataclass
class Session:
    sid: str          # token session id, or "client:<ip>" when auth is off


def require_session(request: Request) -> Session:
    """Router-level dependency for every protected /v1 route: auth + request/spend limits."""
    s = _settings()
    mode = auth_mode(s)
    if mode == "misconfigured":
        raise HTTPException(status_code=503, detail={"code": "auth_not_configured", "errors": {},
                            "message": "Access control is not configured on this server, so the API is closed."})
    if mode == "on":
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        sid = verify_token(s, token) if token else None
        if not sid:
            raise HTTPException(status_code=401, detail={"code": "auth_required", "errors": {},
                                "message": "Sign in with the demo password to use the API."},
                                headers={"WWW-Authenticate": "Bearer"})
        key = f"sid:{sid}"
        retry = requests_window.hit(key, s.requests_per_min, 60)
        if retry:
            raise _too_many("Too many requests for this session — slow down and try again shortly.", retry)
    else:
        key = f"client:{client_key(request)}"

    if (request.method, request.url.path) in SPEND_ROUTES:
        window = s.spend_window_min * 60
        if spend_window.count("global", window) >= s.spend_global_max:
            raise _too_many(f"This demo has reached its limit of {s.spend_global_max} live searches/verifications "
                            f"per {s.spend_window_min} minutes. Try again later — stored runs remain available.", window)
        retry = spend_window.hit(key, s.spend_per_session, window)
        if retry:
            raise _too_many(f"This session has used its {s.spend_per_session} live searches/verifications for now "
                            f"(limit per {s.spend_window_min} minutes). Stored runs remain available.", retry)
        spend_window.hit("global", 10**9, window)
    return Session(sid=key)
