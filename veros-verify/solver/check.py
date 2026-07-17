#!/usr/bin/env python3
"""
Counterflow trusted solver entrypoint.

Reads a validated "binding" JSON on stdin, discharges every function/invariant
obligation via Z3 (see models.py), and writes a verdict JSON to stdout.

The binding schema (already validated by the Node layer against the fixed
vocabularies) looks like:

{
  "model": "erc20_pool",
  "functions": [
    {"name": "withdraw", "guards": ["amt_gt_0"], "effects": ["bal_sub_amt","total_sub_amt"]}
  ],
  "invariants": ["nonneg_balance", "nonneg_total"]
}

This process is deterministic and sound: no network, no LLM, no I/O beyond
stdin/stdout. It is the trust anchor of the whole system.
"""
import json
import sys

from models import check_function, GUARDS, EFFECTS, INVARIANTS


def main():
    raw = sys.stdin.read()
    binding = json.loads(raw)

    # Defense in depth: re-validate the vocabulary here too, so the trusted core
    # never relies on the untrusted Node layer having validated correctly.
    invariants = binding.get("invariants", [])
    for inv in invariants:
        if inv not in INVARIANTS:
            print(json.dumps({"error": f"unknown invariant: {inv}"}))
            sys.exit(2)

    func_results = []
    any_violation = False
    any_unknown = False

    for func in binding.get("functions", []):
        for g in func.get("guards", []):
            if g not in GUARDS:
                print(json.dumps({"error": f"unknown guard: {g}"}))
                sys.exit(2)
        for e in func.get("effects", []):
            if e not in EFFECTS:
                print(json.dumps({"error": f"unknown effect: {e}"}))
                sys.exit(2)

        results = check_function(func, invariants)
        for r in results:
            if r["status"] == "violated":
                any_violation = True
            elif r["status"] == "unknown":
                any_unknown = True
        func_results.append({"function": func["name"], "results": results})

    if any_violation:
        verdict = "violated"
    elif any_unknown:
        verdict = "unknown"
    else:
        verdict = "proved"

    print(json.dumps({
        "verdict": verdict,
        "model": binding.get("model"),
        "functions": func_results,
    }, indent=2))


if __name__ == "__main__":
    main()
