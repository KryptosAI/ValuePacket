# <picture><img src="assets/logo.png" height="48" align="left" alt="Counterflow logo"/></picture>Counterflow

> **Prove the contract, or reveal the exploit.**

AI-translated, machine-proved smart contract invariant checking — three layers:

1. **Z3 abstract model** — inductive proofs over a fixed vocabulary (allowances, transfers, vault shares, ghost-sum accounting). 6 benchmark exploit classes, all caught.
2. **Halmos bytecode** — symbolic execution against compiled EVM bytecode, closing the spec-vs-implementation gap.
3. **LLM translation** — Solidity + English → structured binding (the only untrusted layer; never decides the verdict).

**The LLM never decides the verdict.** A ~350-line, human-auditable Z3 core either *proves*
the invariant holds for **all** inputs, or produces a **concrete
counterexample** (an exploit trace). Hallucination is structurally contained:
a bad translation is caught by deterministic vocabulary validation or produces a wrong
model — never a false proof of the trusted core's semantics.

```
Solidity + English invariants
        │
        ▼
  [Slither extraction]     structural AST pass — function selectors, state vars
        │
        ▼
  [LLM translate]          untrusted — DeepSeek/OpenAI, temperature 0
        │
        ▼
  binding.json             human-reviewable artifact (the real spec)
        │
        ▼
  [validate]               deterministic vocabulary/schema gate
        │
        ├─────────────────────────────────────────┬──────────────────────────┐
        ▼                                         ▼                          ▼
  [Z3 inductive check]                   [Halmos bytecode]          [Echidna validation]
   TRUSTED — abstract model              TRUSTED — EVM symbolic exec  fuzzing harness gen
        │                                         │                          │
        ▼                                         ▼                          ▼
  PROVED | VIOLATED (+ cex)              PASS | FAIL (+ cex calldata)   echidna test file
        │                                         │                          │
        └───────────────┬─────────────────────────┴──────────────────────────┘
                        ▼
  audit.jsonl            SHA-256 hash-chained, tamper-evident run log
        │
        ▼
  [Foundry export]        renderSolidity → handler + invariants .sol files
```

## Quickstart

```bash
# —— deterministic (no LLM needed) ——
node src/cli.js check examples/TokenPool.binding.json           # PROVED
node src/cli.js check examples/TokenPoolBuggy.binding.json      # VIOLATED + exploit

# —— full AI pipeline (needs DEEPSEEK_API_KEY or OPENAI_API_KEY) ——
node src/cli.js verify examples/TokenPoolBuggy.sol examples/invariants.txt

# —— two-step, human-in-the-loop (recommended) ——
node src/cli.js extract examples/TokenPool.sol examples/invariants.txt -o binding.json
# review binding.json ...
node src/cli.js check binding.json

# —— bytecode-level (needs foundry + halmos) ——
pip install z3-solver halmos    # or use project .venv
node src/cli.js bytecode HalmosTest

# —— everything ——
npm run all

# —— audit chain ——
node src/cli.js audit
```

