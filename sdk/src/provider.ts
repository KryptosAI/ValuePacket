/** ChannelServer — HTTP server for agents that PROVIDE services and receive payments */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { WalletClient, PublicClient } from 'viem';
import { recoverTypedDataAddress } from 'viem';
import { PAYMENT_PROOF_TYPE } from './signing.js';
import { PAYMENT_CHANNEL_ABI } from './contracts.js';
import {
  InvalidSignatureError,
  InsufficientFundsError,
  AgentSettlementError,
} from './errors.js';

const DOMAIN_NAME = 'ValuePacket';
const DOMAIN_VERSION = '1';

interface ChannelState {
  channelId: bigint;
  cumulativeSpent: bigint;
  lastNonce: bigint;
  payer: `0x${string}`;
  deposit: bigint;
}

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
  private httpServer: Server | null;
  private channels: Map<bigint, ChannelState>;

  constructor(config: ChannelServerConfig) {
    this.wallet = config.wallet;
    this.publicClient = config.publicClient;
    this.paymentChannelAddress = config.paymentChannelAddress;
    this.port = config.port;
    this.handler = config.handler;
    this.httpServer = null;
    this.channels = new Map();
  }

  /**
   * Starts the HTTP server and begins listening for incoming paid requests.
   */
  async start(): Promise<void> {
    if (this.httpServer) {
      throw new Error('Server is already running');
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
        const payerAddress = await this.verifyProof(
          channelId,
          cumulativeSpent,
          requestHash,
          nonce,
          proof,
        );

        // Check or initialize channel state
        await this.validateAndTrackChannel(
          channelId,
          cumulativeSpent,
          nonce,
          payerAddress,
        );

        // Process the request via the handler
        const result = await this.handler({
          body,
          channelId,
          cumulativeSpent,
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
   * Stops the HTTP server gracefully.
   */
  async stop(): Promise<void> {
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

  // ── Private methods ─────────────────────────────────────────────

  private async verifyProof(
    channelId: bigint,
    cumulativeSpent: bigint,
    requestHash: `0x${string}`,
    nonce: bigint,
    proof: `0x${string}`,
  ): Promise<`0x${string}`> {
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

    const result = await this.publicClient.readContract({
      address: this.paymentChannelAddress,
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'getChannel',
      args: [channelId],
    });

    const channel = result as unknown as ViemChannel;

    const expectedPayer = channel.payer;

    if (recoveredAddress.toLowerCase() !== expectedPayer.toLowerCase()) {
      throw new InvalidSignatureError(
        `Recovered signer ${recoveredAddress} does not match channel payer ${expectedPayer}`,
      );
    }

    if (channel.status !== 0) {
      throw new AgentSettlementError(
        `Channel ${channelId.toString()} is not open (status: ${channel.status})`,
        'CHANNEL_NOT_OPEN',
      );
    }

    return expectedPayer;
  }

  private async validateAndTrackChannel(
    channelId: bigint,
    cumulativeSpent: bigint,
    nonce: bigint,
    payerAddress: `0x${string}`,
  ): Promise<void> {
    const existing = this.channels.get(channelId);

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
    } else {
      const result = await this.publicClient.readContract({
        address: this.paymentChannelAddress,
        abi: PAYMENT_CHANNEL_ABI,
        functionName: 'getChannel',
        args: [channelId],
      });

      const channel = result as unknown as ViemChannel;

      this.channels.set(channelId, {
        channelId,
        cumulativeSpent,
        lastNonce: nonce,
        payer: payerAddress,
        deposit: channel.deposit,
      });
    }
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
