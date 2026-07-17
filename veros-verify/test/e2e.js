const assert = require('assert');
const path = require('path');
const { runSolver } = require('../src/verify');
const { validateBinding } = require('../src/validate');

const buggy = require('../examples/TokenPoolBuggy.binding.json');
const correct = require('../examples/TokenPool.binding.json');

function run() {
  let failures = 0;
  const t = (name, fn) => {
    try { fn(); console.log(`  ✓ ${name}`); }
    catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  };

  console.log('validation');
  t('correct binding validates', () => {
    assert.strictEqual(validateBinding(correct).valid, true);
  });
  t('buggy binding validates (structurally)', () => {
    assert.strictEqual(validateBinding(buggy).valid, true);
  });
  t('rejects unknown effect', () => {
    const bad = JSON.parse(JSON.stringify(correct));
    bad.functions[0].effects.push('bal_teleport');
    assert.strictEqual(validateBinding(bad).valid, false);
  });

  console.log('soundness / Z3 core');
  t('correct contract: all invariants PROVED', () => {
    const r = runSolver(correct);
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.output.verdict, 'proved');
  });
  t('buggy contract: nonneg_balance VIOLATED with counterexample', () => {
    const r = runSolver(buggy);
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.output.verdict, 'violated');
    const withdraw = r.output.functions.find((f) => f.function === 'withdraw');
    const nb = withdraw.results.find((x) => x.invariant === 'nonneg_balance');
    assert.strictEqual(nb.status, 'violated');
    assert.ok(nb.counterexample, 'expected a counterexample');
    assert.ok(Number(nb.counterexample.balance_actor_post) < 0, 'post balance should be negative');
  });

  console.log('reentrancy vocabulary');
  t('reentrancy binding validates', () => {
    const reentrancyBinding = {
      model: "erc20_pool",
      functions: [
        {
          name: "withdraw",
          guards: ["amt_gt_0", "bal_ge_amt", "not_locked"],
          effects: ["reentrancy_lock_acquire", "bal_sub_amt", "total_sub_amt", "external_call", "reentrancy_lock_release"]
        }
      ],
      invariants: ["nonneg_balance", "nonneg_total", "reentrancy_safe"]
    };
    const v = validateBinding(reentrancyBinding);
    assert.strictEqual(v.valid, true, v.errors ? v.errors.join(', ') : '');
  });
  t('reentrancy binding runs through solver', () => {
    const reentrancyBinding = {
      model: "erc20_pool",
      functions: [
        {
          name: "withdraw",
          guards: ["amt_gt_0", "bal_ge_amt", "not_locked"],
          effects: ["reentrancy_lock_acquire", "bal_sub_amt", "total_sub_amt", "external_call", "reentrancy_lock_release"]
        }
      ],
      invariants: ["nonneg_balance", "nonneg_total", "reentrancy_safe"]
    };
    const r = runSolver(reentrancyBinding);
    assert.ok(r.ok, r.error);
    assert.ok(['proved', 'violated'].includes(r.output.verdict),
      `unexpected verdict: ${r.output.verdict}`);
  });

  console.log('diff engine');
  t('diff detects changes between bindings', () => {
    const { diff, generateSuggestedBinding } = require('../src/diff-engine');
    const a = {
      model: "erc20_pool",
      functions: [{ name: "withdraw", guards: ["amt_gt_0"], effects: ["bal_sub_amt"] }],
      invariants: ["nonneg_balance"]
    };
    const b = {
      model: "erc20_pool",
      functions: [{ name: "withdraw", guards: ["amt_gt_0", "bal_ge_amt"], effects: ["bal_sub_amt", "total_sub_amt"] }],
      invariants: ["nonneg_balance", "nonneg_total"]
    };
    const d = diff(a, b);
    assert.ok(Array.isArray(d.differences), 'diff should have a differences array');
    assert.ok(typeof d.summary === 'object', 'diff should have a summary object');
    assert.ok(d.summary.total_functions > 0, 'summary should count functions');
    const s = generateSuggestedBinding(a, b);
    assert.ok(Array.isArray(s.functions), 'should produce a binding with functions');
    assert.ok(s.functions.length > 0, 'merged binding should have functions');
  });

  console.log('echidna gen');
  t('generateEchidnaTest produces valid output', () => {
    const { generateEchidnaTest } = require('../src/echidna-gen');
    const out = generateEchidnaTest(correct);
    assert.ok(typeof out === 'string', 'output should be a string');
    assert.ok(out.includes('echidna_'), 'output should contain echidna_ properties');
    assert.ok(out.includes('contract Echidna'), 'output should contain contract Echidna');
  });

  console.log('foundry export');
  t('renderSolidity produces handler + invariants', () => {
    const { renderSolidity } = require('../src/export-foundry');
    const out = renderSolidity(correct);
    assert.ok(out.handler, 'output should have .handler key');
    assert.ok(out.invariants, 'output should have .invariants key');
    assert.ok(
      out.handler.includes('function invariant_') || out.invariants.includes('function invariant_'),
      'output should contain function invariant_'
    );
  });

  console.log('');
  if (failures) { console.error(`${failures} test(s) failed`); process.exit(1); }
  console.log('all tests passed');
}

run();
