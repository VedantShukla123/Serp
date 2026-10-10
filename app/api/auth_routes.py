"""Demo access endpoints (public): status, login, logout. See app/security.py."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app import security

auth_router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str


@auth_router.get("/status")
def auth_status():
    mode = security.auth_mode(security._settings())
    return {"auth_required": mode != "off", "configured": mode != "misconfigured"}


@auth_router.post("/login")
def login(body: LoginRequest, request: Request):
    s = security._settings()
    mode = security.auth_mode(s)
    if mode == "misconfigured":
        raise HTTPException(status_code=503, detail={"code": "auth_not_configured", "errors": {},
                            "message": "Access control is not configured on this server."})
    if mode == "off":
        raise HTTPException(status_code=400, detail={"code": "auth_disabled", "errors": {},
                            "message": "This server does not require sign-in."})
    client = f"login:{security.client_key(request)}"
    w = security.LOGIN_WINDOW_S
    # Per client IP only: a server-wide lockout would let one person block every demo user.
    if security.failed_logins.count(client, w) >= security.LOGIN_FAILS_PER_CLIENT:
        raise HTTPException(status_code=429, detail={"code": "too_many_attempts", "errors": {},
                            "message": "Too many failed sign-in attempts. Wait 15 minutes and try again."},
                            headers={"Retry-After": str(w)})
    if not security.password_ok(s, body.password):
        security.failed_logins.hit(client, 10**9, w)
        raise HTTPException(status_code=401, detail={"code": "wrong_password", "errors": {},
                            "message": "That demo password is not correct."})
    token, exp, _ = security.issue_token(s)
    return {"token": token, "token_type": "bearer", "expires_at": exp, "ttl_seconds": s.session_ttl_min * 60}


@auth_router.post("/logout")
def logout(request: Request):
    s = security._settings()
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if security.auth_mode(s) == "on" and token:
        sid = security.verify_token(s, token)
        if sid:
            exp = int(json.loads(security._unb64(token.split(".", 1)[0]))["exp"])
            security._revoked.add(sid, exp)
    return {"ok": True}