Requires Node >= 18, Python 3 with `z3-solver` and `halmos`, and [Foundry](https://getfoundry.sh/) (`brew install foundry`). Set `COUNTERFLOW_PYTHON` to a venv python if needed.

## Audit Binding

```bash
# —— audit-binding: review & compare binding snapshots ——
node src/cli.js audit-binding binding.json       # show binding structure & validation
node src/cli.js audit-binding a.json b.json      # diff two bindings side-by-side
```

Audit-binding loads one or two binding files and produces a human-readable summary:
- Validates the binding vocabulary and schema
- Lists all functions, guards, effects, and invariants
- When given two bindings, computes a structural diff showing added/removed/changed
  functions, guards, effects, and invariants
- Useful in CI to detect unintended binding drift across revisions

## Export

```bash
# —— generate Echidna fuzzing harness ——
node src/cli.js gen-echidna binding.json > EchidnaTest.sol
# produces: contract EchidnaBindingTest with echidna_ prefixed properties

# —— generate Foundry invariant test files ——
node src/cli.js gen-foundry binding.json -o foundry-tests/
# produces: handler .sol + invariants .sol with function invariant_ stubs
```

Export commands generate derivative artifacts from a binding:
- **Echidna**: produces a standalone Solidity file with `echidna_`-prefixed property
  functions ready for `echidna-test`. Each invariant becomes an Echidna property.
- **Foundry**: produces `{Model}Handler.sol` (actor management) and
  `{Model}Invariants.sol` (per-invariant `function invariant_*` stubs) for use
  with `forge test` invariant testing.

## DeFiHackLabs Benchmark

The defihack runner executes Counterflow against the
[DeFiHackLabs](https://github.com/SunWeb3Sec/DeFiHackLabs) exploit corpus:

```bash
node bench/defihack.js                    # run all cases
node bench/defihack.js --case cream-finance  # single case
```

Each case:
1. Loads the Solidity source and English invariants from the corpus
2. Runs LLM translation → binding validation → Z3 proof
3. Compares the verdict against the known exploit label
4. Produces a per-case report (contract, invariants, verdict, counterexample)

This validates that the pipeline catches real-world DeFi exploits, not just
synthetic examples. Current coverage includes CREAM Finance, Hundred Finance,
and other high-profile incidents.

## Benchmark

```
npm run bench
# or: npm run all  (includes e2e tests + bytecode check)

6/6 cases correct:

  TokenPool (safe)                        PROVED      [reference]
  TokenPoolBuggy (missing balance check)  VIOLATED    [underflow-drain]
  SafeVault (safe)                        PROVED      [reference]
  ApprovalDrain (transferFrom no check)   VIOLATED    [approval-drain]
  UnbackedMintVault (owner infinite mint) VIOLATED    [unbacked-mint]
  BurnDesyncVault (totalShares desync)    VIOLATED    [accounting-desync]

Bytecode: Halmos symbolic test
  ✓ TokenPool withdraw no underflow       PASS
  ✗ TokenPoolBuggy withdraw no underflow  FAIL (amt > pre counterexample)
```

## State model (v2)

| Vocabulary | Covers |
|---|---|
| `balances[a]`, `shares[a]`, `allowances[a]` | ERC20 + ERC4626 + approvals |
| `totalAssets`, `totalShares` | pool totals |
| ghost sums: `sumBalances`, `sumShares` | exact accounting integrity |
| 9 invariants | nonneg_balance/shares/allowance/total/total_shares, solvency, shares_integrity, backing, supply_cap |
| 9 guards, 13 effects | deposit/withdraw/mint/burn/transfer/transferFrom/approve |

### Reentrancy

The reentrancy vocabulary models the standard check-effects-interaction pattern
with a reentrancy lock:

| Vocabulary | Covers |
|---|---|
| guard `not_locked` | `require(!locked)` — the function's reentrancy lock is free |
| effect `reentrancy_lock_acquire` | `locked = true` |
| effect `reentrancy_lock_release` | `locked = false` |
| effect `external_call` | marker for an external call — snapshots state for reentrancy checks |
| invariant `reentrancy_safe` | if in external call, storage (total, sumBalances) has not changed since the snapshot |

A properly modeled withdraw with reentrancy:

```json
{
  "name": "withdraw",
  "guards": ["amt_gt_0", "bal_ge_amt", "not_locked"],
  "effects": ["reentrancy_lock_acquire", "bal_sub_amt", "total_sub_amt",
              "external_call", "reentrancy_lock_release"]
}
```

The Z3 core tracks per-function locks, an `in_call` flag, and storage snapshots
taken at the `external_call` point. The `reentrancy_safe` invariant is violated if
any state variable changes between the snapshot and the end of the call — catching
cross-function reentrancy even when locks appear to be used.

## What a verdict means (read this)

- **PROVED** — the modeled transition preserves the invariant for *all*
  possible inputs and states (an inductive proof over the reviewed binding).
  It is **not** a claim that the contract is "safe": the binding is an
  abstraction and must be reviewed; bytecode verification closes the gap.
- **VIOLATED** — Z3 or Halmos found a concrete counterexample.
- **UNKNOWN** — the solver could not decide within limits. Nothing is claimed.

## Open core

MIT-licensed: CLI, translation prompts, validation, the trusted Z3 core,
Halmos symbolic tests, and example bindings. Commercial layer (separate):
hosted pipeline, CI integration, dashboards, proof storage, multi-contract
projects.

## Roadmap

- CVL export for Certora interop
- Richer state model: reentrancy flags, compound interest/accrual
- L2/bridge message verification targets
- Public leaderboard of verified contracts
