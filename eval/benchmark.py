"""Evaluation harness (§19): compare SerpApi-top vs keyword vs direct-LLM vs ProofGate.

Real measurements on a labeled test set — no faked numbers.
Each case: request + requirements + candidates with per-requirement gold labels.

    python -m eval.benchmark --cases eval/cases.json

Metrics per strategy: requirement satisfaction, top-1 correctness,
false-match rate, hard-constraint violation rate, verified-match rate,
abstention rate, latency, (optional) cost.
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class EvalCase:
    request: str
    requirements: list[dict]
    candidates: list[dict]  # each: {candidate_id, name, evidence fields..., gold: {req_id: SATISFIED|CONTRADICTED|UNKNOWN}}
    expected_verified: str | None = None  # candidate_id expected, None = expect abstention


def load_cases(path: str) -> list[EvalCase]:
    data = json.loads(Path(path).read_text())
    return [EvalCase(**c) for c in data]


def gold_status(req_importance: dict[str, str], gold: dict[str, str]) -> str:
    for rid, imp in req_importance.items():
        if imp == "required":
            s = gold.get(rid, "UNKNOWN")
            if s == "CONTRADICTED":
                return "REJECTED"
    for rid, imp in req_importance.items():
        if imp == "required" and gold.get(rid, "UNKNOWN") == "UNKNOWN":
            return "UNVERIFIED"
    return "VERIFIED"


def keyword_pick(case: EvalCase) -> str | None:
    """Naive baseline: most query-word hits in evidence text. (Baseline only —
    never used in the product path.)"""
    words = [w.lower() for w in case.request.split() if len(w) > 3]
    best, best_s = None, -1
    for c in case.candidates:
        blob = json.dumps(c).lower()
        s = sum(blob.count(w) for w in words)
        if s > best_s:
            best, best_s = c["candidate_id"], s
    return best


def run_strategy_comparison(cases: list[EvalCase]) -> dict:
    """Offline comparison using GOLD labels as a perfect verifier (measures
    ranking quality). Live ProofGate runs are measured separately via the API."""
    rows = []
    for case in cases:
        imp = {r["id"]: r.get("importance", "required") for r in case.requirements}
        # A: serpapi top = first candidate
        a_pick = case.candidates[0]["candidate_id"] if case.candidates else None
        # B: keyword baseline
        b_pick = keyword_pick(case)
        for label, pick in (("serpapi_top", a_pick), ("keyword", b_pick)):
            gold = next((c.get("gold", {}) for c in case.candidates if c["candidate_id"] == pick), {})
            status = gold_status(imp, gold)
            rows.append({"case": case.request[:60], "strategy": label, "pick": pick,
                         "gold_status": status,
                         "hard_violation": status == "REJECTED",
                         "correct": pick == case.expected_verified})
    summary: dict = {"rows": rows}
    for label in ("serpapi_top", "keyword"):
        sub = [r for r in rows if r["strategy"] == label]
        n = max(len(sub), 1)
        summary[label] = {
            "n": len(sub),
            "top1_correct_rate": sum(r["correct"] for r in sub) / n,
            "hard_violation_rate": sum(r["hard_violation"] for r in sub) / n,
        }
    summary["note"] = ("Offline gold-label comparison for ranking baselines. "
                       "Strategies C (direct LLM) and D (ProofGate) must be measured live "
                       "via POST /v1/find-and-verify on the same cases; see eval/README.")
    return summary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default="eval/cases.json")
    ap.add_argument("--out", default="eval/results.json")
    args = ap.parse_args()
    t0 = time.perf_counter()
    cases = load_cases(args.cases)
    summary = run_strategy_comparison(cases)
    summary["elapsed_ms"] = int((time.perf_counter() - t0) * 1000)
    Path(args.out).write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
