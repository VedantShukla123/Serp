"""Central configuration. All secrets stay server-side (env vars)."""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


DEV_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"


def parse_origins(raw: str) -> tuple[str, ...]:
    """Comma-separated origins for CORS. '*' allows any origin (not recommended outside local dev)."""
    items = tuple(o.strip().rstrip("/") for o in raw.split(",") if o.strip())
    return ("*",) if "*" in items else items


def _get(name: str, default: str = "") -> str:
    v = os.getenv(name, default)
    return v.strip()


@dataclass(frozen=True)
class Settings:
    serpapi_api_key: str = ""
    serpapi_engine: str = "google_hotels"
    llm_api_key: str = ""
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4o-mini"
    llm_timeout_s: int = 60
    jev_api_key: str = ""
    jev_endpoint: str = "https://api.typesafe.ai/v1/systemone"
    jev_model: str = "jev-latest"
    jev_satisfied_at: float = 0.75
    jev_contradicted_below: float = 0.25
    jev_timeout_s: int = 60
    proofgate_api_key: str = ""   # read but NOT enforced by any route (see DEPLOYMENT.md)
    db_path: str = "./proofgate.db"
    allowed_origins: tuple[str, ...] = parse_origins(DEV_ORIGINS)

    @property
    def has_serpapi(self) -> bool:
        return bool(self.serpapi_api_key)

    @property
    def has_llm(self) -> bool:
        return bool(self.llm_api_key)

    @property
    def has_jev(self) -> bool:
        return bool(self.jev_endpoint and self.jev_api_key)


def load_settings() -> Settings:
    try:
        llm_timeout = int(_get("LLM_TIMEOUT_S", "60"))
    except ValueError:
        llm_timeout = 60
    try:
        jev_timeout = int(_get("JEV_TIMEOUT_S", "60"))
    except ValueError:
        jev_timeout = 60
    try:
        sat_at = float(_get("JEV_SATISFIED_AT", "0.75"))
    except ValueError:
        sat_at = 0.75
    try:
        contra_below = float(_get("JEV_CONTRADICTED_BELOW", "0.25"))
    except ValueError:
        contra_below = 0.25
    return Settings(
        serpapi_api_key=_get("SERPAPI_API_KEY"),
        serpapi_engine=_get("SERPAPI_ENGINE", "google_hotels"),
        llm_api_key=_get("LLM_API_KEY"),
        llm_base_url=_get("LLM_BASE_URL", "https://api.openai.com/v1"),
        llm_model=_get("LLM_MODEL", "gpt-4o-mini"),
        llm_timeout_s=llm_timeout,
        jev_api_key=_get("JEV_API_KEY"),
        jev_endpoint=_get("JEV_ENDPOINT", "https://api.typesafe.ai/v1/systemone"),
        jev_model=_get("JEV_MODEL", "jev-latest"),
        jev_satisfied_at=sat_at,
        jev_contradicted_below=contra_below,
        jev_timeout_s=jev_timeout,
        proofgate_api_key=_get("PROOFGATE_API_KEY"),
        db_path=_get("PROOFGATE_DB_PATH", "./proofgate.db"),
        allowed_origins=parse_origins(_get("PROOFGATE_ALLOWED_ORIGINS", DEV_ORIGINS)),
    )


settings = load_settings()
