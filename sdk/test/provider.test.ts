/**
 * ChannelServer integration tests against a REAL local chain (anvil on port
 * 8547 — never 8545, that belongs to another agent).
 *
 * Covers: payment verification, replay rejection, the 30s channel cache,
 * C3 persistence across a simulated restart (two ChannelServer instances
 * sharing one FileChannelStateStore), and C2 auto-settlement (near-expiry
 * channels are closed on-chain with the latest payer-signed proof).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, PublicClient, WalletClient } from 'viem';
import { ChannelServer, type ChannelServerConfig } from '../src/provider.js';
import { ChannelSession } from '../src/channel.js';
import {
  signPaymentProof,
  signChannelClose,
  createPaymentProofHeader,
} from '../src/signing.js';
import { PAYMENT_CHANNEL_ABI } from '../src/contracts.js';
import { FileChannelStateStore } from '../src/extensions/persistence.js';
import type { ChannelClosedEvent, PaymentReceivedEvent } from '../src/extensions/events.js';
import {
  ACCOUNTS,
  anvilChain,
  startAnvil,
  stopAnvil,
  deployContract,
  createAnvilWallet,
  createAnvilPublicClient,
  mintUsdc,
  approveToken,
  balanceOf,
  openChannel,
  getOnChainChannel,
  waitUntil,
  usdc,
} from './helpers/chain.js';

let anvil: ChildProcess | null = null;
let publicClient: PublicClient;
let payerWallet: WalletClient;
let payeeWallet: WalletClient;
let strangerWallet: WalletClient;

let usdcAddress: Address;
let channelAddress: Address;

let tempDir: string;

const PAYER = ACCOUNTS.account1.addr;
const PAYEE = ACCOUNTS.deployer.addr;

const DEPOSIT = usdc(1); // 1_000_000 (6 decimals)
const PRICE = 1_000n;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function makeServer(port: number, extra: Partial<ChannelServerConfig> = {}): ChannelServer {
  return new ChannelServer({
    wallet: payeeWallet,
    publicClient,
    paymentChannelAddress: channelAddress,
    port,
    handler: async ({ body, channelId, cumulativeSpent }) => ({
      ok: true,
      echo: body,
      channelId: channelId.toString(),
      cumulativeSpent: cumulativeSpent.toString(),
    }),
    ...extra,
  });
}

function makeSession(channelId: bigint, port: number): ChannelSession {
  return new ChannelSession({
    channelId,
    payer: payerWallet,
    publicClient,
    payeeEndpoint: `http://127.0.0.1:${port}`,
    pricePerRequest: PRICE,
    token: usdcAddress,
    deposit: DEPOSIT,
    verifyingContract: channelAddress,
    paymentChannelAddress: channelAddress,
  });
}

async function openTestChannel(expiresInSeconds: number): Promise<bigint> {
  return openChannel(
    payerWallet,
    publicClient,
    channelAddress,
    PAYEE,
    usdcAddress,
    DEPOSIT,
    nowSeconds() + expiresInSeconds,
  );
}

async function sendRaw(opts: {
  port: number;
  channelId: bigint;
  spent: bigint;
  nonce: bigint;
  body?: Record<string, unknown>;
  signer?: WalletClient;
  includeCloseSig?: boolean;
}): Promise<Response> {
  const body = opts.body ?? { q: 'ping' };
  const signer = opts.signer ?? payerWallet;

  const proof = await signPaymentProof(
    signer,
    channelAddress,
    opts.channelId,
    opts.spent,
    body,
    opts.nonce,
  );
  const header = createPaymentProofHeader(opts.channelId, opts.spent, body, opts.nonce, proof);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Channel-Id': header.channelId,
    'X-Cumulative-Spent': header.cumulativeSpent,
    'X-Payment-Proof': header.proof,
    'X-Request-Nonce': header.nonce,
    'X-Request-Hash': header.requestHash,
  };
  if (opts.includeCloseSig) {
    headers['X-Close-Signature'] = await signChannelClose(
      signer,
      channelAddress,
      opts.channelId,
      opts.spent,
    );
  }

  return fetch(`http://127.0.0.1:${opts.port}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function closeChannelExternally(channelId: bigint, spent: bigint): Promise<void> {
  const signature = await signChannelClose(payerWallet, channelAddress, channelId, spent);
  const hash = await payeeWallet.writeContract({
    address: channelAddress,
    abi: PAYMENT_CHANNEL_ABI,
    functionName: 'closeChannel',
    args: [channelId, spent, signature],
    chain: anvilChain,
    account: payeeWallet.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

describe('ChannelServer (anvil:8547)', () => {
  beforeAll(async () => {
    anvil = await startAnvil();

    usdcAddress = await deployContract('src/mocks/MockUSDC.sol:MockUSDC');
    channelAddress = await deployContract('src/PaymentChannel.sol:PaymentChannel');

    publicClient = createAnvilPublicClient();
    payeeWallet = createAnvilWallet(ACCOUNTS.deployer.pk);
    payerWallet = createAnvilWallet(ACCOUNTS.account1.pk);
    strangerWallet = createAnvilWallet(ACCOUNTS.account2.pk);

    await mintUsdc(payeeWallet, publicClient, usdcAddress, PAYER, usdc(1000));
    await approveToken(payerWallet, publicClient, usdcAddress, channelAddress, usdc(1000));

    tempDir = await mkdtemp(join(tmpdir(), 'vp-sdk-provider-'));
  }, 300_000);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await stopAnvil(anvil);
    anvil = null;
  }, 20_000);

  it('verifies signed payments, tracks channel state, and emits payment:received', async () => {
    const channelId = await openTestChannel(3600);
    const server = makeServer(8790);
    const received: PaymentReceivedEvent[] = [];
    server.events.on('payment:received', (e) => received.push(e));

    await server.start();
    try {
      const session = makeSession(channelId, 8790);

      const r1 = await session.request<{ ok: boolean; echo: { n: number } }>({ n: 1 });
      const r2 = await session.request<{ ok: boolean; echo: { n: number } }>({ n: 2 });

      expect(r1.ok).toBe(true);
      expect(r1.echo).toEqual({ n: 1 });
      expect(r2.echo).toEqual({ n: 2 });

      const state = server.getChannelState(channelId);
      expect(state).toBeDefined();
      expect(state!.cumulativeSpent).toBe(2n * PRICE);
      expect(state!.lastNonce).toBe(2n);
      expect(state!.payer.toLowerCase()).toBe(PAYER.toLowerCase());
      expect(state!.deposit).toBe(DEPOSIT);
      // ChannelSession sends a close signature with every request; the server
      // must retain the latest one for settlement.
      expect(state!.closeSignature).toMatch(/^0x[a-fA-F0-9]+$/);

      expect(received).toHaveLength(2);
      expect(received[0].perRequestSpent).toBe(PRICE);
      expect(received[1].perRequestSpent).toBe(PRICE);
      expect(received[1].cumulativeSpent).toBe(2n * PRICE);
    } finally {
      await server.stop();
    }
  });

  it('rejects replayed proofs and non-increasing spent/nonce', async () => {
    const channelId = await openTestChannel(3600);
    const server = makeServer(8791);
    await server.start();
    try {
      const first = await sendRaw({ port: 8791, channelId, spent: 1_000n, nonce: 1n });
      expect(first.status).toBe(200);

      // Exact replay of the same proof.
      const replay = await sendRaw({ port: 8791, channelId, spent: 1_000n, nonce: 1n });
      expect(replay.status).toBe(409);
      expect(((await replay.json()) as { code: string }).code).toBe('SPENT_NOT_INCREASED');

      // Higher spent but stale nonce.
      const staleNonce = await sendRaw({ port: 8791, channelId, spent: 2_000n, nonce: 1n });
      expect(staleNonce.status).toBe(409);
      expect(((await staleNonce.json()) as { code: string }).code).toBe('NONCE_NOT_INCREASED');

      // Lower spent with fresh nonce.
      const lowerSpent = await sendRaw({ port: 8791, channelId, spent: 500n, nonce: 2n });
      expect(lowerSpent.status).toBe(409);
      expect(((await lowerSpent.json()) as { code: string }).code).toBe('SPENT_NOT_INCREASED');

      // A strictly increasing proof still works after the rejections.
      const ok = await sendRaw({ port: 8791, channelId, spent: 2_000n, nonce: 2n });
      expect(ok.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('rejects proofs signed by anyone but the channel payer, missing headers, and non-POST', async () => {
    const channelId = await openTestChannel(3600);
    const server = makeServer(8792);
    await server.start();
    try {
      const forged = await sendRaw({
        port: 8792,
        channelId,
        spent: 1_000n,
        nonce: 1n,
        signer: strangerWallet,
      });
      expect(forged.status).toBe(401);
      expect(((await forged.json()) as { code: string }).code).toBe('INVALID_SIGNATURE');

      const missing = await fetch('http://127.0.0.1:8792', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: 'ping' }),
      });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { code: string }).code).toBe('MISSING_HEADERS');

      const wrongMethod = await fetch('http://127.0.0.1:8792', { method: 'GET' });
      expect(wrongMethod.status).toBe(405);
    } finally {
      await server.stop();
    }
  });

  it('serves on-chain channel reads from the 30s cache until invalidated', async () => {
    const channelId = await openTestChannel(3600);
    const server = makeServer(8793);
    await server.start();
    try {
      const first = await sendRaw({ port: 8793, channelId, spent: 1_000n, nonce: 1n });
      expect(first.status).toBe(200);

      // The channel is closed on-chain behind the server's back...
      await closeChannelExternally(channelId, 1_000n);
      const onChain = await getOnChainChannel(publicClient, channelAddress, channelId);
      expect(onChain.status).toBe(1); // Settled

      // ...but the 30s cache still says Open, so the next proof is accepted.
      const cached = await sendRaw({ port: 8793, channelId, spent: 2_000n, nonce: 2n });
      expect(cached.status).toBe(200);

      // After invalidation the server re-reads the chain and refuses.
      server.invalidateChannelCache(channelId);
      const refreshed = await sendRaw({ port: 8793, channelId, spent: 3_000n, nonce: 3n });
      expect(refreshed.status).toBe(410);
      expect(((await refreshed.json()) as { code: string }).code).toBe('CHANNEL_NOT_OPEN');
    } finally {
      await server.stop();
    }
  });

  it('C3: hydrates persisted proofs after a restart and keeps replay protection', async () => {
    const channelId = await openTestChannel(3600);
    const storePath = join(tempDir, 'restart-store.json');

    const server1 = makeServer(8794, { stateStore: new FileChannelStateStore(storePath) });
    await server1.start();
    try {
      expect((await sendRaw({
        port: 8794, channelId, spent: 1_000n, nonce: 1n, includeCloseSig: true,
      })).status).toBe(200);
      expect((await sendRaw({
        port: 8794, channelId, spent: 2_000n, nonce: 2n, includeCloseSig: true,
      })).status).toBe(200);
    } finally {
      await server1.stop();
    }

    // Simulated restart: a brand-new instance sharing only the state file.
    const server2 = makeServer(8794, { stateStore: new FileChannelStateStore(storePath) });
    await server2.start();
    try {
      // Hydrated before any request arrives.
      const hydrated = server2.getChannelState(channelId);
      expect(hydrated).toBeDefined();
      expect(hydrated!.cumulativeSpent).toBe(2_000n);
      expect(hydrated!.lastNonce).toBe(2n);
      expect(hydrated!.closeSignature).toMatch(/^0x[a-fA-F0-9]+$/);

      // Replaying the pre-restart proof must fail.
      const replay = await sendRaw({ port: 8794, channelId, spent: 2_000n, nonce: 2n });
      expect(replay.status).toBe(409);

      const rollback = await sendRaw({ port: 8794, channelId, spent: 1_500n, nonce: 3n });
      expect(rollback.status).toBe(409);

      // Fresh, strictly-increasing proofs continue to work.
      const ok = await sendRaw({ port: 8794, channelId, spent: 3_000n, nonce: 3n });
      expect(ok.status).toBe(200);
    } finally {
      await server2.stop();
    }
  });

  it('C2: auto-settles an open channel near expiry using the latest stored proof', async () => {
    const channelId = await openTestChannel(50); // inside the default 300s margin
    const server = makeServer(8795, {
      autoSettle: { enabled: true, pollIntervalMs: 250 },
    });
    const closedEvents: ChannelClosedEvent[] = [];
    server.events.on('channel:closed', (e) => closedEvents.push(e));

    const payeeBalanceBefore = await balanceOf(publicClient, usdcAddress, PAYEE);

    await server.start();
    try {
      const session = makeSession(channelId, 8795);
      await session.request({ job: 'settle-me' });

      const settled = await waitUntil(
        async () => {
          const ch = await getOnChainChannel(publicClient, channelAddress, channelId);
          return ch.status === 1 ? ch : undefined;
        },
        { timeoutMs: 20_000, label: 'auto-settlement to land on-chain' },
      );

      expect(settled.spent).toBe(PRICE);

      const payeeBalanceAfter = await balanceOf(publicClient, usdcAddress, PAYEE);
      expect(payeeBalanceAfter - payeeBalanceBefore).toBe(PRICE);

      // Settled channels are dropped from tracking and persistence.
      await waitUntil(
        async () => server.getChannelState(channelId) === undefined,
        { timeoutMs: 10_000, label: 'settled channel to be removed from tracking' },
      );

      expect(closedEvents).toHaveLength(1);
      expect(closedEvents[0].channelId).toBe(channelId);
      expect(closedEvents[0].spent).toBe(PRICE);
      expect(closedEvents[0].refunded).toBe(DEPOSIT - PRICE);
      expect(closedEvents[0].txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    } finally {
      await server.stop();
    }
  });

  it('C2: a channel closed by someone else is cleaned up gracefully (no double close)', async () => {
    const channelId = await openTestChannel(50);
    const server = makeServer(8796, {
      autoSettle: { enabled: true, pollIntervalMs: 2_500 },
    });
    const closedEvents: ChannelClosedEvent[] = [];
    server.events.on('channel:closed', (e) => closedEvents.push(e));

    await server.start();
    try {
      const ok = await sendRaw({
        port: 8796, channelId, spent: 1_000n, nonce: 1n, includeCloseSig: true,
      });
      expect(ok.status).toBe(200);
      expect(server.getChannelState(channelId)).toBeDefined();

      // Someone else settles first — before the first auto-settle sweep fires.
      await closeChannelExternally(channelId, 1_000n);

      // The sweep must notice the closed channel and drop it without reverting.
      await waitUntil(
        async () => server.getChannelState(channelId) === undefined,
        { timeoutMs: 15_000, label: 'externally closed channel to be pruned' },
      );

      const onChain = await getOnChainChannel(publicClient, channelAddress, channelId);
      expect(onChain.status).toBe(1);
      // The server did not settle it itself.
      expect(closedEvents).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it('C2+C3: auto-settlement works from hydrated state after a restart', async () => {
    const channelId = await openTestChannel(60);
    const storePath = join(tempDir, 'autosettle-restart.json');

    // First life: receives the proof, does NOT auto-settle.
    const server1 = makeServer(8797, { stateStore: new FileChannelStateStore(storePath) });
    await server1.start();
    try {
      const ok = await sendRaw({
        port: 8797, channelId, spent: 1_500n, nonce: 1n, includeCloseSig: true,
      });
      expect(ok.status).toBe(200);
    } finally {
      await server1.stop();
    }

    const payeeBalanceBefore = await balanceOf(publicClient, usdcAddress, PAYEE);

    // Second life: no new requests — settlement must come purely from
    // the hydrated proof + close signature.
    const server2 = makeServer(8797, {
      stateStore: new FileChannelStateStore(storePath),
      autoSettle: { enabled: true, pollIntervalMs: 250 },
    });
    await server2.start();
    try {
      const settled = await waitUntil(
        async () => {
          const ch = await getOnChainChannel(publicClient, channelAddress, channelId);
          return ch.status === 1 ? ch : undefined;
        },
        { timeoutMs: 20_000, label: 'hydrated auto-settlement to land on-chain' },
      );

      expect(settled.spent).toBe(1_500n);

      const payeeBalanceAfter = await balanceOf(publicClient, usdcAddress, PAYEE);
      expect(payeeBalanceAfter - payeeBalanceBefore).toBe(1_500n);
    } finally {
      await server2.stop();
    }
  });
});
