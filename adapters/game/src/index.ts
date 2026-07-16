import {
  AgentPay,
  ChannelSession,
  type AgentPayConfig,
  type DiscoveredService,
  type ServiceDescriptor,
  type Channel,
  ChannelStatus,
} from '@valuepacket/sdk';
import { createPublicClient, http, type WalletClient, type Address, type PublicClient } from 'viem';
import { getAddress } from 'viem';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the G.A.M.E ValuePacket adapter.
 */
export interface GameAgentConfig {
  /** Authenticated viem wallet client. */
  wallet: WalletClient;
  /** Address of the ServiceRegistry contract. */
  serviceRegistryAddress: string;
  /** Address of the PaymentChannel contract. */
  paymentChannelAddress: string;
  /** Optional SpendingPolicy contract address. */
  spendingPolicyAddress?: string;
  /** Optional indexer GraphQL endpoint for efficient service discovery. */
  indexerUrl?: string;
}

/**
 * Parameters for listing a service.
 */
export interface ListServiceParams {
  /** IPFS URI of the service descriptor metadata document. */
  metadataURI: string;
  /** Price per request in token smallest units (e.g. "50000" for 0.05 USDC). */
  pricePerRequest: string;
  /** Maximum response time in milliseconds. */
  maxResponseMs: number;
}

/**
 * Result of a successful service listing.
 */
export interface ListServiceResult {
  serviceId: string;
  txHash: string;
}

/**
 * Parameters for discovering agent services.
 */
export interface DiscoverAgentsParams {
  /** Filter by service type identifier (e.g. "prediction-feed"). */
  serviceType?: string;
  /** Filter by provider address. */
  provider?: string;
  /** Filter by maximum price per request in token smallest units. */
  maxPrice?: string;
  /** Filter by active status (defaults to true). */
  active?: boolean;
}

/**
 * Parameters for subscribing to a service (opening a payment channel).
 */
export interface SubscribeToServiceParams {
  /** The provider agent's wallet address. */
  provider: string;
  /** Settlement token address. */
  token: string;
  /** Deposit amount in token smallest units as a string. */
  deposit: string;
  /** Channel lifetime in hours from the time of opening. */
  expiresInHours: number;
  /** Optional spending policy contract address. */
  policy?: string;
  /** Optional request body to send immediately after opening. */
  requestBody?: Record<string, unknown>;
  /** Maximum expected number of requests (informational). */
  maxRequests?: number;
}

/**
 * Result of a channel close operation.
 */
export interface CloseChannelResult {
  txHash: string;
  spent: string;
  refunded: string;
}

/**
 * Summary of an active payment channel.
 */
export interface ActiveChannelInfo {
  /** On-chain channel ID. */
  channelId: string;
  /** Provider (payee) address. */
  provider: string;
  /** Payer address. */
  payer: string;
  /** Deposit amount in token smallest units. */
  deposit: string;
  /** Amount spent so far. */
  spent: string;
  /** Remaining balance. */
  remaining: string;
  /** Channel status (Open, Settled, Refunded). */
  status: string;
  /** Unix timestamp of expiry. */
  expiresAt: number;
  /** Token address. */
  token: string;
}

// ---------------------------------------------------------------------------
// AgentSettlementWorker
// ---------------------------------------------------------------------------

/**
 * Worker class for G.A.M.E agent integration with the ValuePacket Protocol.
 *
 * Provides a clean imperative API with result/error tuple patterns for robust
 * error handling. Each method returns `{ result }` on success or `{ error }` on failure.
 *
 * @example
 * ```typescript
 * import { AgentSettlementWorker } from '@valuepacket/adapter-game';
 * import { createWalletClient, http, privateKeyToAccount } from 'viem';
 * import { base } from 'viem/chains';
 *
 * const worker = new AgentSettlementWorker({
 *   wallet: createWalletClient({
 *     account: privateKeyToAccount('0x...'),
 *     chain: base,
 *     transport: http(),
 *   }),
 *   serviceRegistryAddress: '0x...',
 *   paymentChannelAddress: '0x...',
 * });
 *
 * // In a G.A.M.E worker function:
 * async function execute(state: Record<string, unknown>) {
 *   const { result, error } = await worker.discoverAgents({
 *     serviceType: state.serviceType as string,
 *   });
 *   if (error) return { status: 'error', message: error };
 *
 *   const { result: sub, error: subErr } = await worker.subscribeToService({
 *     provider: result[0].provider,
 *     token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
 *     deposit: '5000000',
 *     expiresInHours: 24,
 *     requestBody: { market: 'ETH/USDC' },
 *   });
 *   if (subErr) return { status: 'error', message: subErr };
 *
 *   return { status: 'success', data: sub };
 * }
 * ```
 */
