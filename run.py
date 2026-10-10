#!/usr/bin/env python3
"""First working demo CLI.

Usage:
    python run.py "Find me the best hotel in Goa under Rs 10000 for 2 people, beachfront, breakfast included and free cancellation."
    python run.py --action book_hotel "request..."
    python run.py --serve   # start API server
"""
from __future__ import annotations

import argparse
import os
import sys

from app.config import load_settings


def print_report(rec) -> None:
    print(f"\n{rec.candidate_count} candidates found")
    print("\nLLM ranking:")
    by_id = {c.candidate_id: c for c in rec.candidates}
    for rc in rec.ranked_candidates:
        name = by_id.get(rc.candidate_id).name if rc.candidate_id in by_id else rc.candidate_id
        print(f"{rc.rank}. {name}  ({rc.candidate_id}) — {rc.reason[:100]}")
    for att in rec.attempts:
        v = att.verification
        cname = att.candidate_name or att.candidate_id
        print(f"\nChecking {cname}...")
        print()
        for rv in v.requirements:
            print(f"{rv.requirement_id:22s} {rv.status}")
            if rv.reason:
                print(f"  ↳ {rv.reason[:140]}")
        print(f"\n{cname} → {v.overall_status}")
    print("\n" + ("=" * 40))
    if rec.status == "verified" and rec.selected_candidate:
        print(f"FINAL MATCH:\n{rec.selected_candidate.name}")
        print(f"  price: {rec.selected_candidate.price}  rating: {rec.selected_candidate.rating}")
        print(f"  url: {rec.selected_candidate.source_url}")
    elif rec.status == "needs_human_review" and rec.selected_candidate:
        print("NO VERIFIED CANDIDATE — best match returned for HUMAN REVIEW.")
        print(f"BEST MATCH (NOT verified):\n{rec.selected_candidate.name}")
        print(f"  price: {rec.selected_candidate.price}  rating: {rec.selected_candidate.rating}")
        print(f"  url: {rec.selected_candidate.source_url}")
        if rec.verification:
            print(f"\nCandidate status: {rec.verification.overall_status}")
            print("Flagged points a human must confirm:")
            for rv in rec.verification.requirements:
                if rv.status != "SATISFIED":
                    print(f"  ! {rv.requirement_id:22s} {rv.status} — {rv.reason[:140]}")
        print("\n⚠ Do NOT treat this as verified. Confirm the flagged points before acting.")
    elif rec.status == "no_verified_match":
        print("NO VERIFIED MATCH.")
        print("No candidate in the retrieved/ranked set could be verified against the required constraints.")
        print("(This does NOT mean no such match exists on the internet.)")
    if rec.errors:
        print("\nnotes:", "; ".join(rec.errors))
    print(f"\nrun_id: {rec.run_id} (persisted to SQLite)")


def main() -> int:
    ap = argparse.ArgumentParser(description="ProofGate demo CLI")
    ap.add_argument("request", nargs="?", help="natural-language request")
    ap.add_argument("--action", default="search")
    ap.add_argument("--max-candidates", type=int, default=10)
    ap.add_argument("--serve", action="store_true", help="start API server instead")
    ap.add_argument("--host", default=os.environ.get("PROOFGATE_HOST", "127.0.0.1"),
                    help="bind address (env PROOFGATE_HOST; default 127.0.0.1 = this machine only)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT") or os.environ.get("PROOFGATE_PORT") or 8000),
                    help="port (env PORT or PROOFGATE_PORT; default 8000)")
    args = ap.parse_args()

    if args.serve:
        import uvicorn
        reload = os.environ.get("PROOFGATE_RELOAD", "1") != "0"   # set PROOFGATE_RELOAD=0 when deploying
        uvicorn.run("app.main:app", host=args.host, port=args.port, reload=reload)
        return 0

    if not args.request:
        ap.print_help()
        return 2

    from app.services.pipeline import run_find_and_verify
    settings = load_settings()
    try:
        rec = run_find_and_verify(args.request, args.action, settings, args.max_candidates)
    except RuntimeError as e:
        print(f"SYSTEM ERROR (upstream failure, not a verification): {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"SYSTEM ERROR: {e}", file=sys.stderr)
        return 1
    print_report(rec)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
