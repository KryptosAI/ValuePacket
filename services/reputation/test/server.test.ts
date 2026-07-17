/**
 * reputation service tests
 *
 * This service does NOT use payment headers — it's a free read-only API.
 * Anvil port: 8551 (never 8545/8547)
 * Server: child process on a random free port
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createPublicClient, http } from 'viem';
import { createServer } from 'node:http';

const ANVIL_PORT = '8551';
const ANVIL_RPC = `http://localhost:${ANVIL_PORT}`;
const CONTRACTS_DIR = '../../contracts';

const ANVIL_PAYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let anvil: ChildProcess | null = null;
let serverProcess: ChildProcess | null = null;
let serverPort: number;
let chainId: number;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Server on port ${port} not ready within ${timeoutMs}ms`);
}

async function waitForAnvil(rpc: string, timeoutMs = 30000): Promise<void> {
  const client = createPublicClient({ transport: http(rpc) });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.getChainId();
      return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Anvil at ${rpc} not ready within ${timeoutMs}ms`);
}

beforeAll(async () => {
  anvil = spawn('anvil', ['--host', '0.0.0.0', '--port', ANVIL_PORT, '--chain-id', '31337'], {
    stdio: 'pipe',
    detached: false,
  });
  await waitForAnvil(ANVIL_RPC);

  const transport = http(ANVIL_RPC);
  const pc = createPublicClient({ transport });
  chainId = await pc.getChainId();

  serverPort = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('Could not get server port'));
      s.close();
    });
    s.on('error', reject);
  });

  serverProcess = spawn(
    'npx',
    ['tsx', 'src/server.ts'],
    {
      cwd: __dirname + '/..',
      env: {
        ...process.env,
        PORT: String(serverPort),
        RPC_URL: ANVIL_RPC,
        CHAIN: 'local',
        DEPLOYMENT_FILE: '',
        AGENT_REPUTATION_ADDRESS: '',
      },
      stdio: 'pipe',
      detached: false,
    },
  );

  await waitForPort(serverPort, 20000);
}, 60000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await sleep(1000);
    try { serverProcess.kill('SIGKILL'); } catch {}
  }
  if (anvil) {
    anvil.kill('SIGTERM');
    await sleep(500);
    try { anvil.kill('SIGKILL'); } catch {}
  }
  await sleep(1000);
  const survivors = (() => { try { return execSync(`lsof -ti tcp:${ANVIL_PORT}`, { encoding: 'utf-8' }).trim(); } catch { return ''; } })();
  if (survivors) {
    survivors.split('\n').forEach((pid) => { try { process.kill(Number(pid), 'SIGKILL'); } catch {} });
  }
});

describe('GET /health', () => {
  it('returns 200 with service info and contractAvailable=false', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.service).toBe('reputation');
    expect(json.contractAvailable).toBe(false);
  });
});

describe('GET /score/{provider}', () => {
  it('returns 400 for invalid address', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/score/notanaddress`);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_ADDRESS');
  });

  it('returns score for valid address (no ratings, contract unavailable)', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/score/0x1234567890123456789012345678901234567890`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.averageScore).toBeNull();
    expect(json.weightedScore).toBeNull();
    expect(json.totalRatings).toBe(0);
    expect(json.confidence).toBe('low');
  });
});

describe('GET /top', () => {
  it('returns empty top list when no contract is configured', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/top?limit=5`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.top).toEqual([]);
    expect(json.note).toContain('No providers indexed');
  });
});

describe('GET /scores', () => {
  it('returns 400 for missing providers parameter', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/scores`);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('MISSING_PROVIDERS');
  });

  it('returns scores for valid addresses', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/scores?providers=0x1234567890123456789012345678901234567890,0x1234567890abcdef1234567890abcdef12345678`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json.scores).length).toBe(2);
  });
});
