const { spawnSync } = require('child_process');
const path = require('path');

const HALMOS_DIR = path.join(__dirname, '..', 'halmos');

function pickPythonInner() {
  const candidates = [
    process.env.COUNTERFLOW_PYTHON,
    path.join(__dirname, '..', '.venv', 'bin', 'python'),
    'python3',
  ].filter(Boolean);
  for (const p of candidates) {
    const r = spawnSync(p, ['-c', 'import z3'], { encoding: 'utf-8' });
    if (r.status === 0) return p;
  }
  return null;
}

/**
 * Run Halmos symbolic tests for a specific test contract (or all if '*').
 * Returns { ok, results: [{ name, passed, counterexample }] }.
 */
function runHalmos(testGlob) {
  const python = pickPythonInner();
  if (!python) return { ok: false, error: 'no python with z3' };

  const pythonArg = ['-m', 'halmos', '--root', HALMOS_DIR, '--contract', testGlob];

  // First ensure forge build is up to date
  const build = spawnSync('forge', ['build'], { cwd: HALMOS_DIR, encoding: 'utf-8' });
  if (build.status !== 0) {
    return { ok: false, error: `forge build failed:\n${build.stderr}` };
  }

  const res = spawnSync(python, pythonArg, {
    cwd: HALMOS_DIR,
    encoding: 'utf-8',
  });

  // Halmos writes results to stdout; failures are in stderr for counterexamples
  const combined = (res.stdout || '') + '\n' + (res.stderr || '');

  // Parse test results from halmos output
  const results = parseHalmosOutput(combined);

  return { ok: true, results };
}

function parseHalmosOutput(text) {
  const results = [];

  // Strip ANSI color codes that wrap [PASS]/[FAIL] markers
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split('\n');
  let currentFail = null;

  for (const line of lines) {
    const passMatch = line.match(/\[PASS\]\s+(\S+)/);
    const failMatch = line.match(/\[FAIL\]\s+(\S+)/);

    if (passMatch) {
      results.push({ name: passMatch[1], passed: true, counterexample: null });
      currentFail = null;
    } else if (failMatch) {
      currentFail = { name: failMatch[1], passed: false, counterexample: {} };
      results.push(currentFail);
    } else if (line.includes('Counterexample')) {
      // Header line; actual values follow
    } else if (currentFail && line.trim()) {
      const stripped = line.trim();
      const eq = stripped.indexOf(' = ');
      if (eq > 0) {
        const key = stripped.substring(0, eq).trim();
        const val = stripped.substring(eq + 3).trim();
        currentFail.counterexample[key] = val;
      }
    }
  }

  return results;
}

module.exports = { runHalmos };
