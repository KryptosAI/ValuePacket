/** ChannelSession — wraps an open payment channel and handles per-request micropayments */

import type { WalletClient, PublicClient } from 'viem';
import { signPaymentProof, signChannelClose, createPaymentProofHeader } from './signing.js';
import { PAYMENT_CHANNEL_ABI } from './contracts.js';
import {
  InsufficientFundsError,
  HttpRequestError,
} from './errors.js';
import { ChannelServer } from './provider.js';

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
 * Configuration for creating a ChannelSession.
 */
export interface ChannelSessionConfig {
  channelId: bigint;
  payer: WalletClient;
  publicClient: PublicClient;
  payeeEndpoint: string;
  pricePerRequest: bigint;
  token: `0x${string}`;
  deposit: bigint;
  verifyingContract: `0x${string}`;
  paymentChannelAddress: `0x${string}`;
}

/**
 * ChannelSession represents an active payment channel from the payer's
 * perspective. Each call to `request()` automatically generates a signed
 * PaymentProof and includes it as HTTP headers, making it feel like a
 * normal HTTP request with automatic micropayment settlement.
 *
 * Usage:
 * ```typescript
 * const session = await agentPay.openChannel({ provider, token, deposit, expiresIn });
 * session.setEndpoint('https://api.provider.com');
 * session.setPricePerRequest(1000000n);
 * const result = await session.request<ChatResponse>({ prompt: 'Hello' });
 * ```
 */
export class ChannelSession {
  readonly channelId: bigint;
  readonly token: `0x${string}`;
  readonly deposit: bigint;

  private payer: WalletClient;
  private publicClient: PublicClient;
  private payeeEndpoint: string;
  private pricePerRequest: bigint;
  private verifyingContract: `0x${string}`;
  private paymentChannelAddress: `0x${string}`;

  /** Total amount spent so far across all requests. */
  cumulativeSpent: bigint;
  /** Current request counter, incremented per request. */
  nonce: bigint;

  constructor(config: ChannelSessionConfig) {
    this.channelId = config.channelId;
    this.payer = config.payer;
    this.publicClient = config.publicClient;
    this.payeeEndpoint = config.payeeEndpoint;
    this.pricePerRequest = config.pricePerRequest;
    this.token = config.token;
    this.deposit = config.deposit;
    this.verifyingContract = config.verifyingContract;
    this.paymentChannelAddress = config.paymentChannelAddress;

    this.cumulativeSpent = 0n;
    this.nonce = 0n;
  }

  /**
   * Sets the endpoint URL for the service provider.
   */
  setEndpoint(endpoint: string): void {
    this.payeeEndpoint = endpoint;
  }

  /**
   * Sets the price per request. Used to compute cumulativeSpent = pricePerRequest * nonce.
   */
  setPricePerRequest(price: bigint): void {
    this.pricePerRequest = price;
  }

  /**
   * Sets the starting state for a resumed channel.
   * Use when restoring a ChannelSession after server restart or reconnection.
   */
  setState(spent: bigint, requestNonce: bigint): void {
    this.cumulativeSpent = spent;
    this.nonce = requestNonce;
  }

  /**
   * Makes a paid request to the service provider.
   *
   * 1. Increments the nonce and computes the new cumulative spent.
   * 2. Signs an EIP-712 PaymentProof.
   * 3. POSTs the request body to the payee's endpoint with payment headers.
   * 4. Parses and returns the response body.
   *
   * @param body - The request payload (serialized as JSON in the POST body).
   * @returns The parsed JSON response from the service provider.
   * @throws {InsufficientFundsError} if cumulativeSpent exceeds the deposit.
   * @throws {HttpRequestError} if the provider returns a non-200 status.
   */
  async request<T = unknown>(body: Record<string, unknown>): Promise<T> {
    this.nonce += 1n;
    const newSpent = this.pricePerRequest * this.nonce;

    if (newSpent > this.deposit) {
      throw new InsufficientFundsError(newSpent, this.deposit);
    }

    const signature = await signPaymentProof(
      this.payer,
      this.verifyingContract,
      this.channelId,
      newSpent,
      body,
      this.nonce,
    );

    const headers = createPaymentProofHeader(
      this.channelId,
      newSpent,
      body,
      this.nonce,
      signature,
    );

    const response = await fetch(this.payeeEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Channel-Id': headers.channelId,
        'X-Cumulative-Spent': headers.cumulativeSpent,
        'X-Payment-Proof': headers.proof,
        'X-Request-Nonce': headers.nonce,
        'X-Request-Hash': headers.requestHash,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let responseBody = '';
      try {
        responseBody = await response.text();
      } catch {
        // ignore
      }
      throw new HttpRequestError(response.status, this.payeeEndpoint, responseBody);
    }

    this.cumulativeSpent = newSpent;

    const data = await response.json() as T;
    return data;
  }

