#!/usr/bin/env python3
"""Minimal agent-chat demo (optional).

Talks to a running server (python run.py --serve) over the agent contract:
POST /v1/agent/chat for turns, GET /v1/agent/chat/stream for the live
search -> rank -> verify trace. Standard library only.

Usage:
    python demo_agent.py "Hotel in Goa under Rs 10000, beachfront, free cancellation."
    python demo_agent.py --stream "Laptop under Rs 90000 with 32GB RAM and OLED"
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request

BASE = "http://localhost:8000"


def chat(message: str, session_id: str | None) -> dict:
    payload = {"message": message}
    if session_id:
        payload["session_id"] = session_id
    req = urllib.request.Request(
        f"{BASE}/v1/agent/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        raise SystemExit(1)


def stream(message: str) -> None:
    from urllib.parse import urlencode

    url = f"{BASE}/v1/agent/chat/stream?{urlencode({'message': message})}"
    try:
        with urllib.request.urlopen(url) as resp:
            for raw in resp:
                print(raw.decode(errors='replace').rstrip())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        raise SystemExit(1)


def main() -> int:
    ap = argparse.ArgumentParser(description="ProofGate agent-chat demo")
    ap.add_argument("message", help="what to ask the agent")
    ap.add_argument("--session-id", default=None, help="continue an existing session")
    ap.add_argument("--stream", action="store_true", help="print the SSE trace instead")
    args = ap.parse_args()

    if args.stream:
        stream(args.message)
        return 0

    body = chat(args.message, args.session_id)
    print(f"\n{body.get('reply', '')}")
    if body.get("selected_candidate"):
        cand = body["selected_candidate"]
        print(f"\nmatch: {cand.get('name')} ({cand.get('candidate_id')})")
    print(f"\nsession_id: {body.get('session_id')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
