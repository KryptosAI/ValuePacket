import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryChannelStateStore,
  FileChannelStateStore,
  type ChannelState,
} from '../src/extensions/persistence.js';

const PAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const SIG = ('0x' + 'ab'.repeat(65)) as `0x${string}`;

function makeState(overrides: Partial<ChannelState> = {}): ChannelState {
  return {
    channelId: 1n,
    cumulativeSpent: 5_000n,
    lastNonce: 5n,
    payer: PAYER,
    deposit: 1_000_000n,
    expiresAt: 1_900_000_000,
    ...overrides,
  };
}

describe('MemoryChannelStateStore', () => {
  let store: MemoryChannelStateStore;

  beforeEach(() => {
    store = new MemoryChannelStateStore();
  });

  it('returns null for unknown channels', async () => {
    expect(await store.get(42n)).toBeNull();
  });

  it('sets and gets channel state with bigint fidelity', async () => {
    const state = makeState({ channelId: 42n, cumulativeSpent: 123456789012345678901n });
    await store.set(42n, state);

    const loaded = await store.get(42n);
    expect(loaded).not.toBeNull();
    expect(loaded!.channelId).toBe(42n);
    expect(loaded!.cumulativeSpent).toBe(123456789012345678901n);
    expect(loaded!.lastNonce).toBe(5n);
    expect(loaded!.payer).toBe(PAYER);
  });

  it('lists all stored channels via getAll', async () => {
    await store.set(1n, makeState({ channelId: 1n }));
    await store.set(2n, makeState({ channelId: 2n, cumulativeSpent: 9n }));

    const all = await store.getAll();
    expect(all.size).toBe(2);
    expect(all.get(1n)!.channelId).toBe(1n);
    expect(all.get(2n)!.cumulativeSpent).toBe(9n);
  });

  it('deletes channels', async () => {
    await store.set(7n, makeState({ channelId: 7n }));
    await store.delete(7n);
    expect(await store.get(7n)).toBeNull();
    expect((await store.getAll()).size).toBe(0);
  });

  it('deleting a missing channel is a no-op', async () => {
    await expect(store.delete(999n)).resolves.toBeUndefined();
  });

  it('stores the optional closeSignature', async () => {
    await store.set(3n, makeState({ channelId: 3n, closeSignature: SIG }));
    const loaded = await store.get(3n);
    expect(loaded!.closeSignature).toBe(SIG);
  });
});

describe('FileChannelStateStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vp-sdk-persist-'));
    filePath = join(dir, 'nested', 'channels.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist yet', async () => {
    const store = new FileChannelStateStore(filePath);
    expect(await store.get(1n)).toBeNull();
  });

  it('persists state to disk and reloads it in a fresh instance', async () => {
    const store = new FileChannelStateStore(filePath);
    await store.set(11n, makeState({ channelId: 11n, closeSignature: SIG }));

    const reloaded = new FileChannelStateStore(filePath);
    const loaded = await reloaded.get(11n);
    expect(loaded).not.toBeNull();
    expect(loaded!.channelId).toBe(11n);
    expect(loaded!.cumulativeSpent).toBe(5_000n);
    expect(loaded!.deposit).toBe(1_000_000n);
    expect(loaded!.expiresAt).toBe(1_900_000_000);
    expect(loaded!.closeSignature).toBe(SIG);
  });

  it('serializes bigints as strings in the underlying JSON file', async () => {
    const store = new FileChannelStateStore(filePath);
    await store.set(11n, makeState({ channelId: 11n }));

    const raw = JSON.parse(await readFile(filePath, 'utf-8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(raw['11']).toBeDefined();
    expect(raw['11'].channelId).toBe('11');
    expect(raw['11'].cumulativeSpent).toBe('5000');
    expect(raw['11'].deposit).toBe('1000000');
    expect(typeof raw['11'].expiresAt).toBe('number');
  });

  it('omits closeSignature from JSON when not set and keeps it when set', async () => {
    const store = new FileChannelStateStore(filePath);
    await store.set(1n, makeState({ channelId: 1n }));
    await store.set(2n, makeState({ channelId: 2n, closeSignature: SIG }));

    const raw = JSON.parse(await readFile(filePath, 'utf-8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(raw['1'].closeSignature).toBeUndefined();
    expect(raw['2'].closeSignature).toBe(SIG);
  });

  it('persists deletes across instances', async () => {
    const store = new FileChannelStateStore(filePath);
    await store.set(1n, makeState({ channelId: 1n }));
    await store.set(2n, makeState({ channelId: 2n }));
    await store.delete(1n);

    const reloaded = new FileChannelStateStore(filePath);
    expect(await reloaded.get(1n)).toBeNull();
    expect(await reloaded.get(2n)).not.toBeNull();
    expect((await reloaded.getAll()).size).toBe(1);
  });

  it('tolerates a corrupted file and starts fresh', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(filePath, 'this is {{ not json !!', 'utf-8');

    const store = new FileChannelStateStore(filePath);
    expect(await store.get(1n)).toBeNull();
    expect((await store.getAll()).size).toBe(0);

    // Writes after corruption produce a valid file again.
    await store.set(5n, makeState({ channelId: 5n }));
    const reloaded = new FileChannelStateStore(filePath);
    expect((await reloaded.get(5n))!.channelId).toBe(5n);
  });

  it('tolerates partially malformed entries without throwing on load', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(filePath, JSON.stringify({ '1': { channelId: 'not-a-number' } }), 'utf-8');

    const store = new FileChannelStateStore(filePath);
    // BigInt('not-a-number') throws inside load; the store must swallow it.
    expect(await store.get(2n)).toBeNull();
    await store.set(2n, makeState({ channelId: 2n }));
    expect((await store.get(2n))!.channelId).toBe(2n);
  });

  it('handles concurrent-ish writes from one instance without losing entries', async () => {
    const store = new FileChannelStateStore(filePath);

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.set(BigInt(i), makeState({ channelId: BigInt(i), lastNonce: BigInt(i) })),
      ),
    );

    const all = await store.getAll();
    expect(all.size).toBe(25);

    const reloaded = new FileChannelStateStore(filePath);
    const allReloaded = await reloaded.getAll();
    expect(allReloaded.size).toBe(25);
    for (let i = 0; i < 25; i++) {
      expect(allReloaded.get(BigInt(i))!.lastNonce).toBe(BigInt(i));
    }
  });

  it('overwrites existing entries with the latest state', async () => {
    const store = new FileChannelStateStore(filePath);
    await store.set(9n, makeState({ channelId: 9n, cumulativeSpent: 1n, lastNonce: 1n }));
    await store.set(9n, makeState({ channelId: 9n, cumulativeSpent: 2n, lastNonce: 2n }));

    const loaded = await store.get(9n);
    expect(loaded!.cumulativeSpent).toBe(2n);
    expect(loaded!.lastNonce).toBe(2n);
  });
});
