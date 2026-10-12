"""Account endpoints: status, register, login, logout, me. See app/security.py.

register / login / logout / status are public; /me needs a valid token. All inputs are validated here
on the server (the frontend checks are only for convenience)."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app import security
from app.storage import store

auth_router = APIRouter(prefix="/auth", tags=["auth"])

MIN_PASSWORD = 10
MAX_PASSWORD = 128
MAX_NAME = 100
MAX_EMAIL = 254
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# Hard caps reject oversized bodies before any work (and before hashing); friendly field errors below.
class RegisterRequest(BaseModel):
    name: str = Field("", max_length=1000)
    email: str = Field("", max_length=1000)
    password: str = Field("", max_length=1000)


class LoginRequest(BaseModel):
    email: str = Field("", max_length=1000)
    password: str = Field("", max_length=1000)


def normalize_email(email: str) -> str:
    return email.strip().lower()


def _err(status: int, code: str, message: str, errors: dict | None = None, headers: dict | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, "errors": errors or {}},
                         headers=headers)


def _require_accounts() -> object:
    s = security._settings()
    mode = security.auth_mode(s)
    if mode == "misconfigured":
        raise security._closed()
    if mode == "off":
        raise _err(400, "auth_disabled", "Accounts are disabled on this local development server "
                   "(PROOFGATE_SESSION_SECRET is not set). Everything works without signing in.")
    return s


def _public_user(u: dict) -> dict:
    return {"user_id": u["user_id"], "name": u["name"], "email": u["email"], "created_at": u["created_at"]}


def _session_response(s, user: dict) -> dict:
    token, exp, _ = security.issue_token(s, user["user_id"])
    return {"token": token, "token_type": "bearer", "expires_at": exp, "ttl_seconds": s.session_ttl_min * 60,
            "user": _public_user(user)}


def validate_registration(body: RegisterRequest) -> tuple[str, str]:
    errors: dict[str, str] = {}
    name = " ".join(body.name.split())
    email = normalize_email(body.email)
    if not name:
        errors["name"] = "Enter your name."
    elif len(name) > MAX_NAME:
        errors["name"] = f"Use at most {MAX_NAME} characters."
    if len(email) > MAX_EMAIL or not _EMAIL.match(email):
        errors["email"] = "Enter a valid email address."
    if len(body.password) < MIN_PASSWORD:
        errors["password"] = f"Use at least {MIN_PASSWORD} characters."
    elif len(body.password) > MAX_PASSWORD:
        errors["password"] = f"Use at most {MAX_PASSWORD} characters."
    elif not body.password.strip():
        errors["password"] = "The password cannot be only spaces."
    if errors:
        raise _err(422, "invalid_signup", "Please fix the highlighted fields.", errors)
    return name, email


@auth_router.get("/status")
def auth_status():
    mode = security.auth_mode(security._settings())
    return {"auth_required": mode != "off", "configured": mode != "misconfigured", "accounts": mode == "on"}


@auth_router.post("/register", status_code=201)
def register(body: RegisterRequest, request: Request):
    s = _require_accounts()
    name, email = validate_registration(body)
    retry = security.registrations.hit(f"register:{security.client_key(request)}",
                                       security.REGISTRATIONS_PER_CLIENT, security.REGISTER_WINDOW_S)
    if retry:
        raise _err(429, "too_many_signups", "Too many accounts were created from this network. Try again later.",
                   headers={"Retry-After": str(int(retry))})
    user = {"user_id": uuid.uuid4().hex, "email": email, "name": name,
            "created_at": datetime.now(timezone.utc).isoformat()}
    try:
        store.create_user(s.db_path, user["user_id"], email, name, security.hash_password(body.password),
                          user["created_at"])
    except store.EmailTaken:
        raise _err(409, "email_taken", "An account with this email already exists. Sign in instead.",
                   {"email": "An account with this email already exists."})
    return _session_response(s, user)


@auth_router.post("/login")
def login(body: LoginRequest, request: Request):
    s = _require_accounts()
    client = f"login:{security.client_key(request)}"
    w = security.LOGIN_WINDOW_S
    # Per client IP only: a server-wide or per-account lockout would let one person lock others out.
    if security.failed_logins.count(client, w) >= security.LOGIN_FAILS_PER_CLIENT:
        raise _err(429, "too_many_attempts", "Too many failed sign-in attempts. Wait 15 minutes and try again.",
                   headers={"Retry-After": str(w)})
    email = normalize_email(body.email)
    user = store.get_user_by_email(s.db_path, email) if email and len(email) <= MAX_EMAIL else None
    password_ok = len(body.password) <= MAX_PASSWORD and security.check_password(
        user["password_hash"] if user else None, body.password)
    if not (user and password_ok):
        security.failed_logins.hit(client, 10**9, w)
        raise _err(401, "invalid_credentials", "Email or password is incorrect.")
    if security.needs_rehash(user["password_hash"]):
        store.update_password_hash(s.db_path, user["user_id"], security.hash_password(body.password))
    return _session_response(s, user)


@auth_router.post("/logout")
def logout(request: Request):
    s = security._settings()
    if security.auth_mode(s) == "on":
        claims = security.read_token(s, security.bearer(request))
        if claims:
            security.revoke(s, claims)
    return {"ok": True}


@auth_router.get("/me")
def me(request: Request):
    s = _require_accounts()
    session = security.authenticate(request, s)
    user = store.get_user(s.db_path, session.user_id)
    if user is None:     # authenticate() already checked; deleted between the two reads
        raise _err(401, "auth_required", "Your session has ended. Please sign in again.")
    return _public_user(user)
