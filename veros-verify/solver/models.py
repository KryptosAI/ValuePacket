"""
Trusted semantic core for Counterflow.

This module is the SOUND, HUMAN-AUDITED part of the pipeline. The LLM never
decides a verdict; it only emits a structured abstraction (a "binding") drawn
from the fixed vocabularies below.

State model (generic ERC20-style pool / ERC4626-style vault):
    totalAssets  : Int                 -- pool-wide asset accounting total
    totalShares  : Int                 -- vault share supply
    balances     : Array(Int,Int)      -- per-address token claim
    shares       : Array(Int,Int)      -- per-address vault shares
    allowances   : Array(Int,Int)      -- allowance[src -> actor] (spender = actor)
    sumBalances  : Int (ghost)         -- Σ balances, mirrored exactly by effects
    sumShares    : Int (ghost)         -- Σ shares,   mirrored exactly by effects

Actors: actor (msg.sender), to (recipient), src (transferFrom source),
owner (privileged address). All symbolic.

Soundness notes
---------------
1. Ghost sums are sound: sum(Store(b, i, b[i] ± k)) = sum(b) ± k, so mirroring
   every single-entry update onto the ghost is exact, not an approximation.
2. Quantified invariants (nonneg_*) use a ForAll hypothesis and are checked in
   the post-state at every index a transition can touch (actor, to, src) —
   untouched indices retain their values, so this is sound.
3. Background axiom: if all entries are non-negative then each entry is at
   most the sum. True in every concrete state of the intended semantics, so
   assuming it (instantiated at touched indices) is sound.
4. The inductive hypothesis assumes the FULL CONJUNCTION of the selected
   invariants in the pre-state.
"""

from z3 import (
    Int, Array, IntSort, Select, Store, ForAll, Implies, And, Not,
    Solver, sat, unsat, IntVal, K,
)

CAP = 1_000_000_000  # example supply cap used by supply_cap invariant

GUARDS = {
    "amt_gt_0",           # require(amt > 0)
    "bal_ge_amt",         # require(balances[actor] >= amt)
    "bal_gt_0",           # require(balances[actor] > 0)
    "total_ge_amt",       # require(totalAssets >= amt)
    "sender_is_owner",    # require(actor == owner)
    "bal_src_ge_amt",     # require(balances[src] >= amt)
    "allowance_ge_amt",   # require(allowances[src -> actor] >= amt)
    "shares_ge_amt",      # require(shares[actor] >= amt)
    "total_shares_ge_amt", # require(totalShares >= amt)
    "not_locked",          # require(locks[func_id] == 0)
    "balance_unchanged_before_call",  # require(snapshot_sum_bal == sumBalances)
}

EFFECTS = {
    "bal_add_amt",          # balances[actor] += amt        (ghost: sumBalances += amt)
    "bal_sub_amt",          # balances[actor] -= amt        (ghost: sumBalances -= amt)
    "bal_add_amt_to",       # balances[to]    += amt        (ghost: sumBalances += amt)
    "bal_sub_amt_src",      # balances[src]   -= amt        (ghost: sumBalances -= amt)
    "set_bal_zero",         # balances[actor]  = 0          (ghost: sumBalances -= old)
    "total_add_amt",        # totalAssets += amt
    "total_sub_amt",        # totalAssets -= amt
    "shares_add_amt",       # shares[actor] += amt          (ghost: sumShares += amt)
    "shares_sub_amt",       # shares[actor] -= amt          (ghost: sumShares -= amt)
    "total_shares_add_amt", # totalShares += amt
    "total_shares_sub_amt", # totalShares -= amt
    "allowance_sub_amt",    # allowances[src] -= amt
    "allowance_set_zero",   # allowances[src]  = 0
    "reentrancy_lock_acquire",    # locks[func_id] = 1
    "reentrancy_lock_release",    # locks[func_id] = 0, in_call = 0
    "external_call",              # snapshot storage, in_call = 1
}

INVARIANTS = {
    "nonneg_balance",    # forall u: balances[u]   >= 0
    "nonneg_shares",     # forall u: shares[u]     >= 0
    "nonneg_allowance",  # forall u: allowances[u] >= 0
    "nonneg_total",      # totalAssets  >= 0
    "nonneg_total_shares",  # totalShares >= 0
    "solvency",          # sumBalances == totalAssets   (accounting integrity)
    "shares_integrity",  # sumShares   == totalShares
    "backing",           # totalAssets >= totalShares   (1:1-backed vault)
    "supply_cap",        # totalAssets <= CAP
    "reentrancy_safe",   # if in_call then storage == snapshot
}


