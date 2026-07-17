/** ChannelServer — HTTP server for agents that PROVIDE services and receive payments */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { WalletClient, PublicClient } from 'viem';
import { recoverTypedDataAddress } from 'viem';
import { PAYMENT_PROOF_TYPE } from './signing.js';
import { PAYMENT_CHANNEL_ABI } from './contracts.js';
import { SettlementWorker } from './extensions/settlement.js';
import {
  InvalidSignatureError,
  InsufficientFundsError,
  AgentSettlementError,
} from './errors.js';
import { ValuePacketEvents } from './extensions/events.js';
import type { ChannelStateStore, ChannelState } from './extensions/persistence.js';
import { MemoryChannelStateStore } from './extensions/persistence.js';

const DOMAIN_NAME = 'ValuePacket';
const DOMAIN_VERSION = '1';

interface ViemChannel {
  payer: `0x${string}`;
  payee: `0x${string}`;
  token: `0x${string}`;
  deposit: bigint;
  spent: bigint;
  openedAt: number;
  expiresAt: number;
  policy: `0x${string}`;
  metadata: `0x${string}`;
  status: number;
}

/**
 * Opt-in automatic settlement of channels that are close to expiry.
 */
export interface AutoSettleConfig {
  /** Master switch. When false the poller never starts. */
  enabled: boolean;
  /**
   * How many seconds before a channel's expiry auto-settlement kicks in.
   * Defaults to 300 (5 minutes).
   */
  marginSeconds?: number;
  /**
   * How often the poller scans tracked channels, in milliseconds.
   * Defaults to 30000 (30 seconds).
   */
  pollIntervalMs?: number;
}

/**
 * Configuration for the ChannelServer.
 */
export interface ChannelServerConfig {
  wallet: WalletClient;
  publicClient: PublicClient;
  paymentChannelAddress: `0x${string}`;
  port: number;
  handler: (request: {
    body: unknown;
    channelId: bigint;
    cumulativeSpent: bigint;
  }) => Promise<unknown>;
  /**
   * Persistent store for per-channel payment state. Defaults to an
   * in-memory store. Provide a FileChannelStateStore (or custom
   * implementation) so replay protection and auto-settlement survive
   * process restarts.
   */
  stateStore?: ChannelStateStore;
  /** @deprecated Use `stateStore` instead. Kept for backwards compatibility. */
  store?: ChannelStateStore;
  settlementWorker?: SettlementWorker;
  /** Opt-in automatic settlement of channels nearing expiry. */
  autoSettle?: AutoSettleConfig;
}

/**
 * ChannelServer is an HTTP server that handles incoming requests from payment
 * channels. It verifies PaymentProof signatures, tracks per-channel spending,
 * and can automatically settle channels when a spending threshold is reached.
 *
 * Usage:
 * ```typescript
 * const server = await ChannelSession.serve({
 *   wallet, publicClient, paymentChannelAddress,
 *   port: 8080,
 *   handler: async ({ body, channelId, cumulativeSpent }) => {
 *     const result = await myAgent.process(body);
 *     return result;
 *   },
 * });
 * await server.start();
 * ```
 */
export class ChannelServer {
  private wallet: WalletClient;
  private publicClient: PublicClient;
  private paymentChannelAddress: `0x${string}`;
  private port: number;
  private handler: (request: {
    body: unknown;
    channelId: bigint;
    cumulativeSpent: bigint;
  }) => Promise<unknown>;
  private settlementWorker: SettlementWorker | null;
  private httpServer: Server | null;
  private channels: Map<bigint, ChannelState>;
  private store: ChannelStateStore;
  private channelCache: Map<bigint, { channel: ViemChannel; timestamp: number }>;
  private readonly CACHE_TTL_MS = 30_000;

  private autoSettleEnabled: boolean;
  private autoSettleMarginSeconds: number;
  private autoSettlePollIntervalMs: number;
  private autoSettleTimer: NodeJS.Timeout | null;
  private autoSettleSweepInFlight: boolean;
  private settling: Set<bigint>;