export class AgentSettlementWorker {
  private pay: AgentPay;
  private publicClient: PublicClient;
  private channels: Map<string, ChannelSession> = new Map();
  private config: GameAgentConfig;

  constructor(config: GameAgentConfig) {
    this.config = config;

    if (!config.wallet.chain) {
      throw new Error('Wallet must have a chain configured');
    }

    this.publicClient = createPublicClient({
      chain: config.wallet.chain,
      transport: http(),
    });

    this.pay = new AgentPay({
      wallet: config.wallet,
      publicClient: this.publicClient,
      serviceRegistryAddress: getAddress(config.serviceRegistryAddress),
      paymentChannelAddress: getAddress(config.paymentChannelAddress),
      spendingPolicyAddress: config.spendingPolicyAddress
        ? getAddress(config.spendingPolicyAddress)
        : undefined,
      indexerUrl: config.indexerUrl,
    });
  }

  // ── Service registration ────────────────────────────────────────────────

  /**
   * Register this agent's service on-chain so other agents can discover and pay for it.
   *
   * @returns A result/error tuple with the service ID and transaction hash.
   */
  async listService(
    params: ListServiceParams,
  ): Promise<{ result?: ListServiceResult; error?: string }> {
    try {
      const { serviceId, txHash } = await this.pay.registerService({
        metadataURI: params.metadataURI,
        pricePerRequest: BigInt(params.pricePerRequest),
        maxResponseMs: params.maxResponseMs,
      });

      return {
        result: {
          serviceId: serviceId,
          txHash: txHash,
        },
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Failed to register service',
      };
    }
  }

