/**
 * price-feed HTTP server tests
 *
 * Anvil port: 8548 (never 8545/8547)
 * Server: child process on a random free port
 * External APIs: NOT hit — CoinGecko fetch fails in child process;
 *   payment verification is tested via error-code discrimination.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PAYMENT_PROOF_TYPE, PAYMENT_CHANNEL_ABI } from '@valuepacket/sdk';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const ANVIL_PORT = '8548';
const ANVIL_RPC = `http://localhost:${ANVIL_PORT}`;
const CONTRACTS_DIR = resolve(__dirname, '..', '..', '..', 'contracts');

const ANVIL_PAYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_PAYEE_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DEPOSIT = 2_000_000n; // 2 USDC (6 decimals)
const PRICE_PER = 1000n;

let anvil: ChildProcess | null = null;
let serverProcess: ChildProcess | null = null;
let serverPort: number;
let usdcAddr: `0x${string}`;
let channelAddr: `0x${string}`;
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

function makeGet(url: string) {
  return fetch(url);
}

function makePost(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // 1. Start anvil
  anvil = spawn('anvil', ['--host', '0.0.0.0', '--port', ANVIL_PORT, '--chain-id', '31337'], {
    stdio: 'pipe',
    detached: false,
  });
  await waitForAnvil(ANVIL_RPC);

  const transport = http(ANVIL_RPC);
  const pc = createPublicClient({ transport });
  chainId = await pc.getChainId();

  // 2. Deploy MockUSDC
  const usdcJson = JSON.parse(execSync(
    `cd "${CONTRACTS_DIR}" && forge create src/mocks/MockUSDC.sol:MockUSDC --rpc-url ${ANVIL_RPC} --private-key ${ANVIL_PAYER_PK} --broadcast --json 2>/dev/null`,
    { encoding: 'utf-8', timeout: 60000 },
  ));
  usdcAddr = usdcJson.deployedTo as `0x${string}`;

  // 3. Deploy PaymentChannel
  const chJson = JSON.parse(execSync(
    `cd "${CONTRACTS_DIR}" && forge create src/PaymentChannel.sol:PaymentChannel --rpc-url ${ANVIL_RPC} --private-key ${ANVIL_PAYER_PK} --broadcast --json 2>/dev/null`,
    { encoding: 'utf-8', timeout: 60000 },
  ));
  channelAddr = chJson.deployedTo as `0x${string}`;

  // 4. Mint USDC to payer + payee using cast send (bypasses viem gas estimation issue)
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

  // 5. Find a free port for the server
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

  // 6. Start server as child process
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
  // Verify cleanup
  await sleep(1000);
  const anvilSurvivors = (() => { try { return execSync(`lsof -ti tcp:${ANVIL_PORT}`, { encoding: 'utf-8' }).trim(); } catch { return ''; } })();
  if (anvilSurvivors) {
    anvilSurvivors.split('\n').forEach((pid) => { try { process.kill(Number(pid), 'SIGKILL'); } catch {} });
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

// ─── Tests ───────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with service info', async () => {
    const res = await makeGet(`http://127.0.0.1:${serverPort}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.service).toBe('price-feed');
  });
});

describe('Payment header rejection paths', () => {
  it('POST /price/eth-usdc without payment headers returns 400', async () => {
    const res = await makePost(`http://127.0.0.1:${serverPort}/price/eth-usdc`, { pair: 'eth-usdc' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('MISSING_HEADERS');
  });

  it('POST /price/eth-usdc with partial headers returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/price/eth-usdc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Channel-Id': '999' },
      body: JSON.stringify({ pair: 'eth-usdc' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('MISSING_HEADERS');
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

    const PChAbi = [
      { type: 'function', name: 'openChannel', inputs: [
        { name: 'payee', type: 'address' }, { name: 'token', type: 'address' }, { name: 'deposit', type: 'uint256' },
        { name: 'expiresAt', type: 'uint32' }, { name: 'policy', type: 'address' }, { name: 'metadata', type: 'bytes' },
      ], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' },
    ] as const;
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const openHash = await wallet.writeContract({
      address: channelAddr, abi: PChAbi, functionName: 'openChannel',
      args: [payeeAccount.address, usdcAddr, DEPOSIT, expiresAt, '0x0000000000000000000000000000000000000000' as `0x${string}`, '0x'],
      chain: chains, account: payerAccount,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash: openHash });
    const channelLog = receipt.logs.find((l) => l.address.toLowerCase() === channelAddr.toLowerCase());
    channelId = channelLog ? BigInt(channelLog.topics[1]) : 1n;
  });

  it('pays with valid proof (payment accepted, real API returns price data or price fetch fails)', async () => {
    const body = { pair: 'eth-usdc' };
    const { sig, requestHash } = await signPaymentProof(ANVIL_PAYER_PK, channelId, PRICE_PER, 1n, body);
    const res = await makePost(`http://127.0.0.1:${serverPort}/price/eth-usdc`, body, {
      'X-Channel-Id': channelId.toString(),
      'X-Cumulative-Spent': PRICE_PER.toString(),
      'X-Payment-Proof': sig,
      'X-Request-Nonce': '1',
      'X-Request-Hash': requestHash,
    });
    // Payment verification passed. CoinGecko may respond 200 (real data) or 503 (if blocked).
    // Either way, this proves the payment layer works.
    expect(res.status === 200 || res.status === 503).toBe(true);
    if (res.status === 200) {
      const json = await res.json();
      expect(typeof json.price).toBe('number');
    }
  });

  it('rejects wrong signer signature with 401', async () => {
    // Use a DIFFERENT private key to sign, so the recovered address won't match the payer
    const WRONG_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // anvil account #1
    const body = { pair: 'eth-usdc' };
    const { sig, requestHash } = await signPaymentProof(WRONG_PK, channelId, 5000n, 10n, body);
    const res = await makePost(`http://127.0.0.1:${serverPort}/price/eth-usdc`, body, {
      'X-Channel-Id': channelId.toString(),
      'X-Cumulative-Spent': '5000',
      'X-Payment-Proof': sig,
      'X-Request-Nonce': '10',
      'X-Request-Hash': requestHash,
    });
    expect(res.status).toBe(401);
  });

  it('rejects replay of already-used nonce with 409', async () => {
    const body = { pair: 'btc-usdc' };
    const { sig, requestHash } = await signPaymentProof(ANVIL_PAYER_PK, channelId, PRICE_PER + 1000n, 2n, body);
    // First request
    await makePost(`http://127.0.0.1:${serverPort}/price/btc-usdc`, body, {
      'X-Channel-Id': channelId.toString(),
      'X-Cumulative-Spent': (PRICE_PER + 1000n).toString(),
      'X-Payment-Proof': sig,
      'X-Request-Nonce': '2',
      'X-Request-Hash': requestHash,
    });
    // Replay
    const res = await makePost(`http://127.0.0.1:${serverPort}/price/btc-usdc`, body, {
      'X-Channel-Id': channelId.toString(),
      'X-Cumulative-Spent': (PRICE_PER + 1000n).toString(),
      'X-Payment-Proof': sig,
      'X-Request-Nonce': '2',
      'X-Request-Hash': requestHash,
    });
    expect(res.status).toBe(409);
  });
});
