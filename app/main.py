"""ProofGate API — FastAPI app. Secrets stay server-side."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.config import settings
from app.storage import store

app = FastAPI(title="ProofGate", version="0.1.0",
              description="Search finds candidates. ProofGate finds the one that actually fits.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
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
    }


app.include_router(router, prefix="/v1", tags=["v1"])
