#!/usr/bin/env python3
"""ProofGate MCP server — stdio entry point for MCP hosts.

    <repo>/.venv/Scripts/python.exe <repo>/run_mcp.py           # serve MCP over stdio
    <repo>/.venv/Scripts/python.exe <repo>/run_mcp.py --check   # list tools in-process, then exit

Works from any working directory: it anchors itself to this repository so the
project's .env and ./proofgate.db resolve exactly as for the REST API. Credentials
come from the repository's .env — never put them in the MCP host's config.
stdout carries only MCP protocol messages; every log line goes to stderr.
"""
from __future__ import annotations

import contextlib
import logging
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent


def _anchor() -> None:
    os.chdir(REPO)                       # relative paths such as ./proofgate.db
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))    # `import app` regardless of the host's cwd
    logging.basicConfig(level=os.environ.get("PROOFGATE_MCP_LOG_LEVEL", "INFO"), stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def _load_server():
    # Anything printed while importing the app must not reach the protocol stream.
    with contextlib.redirect_stdout(sys.stderr):
        from app.mcp.server import mcp_server
    return mcp_server


def _check() -> int:
    import asyncio

    from mcp import Client

    server = _load_server()

    async def run() -> None:
        async with Client(server) as client:
            tools = (await client.list_tools()).tools
            print(f"ProofGate MCP server OK - {len(tools)} tools:")
            for t in tools:
                print(f"  - {t.name}")

    asyncio.run(run())
    return 0


def main() -> int:
    _anchor()
    if "--check" in sys.argv[1:]:
        return _check()
    server = _load_server()
    logging.getLogger("proofgate.mcp").info("ProofGate MCP server starting (stdio) from %s", REPO)
    server.run("stdio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
