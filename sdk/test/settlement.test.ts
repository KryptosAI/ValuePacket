import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WalletClient, PublicClient } from 'viem';
import { SettlementWorker } from '../src/extensions/settlement.js';

const PAYMENT_CHANNEL = '0x2222222222222222222222222222222222222222' as const;
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const TX_HASH = ('0x' + 'dd'.repeat(32)) as `0x${string}`;
const CLOSE_SIG = ('0x' + 'ee'.repeat(65)) as `0x${string}`;

const POLL_MS = 1_000;

interface Mocks {
  wallet: WalletClient;
  publicClient: PublicClient;
  simulateContract: ReturnType<typeof vi.fn>;
  writeContract: ReturnType<typeof vi.fn>;
}

function createMocks(overrides: { account?: unknown } = {}): Mocks {
  const simulateContract = vi.fn().mockResolvedValue({ request: { fake: true } });
  const writeContract = vi.fn().mockResolvedValue(TX_HASH);

  const wallet = {
    account: 'account' in overrides ? overrides.account : { address: PAYEE },
    writeContract,
  } as unknown as WalletClient;

  const publicClient = { simulateContract } as unknown as PublicClient;

  return { wallet, publicClient, simulateContract, writeContract };
}

function createWorker(mocks: Mocks): SettlementWorker {
  return new SettlementWorker({
    wallet: mocks.wallet,
    publicClient: mocks.publicClient,
    paymentChannelAddress: PAYMENT_CHANNEL,
    pollIntervalMs: POLL_MS,
  });
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('SettlementWorker', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let worker: SettlementWorker | null;

  beforeEach(() => {
    vi.useFakeTimers();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker = null;
  });

  afterEach(() => {
    worker?.stop();
    vi.useRealTimers();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('settles a channel that is inside the danger threshold', async () => {
    const mocks = createMocks();
    worker = createWorker(mocks);

    worker.trackChannel(5n, 1_234n, nowSeconds() + 100, CLOSE_SIG);
    worker.start();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushAsync();

    expect(mocks.simulateContract).toHaveBeenCalledTimes(1);
    expect(mocks.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: PAYMENT_CHANNEL,
        functionName: 'closeChannel',
        args: [5n, 1_234n, CLOSE_SIG],
        account: (mocks.wallet as { account: unknown }).account,
      }),
    );
    expect(mocks.writeContract).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('settled'));
  });

  it('removes a settled channel so it is not settled twice', async () => {
    const mocks = createMocks();
    worker = createWorker(mocks);

    worker.trackChannel(5n, 1_234n, nowSeconds() + 100, CLOSE_SIG);
    worker.start();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushAsync();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushAsync();

    expect(mocks.simulateContract).toHaveBeenCalledTimes(1);
    expect(mocks.writeContract).toHaveBeenCalledTimes(1);
  });

  it('leaves channels alone when expiry is far in the future', async () => {
    const mocks = createMocks();
    worker = createWorker(mocks);

    worker.trackChannel(6n, 999n, nowSeconds() + 7_200, CLOSE_SIG);
    worker.start();

    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    await flushAsync();

    expect(mocks.simulateContract).not.toHaveBeenCalled();
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });

  it('only settles the channels within the threshold when tracking several', async () => {
    const mocks = createMocks();
    worker = createWorker(mocks);

    worker.trackChannel(1n, 100n, nowSeconds() + 60, CLOSE_SIG);
    worker.trackChannel(2n, 200n, nowSeconds() + 7_200, CLOSE_SIG);
    worker.start();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushAsync();

    expect(mocks.simulateContract).toHaveBeenCalledTimes(1);
    expect(mocks.simulateContract.mock.calls[0][0].args[0]).toBe(1n);
  });

  it('uses the latest tracked proof when trackChannel is called repeatedly', async () => {
    const mocks = createMocks();
    worker = createWorker(mocks);

    const newerSig = ('0x' + 'ff'.repeat(65)) as `0x${string}`;
    worker.trackChannel(3n, 100n, nowSeconds() + 60, CLOSE_SIG);
    worker.trackChannel(3n, 400n, nowSeconds() + 60, newerSig);
    worker.start();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushAsync();

    expect(mocks.simulateContract).toHaveBeenCalledTimes(1);
    expect(mocks.simulateContract.mock.calls[0][0].args).toEqual([3n, 400n, newerSig]);
  });

  it('keeps the channel and retries after a settlement failure', async () => {
    const mocks = createMocks();
    mocks.simulateContract.mockRejectedValueOnce(new Error('nonce too low'));
    worker = createWorker(mocks);

    worker.trackChannel(4n, 500n, nowSeconds() + 60, CLOSE_SIG);
    worker.start();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushAsync();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to settle channel 4'));
    expect(mocks.writeContract).not.toHaveBeenCalled();

    // Next tick retries and succeeds.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushAsync();

    expect(mocks.simulateContract).toHaveBeenCalledTimes(2);
    expect(mocks.writeContract).toHaveBeenCalledTimes(1);
  });

  it('logs an error and skips settlement when the wallet has no account', async () => {
    const mocks = createMocks({ account: undefined });
    worker = createWorker(mocks);

    worker.trackChannel(8n, 100n, nowSeconds() + 60, CLOSE_SIG);
    worker.start();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushAsync();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('wallet has no account configured'),
    );
    expect(mocks.simulateContract).not.toHaveBeenCalled();
  });

  it('start() is idempotent — a second call does not double the polling', async () => {
    const mocks = createMocks();
    worker = createWorker(mocks);

    worker.trackChannel(9n, 100n, nowSeconds() + 60, CLOSE_SIG);
    worker.start();
    worker.start();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushAsync();

    expect(mocks.simulateContract).toHaveBeenCalledTimes(1);
  });

  it('stop() clears the poller so no further settlements occur', async () => {
    const mocks = createMocks();
    worker = createWorker(mocks);

    worker.trackChannel(10n, 100n, nowSeconds() + 60, CLOSE_SIG);
    worker.start();
    worker.stop();

    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    await flushAsync();

    expect(mocks.simulateContract).not.toHaveBeenCalled();

    // stop() again is safe.
    worker.stop();
  });
});
