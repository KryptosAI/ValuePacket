/**
 * Shared helpers for anvil-backed SDK integration tests.
 *
 * Every anvil-backed test file spawns its OWN anvil on port 8547 in
 * beforeAll and kills it in afterAll. sdk/vitest.config.ts sets
 * fileParallelism: false so files never compete for the port.
 * Port 8545 is reserved for other agents — never use it here.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import type { Address, Hash, PublicClient, WalletClient } from 'viem';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAYMENT_CHANNEL_ABI } from '../../src/contracts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const ANVIL_PORT = 8547;
export const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

function resolveBin(name: string): string {
  const envOverride = process.env[`${name.toUpperCase()}_BIN`];
  if (envOverride && existsSync(envOverride)) return envOverride;
  try {
    const found = execSync(`command -v ${name}`, { encoding: 'utf-8' }).trim();
    if (found) return found;
  } catch {
    // not on PATH; try well-known locations
  }
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    join(homedir(), '.foundry', 'bin', name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

export const ANVIL_BIN = resolveBin('anvil');
export const FORGE_BIN = resolveBin('forge');
export const CONTRACTS_DIR = join(__dirname, '..', '..', '..', 'contracts');

export const ACCOUNTS = {
  deployer: {
    pk: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hash,
    addr: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
  },
  account1: {
    pk: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hash,
    addr: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address,
  },
  account2: {
    pk: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hash,
    addr: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address,
  },
  account3: {
    pk: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hash,
    addr: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address,
  },
} as const;

export const anvilChain = {
  id: 31337,
  name: 'Anvil-8547',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
} as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/** 6-decimal USDC helper. */
export function usdc(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

function portPids(): string[] {
  try {
    const out = execSync(`lsof -ti tcp:${ANVIL_PORT}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    // lsof exits non-zero when nothing listens on the port.
    return [];
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed with HTTP ${res.status}`);
  const data = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (data.error) throw new Error(`RPC ${method} failed: ${data.error.message}`);
  return data.result;
}

async function waitForAnvil(retries = 60, delayMs = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await rpc('eth_chainId');
      if (result) return;
    } catch {
      // not ready yet
    }
    await sleep(delayMs);
  }
  throw new Error('anvil did not become ready on port 8547 in time');
}

/**
 * Spawns anvil on port 8547 after verifying the port is free.
 * Never kills processes it did not spawn: if the port stays occupied,
 * it fails loudly instead.
 */
export async function startAnvil(): Promise<ChildProcess> {
  for (let i = 0; i < 20; i++) {
    if (portPids().length === 0) break;
    await sleep(500);
  }
  const stale = portPids();
  if (stale.length > 0) {
    throw new Error(
      `tcp:${ANVIL_PORT} is already in use by PID(s) ${stale.join(', ')} — refusing to spawn anvil or kill a process this test did not start`,
    );
  }

  const proc = spawn(ANVIL_BIN, ['--port', String(ANVIL_PORT), '--chain-id', '31337'], {
    stdio: 'pipe',
    detached: false,
  });

  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => resolve();
    const onError = (err: Error) => reject(new Error(`failed to start anvil: ${err.message}`));
    proc.once('spawn', onSpawn);
    proc.once('error', onError);
  });

  if (proc.exitCode !== null) {
    throw new Error(`anvil exited immediately (code ${proc.exitCode})\n${stderr}`);
  }

  await waitForAnvil();
  return proc;
}

/** Terminates the anvil process this test spawned and waits for the port to free up. */
export async function stopAnvil(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.pid === undefined) return;

  if (proc.exitCode === null) {
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
        resolve();
      }, 5000);
      proc.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  for (let i = 0; i < 20; i++) {
    if (portPids().length === 0) return;
    await sleep(250);
  }
}

