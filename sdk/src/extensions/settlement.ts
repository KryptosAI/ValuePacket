/** SettlementWorker — monitors open channels and auto-settles them before expiry */

import type { WalletClient, PublicClient } from 'viem';
import { PAYMENT_CHANNEL_ABI } from '../contracts.js';

interface TrackedChannel {
  cumulativeSpent: bigint;
  expiresAt: number;
  closeSignature: `0x${string}`;
}

export class SettlementWorker {
  private wallet: WalletClient;
  private publicClient: PublicClient;
  private paymentChannelAddress: `0x${string}`;
  private channels: Map<bigint, TrackedChannel>;
  private interval: NodeJS.Timeout | null;
  private pollIntervalMs: number;

  constructor(config: {
    wallet: WalletClient;
    publicClient: PublicClient;
    paymentChannelAddress: `0x${string}`;
    pollIntervalMs?: number;
  }) {
    this.wallet = config.wallet;
    this.publicClient = config.publicClient;
    this.paymentChannelAddress = config.paymentChannelAddress;
    this.channels = new Map();
    this.interval = null;
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
  }

  trackChannel(
    channelId: bigint,
    cumulativeSpent: bigint,
    expiresAt: number,
    closeSignature: `0x${string}`,
  ): void {
    this.channels.set(channelId, {
      cumulativeSpent,
      expiresAt,
      closeSignature,
    });
  }

  start(): void {
    if (this.interval) {
      return;
    }

    this.interval = setInterval(() => {
      this.checkChannels().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[SettlementWorker] Error in check loop: ${message}`);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async checkChannels(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const DANGER_THRESHOLD = 3600;

    for (const [channelId, info] of this.channels) {
      if (info.expiresAt - now < DANGER_THRESHOLD) {
        await this.settleChannel(channelId, info.cumulativeSpent, info.closeSignature);
      }
    }
  }

  private async settleChannel(
    channelId: bigint,
    spent: bigint,
    signature: `0x${string}`,
  ): Promise<void> {
    if (!this.wallet.account) {
      console.error(
        `[SettlementWorker] Cannot settle channel ${channelId}: wallet has no account configured`,
      );
      return;
    }

    try {
      console.log(
        `[SettlementWorker] Settling channel ${channelId} with spent ${spent}...`,
      );

      const { request } = await this.publicClient.simulateContract({
        address: this.paymentChannelAddress,
        abi: PAYMENT_CHANNEL_ABI,
        functionName: 'closeChannel',
        args: [channelId, spent, signature],
        account: this.wallet.account,
      });

      const txHash = await this.wallet.writeContract(request);

      this.channels.delete(channelId);

      console.log(
        `[SettlementWorker] Channel ${channelId} settled. Spent: ${spent}, txHash: ${txHash}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[SettlementWorker] Failed to settle channel ${channelId}: ${message}`,
      );
    }
  }
}
