"""ProofGate API — FastAPI app. Secrets stay server-side."""
from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import security
from app.api.auth_routes import auth_router
from app.api.routes import router
from app.config import settings
from app.storage import store

app = FastAPI(title="ProofGate", version="0.1.0",
              description="Search finds candidates. ProofGate finds the one that actually fits.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),   # PROOFGATE_ALLOWED_ORIGINS; local dev origins by default
    allow_credentials=False,                         # bearer tokens, not cookies
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
)

store.init_db(settings.db_path)


@app.get("/health")
def health():
    missing = [
        name for name, present in
        (("SERPAPI_API_KEY", settings.has_serpapi), ("LLM_API_KEY", settings.has_llm))
        if not present
    ]
    return {
        "ok": True,
        "service": "proofgate",
        "ready": not missing,
        "missing_credentials": missing,
        "has_serpapi_key": settings.has_serpapi,
        "has_llm_key": settings.has_llm,
        "has_jev": settings.has_jev,
        "auth": security.auth_mode(security._settings()),   # off | on | misconfigured — never values
    }


app.include_router(auth_router, prefix="/v1")   # public: status / login / logout
# every other /v1 route needs a valid session (when auth is on) and is rate limited
app.include_router(router, prefix="/v1", tags=["v1"], dependencies=[Depends(security.require_session)])