export function runForge(args: string): string {
  try {
    return execSync(`${FORGE_BIN} ${args}`, {
      cwd: CONTRACTS_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 180_000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr || '';
    throw new Error(`forge failed: ${msg}\n${stderr}`);
  }
}

/**
 * Deploys a contract with `forge create`. Constructor args are passed as
 * human-readable values (addresses, integers), never abi-encoded hex.
 * Retries once after 10s: a parallel agent may be mid-edit in contracts/,
 * so a single transient compile failure is tolerated.
 */
export async function deployContract(
  contractPath: string,
  constructorArgs?: string,
): Promise<Address> {
  const attempt = (): Address => {
    let cmd = `create ${contractPath} --rpc-url ${ANVIL_RPC} --private-key ${ACCOUNTS.deployer.pk} --broadcast`;
    if (constructorArgs) {
      cmd += ` --constructor-args ${constructorArgs}`;
    }
    const output = runForge(cmd);
    const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
    if (!match || !match[1]) {
      throw new Error(`could not parse deployed address from forge output:\n${output.slice(0, 2000)}`);
    }
    return match[1] as Address;
  };

  try {
    return attempt();
  } catch (firstErr) {
    await sleep(10_000);
    try {
      return attempt();
    } catch {
      throw firstErr;
    }
  }
}

export async function increaseTime(seconds: number): Promise<void> {
  await rpc('evm_increaseTime', [seconds]);
  await rpc('evm_mine', []);
}

export function createAnvilWallet(pk: Hash): WalletClient {
  return createWalletClient({
    chain: anvilChain,
    transport: http(ANVIL_RPC),
    account: privateKeyToAccount(pk),
  });
}

export function createAnvilPublicClient(): PublicClient {
  return createPublicClient({
    chain: anvilChain,
    transport: http(ANVIL_RPC),
  }) as PublicClient;
}

// ── ERC20 helpers ────────────────────────────────────────────────────

export const mockUsdcAbi = [
  {
    type: 'function',
    name: 'mint',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

export async function mintUsdc(
  minter: WalletClient,
  pc: PublicClient,
  token: Address,
  to: Address,
  amount: bigint,
): Promise<void> {
  const hash = await minter.writeContract({
    address: token,
    abi: mockUsdcAbi,
    functionName: 'mint',
    args: [to, amount],
    chain: anvilChain,
    account: minter.account!,
  });
  await pc.waitForTransactionReceipt({ hash });
}

export async function approveToken(
  owner: WalletClient,
  pc: PublicClient,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  const hash = await owner.writeContract({
    address: token,
    abi: mockUsdcAbi,
    functionName: 'approve',
    args: [spender, amount],
    chain: anvilChain,
    account: owner.account!,
  });
  await pc.waitForTransactionReceipt({ hash });
}

export async function balanceOf(
  pc: PublicClient,
  token: Address,
  account: Address,
): Promise<bigint> {
  return (await pc.readContract({
    address: token,
    abi: mockUsdcAbi,
    functionName: 'balanceOf',
    args: [account],
  })) as bigint;
}

// ── PaymentChannel helpers ───────────────────────────────────────────

const CHANNEL_OPENED_TOPIC = keccak256(
  toHex('ChannelOpened(uint256,address,address,address,uint256,uint32)'),
);

export async function openChannel(
  payer: WalletClient,
  pc: PublicClient,
  paymentChannel: Address,
  payee: Address,
  token: Address,
  deposit: bigint,
  expiresAt: number,
): Promise<bigint> {
  const hash = await payer.writeContract({
    address: paymentChannel,
    abi: PAYMENT_CHANNEL_ABI,
    functionName: 'openChannel',
    args: [payee, token, deposit, expiresAt, ZERO_ADDRESS, '0x'],
    chain: anvilChain,
    account: payer.account!,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === paymentChannel.toLowerCase() &&
      l.topics[0] === CHANNEL_OPENED_TOPIC,
  );
  if (!log || !log.topics[1]) {
    throw new Error('ChannelOpened event not found in receipt');
  }
  return BigInt(log.topics[1]);
}

export interface OnChainChannel {
  payer: Address;
  payee: Address;
  token: Address;
  deposit: bigint;
  spent: bigint;
  openedAt: number;
  expiresAt: number;
  policy: Address;
  metadata: `0x${string}`;
  status: number;
}

export async function getOnChainChannel(
  pc: PublicClient,
  paymentChannel: Address,
  channelId: bigint,
): Promise<OnChainChannel> {
  return (await pc.readContract({
    address: paymentChannel,
    abi: PAYMENT_CHANNEL_ABI,
    functionName: 'getChannel',
    args: [channelId],
  })) as unknown as OnChainChannel;
}

/** Polls until `condition` returns truthy or the timeout elapses. */
export async function waitUntil<T>(
  condition: () => Promise<T | undefined | false | null>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitUntil timed out${opts.label ? `: ${opts.label}` : ''}`);
    }
    await sleep(intervalMs);
  }
}
