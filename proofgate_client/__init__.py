"""ProofGate local Python client — available in this repository, not published to PyPI."""
from .client import (
    DEFAULT_BASE_URL,
    ProofGateClient,
    ProofGateConnectionError,
    ProofGateError,
    ProofGateHTTPError,
    ProofGateNotFound,
)

__all__ = ["DEFAULT_BASE_URL", "ProofGateClient", "ProofGateConnectionError", "ProofGateError",
           "ProofGateHTTPError", "ProofGateNotFound"]
