/**
 * contract-audit tests: HTTP server + pure business logic unit tests
 *
 * Anvil port: 8549 (never 8545/8547)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PAYMENT_PROOF_TYPE } from '@valuepacket/sdk';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const ANVIL_PORT = '8549';
const ANVIL_RPC = `http://localhost:${ANVIL_PORT}`;
const CONTRACTS_DIR = resolve(__dirname, '..', '..', '..', 'contracts');

const ANVIL_PAYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_PAYEE_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEPOSIT = 10_000_000n;
const PRICE_PER = 2_000_000n;

let anvil: ChildProcess | null = null;
let serverProcess: ChildProcess | null = null;
let serverPort: number;
let usdcAddr: `0x${string}`;
let channelAddr: `0x${string}`;
let chainId: number;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort(port: number, timeoutMs = 20000): Promise<void> {
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

function makePost(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
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

  const usdcJson = JSON.parse(execSync(
    `cd "${CONTRACTS_DIR}" && forge create src/mocks/MockUSDC.sol:MockUSDC --rpc-url ${ANVIL_RPC} --private-key ${ANVIL_PAYER_PK} --broadcast --json 2>/dev/null`,
    { encoding: 'utf-8', timeout: 60000 },
  ));
  usdcAddr = usdcJson.deployedTo as `0x${string}`;

  const chJson = JSON.parse(execSync(
    `cd "${CONTRACTS_DIR}" && forge create src/PaymentChannel.sol:PaymentChannel --rpc-url ${ANVIL_RPC} --private-key ${ANVIL_PAYER_PK} --broadcast --json 2>/dev/null`,
    { encoding: 'utf-8', timeout: 60000 },
  ));
  channelAddr = chJson.deployedTo as `0x${string}`;

  const payerAccount = privateKeyToAccount(ANVIL_PAYER_PK);
  const payeeAccount = privateKeyToAccount(ANVIL_PAYEE_PK);

  execSync(
    `cd "${CONTRACTS_DIR}" && cast send ${usdcAddr} "mint(address,uint256)" ${payerAccount.address} 100000000000 --private-key ${ANVIL_PAYER_PK} --rpc-url ${ANVIL_RPC} --json 2>/dev/null`,
    { encoding: 'utf-8', timeout: 30000 },
  );
  execSync(
    `cd "${CONTRACTS_DIR}" && cast send ${usdcAddr} "mint(address,uint256)" ${payeeAccount.address} 100000000000 --private-key ${ANVIL_PAYER_PK} --rpc-url ${ANVIL_RPC} --json 2>/dev/null`,
    { encoding: 'utf-8', timeout: 30000 },
  );

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
        PAYMENT_CHANNEL_ADDRESS: channelAddr,
        CHAIN: 'local',
        DEPLOYMENT_FILE: '',
      },
      stdio: 'pipe',
      detached: false,
    },
  );

  await waitForPort(serverPort, 20000);
}, 120000);

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

async function signPaymentProof(
  signerPk: `0x${string}`,
  channelId: bigint,
  cumulativeSpent: bigint,
  nonce: bigint,
  body: unknown,
): Promise<{ sig: `0x${string}`; requestHash: `0x${string}` }> {
  const account = privateKeyToAccount(signerPk);
  const chains = { id: chainId, name: 'local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ANVIL_RPC] } } };
  const wallet = createWalletClient({ account, transport: http(ANVIL_RPC), chain: chains });
  const requestHash = keccak256(toHex(JSON.stringify(body)));
  const sig = await wallet.signTypedData({
    account,
    domain: { name: 'ValuePacket', version: '1', chainId, verifyingContract: channelAddr },
    types: PAYMENT_PROOF_TYPE,
    primaryType: 'PaymentProof',
    message: { channelId, cumulativeSpent, requestHash, nonce },
  });
  return { sig, requestHash };
}

// ─── HTTP server tests ───────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with service info', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.service).toBe('contract-audit');
  });
});

describe('Payment header rejection paths', () => {
  it('POST /audit without payment headers returns 400', async () => {
    const res = await makePost(`http://127.0.0.1:${serverPort}/audit`, { chainId: 1, address: '0x1234567890123456789012345678901234567890' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('MISSING_HEADERS');
  });
});

describe('Paid requests (payment verification layer)', () => {
  let channelId: bigint;

  beforeAll(async () => {
    const payerAccount = privateKeyToAccount(ANVIL_PAYER_PK);
    const payeeAccount = privateKeyToAccount(ANVIL_PAYEE_PK);
    const transport = http(ANVIL_RPC);
    const chains = { id: chainId, name: 'local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ANVIL_RPC] } } };
    const pc = createPublicClient({ transport, chain: chains });
    const wallet = createWalletClient({ account: payerAccount, transport, chain: chains });

    const erc20Abi = [
      { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
    ] as const;
    const approveHash = await wallet.writeContract({ address: usdcAddr, abi: erc20Abi, functionName: 'approve', args: [channelAddr, DEPOSIT], chain: chains, account: payerAccount });
    await pc.waitForTransactionReceipt({ hash: approveHash });

    const openAbi = [
      { type: 'function', name: 'openChannel', inputs: [
        { name: 'payee', type: 'address' }, { name: 'token', type: 'address' }, { name: 'deposit', type: 'uint256' },
        { name: 'expiresAt', type: 'uint32' }, { name: 'policy', type: 'address' }, { name: 'metadata', type: 'bytes' },
      ], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' },
    ] as const;
    const openHash = await wallet.writeContract({
      address: channelAddr, abi: openAbi, functionName: 'openChannel',
      args: [payeeAccount.address, usdcAddr, DEPOSIT, Math.floor(Date.now() / 1000) + 3600,
        '0x0000000000000000000000000000000000000000' as `0x${string}`, '0x'],
      chain: chains, account: payerAccount,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash: openHash });
    const chLog = receipt.logs.find((l) => l.address.toLowerCase() === channelAddr.toLowerCase());
    channelId = chLog ? BigInt(chLog.topics[1]) : 1n;
  });

  it('pays with valid proof (payment accepted, explorer lookup may succeed or fail)', async () => {
    const body = { chainId: 1, address: '0x1234567890123456789012345678901234567890' };
    const { sig, requestHash } = await signPaymentProof(ANVIL_PAYER_PK, channelId, PRICE_PER, 1n, body);
    const res = await makePost(`http://127.0.0.1:${serverPort}/audit`, body, {
      'X-Channel-Id': channelId.toString(),
      'X-Cumulative-Spent': PRICE_PER.toString(),
      'X-Payment-Proof': sig,
      'X-Request-Nonce': '1',
      'X-Request-Hash': requestHash,
    });
    // Payment verification passed. Explorer may return 200 or 502/404.
    // Either way proves the payment layer works.
    expect([200, 502, 404]).toContain(res.status);
  });

  it('rejects wrong signer signature with 401', async () => {
    const WRONG_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const body = { chainId: 1, address: '0x1234567890123456789012345678901234567890' };
    const { sig, requestHash } = await signPaymentProof(WRONG_PK, channelId, 5000000n, 10n, body);
    const res = await makePost(`http://127.0.0.1:${serverPort}/audit`, body, {
      'X-Channel-Id': channelId.toString(),
      'X-Cumulative-Spent': '5000000',
      'X-Payment-Proof': sig,
      'X-Request-Nonce': '10',
      'X-Request-Hash': requestHash,
    });
    expect(res.status).toBe(401);
  });
});

// ─── Pure business logic unit tests ──────────────────────────────────

import {
  analyzeSolidity,
  calculateRiskScore,
  buildSummary,
  findLine,
  hasStateChangingFunctions,
} from '../src/analyzer.js';

describe('findLine', () => {
  it('finds line number for a pattern', () => {
    const source = 'line 1\nline 2\nselfdestruct\nline 4';
    expect(findLine(source, 'selfdestruct')).toBe(3);
  });

  it('returns 0 for missing pattern', () => {
    expect(findLine('hello world', 'zzz')).toBe(0);
  });
});

describe('hasStateChangingFunctions', () => {
  it('detects public non-view function', () => {
    const src = 'function transfer(address to, uint256 amount) public returns (bool) { _transfer(msg.sender, to, amount); return true; }';
    expect(hasStateChangingFunctions(src)).toBe(true);
  });

  it('detects external non-view function', () => {
    const src = 'function withdraw() external { payable(msg.sender).transfer(address(this).balance); }';
    expect(hasStateChangingFunctions(src)).toBe(true);
  });

  it('ignores view functions', () => {
    const src = 'function balanceOf(address account) public view returns (uint256) { return _balances[account]; }';
    expect(hasStateChangingFunctions(src)).toBe(false);
  });

  it('ignores pure functions', () => {
    const src = 'function add(uint256 a, uint256 b) public pure returns (uint256) { return a + b; }';
    expect(hasStateChangingFunctions(src)).toBe(false);
  });

  it('returns false for comment-only source', () => {
    expect(hasStateChangingFunctions('// no code here')).toBe(false);
  });
});

describe('analyzeSolidity', () => {
  it('finds selfdestruct usage (high)', () => {
    const findings = analyzeSolidity('contract X { function kill() public { selfdestruct(payable(msg.sender)); } }');
    expect(findings.some((f) => f.severity === 'high' && f.description.includes('selfdestruct'))).toBe(true);
  });

  it('finds tx.origin usage (high)', () => {
    const findings = analyzeSolidity('contract X { function auth() public { require(tx.origin == owner); } }');
    expect(findings.some((f) => f.severity === 'high' && f.description.includes('tx.origin'))).toBe(true);
  });

  it('finds delegatecall (medium)', () => {
    const findings = analyzeSolidity('contract X { function proxy(address target) external { target.delegatecall(msg.data); } }');
    expect(findings.some((f) => f.severity === 'medium' && f.description.includes('delegatecall'))).toBe(true);
  });

  it('finds assembly block (medium)', () => {
    const findings = analyzeSolidity('contract X { function fn() public { assembly { mstore(0, 1) } } }');
    expect(findings.some((f) => f.severity === 'medium' && f.description.includes('assembly'))).toBe(true);
  });

  it('finds onlyOwner usage (low)', () => {
    const findings = analyzeSolidity('contract X { modifier onlyOwner() { _; } function fn() external onlyOwner {} }');
    expect(findings.some((f) => f.severity === 'low' && f.description.includes('onlyOwner'))).toBe(true);
  });

  it('returns empty array for clean contract', () => {
    const src = `contract Clean {
      function getValue() public pure returns (uint256) { return 42; }
    }`;
    const findings = analyzeSolidity(src);
    expect(findings).toEqual([]);
  });

  it('sorts findings by severity', () => {
    const src = 'contract X { function fn() public { assembly {} } modifier onlyOwner() { _; } function bad() public { selfdestruct(payable(msg.sender)); } }';
    const findings = analyzeSolidity(src);
    const order: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
    for (let i = 1; i < findings.length; i++) {
      expect(order[findings[i - 1].severity]).toBeLessThanOrEqual(order[findings[i].severity]);
    }
  });
});

describe('calculateRiskScore', () => {
  it('returns 0 for no findings', () => {
    expect(calculateRiskScore([])).toBe(0);
  });

  it('calculates weighted score', () => {
    const findings = [
      { severity: 'high' as const, description: 'a', line: 0 },
      { severity: 'medium' as const, description: 'b', line: 0 },
      { severity: 'medium' as const, description: 'c', line: 0 },
    ];
    expect(calculateRiskScore(findings)).toBe(7);
  });

  it('caps at 10', () => {
    const findings = Array(10).fill({ severity: 'high' as const, description: 'x', line: 0 });
    expect(calculateRiskScore(findings)).toBe(10);
  });
});

describe('buildSummary', () => {
  it('returns "No findings detected" for empty', () => {
    expect(buildSummary([])).toBe('No findings detected');
  });

  it('summarizes findings', () => {
    const findings = [
      { severity: 'high' as const, description: 'a', line: 0 },
      { severity: 'low' as const, description: 'b', line: 0 },
      { severity: 'low' as const, description: 'c', line: 0 },
    ];
    expect(buildSummary(findings)).toBe('3 findings: 1 high, 2 low');
  });
});
