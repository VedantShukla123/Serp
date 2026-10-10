"""Small synchronous REST client for a local ProofGate API (app/api/routes.py).

Only wraps endpoints that exist. No authentication is sent or implied: the local
API does not check any key. Uses httpx, already a ProofGate dependency.
"""
from __future__ import annotations

from typing import Any

import httpx

DEFAULT_BASE_URL = "http://localhost:8000"


class ProofGateError(Exception):
    """Base class for every error raised by this client."""


class ProofGateConnectionError(ProofGateError):
    """The API could not be reached (server not running, DNS, refused) or timed out."""


class ProofGateHTTPError(ProofGateError):
    """The API answered with a non-2xx status. `detail` is the server's JSON detail."""

    def __init__(self, status_code: int, detail: Any, method: str, path: str):
        self.status_code = status_code
        self.detail = detail
        self.method = method
        self.path = path
        super().__init__(f"{method} {path} -> HTTP {status_code}: {_detail_text(detail)}")


class ProofGateNotFound(ProofGateHTTPError):
    """HTTP 404 — e.g. an unknown run_id."""


def _detail_text(detail: Any) -> str:
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("code") or detail)
    if isinstance(detail, list):   # FastAPI validation errors
        return "; ".join(f"{'.'.join(map(str, e.get('loc', [])))}: {e.get('msg')}" for e in detail if isinstance(e, dict)) or str(detail)
    return str(detail)


class ProofGateClient:
    """
    >>> pg = ProofGateClient()                      # http://localhost:8000
    >>> pg.health()["ready"]
    >>> run = pg.get_run("c28bb2b65036")            # free: reads the local store
    """

    def __init__(self, base_url: str = DEFAULT_BASE_URL, *, timeout: float = 30.0,
                 verify_timeout: float = 300.0, transport: httpx.BaseTransport | None = None):
        """`timeout` applies to reads; `verify_timeout` to find_and_verify / verify, which run
        live searches and LLM/Jev calls and can take minutes. `transport` is for tests."""
        self.base_url = base_url.rstrip("/")
        self.verify_timeout = verify_timeout
        self._http = httpx.Client(base_url=self.base_url, timeout=timeout, transport=transport)

    # -- plumbing ------------------------------------------------------------
    def _request(self, method: str, path: str, *, json: Any = None, params: dict | None = None,
                 timeout: float | None = None) -> Any:
        try:
            kwargs: dict[str, Any] = {"json": json, "params": params}
            if timeout is not None:
                kwargs["timeout"] = timeout
            r = self._http.request(method, path, **kwargs)
        except httpx.TimeoutException as e:
            raise ProofGateConnectionError(f"{method} {path} timed out ({e.__class__.__name__}).") from e
        except httpx.TransportError as e:
            raise ProofGateConnectionError(
                f"Could not reach ProofGate at {self.base_url} ({e.__class__.__name__}). "
                "Is it running? Start it with: python run.py --serve") from e
        if r.is_success:
            return r.json()
        try:
            detail = r.json().get("detail", r.text)
        except ValueError:
            detail = r.text
        cls = ProofGateNotFound if r.status_code == 404 else ProofGateHTTPError
        raise cls(r.status_code, detail, method, path)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> ProofGateClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- free, read-only -----------------------------------------------------
    def health(self) -> dict:
        """GET /health → {ok, service, ready, missing_credentials, has_serpapi_key, has_llm_key, has_jev}."""
        return self._request("GET", "/health")

    def list_runs(self, limit: int = 50) -> list[dict]:
        """GET /v1/runs → [{run_id, created_at, request}], newest first (server clamps limit to 1–200)."""
        return self._request("GET", "/v1/runs", params={"limit": limit})

    def get_run(self, run_id: str) -> dict:
        """GET /v1/runs/{run_id} → the stored run. Raises ProofGateNotFound for unknown ids."""
        return self._request("GET", f"/v1/runs/{_seg(run_id)}")

    def get_evidence(self, run_id: str) -> dict:
        """GET /v1/runs/{run_id}/evidence → {run_id, candidates, raw_serpapi, attempts}."""
        return self._request("GET", f"/v1/runs/{_seg(run_id)}/evidence")

    # -- uses external API credits -------------------------------------------
    def find_and_verify(self, request: str, action: str = "search", max_candidates: int = 15,
                        engine: str | None = None) -> dict:
        """POST /v1/find-and-verify. USES API CREDITS (SerpApi + LLM + Jev).
        Returns the run (status, requirements, ranked_candidates, attempts, …).
        Missing keys / upstream failures raise ProofGateHTTPError (502), never a fake result."""
        body = {"request": request, "action": action, "max_candidates": max_candidates, "engine": engine}
        return self._request("POST", "/v1/find-and-verify", json=body, timeout=self.verify_timeout)

    def verify(self, requirements: list[dict], candidate: dict) -> dict:
        """POST /v1/verify. USES Jev/LLM CREDITS. requirements: [{id, description, importance?}],
        candidate: {candidate_id, name, …}. Returns {candidate_id, overall_status, requirements, verifier}."""
        return self._request("POST", "/v1/verify", json={"requirements": requirements, "candidate": candidate},
                             timeout=self.verify_timeout)


def _seg(value: str) -> str:
    """Percent-encode a path segment so ids can't escape the route."""
    from urllib.parse import quote
    return quote(str(value), safe="")
