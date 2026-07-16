/** SubscriptionSession — wraps ValuePacket's SubscriptionManager for recurring agent payments */

import type { WalletClient, PublicClient } from 'viem';
import { keccak256, encodeAbiParameters, decodeEventLog } from 'viem';
import { ChannelSession } from '../channel.js';
import { InsufficientFundsError, HttpRequestError } from '../errors.js';

// ─── SubscriptionManager ABI ──────────────────────────────────────

export const SUBSCRIPTION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'createSubscription',
    inputs: [
      { name: 'payee', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amountPerPeriod', type: 'uint256' },
      { name: 'periodDuration', type: 'uint32' },
      { name: 'maxPeriods', type: 'uint256' },
      { name: 'initialDeposit', type: 'uint256' },
      { name: 'metadata', type: 'bytes' },
    ],
    outputs: [{ name: 'subscriptionId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'renew',
    inputs: [
      { name: 'subscriptionId', type: 'uint256' },
      { name: 'spent', type: 'uint256' },
      { name: 'salt', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'newChannelId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancelSubscription',
    inputs: [{ name: 'subscriptionId', type: 'uint256' }],
    outputs: [{ name: 'refunded', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getSubscription',
    inputs: [{ name: 'subscriptionId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'payer', type: 'address' },
          { name: 'payee', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'amountPerPeriod', type: 'uint256' },
          { name: 'periodDuration', type: 'uint32' },
          { name: 'maxPeriods', type: 'uint256' },
          { name: 'completedPeriods', type: 'uint32' },
          { name: 'totalSpent', type: 'uint256' },
          { name: 'remainingBalance', type: 'uint256' },
          { name: 'currentChannelId', type: 'uint256' },
          { name: 'active', type: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'SubscriptionCreated',
    inputs: [
      { name: 'subscriptionId', type: 'uint256', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'channelId', type: 'uint256', indexed: false },
      { name: 'initialDeposit', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SubscriptionRenewed',
    inputs: [
      { name: 'subscriptionId', type: 'uint256', indexed: true },
      { name: 'newChannelId', type: 'uint256', indexed: false },
      { name: 'periodNumber', type: 'uint32', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SubscriptionCancelled',
    inputs: [
      { name: 'subscriptionId', type: 'uint256', indexed: true },
      { name: 'refunded', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'SubscriptionNotFound',
    inputs: [{ name: 'subscriptionId', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'SubscriptionNotActive',
    inputs: [{ name: 'subscriptionId', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'NotPayer',
    inputs: [
      { name: 'subscriptionId', type: 'uint256' },
      { name: 'caller', type: 'address' },
      { name: 'payer', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'InvalidSignature',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InsufficientBalance',
    inputs: [
      { name: 'required', type: 'uint256' },
      { name: 'available', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'MaxPeriodsReached',
    inputs: [
      { name: 'subscriptionId', type: 'uint256' },
      { name: 'completed', type: 'uint32' },
      { name: 'max', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'InvalidInitialDeposit',
    inputs: [
      { name: 'deposit', type: 'uint256' },
      { name: 'amountPerPeriod', type: 'uint256' },
    ],
  },
] as const;

// ─── EIP-712 Type ─────────────────────────────────────────────────

export const SUBSCRIPTION_AUTH_TYPE = {
  SubscriptionAuth: [
    { name: 'subscriptionId', type: 'uint256' },
    { name: 'amountPerPeriod', type: 'uint256' },
    { name: 'periodDuration', type: 'uint32' },
    { name: 'maxPeriods', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const;

const DOMAIN_NAME = 'ValuePacket';
const DOMAIN_VERSION = '1';

interface ViemSubscription {
  id: bigint;
  payer: `0x${string}`;
  payee: `0x${string}`;
  token: `0x${string}`;
  amountPerPeriod: bigint;
  periodDuration: number;
  maxPeriods: bigint;
  completedPeriods: number;
  totalSpent: bigint;
  remainingBalance: bigint;
  currentChannelId: bigint;
  active: boolean;
}

// ─── Configuration ────────────────────────────────────────────────

/**
 * Configuration for creating a SubscriptionSession.
 */
export interface SubscriptionConfig {
  payee: `0x${string}`;
  token: `0x${string}`;
  amountPerPeriod: bigint;
  periodDuration: number;
  maxPeriods: number;
  initialDeposit: bigint;
  metadata?: `0x${string}`;
  subscriptionManagerAddress: `0x${string}`;
  paymentChannelAddress: `0x${string}`;
}

// ─── SubscriptionSession ──────────────────────────────────────────

/**
 * SubscriptionSession manages a recurring payment subscription through
 * ValuePacket's SubscriptionManager contract. It handles auto-renewal
 * of payment channels per billing period, balance tracking, and cancellation.
 *
 * Each period's payment channel can be used for per-request micropayments
 * via the `request()` method, which works identically to ChannelSession.
 *
 * Usage:
 * ```typescript
 * const session = await SubscriptionSession.create(wallet, publicClient, {
 *   payee: '0x...',
 *   token: '0x...',
 *   amountPerPeriod: 10000000n,  // 10 USDC per period
 *   periodDuration: 2592000,     // 30 days
 *   maxPeriods: 12,
 *   initialDeposit: 120000000n,  // 12 periods worth
 *   subscriptionManagerAddress: '0x...',
 *   paymentChannelAddress: '0x...',
 * });
 *
 * session.setPricePerRequest(100000n);
 * const result = await session.request('https://api.provider.com', { prompt: 'Hello' });
 * ```
 */
export class SubscriptionSession {
  subscriptionId: bigint;
  payer: WalletClient;
  payee: `0x${string}`;
  token: `0x${string}`;
  amountPerPeriod: bigint;
  periodDuration: number;
  maxPeriods: number;
  completedPeriods: number;
  totalSpent: bigint;
  remainingBalance: bigint;

  private publicClient!: PublicClient;
  private subscriptionManagerAddress: `0x${string}`;
  private paymentChannelAddress: `0x${string}`;
  private currentChannel: ChannelSession | null;
  private pricePerRequest: bigint;
  private metadata: `0x${string}`;

  /**
   * Constructs a SubscriptionSession shell. Use `SubscriptionSession.create()`
   * or `SubscriptionSession.load()` to obtain a fully initialized session.
   */
  constructor(config: SubscriptionConfig) {
    this.subscriptionId = 0n;
    this.payer = undefined!;
    this.payee = config.payee;
    this.token = config.token;
    this.amountPerPeriod = config.amountPerPeriod;
    this.periodDuration = config.periodDuration;
    this.maxPeriods = config.maxPeriods;
    this.completedPeriods = 0;
    this.totalSpent = 0n;
    this.remainingBalance = config.initialDeposit;

    this.subscriptionManagerAddress = config.subscriptionManagerAddress;
    this.paymentChannelAddress = config.paymentChannelAddress;
    this.currentChannel = null;
    this.pricePerRequest = 0n;
    this.metadata = config.metadata ?? '0x';
  }

  /**
   * Creates a new subscription on-chain by calling `createSubscription` on
   * the SubscriptionManager contract. Opens the first payment channel
   * pre-funded with `amountPerPeriod` and returns a ready-to-use session.
   *
   * @param wallet - The payer's WalletClient (must have account configured).
   * @param publicClient - A PublicClient for reading from the chain.
   * @param config - Subscription configuration including payee, token, amounts, and contract addresses.
   * @returns A fully initialized SubscriptionSession bound to the new on-chain subscription.
   */
  static async create(
    wallet: WalletClient,
    publicClient: PublicClient,
    config: SubscriptionConfig,
  ): Promise<SubscriptionSession> {
    if (!wallet.account) {
      throw new Error('Wallet has no account configured');
    }

    const { request } = await publicClient.simulateContract({
      address: config.subscriptionManagerAddress,
      abi: SUBSCRIPTION_MANAGER_ABI,
      functionName: 'createSubscription',
      args: [
        config.payee,
        config.token,
        config.amountPerPeriod,
        config.periodDuration,
        BigInt(config.maxPeriods),
        config.initialDeposit,
        config.metadata ?? '0x',
      ],
      account: wallet.account,
    });

    const txHash = await wallet.writeContract(request);

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    const parsed = parseSubscriptionCreatedLog(
      receipt.logs,
      config.subscriptionManagerAddress,
    );

    if (!parsed) {
      throw new Error('SubscriptionCreated event not found in transaction receipt');
    }

    const { subscriptionId, channelId } = parsed;

    const session = new SubscriptionSession(config);
    session.subscriptionId = subscriptionId;
    session.payer = wallet;
    session.publicClient = publicClient;
    session.remainingBalance = config.initialDeposit - config.amountPerPeriod;

    session.currentChannel = new ChannelSession({
      channelId,
      payer: wallet,
      publicClient,
      payeeEndpoint: '',
      pricePerRequest: 0n,
      token: config.token,
      deposit: config.amountPerPeriod,
      verifyingContract: config.paymentChannelAddress,
      paymentChannelAddress: config.paymentChannelAddress,
    });

    return session;
  }

  /**
   * Loads an existing subscription from on-chain by its ID. Reconstructs
   * the current payment channel so that `request()` calls work immediately.
   *
   * @param wallet - The payer's WalletClient.
   * @param publicClient - A PublicClient for reading from the chain.
   * @param subscriptionId - The on-chain subscription ID to load.
   * @param subscriptionManagerAddress - The SubscriptionManager contract address.
   * @param paymentChannelAddress - The PaymentChannel contract address.
   * @returns A SubscriptionSession reflecting the current on-chain state.
   */
  static async load(
    wallet: WalletClient,
    publicClient: PublicClient,
    subscriptionId: bigint,
    subscriptionManagerAddress: `0x${string}`,
    paymentChannelAddress: `0x${string}`,
  ): Promise<SubscriptionSession> {
    const result = await publicClient.readContract({
      address: subscriptionManagerAddress,
      abi: SUBSCRIPTION_MANAGER_ABI,
      functionName: 'getSubscription',
      args: [subscriptionId],
    });

    const sub = result as unknown as ViemSubscription;

    if (sub.id === 0n || !sub.active) {
      throw new Error(`Subscription ${subscriptionId.toString()} not found or is not active`);
    }

    const session = new SubscriptionSession({
      payee: sub.payee,
      token: sub.token,
      amountPerPeriod: sub.amountPerPeriod,
      periodDuration: sub.periodDuration,
      maxPeriods: Number(sub.maxPeriods),
      initialDeposit: sub.remainingBalance + sub.totalSpent,
      metadata: '0x',
      subscriptionManagerAddress,
      paymentChannelAddress,
    });

    session.subscriptionId = sub.id;
    session.payer = wallet;
    session.publicClient = publicClient;
    session.completedPeriods = sub.completedPeriods;
    session.totalSpent = sub.totalSpent;
    session.remainingBalance = sub.remainingBalance;

    session.currentChannel = new ChannelSession({
      channelId: sub.currentChannelId,
      payer: wallet,
      publicClient,
      payeeEndpoint: '',
      pricePerRequest: 0n,
      token: sub.token,
      deposit: sub.amountPerPeriod,
      verifyingContract: paymentChannelAddress,
      paymentChannelAddress,
    });

    return session;
  }

  /**
   * Sets the price per request used by `request()`. This is forwarded
   * to the internal ChannelSession.
   */
  setPricePerRequest(price: bigint): void {
    this.pricePerRequest = price;
    if (this.currentChannel) {
      this.currentChannel.setPricePerRequest(price);
    }
  }

  /**
   * Sets the service endpoint for the current channel.
   */
  setEndpoint(endpoint: string): void {
    if (this.currentChannel) {
      this.currentChannel.setEndpoint(endpoint);
    }
  }

  /**
   * Makes a paid request to the service provider using the current
   * period's payment channel. Works identically to ChannelSession.request().
   *
   * 1. Forwards the endpoint to the internal channel's configuration.
   * 2. Signs an EIP-712 PaymentProof for this request.
   * 3. POSTs the request body with payment headers.
   * 4. Parses and returns the response body.
   *
   * @param endpoint - The provider's API endpoint URL.
   * @param body - The request payload (serialized as JSON in the POST body).
   * @returns The parsed JSON response from the service provider.
   * @throws {InsufficientFundsError} if the current channel's deposit is exceeded.
   * @throws {HttpRequestError} if the provider returns a non-200 status.
   */
  async request<T = unknown>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    if (!this.currentChannel) {
      throw new Error('Subscription has no active channel. Call SubscriptionSession.create() or load() first.');
    }

    this.currentChannel.setEndpoint(endpoint);
    this.currentChannel.setPricePerRequest(this.pricePerRequest);

    const result = await this.currentChannel.request<T>(body);

    this.totalSpent += this.pricePerRequest;

    return result;
  }

  /**
   * Triggers renewal of the subscription for the next billing period.
   * Signs an EIP-712 SubscriptionAuth authorization, submits it on-chain,
   * and switches to the newly created payment channel.
   *
   * The salt is derived from `keccak256(abi.encode(subscriptionId, completedPeriods + 1))`
   * to prevent replay attacks across periods.
   *
   * @returns The transaction hash and the new payment channel ID.
   */
  async renew(spent: bigint = 0n): Promise<{ txHash: `0x${string}`; newChannelId: bigint }> {
    if (!this.payer.account) {
      throw new Error('Payer wallet has no account configured');
    }

    const signature = await this.signRenewAuthorization();

    const { request } = await this.publicClient.simulateContract({
      address: this.subscriptionManagerAddress,
      abi: SUBSCRIPTION_MANAGER_ABI,
      functionName: 'renew',
      args: [
        this.subscriptionId,
        spent,
        computeRenewalSalt(this.subscriptionId, this.completedPeriods + 1),
        signature,
      ],
      account: this.payer.account,
    });

    const txHash = await this.payer.writeContract(request);

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    const newChannelId = parseSubscriptionRenewedLog(
      receipt.logs,
      this.subscriptionManagerAddress,
    );

    if (newChannelId === null) {
      throw new Error('SubscriptionRenewed event not found in transaction receipt');
    }

    this.totalSpent += spent;
    this.completedPeriods += 1;
    this.remainingBalance -= this.amountPerPeriod;

    this.currentChannel = new ChannelSession({
      channelId: newChannelId,
      payer: this.payer,
      publicClient: this.publicClient,
      payeeEndpoint: '',
      pricePerRequest: this.pricePerRequest,
      token: this.token,
      deposit: this.amountPerPeriod,
      verifyingContract: this.paymentChannelAddress,
      paymentChannelAddress: this.paymentChannelAddress,
    });

    return { txHash, newChannelId };
  }

  /**
   * Cancels the subscription on-chain. Settles the current payment channel
   * and refunds the remaining balance (unused channel deposit + uncommitted
   * period funds) to the payer.
   *
   * Only the payer can call this method.
   *
   * @returns The transaction hash and the total amount refunded in wei.
   */
  async cancel(): Promise<{ txHash: `0x${string}`; refunded: bigint }> {
    if (!this.payer.account) {
      throw new Error('Payer wallet has no account configured');
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.subscriptionManagerAddress,
      abi: SUBSCRIPTION_MANAGER_ABI,
      functionName: 'cancelSubscription',
      args: [this.subscriptionId],
      account: this.payer.account,
    });

    const txHash = await this.payer.writeContract(request);

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    const refunded = parseSubscriptionCancelledLog(
      receipt.logs,
      this.subscriptionManagerAddress,
    );

    if (refunded === null) {
      throw new Error('SubscriptionCancelled event not found in transaction receipt');
    }

    this.currentChannel = null;
    this.remainingBalance = 0n;

    return { txHash, refunded };
  }

  /**
   * Fetches the latest subscription state from on-chain and updates
   * all local fields to match.
   */
  async refresh(): Promise<void> {
    const result = await this.publicClient.readContract({
      address: this.subscriptionManagerAddress,
      abi: SUBSCRIPTION_MANAGER_ABI,
      functionName: 'getSubscription',
      args: [this.subscriptionId],
    });

    const sub = result as unknown as ViemSubscription;

    this.completedPeriods = sub.completedPeriods;
    this.totalSpent = sub.totalSpent;
    this.remainingBalance = sub.remainingBalance;

    if (sub.currentChannelId !== 0n) {
      if (!this.currentChannel || this.currentChannel.channelId !== sub.currentChannelId) {
        this.currentChannel = new ChannelSession({
          channelId: sub.currentChannelId,
          payer: this.payer,
          publicClient: this.publicClient,
          payeeEndpoint: '',
          pricePerRequest: this.pricePerRequest,
          token: this.token,
          deposit: sub.amountPerPeriod,
          verifyingContract: this.paymentChannelAddress,
          paymentChannelAddress: this.paymentChannelAddress,
        });
      }
    }
  }

  /**
   * Signs an EIP-712 `SubscriptionAuth` message authorizing the next
   * billing period's deduction. The signature includes a salt derived
   * from `keccak256(abi.encode(subscriptionId, completedPeriods + 1))`
   * so that each period requires a unique, non-replayable signature.
   *
   * The domain uses:
   * - name: "ValuePacket"
   * - version: "1"
   * - chainId: from the wallet
   * - verifyingContract: subscriptionManagerAddress
   *
   * @returns The signed EIP-712 payload as a hex string.
   */
  async signRenewAuthorization(): Promise<`0x${string}`> {
    if (!this.payer.chain) {
      throw new Error('Wallet has no chain configured');
    }
    if (!this.payer.account) {
      throw new Error('Wallet has no account configured');
    }

    const chainId = await this.payer.getChainId();

    const salt = computeRenewalSalt(
      this.subscriptionId,
      this.completedPeriods + 1,
    );

    const signature = await this.payer.signTypedData({
      account: this.payer.account,
      domain: {
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        chainId,
        verifyingContract: this.subscriptionManagerAddress,
      },
      types: SUBSCRIPTION_AUTH_TYPE,
      primaryType: 'SubscriptionAuth',
      message: {
        subscriptionId: this.subscriptionId,
        amountPerPeriod: this.amountPerPeriod,
        periodDuration: this.periodDuration,
        maxPeriods: BigInt(this.maxPeriods),
        salt,
      },
    });

    return signature;
  }
}

// ─── Event Parsing Helpers ────────────────────────────────────────

function parseSubscriptionCreatedLog(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  subscriptionManagerAddress: `0x${string}`,
): { subscriptionId: bigint; channelId: bigint } | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== subscriptionManagerAddress.toLowerCase()) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: SUBSCRIPTION_MANAGER_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });

      if (decoded.eventName === 'SubscriptionCreated') {
        const args = decoded.args as { subscriptionId: bigint; channelId: bigint };
        return {
          subscriptionId: args.subscriptionId,
          channelId: args.channelId,
        };
      }
    } catch {
      if (log.topics.length > 1 && log.topics[1]) {
        return {
          subscriptionId: BigInt(log.topics[1]),
          channelId: 0n,
        };
      }
    }
  }
  return null;
}

function parseSubscriptionRenewedLog(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  subscriptionManagerAddress: `0x${string}`,
): bigint | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== subscriptionManagerAddress.toLowerCase()) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: SUBSCRIPTION_MANAGER_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });

      if (decoded.eventName === 'SubscriptionRenewed') {
        return (decoded.args as { newChannelId: bigint }).newChannelId;
      }
    } catch {
      if (log.data && log.data !== '0x') {
        try {
          return BigInt(log.data);
        } catch {
          // fall through
        }
      }
    }
  }
  return null;
}

function parseSubscriptionCancelledLog(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  subscriptionManagerAddress: `0x${string}`,
): bigint | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== subscriptionManagerAddress.toLowerCase()) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: SUBSCRIPTION_MANAGER_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });

      if (decoded.eventName === 'SubscriptionCancelled') {
        return (decoded.args as { refunded: bigint }).refunded;
      }
    } catch {
      if (log.data && log.data !== '0x') {
        try {
          return BigInt(log.data);
        } catch {
          // fall through
        }
      }
    }
  }
  return null;
}

// ─── EIP-712 Salt ─────────────────────────────────────────────────

/**
 * Computes the replay-protection salt for a subscription renewal.
 * The salt is `keccak256(abi.encode(subscriptionId, completedPeriods + 1))`.
 *
 * This ensures each period requires a unique signature from the payer,
 * preventing the payee from reusing a previous authorization.
 */
function computeRenewalSalt(
  subscriptionId: bigint,
  nextPeriod: number,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'subscriptionId', type: 'uint256' },
        { name: 'nextPeriod', type: 'uint256' },
      ],
      [subscriptionId, BigInt(nextPeriod)],
    ),
  );
}