  /**
   * Update an existing service's pricing or metadata.
   *
   * @param serviceId - The service ID from a previous {@link listService} call.
   * @param params - Updated service parameters.
   * @returns A result/error tuple with the transaction hash.
   */
  async updateService(
    serviceId: string,
    params: { metadataURI?: string; pricePerRequest?: string; maxResponseMs?: number },
  ): Promise<{ result?: { txHash: string }; error?: string }> {
    try {
      const { txHash } = await this.pay.updateService({
        serviceId: serviceId as `0x${string}`,
        metadataURI: params.metadataURI ?? '',
        pricePerRequest: params.pricePerRequest ? BigInt(params.pricePerRequest) : 0n,
        maxResponseMs: params.maxResponseMs ?? 0,
      });

      return { result: { txHash } };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Failed to update service',
      };
    }
  }

  /**
   * Deactivate a registered service so it's no longer discoverable.
   *
   * @param serviceId - The service ID to deactivate.
   * @returns A result/error tuple with the transaction hash.
   */
  async deactivateService(
    serviceId: string,
  ): Promise<{ result?: { txHash: string }; error?: string }> {
    try {
      const { txHash } = await this.pay.deactivateService(serviceId as `0x${string}`);
      return { result: { txHash } };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Failed to deactivate service',
      };
    }
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  /**
   * Discover agent services matching the given criteria.
   *
   * @returns A result/error tuple with an array of discovered services.
   */
  async discoverAgents(
    params?: DiscoverAgentsParams,
  ): Promise<{ result?: DiscoveredService[]; error?: string }> {
    try {
      const services = await this.pay.discover({
        serviceType: params?.serviceType,
        provider: params?.provider as `0x${string}` | undefined,
        maxPrice: params?.maxPrice ? BigInt(params.maxPrice) : undefined,
        active: params?.active,
      });

      return { result: services };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Failed to discover services',
      };
    }
  }

  /**
   * Fetch a single service by its on-chain ID.
   *
   * @param serviceId - The bytes32 service ID.
   * @returns A result/error tuple with the service data.
   */
  async getService(
    serviceId: string,
  ): Promise<{ result?: { provider: string; metadataURI: string; pricePerRequest: string; maxResponseMs: number; active: boolean }; error?: string }> {
    try {
      const svc = await this.pay.getService(serviceId as `0x${string}`);
      return {
        result: {
          provider: svc.provider,
          metadataURI: svc.metadataURI,
          pricePerRequest: svc.pricePerRequest.toString(),
          maxResponseMs: svc.maxResponseMs,
          active: svc.active,
        },
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Service not found',
      };
    }
  }

  /**
   * Resolve a service descriptor from an IPFS or Arweave URI.
   *
   * @param metadataURI - The metadata URI to resolve.
   * @returns A result/error tuple with the parsed service descriptor.
   */
  async resolveMetadata(
    metadataURI: string,
  ): Promise<{ result?: ServiceDescriptor; error?: string }> {
    try {
      const descriptor = await this.pay.resolveMetadata(metadataURI);
      return { result: descriptor };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Failed to resolve metadata',
      };
    }
  }

  // ── Payment channels ────────────────────────────────────────────────────

  /**
   * Open a payment channel with a provider and optionally make an initial request.
   * The channel stays open for subsequent requests via {@link makeRequest}.
   *
   * @returns A result/error tuple with channel metadata and optional response.
   */
  async subscribeToService(
    params: SubscribeToServiceParams,
  ): Promise<{ result?: unknown; error?: string }> {
    try {
      const expiresInSeconds = params.expiresInHours * 3600;
      const deposit = BigInt(params.deposit);

      const session = await this.pay.openChannel({
        provider: getAddress(params.provider),
        token: getAddress(params.token),
        deposit,
        expiresIn: expiresInSeconds,
        policy: params.policy ? getAddress(params.policy) : undefined,
      });

      const channelIdStr = session.channelId.toString();
      this.channels.set(channelIdStr, session);

      const base: Record<string, unknown> = {
        channelId: channelIdStr,
        provider: params.provider,
        token: params.token,
        deposit: params.deposit,
        expiresInHours: params.expiresInHours,
      };

      if (params.requestBody) {
        let endpoint = '';
        let price = 0n;

        const discovered = await this.pay.discover({
          provider: getAddress(params.provider),
          active: true,
        });

        if (discovered.length > 0 && discovered[0].descriptor) {
          endpoint = discovered[0].descriptor.api.endpoint;
          price = discovered[0].pricePerRequest;
          session.setEndpoint(endpoint);
          session.setPricePerRequest(price);
        }

        try {
          const response = await session.request(params.requestBody);
          return {
            result: {
              ...base,
              remaining: (deposit - session.cumulativeSpent).toString(),
              spent: session.cumulativeSpent.toString(),
              response,
            },
          };
        } catch (reqErr) {
          return {
            result: {
              ...base,
              remaining: (deposit - session.cumulativeSpent).toString(),
              spent: session.cumulativeSpent.toString(),
              error: reqErr instanceof Error ? reqErr.message : 'Request failed',
            },
          };
        }
      }

      return { result: base };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Failed to open payment channel',
      };
    }
  }

  /**
   * Make a request on an existing open channel.
   *
   * @param channelId - The channel ID returned by {@link subscribeToService}.
   * @param body - The request payload to send to the service endpoint.
   * @returns A result/error tuple with the service response and remaining balance.
   */
  async makeRequest(
    channelId: string,
    body: Record<string, unknown>,
  ): Promise<{ result?: { response: unknown; remaining: string; spent: string }; error?: string }> {
    try {
      const channel = this.channels.get(channelId);
      if (!channel) {
        return { error: `Channel #${channelId} not found. Has it been closed or expired?` };
      }

      const response = await channel.request(body);

      return {
        result: {
          response,
          remaining: (channel.deposit - channel.cumulativeSpent).toString(),
          spent: channel.cumulativeSpent.toString(),
        },
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Request failed',
      };
    }
  }

  /**
   * Settle and close an open payment channel.
   *
   * The provider receives the cumulative spent amount, and any remaining
   * deposit is refunded to the payer.
   *
   * @param channelId - The channel ID to close.
   * @returns A result/error tuple with spent and refunded amounts and the tx hash.
   */
  async closeChannel(
    channelId: string,
  ): Promise<{ result?: CloseChannelResult; error?: string }> {
    try {
      const channel = this.channels.get(channelId);
      if (!channel) {
        return { error: `Channel #${channelId} not found in active sessions.` };
      }

      const { txHash, spent, refunded } = await channel.close();
      this.channels.delete(channelId);

      return {
        result: {
          txHash,
          spent: spent.toString(),
          refunded: refunded.toString(),
        },
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Failed to close channel',
      };
    }
  }

  /**
   * Close a channel as the payer, using `refundChannel` if expired
   * or `closeChannel` if still active.
   *
   * @param channelId - The channel ID to close.
   * @returns A result/error tuple with the refunded amount and tx hash.
   */
  async closeAsPayer(
    channelId: string,
  ): Promise<{ result?: { txHash: string; refunded: string }; error?: string }> {
    try {
      const channel = this.channels.get(channelId);
      if (!channel) {
        return { error: `Channel #${channelId} not found in active sessions.` };
      }

      const { txHash, refunded } = await channel.closeAsPayer();
      this.channels.delete(channelId);

      return {
        result: {
          txHash,
          refunded: refunded.toString(),
        },
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Failed to close channel',
      };
    }
  }

  /**
   * Get the current balance and state for a specific channel.
   *
   * @param channelId - The channel ID.
   * @returns A result/error tuple with channel balance and status.
   */
  async getChannelInfo(
    channelId: string,
  ): Promise<{ result?: ActiveChannelInfo; error?: string }> {
    try {
      const ch = await this.pay.getChannel(BigInt(channelId));
      const remaining = ch.deposit - ch.spent;
      const statusNames = ['Open', 'Settled', 'Refunded'];

      return {
        result: {
          channelId,
          provider: ch.payee,
          payer: ch.payer,
          deposit: ch.deposit.toString(),
          spent: ch.spent.toString(),
          remaining: remaining.toString(),
          status: statusNames[ch.status as number] ?? 'Unknown',
          expiresAt: ch.expiresAt,
          token: ch.token,
        },
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Channel not found',
      };
    }
  }

  /**
   * Get all active channels associated with this wallet on-chain.
   *
   * Queries the contract and enriches with local session data where available.
   *
   * @returns An array of active channel summaries (never fails — returns empty on error).
   */
  async getActiveChannels(): Promise<ActiveChannelInfo[]> {
    try {
      const services = await this.pay.discover({ active: true });
      const results: ActiveChannelInfo[] = [];
      const statusNames = ['Open', 'Settled', 'Refunded'];

      for (const svc of services) {
        try {
          const ch = await this.pay.getChannel(BigInt(svc.serviceId));
          const remaining = ch.deposit - ch.spent;
          const idStr = svc.serviceId;
          const session = this.channels.get(idStr);

          results.push({
            channelId: idStr,
            provider: ch.payee,
            payer: ch.payer,
            deposit: ch.deposit.toString(),
            spent: (session?.cumulativeSpent ?? ch.spent).toString(),
            remaining: (session ? session.deposit - session.cumulativeSpent : remaining).toString(),
            status: statusNames[ch.status as number] ?? 'Unknown',
            expiresAt: ch.expiresAt,
            token: ch.token,
          });
        } catch {
          continue;
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  /**
   * Set the endpoint and price on a channel session for making paid requests.
   * Must be called before {@link makeRequest} if these were not set during
   * {@link subscribeToService}.
   *
   * @param channelId - The channel ID.
   * @param endpoint - Service endpoint URL.
   * @param pricePerRequest - Price per request in token smallest units.
   */
  configureChannel(
    channelId: string,
    endpoint: string,
    pricePerRequest: string,
  ): { error?: string } {
    const channel = this.channels.get(channelId);
    if (!channel) {
      return { error: `Channel #${channelId} not found.` };
    }
    channel.setEndpoint(endpoint);
    channel.setPricePerRequest(BigInt(pricePerRequest));
    return {};
  }

  /**
   * Get direct access to a ChannelSession for advanced usage.
   *
   * @param channelId - The channel ID.
   * @returns The ChannelSession instance, or undefined if not found.
   */
  getChannel(channelId: string): ChannelSession | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Access the underlying AgentPay SDK instance for advanced operations
   * not covered by the worker methods.
   */
  getAgentPay(): AgentPay {
    return this.pay;
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an AgentSettlementWorker from a G.A.M.E compatible configuration.
 *
 * This is the simplest way to get started — one function call, one worker
 * instance, ready to use in any G.A.M.E worker function or task executor.
 *
 * @example
 * ```typescript
 * import { createAgentPay } from '@valuepacket/adapter-game';
 *
 * const worker = createAgentPay({
 *   wallet: myWallet,
 *   serviceRegistryAddress: '0x...',
 *   paymentChannelAddress: '0x...',
 * });
 * ```
 */
export function createAgentPay(config: GameAgentConfig): AgentSettlementWorker {
  return new AgentSettlementWorker(config);
}