  public readonly events = new ValuePacketEvents();

  constructor(config: ChannelServerConfig) {
    this.wallet = config.wallet;
    this.publicClient = config.publicClient;
    this.paymentChannelAddress = config.paymentChannelAddress;
    this.port = config.port;
    this.handler = config.handler;
    this.settlementWorker = config.settlementWorker ?? null;
    this.httpServer = null;
    this.channels = new Map();
    this.channelCache = new Map();
    this.store = config.stateStore ?? config.store ?? new MemoryChannelStateStore();

    this.autoSettleEnabled = config.autoSettle?.enabled ?? false;
    this.autoSettleMarginSeconds = config.autoSettle?.marginSeconds ?? 300;
    this.autoSettlePollIntervalMs = config.autoSettle?.pollIntervalMs ?? 30_000;
    this.autoSettleTimer = null;
    this.autoSettleSweepInFlight = false;
    this.settling = new Set();
  }

  /**
   * Starts the HTTP server and begins listening for incoming paid requests.
   * Previously persisted channel proofs are hydrated from the state store so
   * replay protection and auto-settlement survive restarts.
   */
  async start(): Promise<void> {
    if (this.httpServer) {
      throw new Error('Server is already running');
    }

    await this.hydrateFromStore();

    if (this.settlementWorker) {
      this.settlementWorker.start();
    }

    if (this.autoSettleEnabled) {
      this.startAutoSettlePoller();
    }

    this.httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }));
          return;
        }

        const body = await this.parseRequestBody(req);

        const paymentHeaders = this.extractPaymentHeaders(req);
        if (!paymentHeaders) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing payment proof headers', code: 'MISSING_HEADERS' }));
          return;
        }

        const channelId = BigInt(paymentHeaders.channelId);
        const cumulativeSpent = BigInt(paymentHeaders.cumulativeSpent);
        const nonce = BigInt(paymentHeaders.nonce);
        const proof = paymentHeaders.proof as `0x${string}`;
        const requestHash = paymentHeaders.requestHash as `0x${string}`;

        // Verify the PaymentProof signature against the payer's address
        const { payerAddress, channel } = await this.verifyProof(
          channelId,
          cumulativeSpent,
          requestHash,
          nonce,
          proof,
        );

        // Check or initialize channel state
        const prevState = this.channels.get(channelId);
        const perRequestSpent = prevState
          ? cumulativeSpent - prevState.cumulativeSpent
          : cumulativeSpent;

        const closeSignature = this.extractCloseSignature(req);

        await this.validateAndTrackChannel(
          channelId,
          cumulativeSpent,
          nonce,
          payerAddress,
          closeSignature,
        );

        // Track for automatic settlement if a close signature is provided
        if (this.settlementWorker && closeSignature) {
          this.settlementWorker.trackChannel(
            channelId,
            cumulativeSpent,
            channel.expiresAt,
            closeSignature,
          );
        }

        // Process the request via the handler
        const result = await this.handler({
          body,
          channelId,
          cumulativeSpent,
        });

        this.events.emit('payment:received', {
          channelId,
          payer: payerAddress,
          cumulativeSpent,
          perRequestSpent,
          nonce,
          body,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        this.handleError(res, error);
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, () => {
        resolve();
      });
      this.httpServer!.on('error', (err: Error) => {
        reject(err);
      });
    });
  }

  /**
   * Stops the HTTP server gracefully and clears the auto-settlement poller.
   */
  async stop(): Promise<void> {
    if (this.autoSettleTimer) {
      clearInterval(this.autoSettleTimer);
      this.autoSettleTimer = null;
    }

    if (this.settlementWorker) {
      this.settlementWorker.stop();
    }

    if (!this.httpServer) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.close((err?: Error) => {
        if (err) {
          reject(err);
        } else {
          this.httpServer = null;
          resolve();
        }
      });
    });
  }

  /**
   * Returns the current tracked state for a channel, or undefined
   * if no requests have been received for that channel yet.
   */
  getChannelState(channelId: bigint): ChannelState | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Invalidates the cached on-chain channel data for a given channel ID.
   * Call this after settling or closing a channel so that subsequent
   * requests re-read the current on-chain state.
   */
  invalidateChannelCache(channelId: bigint): void {
    this.channelCache.delete(channelId);
  }

  /**
   * Removes a channel from in-memory tracking and persistent storage.
   * Call this when a channel is settled or closed.
   */
  async removeChannel(channelId: bigint): Promise<void> {
    this.channels.delete(channelId);
    this.channelCache.delete(channelId);
    await this.store.delete(channelId);
  }

  // ── Private methods ─────────────────────────────────────────────

  private async hydrateFromStore(): Promise<void> {
    const persisted = await this.store.getAll();
    for (const [channelId, state] of persisted) {
      if (!this.channels.has(channelId)) {
        this.channels.set(channelId, state);
      }
    }
  }

  private startAutoSettlePoller(): void {
    if (this.autoSettleTimer) {
      return;
    }

    this.autoSettleTimer = setInterval(() => {
      if (this.autoSettleSweepInFlight) {
        return;
      }
      this.autoSettleSweepInFlight = true;
      this.runAutoSettleSweep()
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ChannelServer] Auto-settle sweep failed: ${message}`);
        })
        .finally(() => {
          this.autoSettleSweepInFlight = false;
        });
    }, this.autoSettlePollIntervalMs);

    this.autoSettleTimer.unref();
  }

  private async runAutoSettleSweep(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    for (const [channelId, state] of [...this.channels]) {
      if (this.settling.has(channelId)) continue;
      if (!state.closeSignature) continue;
      if (state.cumulativeSpent <= 0n) continue;
      if (now < state.expiresAt - this.autoSettleMarginSeconds) continue;

      this.settling.add(channelId);
      try {
        await this.autoSettleChannel(channelId, state);
      } finally {
        this.settling.delete(channelId);
      }
    }
  }

  private async autoSettleChannel(channelId: bigint, state: ChannelState): Promise<void> {
    try {
      // Re-read fresh on-chain state so a channel closed by another party
      // (payer refund, manual close, competing worker) is handled gracefully.
      this.channelCache.delete(channelId);
      const channel = await this.getCachedChannel(channelId);

      if (channel.status !== 0) {
        await this.removeChannel(channelId);
        return;
      }

      // The channel may have been extended since we first tracked it.
      if (channel.expiresAt !== state.expiresAt) {
        state.expiresAt = channel.expiresAt;
        await this.store.set(channelId, state);
        const now = Math.floor(Date.now() / 1000);
        if (now < channel.expiresAt - this.autoSettleMarginSeconds) {
          return;
        }
      }

      if (!this.wallet.account) {
        console.error(
          `[ChannelServer] Cannot auto-settle channel ${channelId.toString()}: wallet has no account configured`,
        );
        return;
      }

      const spent = state.cumulativeSpent;
      const signature = state.closeSignature!;

      const { request } = await this.publicClient.simulateContract({
        address: this.paymentChannelAddress,
        abi: PAYMENT_CHANNEL_ABI,
        functionName: 'closeChannel',
        args: [channelId, spent, signature],
        account: this.wallet.account,
      });

      const txHash = await this.wallet.writeContract(request);
      await this.publicClient.waitForTransactionReceipt({ hash: txHash });

      console.log(
        `[ChannelServer] Auto-settled channel ${channelId.toString()}: spent=${spent.toString()} tx=${txHash}`,
      );

      this.events.emit('channel:closed', {
        channelId,
        spent,
        refunded: state.deposit - spent,
        txHash,
      });

      await this.removeChannel(channelId);
    } catch (err: unknown) {
      // Race: the channel may have been closed between the status check and
      // our submission. Re-check and clean up instead of failing loudly.
      const cleaned = await this.cleanupIfClosed(channelId);
      if (!cleaned) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[ChannelServer] Auto-settle failed for channel ${channelId.toString()}: ${message}`,
        );
      }
    }
  }

  private async cleanupIfClosed(channelId: bigint): Promise<boolean> {
    try {
      this.channelCache.delete(channelId);
      const channel = await this.getCachedChannel(channelId);
      if (channel.status !== 0) {
        await this.removeChannel(channelId);
        return true;
      }
    } catch {
      // Could not re-read the channel; leave state for the next sweep.
    }
    return false;
  }

  private async getCachedChannel(channelId: bigint): Promise<ViemChannel> {
    const cached = this.channelCache.get(channelId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.channel;
    }
    const result = await this.publicClient.readContract({
      address: this.paymentChannelAddress,
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'getChannel',
      args: [channelId],
    });
    const channel = result as unknown as ViemChannel;
    this.channelCache.set(channelId, { channel, timestamp: Date.now() });
    return channel;
  }

  private async verifyProof(
    channelId: bigint,
    cumulativeSpent: bigint,
    requestHash: `0x${string}`,
    nonce: bigint,
    proof: `0x${string}`,
  ): Promise<{ payerAddress: `0x${string}`; channel: ViemChannel }> {
    if (!this.wallet.chain) {
      throw new Error('Wallet has no chain configured');
    }

    const chainId = await this.wallet.getChainId();

    const recoveredAddress = await recoverTypedDataAddress({
      domain: {
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        chainId,
        verifyingContract: this.paymentChannelAddress,
      },
      types: PAYMENT_PROOF_TYPE,
      primaryType: 'PaymentProof',
      message: {
        channelId,
        cumulativeSpent,
        requestHash,
        nonce,
      },
      signature: proof,
    });

    const channel = await this.getCachedChannel(channelId);

    const expectedPayer = channel.payer;

    if (recoveredAddress.toLowerCase() !== expectedPayer.toLowerCase()) {
      throw new InvalidSignatureError(
        `Recovered signer ${recoveredAddress} does not match channel payer ${expectedPayer}`,
      );
    }

    if (channel.status !== 0) {
      this.invalidateChannelCache(channelId);
      await this.store.delete(channelId);
      throw new AgentSettlementError(
        `Channel ${channelId.toString()} is not open (status: ${channel.status})`,
        'CHANNEL_NOT_OPEN',
      );
    }

    return { payerAddress: expectedPayer, channel };
  }

  private async validateAndTrackChannel(
    channelId: bigint,
    cumulativeSpent: bigint,
    nonce: bigint,
    payerAddress: `0x${string}`,
    closeSignature: `0x${string}` | null,
  ): Promise<void> {
    let existing = this.channels.get(channelId);

    if (existing) {
      if (cumulativeSpent <= existing.cumulativeSpent) {
        throw new AgentSettlementError(
          `Cumulative spent ${cumulativeSpent.toString()} is not greater than previous ${existing.cumulativeSpent.toString()} for channel ${channelId.toString()}`,
          'SPENT_NOT_INCREASED',
        );
      }

      if (nonce <= existing.lastNonce) {
        throw new AgentSettlementError(
          `Nonce ${nonce.toString()} is not greater than previous ${existing.lastNonce.toString()} for channel ${channelId.toString()}`,
          'NONCE_NOT_INCREASED',
        );
      }

      existing.cumulativeSpent = cumulativeSpent;
      existing.lastNonce = nonce;
      if (closeSignature) {
        existing.closeSignature = closeSignature;
      }
      await this.store.set(channelId, existing);
      return;
    }

    const persisted = await this.store.get(channelId);
    if (persisted) {
      if (persisted.payer.toLowerCase() !== payerAddress.toLowerCase()) {
        throw new AgentSettlementError(
          `Stored payer ${persisted.payer} does not match verified payer ${payerAddress}`,
          'PAYER_MISMATCH',
        );
      }

      if (cumulativeSpent <= persisted.cumulativeSpent) {
        throw new AgentSettlementError(
          `Cumulative spent ${cumulativeSpent.toString()} is not greater than persisted ${persisted.cumulativeSpent.toString()} for channel ${channelId.toString()}`,
          'SPENT_NOT_INCREASED',
        );
      }

      if (nonce <= persisted.lastNonce) {
        throw new AgentSettlementError(
          `Nonce ${nonce.toString()} is not greater than persisted ${persisted.lastNonce.toString()} for channel ${channelId.toString()}`,
          'NONCE_NOT_INCREASED',
        );
      }

      persisted.cumulativeSpent = cumulativeSpent;
      persisted.lastNonce = nonce;
      if (closeSignature) {
        persisted.closeSignature = closeSignature;
      }
      this.channels.set(channelId, persisted);
      await this.store.set(channelId, persisted);
      return;
    }

    const channel = await this.getCachedChannel(channelId);

    const state: ChannelState = {
      channelId,
      cumulativeSpent,
      lastNonce: nonce,
      payer: payerAddress,
      deposit: channel.deposit,
      expiresAt: channel.expiresAt,
      ...(closeSignature ? { closeSignature } : {}),
    };
    this.channels.set(channelId, state);
    await this.store.set(channelId, state);
  }

  private extractPaymentHeaders(req: IncomingMessage): {
    channelId: string;
    cumulativeSpent: string;
    nonce: string;
    proof: string;
    requestHash: string;
  } | null {
    const channelId = req.headers['x-channel-id'];
    const cumulativeSpent = req.headers['x-cumulative-spent'];
    const proof = req.headers['x-payment-proof'];
    const nonce = req.headers['x-request-nonce'];
    const requestHash = req.headers['x-request-hash'];

    if (!channelId || !cumulativeSpent || !proof || !nonce || !requestHash) {
      return null;
    }

    return {
      channelId: Array.isArray(channelId) ? channelId[0] : channelId,
      cumulativeSpent: Array.isArray(cumulativeSpent) ? cumulativeSpent[0] : cumulativeSpent,
      nonce: Array.isArray(nonce) ? nonce[0] : nonce,
      proof: Array.isArray(proof) ? proof[0] : proof,
      requestHash: Array.isArray(requestHash) ? requestHash[0] : requestHash,
    };
  }

  private extractCloseSignature(req: IncomingMessage): `0x${string}` | null {
    const header = req.headers['x-close-signature'];
    if (!header) {
      return null;
    }
    const value = Array.isArray(header) ? header[0] : header;
    return value as `0x${string}`;
  }

  private parseRequestBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];

      req.on('data', (chunk: Uint8Array) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
          const buffer = Buffer.concat(chunks, totalLength);
          const raw = buffer.toString('utf-8');
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch {
          reject(new AgentSettlementError(
            'Failed to parse JSON body',
            'INVALID_JSON',
          ));
        }
      });

      req.on('error', (err: Error) => {
        reject(new AgentSettlementError(
          `Request body read error: ${err.message}`,
          'BODY_READ_ERROR',
        ));
      });
    });
  }

  private handleError(res: ServerResponse, error: unknown): void {
    if (error instanceof InvalidSignatureError) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: error.message,
        code: error.code,
      }));
      return;
    }

    if (error instanceof InsufficientFundsError) {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: error.message,
        code: error.code,
      }));
      return;
    }

    if (error instanceof AgentSettlementError) {
      const statusCode = this.errorCodeToStatus(error.code);
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: error.message,
        code: error.code,
      }));
      return;
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: message,
      code: 'INTERNAL_ERROR',
    }));
  }

  private errorCodeToStatus(code: string): number {
    switch (code) {
      case 'CHANNEL_NOT_OPEN':
        return 410;
      case 'SPENT_NOT_INCREASED':
      case 'NONCE_NOT_INCREASED':
        return 409;
      case 'INVALID_JSON':
        return 400;
      default:
        return 500;
    }
  }
}