class State:
    def __init__(self, total, total_shares, bal, shr, allow, sum_bal, sum_shr,
                 locks=None, in_call=None, snapshot_total=None, snapshot_sum_bal=None):
        self.total = total
        self.total_shares = total_shares
        self.bal = bal
        self.shr = shr
        self.allow = allow
        self.sum_bal = sum_bal
        self.sum_shr = sum_shr
        self.locks = locks if locks is not None else K(IntSort(), IntVal(0))
        self.in_call = in_call if in_call is not None else IntVal(0)
        self.snapshot_total = snapshot_total if snapshot_total is not None else IntVal(0)
        self.snapshot_sum_bal = snapshot_sum_bal if snapshot_sum_bal is not None else IntVal(0)


def _apply_guards(guard_names, s, actor, to, src, owner, amt, func_id=0):
    conds = []
    for g in guard_names:
        if g == "amt_gt_0":
            conds.append(amt > 0)
        elif g == "bal_ge_amt":
            conds.append(Select(s.bal, actor) >= amt)
        elif g == "bal_gt_0":
            conds.append(Select(s.bal, actor) > 0)
        elif g == "total_ge_amt":
            conds.append(s.total >= amt)
        elif g == "sender_is_owner":
            conds.append(actor == owner)
        elif g == "bal_src_ge_amt":
            conds.append(Select(s.bal, src) >= amt)
        elif g == "allowance_ge_amt":
            conds.append(Select(s.allow, src) >= amt)
        elif g == "shares_ge_amt":
            conds.append(Select(s.shr, actor) >= amt)
        elif g == "total_shares_ge_amt":
            conds.append(s.total_shares >= amt)
        elif g == "not_locked":
            conds.append(Select(s.locks, func_id) == 0)
        elif g == "balance_unchanged_before_call":
            conds.append(s.snapshot_sum_bal == s.sum_bal)
        else:
            raise ValueError(f"unknown guard: {g}")
    return conds


def _apply_effects(effect_names, s, actor, to, src, amt, func_id=0):
    total, total_shares = s.total, s.total_shares
    bal, shr, allow = s.bal, s.shr, s.allow
    sum_bal, sum_shr = s.sum_bal, s.sum_shr
    locks, in_call = s.locks, s.in_call
    snapshot_total, snapshot_sum_bal = s.snapshot_total, s.snapshot_sum_bal
    for e in effect_names:
        if e == "bal_add_amt":
            bal = Store(bal, actor, Select(bal, actor) + amt)
            sum_bal = sum_bal + amt
        elif e == "bal_sub_amt":
            bal = Store(bal, actor, Select(bal, actor) - amt)
            sum_bal = sum_bal - amt
        elif e == "bal_add_amt_to":
            bal = Store(bal, to, Select(bal, to) + amt)
            sum_bal = sum_bal + amt
        elif e == "bal_sub_amt_src":
            bal = Store(bal, src, Select(bal, src) - amt)
            sum_bal = sum_bal - amt
        elif e == "set_bal_zero":
            sum_bal = sum_bal - Select(bal, actor)
            bal = Store(bal, actor, IntVal(0))
        elif e == "total_add_amt":
            total = total + amt
        elif e == "total_sub_amt":
            total = total - amt
        elif e == "shares_add_amt":
            shr = Store(shr, actor, Select(shr, actor) + amt)
            sum_shr = sum_shr + amt
        elif e == "shares_sub_amt":
            shr = Store(shr, actor, Select(shr, actor) - amt)
            sum_shr = sum_shr - amt
        elif e == "total_shares_add_amt":
            total_shares = total_shares + amt
        elif e == "total_shares_sub_amt":
            total_shares = total_shares - amt
        elif e == "allowance_sub_amt":
            allow = Store(allow, src, Select(allow, src) - amt)
        elif e == "allowance_set_zero":
            allow = Store(allow, src, IntVal(0))
        elif e == "reentrancy_lock_acquire":
            locks = Store(locks, func_id, IntVal(1))
        elif e == "reentrancy_lock_release":
            locks = Store(locks, func_id, IntVal(0))
            in_call = IntVal(0)
        elif e == "external_call":
            snapshot_total = total
            snapshot_sum_bal = sum_bal
            in_call = IntVal(1)
        else:
            raise ValueError(f"unknown effect: {e}")
    return State(total, total_shares, bal, shr, allow, sum_bal, sum_shr,
                 locks=locks, in_call=in_call, snapshot_total=snapshot_total,
                 snapshot_sum_bal=snapshot_sum_bal)


