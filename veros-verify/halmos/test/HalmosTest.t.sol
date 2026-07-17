// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {TokenPool} from "../src/TokenPool.sol";
import {TokenPoolBuggy} from "../src/TokenPoolBuggy.sol";

/// Halmos symbolic tests — BYTECODE-level verification.
///
/// Unlike the abstract Z3 model, these run against the compiled EVM bytecode,
/// closing the spec-vs-implementation gap. Halmos explores ALL inputs
/// symbolically: a passing `check_*` is a bounded proof; a failing one yields
/// concrete counterexample calldata.
///
/// The invariant mirrored here is `nonneg_balance` expressed on unsigned EVM
/// state: after any withdraw, the caller's balance must not have wrapped past
/// its starting value (the underflow signature).
contract HalmosTest {
    /// SAFE: TokenPool.withdraw reverts on insufficient balance, so balance
    /// can never exceed its pre-value after a withdraw. Halmos should PASS.
    function check_TokenPool_withdraw_noUnderflow(uint256 pre, uint256 amt) public {
        TokenPool pool = new TokenPool();
        // Establish symbolic starting balance `pre` via a deposit.
        vm_assume(pre > 0);
        pool.deposit(pre);
        uint256 before = pool.balances(address(this));
        pool.withdraw(amt);
        uint256 after_ = pool.balances(address(this));
        // No underflow/inflation: balance only decreases on withdraw.
        assert(after_ <= before);
    }

    /// BUGGY: TokenPoolBuggy.withdraw uses unchecked math with no balance
    /// check, so `amt > pre` wraps the balance to a huge value. Halmos should
    /// FAIL with a counterexample (amt > pre).
    function check_TokenPoolBuggy_withdraw_noUnderflow(uint256 pre, uint256 amt) public {
        TokenPoolBuggy pool = new TokenPoolBuggy();
        vm_assume(pre > 0);
        pool.deposit(pre);
        uint256 before = pool.balances(address(this));
        pool.withdraw(amt);
        uint256 after_ = pool.balances(address(this));
        assert(after_ <= before);
    }

    /// Halmos recognizes `vm.assume`; we inline a tiny helper to avoid a
    /// forge-std dependency for this self-contained demo.
    function vm_assume(bool c) internal pure {
        if (!c) {
            assembly {
                // halmos: treat an unsatisfiable path as pruned
                revert(0, 0)
            }
        }
    }
}