  /**
   * Closes the channel by signing a ChannelClose EIP-712 message and
   * submitting it on-chain. The difference between deposit and spent
   * is refunded to the payer.
   *
   * @returns The transaction hash, total spent, and refunded amount.
   */
  async close(): Promise<{ txHash: `0x${string}`; spent: bigint; refunded: bigint }> {
    if (!this.payer.account) {
      throw new Error('Payer wallet has no account configured');
    }

    const spent = this.cumulativeSpent;
    const refunded = this.deposit - spent;

    const signature = await signChannelClose(
      this.payer,
      this.verifyingContract,
      this.channelId,
      spent,
    );

    const { request } = await this.publicClient.simulateContract({
      address: this.paymentChannelAddress,
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'closeChannel',
      args: [this.channelId, spent, signature],
      account: this.payer.account,
    });

    const txHash = await this.payer.writeContract(request);

    return { txHash, spent, refunded };
  }

  /**
   * Closes the channel as the payer. If the channel has expired,
   * calls `refundChannel` to reclaim the full deposit. Otherwise,
   * signs and submits `closeChannel` with the current spent amount.
   *
   * @returns The transaction hash and refunded amount.
   */
  async closeAsPayer(): Promise<{ txHash: `0x${string}`; refunded: bigint }> {
    if (!this.payer.account) {
      throw new Error('Payer wallet has no account configured');
    }

    const result = await this.publicClient.readContract({
      address: this.paymentChannelAddress,
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'getChannel',
      args: [this.channelId],
    });

    const channel = result as unknown as ViemChannel;

    if (channel.status !== 0) {
      throw new Error(`Channel ${this.channelId.toString()} is already closed`);
    }

    const now = Math.floor(Date.now() / 1000);

    if (now >= channel.expiresAt) {
      const { request } = await this.publicClient.simulateContract({
        address: this.paymentChannelAddress,
        abi: PAYMENT_CHANNEL_ABI,
        functionName: 'refundChannel',
        args: [this.channelId],
        account: this.payer.account,
      });

      const txHash = await this.payer.writeContract(request);

      return { txHash, refunded: this.deposit };
    }

    const signature = await signChannelClose(
      this.payer,
      this.verifyingContract,
      this.channelId,
      this.cumulativeSpent,
    );

    const { request } = await this.publicClient.simulateContract({
      address: this.paymentChannelAddress,
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'closeChannel',
      args: [this.channelId, this.cumulativeSpent, signature],
      account: this.payer.account,
    });

    const txHash = await this.payer.writeContract(request);

    return { txHash, refunded: this.deposit - this.cumulativeSpent };
  }

  /**
   * Creates a ChannelServer for service providers to handle incoming
   * paid requests from payment channels.
   *
   * @param config - Server configuration with wallet, contract address, and handler.
   * @returns A configured ChannelServer instance.
   */
  static async serve(config: {
    wallet: WalletClient;
    publicClient: PublicClient;
    paymentChannelAddress: `0x${string}`;
    port: number;
    handler: (request: {
      body: unknown;
      channelId: bigint;
      cumulativeSpent: bigint;
    }) => Promise<unknown>;
  }): Promise<ChannelServer> {
    const server = new ChannelServer({
      wallet: config.wallet,
      publicClient: config.publicClient,
      paymentChannelAddress: config.paymentChannelAddress,
      port: config.port,
      handler: config.handler,
    });

    return server;
  }
}