def _hypothesis(name, s):
    """Invariant as an assumption over the (quantified) pre-state."""
    u = Int("u")
    if name == "nonneg_balance":
        return ForAll([u], Select(s.bal, u) >= 0)
    if name == "nonneg_shares":
        return ForAll([u], Select(s.shr, u) >= 0)
    if name == "nonneg_allowance":
        return ForAll([u], Select(s.allow, u) >= 0)
    if name == "nonneg_total":
        return s.total >= 0
    if name == "nonneg_total_shares":
        return s.total_shares >= 0
    if name == "solvency":
        return s.sum_bal == s.total
    if name == "shares_integrity":
        return s.sum_shr == s.total_shares
    if name == "backing":
        return s.total >= s.total_shares
    if name == "supply_cap":
        return s.total <= CAP
    if name == "reentrancy_safe":
        return Implies(s.in_call != 0, And(s.total == s.snapshot_total,
                                           s.sum_bal == s.snapshot_sum_bal))
    raise ValueError(f"unknown invariant: {name}")


def _goal(name, s, touched):
    """Invariant as a post-state goal, instantiated at every touched index."""
    if name == "nonneg_balance":
        return And([Select(s.bal, i) >= 0 for i in touched])
    if name == "nonneg_shares":
        return And([Select(s.shr, i) >= 0 for i in touched])
    if name == "nonneg_allowance":
        return And([Select(s.allow, i) >= 0 for i in touched])
    return _hypothesis(name, s)  # scalar invariants: goal == formula


def check_function(func, invariants):
    """Inductively check that `func` preserves each invariant.

    VC (per invariant I):  ALL(pre) AND guards AND (post = effects(pre)) => I(post)
    Z3 searches the NEGATION: unsat => proved; sat => counterexample.
    """
    results = []
    func_id_val = IntVal(func.get("func_id", 0))
    for inv in invariants:
        actor, to, src, owner, amt = Int("actor"), Int("to"), Int("src"), Int("owner"), Int("amt")
        pre = State(
            Int("totalAssets_pre"), Int("totalShares_pre"),
            Array("balances_pre", IntSort(), IntSort()),
            Array("shares_pre", IntSort(), IntSort()),
            Array("allowances_pre", IntSort(), IntSort()),
            Int("sumBalances_pre"), Int("sumShares_pre"),
            locks=Array("locks_pre", IntSort(), IntSort()),
            in_call=Int("in_call_pre"),
            snapshot_total=Int("snapshot_total_pre"),
            snapshot_sum_bal=Int("snapshot_sum_bal_pre"),
        )
        touched = [actor, to, src]

        base = [actor >= 0, to >= 0, src >= 0, owner >= 0]
        # Inductive hypothesis: full conjunction of the selected invariants.
        for hyp in invariants:
            base.append(_hypothesis(hyp, pre))
        # Background axiom (see module docstring, note 3), instantiated at
        # touched indices: nonneg entries => each entry <= its ghost sum.
        u = Int("u")
        base.append(Implies(
            ForAll([u], Select(pre.bal, u) >= 0),
            And([Select(pre.bal, i) <= pre.sum_bal for i in touched]),
        ))
        base.append(Implies(
            ForAll([u], Select(pre.shr, u) >= 0),
            And([Select(pre.shr, i) <= pre.sum_shr for i in touched]),
        ))

        guards = _apply_guards(func["guards"], pre, actor, to, src, owner, amt, func_id_val)
        post = _apply_effects(func["effects"], pre, actor, to, src, amt, func_id_val)

        s = Solver()
        s.add(base)
        s.add(guards)
        s.add(Not(_goal(inv, post, touched)))

        res = s.check()
        if res == unsat:
            results.append({"invariant": inv, "status": "proved", "counterexample": None})
        elif res == sat:
            m = s.model()
            ev = lambda t: str(m.eval(t, model_completion=True))
            cex = {
                "actor": ev(actor), "to": ev(to), "src": ev(src), "amt": ev(amt),
                "totalAssets_pre": ev(pre.total), "totalAssets_post": ev(post.total),
                "totalShares_pre": ev(pre.total_shares), "totalShares_post": ev(post.total_shares),
                "balance_actor_pre": ev(Select(pre.bal, actor)),
                "balance_actor_post": ev(Select(post.bal, actor)),
                "balance_to_post": ev(Select(post.bal, to)),
                "balance_src_post": ev(Select(post.bal, src)),
                "shares_actor_pre": ev(Select(pre.shr, actor)),
                "shares_actor_post": ev(Select(post.shr, actor)),
                "allowance_src_pre": ev(Select(pre.allow, src)),
                "allowance_src_post": ev(Select(post.allow, src)),
            }
            results.append({"invariant": inv, "status": "violated", "counterexample": cex})
        else:
            results.append({"invariant": inv, "status": "unknown", "counterexample": None})
    return results
