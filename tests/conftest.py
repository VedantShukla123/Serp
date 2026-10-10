"""Shared test setup: in-memory auth/rate-limit state starts empty for every test."""
from __future__ import annotations

import pytest

from app import security


@pytest.fixture(autouse=True)
def _reset_security_state():
    security.reset_limits()
    yield
    security.reset_limits()
