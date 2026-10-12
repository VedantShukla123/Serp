"""User accounts, sessions and spend protection.

Modes (see auth_mode):
  off            not production and no PROOFGATE_SESSION_SECRET -> local development only: no sign-in,
                 one unscoped local workspace (every stored run is visible, as before accounts existed)
  on             session secret configured (>= 32 chars) -> every /v1 route needs a user's bearer token,
                 and every run / booking / order is scoped to that user
  misconfigured  production (PROOFGATE_ENV=production) without a strong session secret -> fail closed:
                 protected routes and account endpoints return 503. Production can never be "off".

Passwords: Argon2id (argon2-cffi), OWASP parameters (19 MiB, t=2, p=1). Never stored or logged in clear.
Tokens: base64url(JSON {sid, uid, exp}) + "." + base64url(HMAC-SHA256(secret, payload)). Short-lived,
verified in constant time, tied to an existing user, revocable on logout (persisted in the database).

Limits are IN MEMORY: they reset when the process restarts and are per instance. They bound abuse; they
are not a permanent cost cap — set spending limits at SerpApi / your LLM provider too.
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

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import HTTPException, Request

from app.config import Settings
from app.storage import store

MIN_SECRET_LEN = 32
AuthMode = Literal["off", "on", "misconfigured"]

# Endpoints that can spend SerpApi / LLM / Jev credits.
SPEND_ROUTES = {("POST", "/v1/find-and-verify"), ("POST", "/v1/verify"), ("POST", "/v1/agent/chat"), ("GET", "/v1/agent/chat/stream")}


def _settings() -> Settings:
    # Resolved at call time so tests that patch app.api.routes.settings stay hermetic.
    from app.api import routes
    return routes.settings


def auth_mode(s: Settings) -> AuthMode:
    wants = s.production or bool(s.session_secret)
    if not wants:
        return "off"
    if len(s.session_secret) < MIN_SECRET_LEN:
        return "misconfigured"
    return "on"


# ------------------------------------------------------------------ passwords

_hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)   # Argon2id, OWASP 2023
# Verified when the email is unknown, so a login takes about as long either way (no account probing by timing).
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def check_password(stored_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(stored_hash or _DUMMY_HASH, password) and stored_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(stored_hash)
    except InvalidHashError:
        return False


# ------------------------------------------------------------------ tokens

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(secret: str, payload: str) -> str:
    return _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def issue_token(s: Settings, user_id: str, now: float | None = None) -> tuple[str, int, str]:
    now = time.time() if now is None else now
    exp = int(now + s.session_ttl_min * 60)
    sid = secrets.token_urlsafe(12)
    payload = _b64(json.dumps({"sid": sid, "uid": user_id, "exp": exp}, separators=(",", ":")).encode())
    return f"{payload}.{_sign(s.session_secret, payload)}", exp, sid


@dataclass(frozen=True)
class TokenClaims:
    sid: str
    uid: str
    exp: int


def read_token(s: Settings, token: str, now: float | None = None) -> TokenClaims | None:
    """Claims of a correctly signed, unexpired, unrevoked token; None otherwise."""
    try:
        payload, sig = token.split(".", 1)
        if not hmac.compare_digest(sig, _sign(s.session_secret, payload)):
            return None
        data = json.loads(_unb64(payload))
        claims = TokenClaims(sid=str(data["sid"]), uid=str(data["uid"]), exp=int(data["exp"]))
    except Exception:
        return None
    if (time.time() if now is None else now) >= claims.exp or is_revoked(s, claims.sid):
        return None
    return claims


def is_revoked(s: Settings, sid: str) -> bool:
    return _revoked.is_revoked(sid) or store.is_session_revoked(s.db_path, sid)


def revoke(s: Settings, claims: TokenClaims) -> None:
    _revoked.add(claims.sid, claims.exp)
    store.revoke_session(s.db_path, claims.sid, claims.exp)


def bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header.lower().startswith("bearer ") else ""


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
    """Fast in-process cache of revoked session ids (the database is the source of truth)."""

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
registrations = SlidingWindow()
requests_window = SlidingWindow()
spend_window = SlidingWindow()
_revoked = _Revoked()

LOGIN_WINDOW_S = 15 * 60
LOGIN_FAILS_PER_CLIENT = 5
REGISTER_WINDOW_S = 60 * 60
REGISTRATIONS_PER_CLIENT = 5


def reset_limits() -> None:
    """For tests."""
    for w in (failed_logins, registrations, requests_window, spend_window):
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


# ------------------------------------------------------------------ FastAPI dependencies

@dataclass(frozen=True)
class Session:
    key: str                  # rate-limit key: "user:<id>", or "client:<ip>" when sign-in is off
    user_id: str | None       # the signed-in account; None only in local development (auth off)
    claims: TokenClaims | None = None

    @property
    def scope(self) -> str | None:
        """Ownership scope for the store: the user's id, or None (unscoped) in local development."""
        return self.user_id


def _closed() -> HTTPException:
    return HTTPException(status_code=503, detail={"code": "auth_not_configured", "errors": {},
                         "message": "Sign-in is not configured on this server, so the API is closed."})


def authenticate(request: Request, s: Settings) -> Session:
    """Who is calling. Raises 401 (no/invalid/expired/revoked token, or deleted account) or 503."""
    mode = auth_mode(s)
    if mode == "misconfigured":
        raise _closed()
    if mode == "off":
        return Session(key=f"client:{client_key(request)}", user_id=None)
    claims = read_token(s, bearer(request))
    if claims is None or store.get_user(s.db_path, claims.uid) is None:
        raise HTTPException(status_code=401, detail={"code": "auth_required", "errors": {},
                            "message": "Your session has ended. Please sign in again."},
                            headers={"WWW-Authenticate": "Bearer"})
    return Session(key=f"user:{claims.uid}", user_id=claims.uid, claims=claims)


def require_session(request: Request) -> Session:
    """Router-level dependency for every protected /v1 route: identity + request/spend limits.
    Limits are keyed by ACCOUNT (not by session), so signing in again does not reset them."""
    s = _settings()
    session = authenticate(request, s)
    if session.user_id is not None:
        retry = requests_window.hit(session.key, s.requests_per_min, 60)
        if retry:
            raise _too_many("Too many requests for this account — slow down and try again shortly.", retry)

    if (request.method, request.url.path) in SPEND_ROUTES:
        window = s.spend_window_min * 60
        if spend_window.count("global", window) >= s.spend_global_max:
            raise _too_many(f"This server has reached its limit of {s.spend_global_max} live searches/verifications "
                            f"per {s.spend_window_min} minutes. Try again later — stored runs remain available.", window)
        retry = spend_window.hit(session.key, s.spend_per_session, window)
        if retry:
            raise _too_many(f"This account has used its {s.spend_per_session} live searches/verifications for now "
                            f"(limit per {s.spend_window_min} minutes). Stored runs remain available.", retry)
        spend_window.hit("global", 10**9, window)
    return session
