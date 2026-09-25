# Eval benchmark

Compares retrieval/ranking strategies against the labeled cases in
`eval/cases.json` and writes fresh measurements to `eval/results.json`.

## Run

From the repo root:

```bash
python -m eval.benchmark --cases eval/cases.json
python -m eval.benchmark --cases eval/cases.json --out eval/results.json
```

No API keys or network access are needed for the offline strategies (A/B).
Strategies C/D are measured live (see below).

## Strategies

- **A — SerpApi top-1 (`serpapi_top`):** takes the first candidate returned
  for the case (i.e. what a plain search would show first). No verification.
- **B — Keyword baseline (`keyword`):** picks the candidate with the most
  query-word hits in its evidence text. Naive baseline only — never used in
  the product path.
- **C — Direct LLM:** asks an LLM to pick a candidate directly, with no
  requirement-level verification. Must be measured live against the same
  cases (LLM answers are not pre-recorded).
- **D — ProofGate (`POST /v1/find-and-verify`):** the full pipeline —
  requirements → SerpApi discovery → LLM ranking → Jev per-requirement
  verification → deterministic VERIFIED / NO VERIFIED MATCH decision.
  Must be measured live via the API on the same cases.

## Metrics (per strategy)

Requirement-satisfaction rate, top-1 correctness (pick ==
`expected_verified`), false-match rate, hard-constraint violation rate
(picking a candidate whose gold label is CONTRADICTED on a required
requirement), verified-match rate, abstention rate, latency, and
optionally cost.

## Numbers are measured, not faked

- Strategies A/B in `eval/results.json` are computed by
  `run_strategy_comparison()` from the gold labels in `eval/cases.json`
  every time the benchmark runs — re-run it to regenerate them.
- Strategies C/D cannot be derived from gold labels; their numbers only
  exist after a real live run (LLM call / API call) on the same cases.
- Never hand-edit `eval/results.json` to insert C/D numbers. If a result
  file contains C/D figures, they must come with the command, timestamp,
  and model/endpoint used to produce them.

## Evaluating agent mode

To evaluate agent chat (`POST /v1/agent/chat`, backed by the same
pipeline), run the same cases through multi-turn sessions instead of
single-shot calls: log each session's streamed trace
(status → requirements → searching → candidates → ranking → verifying →
verdict → final) alongside the final reply, then count outcomes per case as
**verified** (selected candidate VERIFIED on all required), **human-review**
(status `needs_human_review` with flagged points), or **wrong** (any other
pick, including an UNVERIFIED candidate presented as fitting). Agent mode
wins when its verified + abstain/flag rate beats direct-LLM picking on
hard-constraint violations, not on raw top-1 hits.
