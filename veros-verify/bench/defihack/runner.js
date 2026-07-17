#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { verify } = require('../../src/verify');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
};

const ROOT = path.join(__dirname, '..', '..');
const CASES_DIR = __dirname;

const suite = JSON.parse(fs.readFileSync(path.join(CASES_DIR, 'suite.json'), 'utf-8'));

let pass = 0;
let fail = 0;
let skip = 0;
const rows = [];

async function runOne(c) {
  const contractPath = path.join(CASES_DIR, c.contract);
  const invariantsPath = path.join(CASES_DIR, c.invariants);
  const contractExists = fs.existsSync(contractPath);
  const invariantsExist = fs.existsSync(invariantsPath);

  if (!contractExists) {
    skip++;
    return { name: c.name, status: 'skipped', reason: 'contract not found', cls: c.exploit_class };
  }
  if (!invariantsExist) {
    skip++;
    return { name: c.name, status: 'skipped', reason: 'invariants not found', cls: c.exploit_class };
  }

  const start = Date.now();
  let result;
  try {
    result = await verify({
      contractPath,
      invariantsText: fs.readFileSync(invariantsPath, 'utf-8'),
    });
  } catch (e) {
    fail++;
    return { name: c.name, status: 'error', ms: Date.now() - start, cls: c.exploit_class, detail: e.message };
  }
  const ms = Date.now() - start;

  let ok = false;
  let detail = '';

  if (result.verdict === 'error') {
    detail = result.error || 'verification error';
  } else if (result.verdict !== c.expected_verdict) {
    detail = `expected ${c.expected_verdict}, got ${result.verdict}`;
  } else if (c.expected_invariant && result.solver) {
    const hit = (result.solver.functions || []).some((f) =>
      (f.results || []).some((x) => x.invariant === c.expected_invariant && x.status === 'violated'));
    ok = hit;
    if (!hit) detail = `expected violation of ${c.expected_invariant}, not found`;
  } else {
    ok = true;
  }

  if (ok) pass++; else fail++;

  return {
    name: c.name,
    status: ok ? 'pass' : 'fail',
    ms,
    cls: c.exploit_class,
    verdict: result.verdict,
    detail,
    expected_invariant: c.expected_invariant,
    real_loss_usd: c.real_loss_usd,
    description: c.description,
  };
}

(async () => {
  for (const c of suite.cases) {
    rows.push(await runOne(c));
  }

  console.log('');
  console.log(`${C.bold}Counterflow DeFiHackLabs benchmark${C.reset} ${C.dim}(real exploit reproductions, Apache-2.0)${C.reset}`);
  console.log(`${C.dim}source: ${suite.source_repo}${C.reset}`);
  console.log('');

  for (const r of rows) {
    if (r.status === 'skipped') {
      console.log(`  ${C.yellow}⊘${C.reset} ${r.name}  ${C.dim}[${r.cls}]${C.reset} SKIPPED: ${r.reason} (run \`npm run defihack:clone\` to fetch)`);
    } else if (r.status === 'error') {
      console.log(`  ${C.red}✗${C.reset} ${r.name}  ${C.dim}[${r.cls}]${C.reset} ERROR ${r.ms}ms\n      ${C.red}${r.detail}${C.reset}`);
    } else {
      const mark = r.status === 'pass' ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      console.log(`  ${mark} ${r.name}  ${C.dim}[${r.cls}] expected=${r.verdict} ${r.ms}ms${C.reset}${r.detail ? `\n      ${C.red}${r.detail}${C.reset}` : ''}`);
    }
  }

  const total = rows.length;
  const ran = total - skip;
  console.log('');
  console.log(`  ${pass}/${ran} correct${skip > 0 ? `  (${skip} skipped — run \`npm run defihack:clone\` to fetch contracts)` : ''}`);
  console.log('');
  process.exit(fail > 0 ? 1 : 0);
})();
