#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { verify, pickPython } = require('./verify');
const { render } = require('./report');
const { translate } = require('./translate');
const { validateBinding } = require('./validate');
const { verifyChain, LOG_PATH } = require('./audit');
const { runHalmos } = require('./halmos-runner');
const { diff: diffBindings } = require('./diff-engine');
const { runFuzzThenSymbolic } = require('./forge-symb');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

function bytecodeReport(results) {
  const lines = [];
  for (const r of results) {
    const mark = r.passed ? `${C.green}✓ PASS${C.reset}` : `${C.red}✗ FAIL${C.reset}`;
    lines.push(`  ${mark}  ${r.name}`);
    if (r.counterexample && Object.keys(r.counterexample).length > (r.counterexample.raw ? 1 : 0)) {
      lines.push(`    ${C.dim}cex:${C.reset} ${JSON.stringify(r.counterexample)}`);
    }
  }
  return lines.join('\n');
}

const USAGE = `Counterflow — Prove the contract, or reveal the exploit.

USAGE
  counterflow verify        <Contract.sol> <invariants.txt> [--binding binding.json] [--json]
  counterflow extract       <Contract.sol> <invariants.txt> [-o binding.json]
  counterflow check         <binding.json> [--json]
  counterflow bytecode      <TestContract> [--json]
  counterflow bench         [--json]
  counterflow audit
  counterflow audit-binding <Contract.sol> [--binding binding.json] [--json]
  counterflow gen-echidna   <binding.json> [--contract-name Name] [--output-dir path]
  counterflow gen-foundry   <binding.json> [--contract-name Name] [--output-dir path]
  counterflow fuzz-symb     <ContractName> [--test TestGlob]

COMMANDS
  verify         Full pipeline: LLM translation -> validation -> sound Z3 verdict.
                 Pass --binding to skip the LLM and use a human-reviewed binding.
  extract        LLM translation only. Writes the binding JSON for human review.
  check          Deterministic verification of a reviewed binding (no LLM, no network).
  bytecode       Halmos symbolic execution against EVM bytecode (closes the
                 spec-vs-implementation gap). Run '*' for all tests.
  bench          Run all benchmark cases (binding models + halmos bytecode + defihack).
  audit          Verify the tamper-evident audit chain.
  audit-binding  Cross-validate an LLM binding against Slither AST extraction.
                 Pass --binding to diff against an existing binding.
  gen-echidna    Generate an Echidna fuzzing test contract + config from a binding.
  gen-foundry    Generate Foundry invariant test files (handler + invariants) from a binding.
  fuzz-symb      Run Foundry fuzz, promote counterexamples to Halmos symbolic execution.

WHAT A VERDICT MEANS
  PROVED    = the modeled transition preserves the invariant for ALL inputs
              (inductive proof over the reviewed abstraction — not a claim
              that the contract is "safe").
  VIOLATED  = Z3 found a concrete counterexample (a real trace in the model).
  UNKNOWN   = solver could not decide within limits.`;

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const cmd = process.argv[2];
  const json = process.argv.includes('--json');

  if (cmd === 'verify') {
    const contractPath = process.argv[3];
    const invPath = process.argv[4];
    if (!contractPath || !invPath) { console.log(USAGE); process.exit(1); }
    const bindingPath = arg('--binding');
    const binding = bindingPath ? JSON.parse(fs.readFileSync(bindingPath, 'utf-8')) : undefined;
    const result = await verify({
      contractPath,
      invariantsText: fs.readFileSync(invPath, 'utf-8'),
      binding,
    });
    console.log(json ? JSON.stringify(result, null, 2) : render(result));
    process.exit(result.verdict === 'proved' ? 0 : result.verdict === 'violated' ? 3 : 2);
  }

  if (cmd === 'extract') {
    const contractPath = process.argv[3];
    const invPath = process.argv[4];
    if (!contractPath || !invPath) { console.log(USAGE); process.exit(1); }
    const out = arg('-o') || 'binding.json';
    const t = await translate(
      fs.readFileSync(contractPath, 'utf-8'),
      fs.readFileSync(invPath, 'utf-8'),
    );
    if (!t.binding) { console.error(`extract failed: ${t.error}`); process.exit(2); }
    const v = validateBinding(t.binding);
    fs.writeFileSync(out, JSON.stringify(t.binding, null, 2) + '\n');
    console.log(`binding written to ${out} (valid: ${v.valid}${v.valid ? '' : '; errors: ' + v.errors.join(', ')})`);
    console.log('REVIEW THIS FILE before running `counterflow check` — the binding is the trusted spec.');
    process.exit(v.valid ? 0 : 2);
  }

  if (cmd === 'check') {
    const bindingPath = process.argv[3];
    if (!bindingPath) { console.log(USAGE); process.exit(1); }
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf-8'));
    const result = await verify({
      contractPath: bindingPath,
      soliditySource: JSON.stringify(binding),
      invariantsText: '(pre-reviewed binding)',
      binding,
    });
    console.log(json ? JSON.stringify(result, null, 2) : render(result));
    process.exit(result.verdict === 'proved' ? 0 : result.verdict === 'violated' ? 3 : 2);
  }

  if (cmd === 'bytecode') {
    const testGlob = process.argv[3] || '*';
    const res = runHalmos(testGlob);
    if (!res.ok) { console.error(`halmos error: ${res.error}`); process.exit(2); }
    console.log(json ? JSON.stringify(res.results, null, 2) : bytecodeReport(res.results));
    const failed = res.results.some(r => !r.passed);
    process.exit(failed ? 3 : 0);
  }

  if (cmd === 'bench') {
    const { spawnSync } = require('child_process');
    let exitCode = 0;

    const r1 = spawnSync('node', [path.join(__dirname, '..', 'bench', 'run.js')], { encoding: 'utf-8', stdio: 'inherit' });
    if ((r1.status || 0) !== 0) exitCode = 3;
    console.log('');

    const bc = runHalmos('*');
    console.log(`${C.bold}Halmos bytecode check${C.reset}`);
    console.log(bytecodeReport(bc.ok ? bc.results : []));
    if (bc.error) console.log(`  ${C.red}${bc.error}${C.reset}`);
    if (!bc.ok || bc.results.some(r => !r.passed)) exitCode = 3;
    console.log('');

    const dhPath = path.join(__dirname, '..', 'bench', 'defihack', 'runner.js');
    if (fs.existsSync(dhPath)) {
      const r2 = spawnSync('node', [dhPath], { encoding: 'utf-8', stdio: 'inherit' });
      if ((r2.status || 0) !== 0) exitCode = 3;
    } else {
      console.log(`${C.yellow}defihack runner not found at ${dhPath}${C.reset}`);
    }
    process.exit(exitCode);
  }

  if (cmd === 'audit') {
    const r = verifyChain();
    console.log(JSON.stringify({ ...r, log: LOG_PATH }, null, 2));
    process.exit(r.valid ? 0 : 2);
  }

  if (cmd === 'audit-binding') {
    const { spawnSync } = require('child_process');
    const contractPath = process.argv[3];
    if (!contractPath) { console.log(USAGE); process.exit(1); }
    const bindingPath = arg('--binding');

    const python = pickPython();
    const extractScript = path.join(__dirname, '..', 'slither', 'extract_binding.py');
    if (!fs.existsSync(extractScript)) {
      console.error(`${C.red}extract_binding.py not found${C.reset}`);
      process.exit(2);
    }

    const pyRes = spawnSync(python || 'python3', [extractScript, contractPath], { encoding: 'utf-8' });
    if (pyRes.status !== 0) {
      const stderr = (pyRes.stderr || '').trim();
      if (stderr.includes('slither not installed') || stderr.includes('No module named')) {
        console.log(`${C.red}slither not installed: pip install slither-analyzer${C.reset}`);
        process.exit(2);
      }
      console.error(`${C.red}slither error:${C.reset} ${stderr || 'unknown error'}`);
      process.exit(2);
    }

    let slitherBinding;
    try {
      slitherBinding = JSON.parse(pyRes.stdout);
    } catch {
      console.error(`${C.red}could not parse slither output${C.reset}`);
      process.exit(2);
    }

    if (!bindingPath) {
      console.log(json ? JSON.stringify(slitherBinding, null, 2) : JSON.stringify(slitherBinding, null, 2));
      process.exit(0);
    }

    const providedBinding = JSON.parse(fs.readFileSync(bindingPath, 'utf-8'));
    const diffResult = diffBindings(providedBinding, slitherBinding, contractPath);

    if (diffResult.differences.length === 0) {
      console.log(`${C.green}No differences — binding matches Slither extraction.${C.reset}`);
      if (json) console.log(JSON.stringify(diffResult, null, 2));
      process.exit(0);
    }

    console.log(`${C.yellow}Differences found:${C.reset}`);
    for (const d of diffResult.differences) {
      const fnLabel = d.function ? `[${d.function}] ` : '';
      console.log(`  ${C.red}✗${C.reset} ${fnLabel}${d.message}`);
    }
    console.log(json ? JSON.stringify(diffResult, null, 2) : '');
    process.exit(3);
  }

  if (cmd === 'gen-echidna') {
    const bindingPath = process.argv[3];
    if (!bindingPath) { console.log(USAGE); process.exit(1); }
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf-8'));
    const contractName = arg('--contract-name') || binding.model || 'Contract';
    const outputDir = path.resolve(arg('--output-dir') || './echidna-output');
    fs.mkdirSync(outputDir, { recursive: true });

    const echidna = require('./echidna-gen');
    const sol = echidna.generateEchidnaTest(binding, contractName);
    const yaml = echidna.generateEchidnaConfig(binding);
    const solFile = path.join(outputDir, `Echidna${contractName}.sol`);
    const cfgFile = path.join(outputDir, 'echidna.yaml');
    fs.writeFileSync(solFile, sol);
    fs.writeFileSync(cfgFile, yaml);
    console.log(`${C.green}Echidna files generated:${C.reset}`);
    console.log(`  ${solFile}`);
    console.log(`  ${cfgFile}`);
    process.exit(0);
  }

  if (cmd === 'gen-foundry') {
    const bindingPath = process.argv[3];
    if (!bindingPath) { console.log(USAGE); process.exit(1); }
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf-8'));
    const contractName = arg('--contract-name') || binding.model || 'Contract';
    const outputDir = path.resolve(arg('--output-dir') || './foundry-output');
    fs.mkdirSync(outputDir, { recursive: true });

    const foundry = require('./export-foundry');
    const out = foundry.renderSolidity(binding, contractName);
    const handlerFile = path.join(outputDir, `${contractName}Handler.sol`);
    const invFile = path.join(outputDir, `${contractName}Invariants.t.sol`);
    fs.writeFileSync(handlerFile, out.handler);
    fs.writeFileSync(invFile, out.invariants);
    console.log(`${C.green}Foundry files generated:${C.reset}`);
    console.log(`  ${handlerFile}`);
    console.log(`  ${invFile}`);
    process.exit(0);
  }

  if (cmd === 'fuzz-symb') {
    const { spawnSync } = require('child_process');
    const contractName = process.argv[3];
    if (!contractName) { console.log(USAGE); process.exit(1); }
    const testGlob = arg('--test') || '*';

    const hasForge = spawnSync('forge', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!hasForge) {
      console.log(`${C.red}forge not installed: install Foundry (https://book.getfoundry.sh)${C.reset}`);
      process.exit(2);
    }

    const results = runFuzzThenSymbolic(contractName, testGlob);
    if (!results.ok) {
      console.log(`${C.red}${results.error}${C.reset}`);
      process.exit(2);
    }

    console.log(`${C.bold}Fuzz + Symbolic Results — ${contractName}${C.reset}`);
    console.log(`\n${results.combinedSummary}`);
    console.log(`\n${C.bold}Forge Fuzz:${C.reset}`);
    console.log(`  exit code: ${results.fuzzResults.exitCode}`);
    console.log(`  failures: ${results.fuzzResults.failures}`);
    if (results.fuzzResults.failures > 0) {
      for (const cex of results.fuzzResults.counterexamples) {
        console.log(`    ${C.red}${cex.testName}${C.reset}: ${cex.reason}`);
      }
    }

    if (results.symbolicResults.length > 0) {
      console.log(`\n${C.bold}Halmos Symbolic:${C.reset}`);
      for (const sr of results.symbolicResults) {
        const allPassed = sr.halmos.ok && sr.halmos.results.every(r => r.passed);
        const mark = allPassed ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
        console.log(`  ${mark} ${sr.testName}`);
        if (!allPassed) {
          console.log(bytecodeReport(sr.halmos.results));
        }
      }
    }

    if (json) console.log(JSON.stringify(results, null, 2));
    process.exit(results.fuzzResults.failures > 0 ? 3 : 0);
  }

  console.log(USAGE);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
