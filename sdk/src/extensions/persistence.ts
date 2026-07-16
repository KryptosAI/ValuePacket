import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ChannelState {
  channelId: bigint;
  cumulativeSpent: bigint;
  lastNonce: bigint;
  payer: `0x${string}`;
  deposit: bigint;
  expiresAt: number;
}

export interface ChannelStateStore {
  get(channelId: bigint): Promise<ChannelState | null>;
  set(channelId: bigint, state: ChannelState): Promise<void>;
  delete(channelId: bigint): Promise<void>;
  getAll(): Promise<Map<bigint, ChannelState>>;
}

export class MemoryChannelStateStore implements ChannelStateStore {
  private store = new Map<string, ChannelState>();

  async get(channelId: bigint): Promise<ChannelState | null> {
    return this.store.get(channelId.toString()) ?? null;
  }

  async set(channelId: bigint, state: ChannelState): Promise<void> {
    this.store.set(channelId.toString(), state);
  }

  async delete(channelId: bigint): Promise<void> {
    this.store.delete(channelId.toString());
  }

  async getAll(): Promise<Map<bigint, ChannelState>> {
    const result = new Map<bigint, ChannelState>();
    for (const [key, value] of this.store.entries()) {
      result.set(BigInt(key), value);
    }
    return result;
  }
}

interface SerializedChannelState {
  channelId: string;
  cumulativeSpent: string;
  lastNonce: string;
  payer: string;
  deposit: string;
  expiresAt: number;
}

export class FileChannelStateStore implements ChannelStateStore {
  private filePath: string;
  private store: Map<string, ChannelState>;
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? '.valuepacket/channels.json';
    this.store = new Map();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, SerializedChannelState>;
      for (const [key, value] of Object.entries(data)) {
        this.store.set(key, {
          channelId: BigInt(value.channelId),
          cumulativeSpent: BigInt(value.cumulativeSpent),
          lastNonce: BigInt(value.lastNonce),
          payer: value.payer as `0x${string}`,
          deposit: BigInt(value.deposit),
          expiresAt: value.expiresAt,
        });
      }
    } catch {
      // File doesn't exist or is malformed; start fresh
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const data: Record<string, SerializedChannelState> = {};
    for (const [key, value] of this.store.entries()) {
      data[key] = {
        channelId: value.channelId.toString(),
        cumulativeSpent: value.cumulativeSpent.toString(),
        lastNonce: value.lastNonce.toString(),
        payer: value.payer,
        deposit: value.deposit.toString(),
        expiresAt: value.expiresAt,
      };
    }
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async get(channelId: bigint): Promise<ChannelState | null> {
    await this.ensureLoaded();
    return this.store.get(channelId.toString()) ?? null;
  }

  async set(channelId: bigint, state: ChannelState): Promise<void> {
    await this.ensureLoaded();
    this.store.set(channelId.toString(), state);
    await this.persist();
  }

  async delete(channelId: bigint): Promise<void> {
    await this.ensureLoaded();
    this.store.delete(channelId.toString());
    await this.persist();
  }

  async getAll(): Promise<Map<bigint, ChannelState>> {
    await this.ensureLoaded();
    const result = new Map<bigint, ChannelState>();
    for (const [key, value] of this.store.entries()) {
      result.set(BigInt(key), value);
    }
    return result;
  }
}
