/**
 * mev-scanner tests: HTTP server + pure business logic unit tests
 *
 * Anvil port: 8550 (never 8545/8547)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PAYMENT_PROOF_TYPE } from '@valuepacket/sdk';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const ANVIL_PORT = '8550';
const ANVIL_RPC = `http://localhost:${ANVIL_PORT}`;
const CONTRACTS_DIR = resolve(__dirname, '..', '..', '..', 'contracts');

const ANVIL_PAYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_PAYEE_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEPOSIT = 5_000_000n;
const PRICE_PER = 100_000n;

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
    expect(json.service).toBe('mev-scanner');
  });
});

describe('Payment header rejection paths', () => {
  it('POST /scan without payment headers returns 400', async () => {
    const res = await makePost(`http://127.0.0.1:${serverPort}/scan`, { pair: 'ETH/USDC' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('MISSING_HEADERS');
  });

  it('POST /scan without pair field returns 400', async () => {
    const res = await makePost(`http://127.0.0.1:${serverPort}/scan`, { chainId: 1 });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('MISSING_PAIR');
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

  it('pays with valid proof (payment accepted, dex scraper may succeed or fail)', async () => {
    const body = { pair: 'ETH/USDC', chainId: 1 };
    const { sig, requestHash } = await signPaymentProof(ANVIL_PAYER_PK, channelId, PRICE_PER, 1n, body);
    const res = await makePost(`http://127.0.0.1:${serverPort}/scan`, body, {
      'X-Channel-Id': channelId.toString(),
      'X-Cumulative-Spent': PRICE_PER.toString(),
      'X-Payment-Proof': sig,
      'X-Request-Nonce': '1',
      'X-Request-Hash': requestHash,
    });
    // Payment verification passed. DexScreener may return 200 or 503.
    expect([200, 503]).toContain(res.status);
  });

  it('rejects wrong signer signature with 401', async () => {
    const WRONG_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    const body = { pair: 'ETH/USDC', chainId: 1 };
    const { sig, requestHash } = await signPaymentProof(WRONG_PK, channelId, 200000n, 10n, body);
    const res = await makePost(`http://127.0.0.1:${serverPort}/scan`, body, {
      'X-Channel-Id': channelId.toString(),
      'X-Cumulative-Spent': '200000',
      'X-Payment-Proof': sig,
      'X-Request-Nonce': '10',
      'X-Request-Hash': requestHash,
    });
    expect(res.status).toBe(401);
  });
});

// ─── Pure business logic unit tests ──────────────────────────────────

import { parsePair, tokenMatches, computeOpportunities } from '../src/matching.js';
import type { DexPair } from '../src/matching.js';

describe('parsePair', () => {
  it('parses slash-separated pair', () => {
    expect(parsePair('ETH/USDC')).toEqual(['ETH', 'USDC']);
  });

  it('parses dash-separated pair', () => {
    expect(parsePair('ETH-USDC')).toEqual(['ETH', 'USDC']);
  });

  it('trims whitespace', () => {
    expect(parsePair(' ETH / USDC ')).toEqual(['ETH', 'USDC']);
  });

  it('returns null for empty string', () => {
    expect(parsePair('')).toBeNull();
  });

  it('returns null for three-part input', () => {
    expect(parsePair('A/B/C')).toBeNull();
  });
});

describe('tokenMatches', () => {
  it('matches exact symbol (case insensitive)', () => {
    expect(tokenMatches('ETH', 'eth')).toBe(true);
  });

  it('matches WETH as ETH', () => {
    expect(tokenMatches('WETH', 'ETH')).toBe(true);
  });

  it('matches WBTC as BTC', () => {
    expect(tokenMatches('WBTC', 'BTC')).toBe(true);
  });

  it('does not match different symbols', () => {
    expect(tokenMatches('ETH', 'BTC')).toBe(false);
  });
});

describe('computeOpportunities', () => {
  function pairData(overrides: Partial<DexPair> = {}): DexPair {
    return {
      chainId: 'ethereum',
      dexId: 'uniswap',
      pairAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
      baseToken: { symbol: 'ETH' },
      quoteToken: { symbol: 'USDC' },
      priceUsd: '3500.00',
      liquidity: { usd: 500000 },
      ...overrides,
    };
  }

  it('returns empty for fewer than 2 pairs', () => {
    const result = computeOpportunities([pairData()], ['ETH', 'USDC']);
    expect(result).toEqual([]);
  });

  it('finds arbitrage when buy < sell price', () => {
    const pairs = [
      pairData({ dexId: 'cheap-dex', priceUsd: '3500.00', liquidity: { usd: 50000 } }),
      pairData({ dexId: 'expensive-dex', priceUsd: '3510.00', liquidity: { usd: 50000 } }),
    ];
    const result = computeOpportunities(pairs, ['ETH', 'USDC']);
    expect(result.length).toBe(1);
    expect(result[0].buyDex).toBe('cheap-dex');
    expect(result[0].sellDex).toBe('expensive-dex');
    expect(result[0].spreadPct).toBeGreaterThan(0);
  });

  it('filters pairs below minimum liquidity', () => {
    const pairs = [
      pairData({ dexId: 'd1', priceUsd: '100.00', liquidity: { usd: 100 } }),
      pairData({ dexId: 'd2', priceUsd: '105.00', liquidity: { usd: 50000 } }),
    ];
    const result = computeOpportunities(pairs, ['ETH', 'USDC']);
    expect(result).toEqual([]);
  });

  it('caps at max 3 opportunities', () => {
    const pairs = [
      pairData({ dexId: 'd1', priceUsd: '100.00', liquidity: { usd: 50000 }, pairAddress: '0x01' }),
      pairData({ dexId: 'd2', priceUsd: '101.00', liquidity: { usd: 50000 }, pairAddress: '0x02' }),
      pairData({ dexId: 'd3', priceUsd: '102.00', liquidity: { usd: 50000 }, pairAddress: '0x03' }),
      pairData({ dexId: 'd4', priceUsd: '103.00', liquidity: { usd: 50000 }, pairAddress: '0x04' }),
      pairData({ dexId: 'd5', priceUsd: '104.00', liquidity: { usd: 50000 }, pairAddress: '0x05' }),
    ];
    const result = computeOpportunities(pairs, ['ETH', 'USDC']);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});
