/** Main AgentPay client — the primary developer API for the Agent Settlement Protocol */

import { decodeEventLog } from 'viem';
import type { WalletClient, PublicClient } from 'viem';
import type {
  Service,
  ServiceDescriptor,
  DiscoveredService,
  RegisterServiceParams,
  UpdateServiceParams,
  OpenChannelParams,
  PolicyConfig,
  AgentPayConfig,
} from './types.js';
import { ChannelStatus } from './types.js';
import {
  ServiceNotFoundError,
  MetadataResolutionError,
} from './errors.js';
import { ChannelSession } from './channel.js';
import {
  SERVICE_REGISTRY_ABI,
  PAYMENT_CHANNEL_ABI,
  SPENDING_POLICY_ABI,
} from './contracts.js';

interface ViemService {
  provider: `0x${string}`;
  metadataURI: string;
  pricePerRequest: bigint;
  maxResponseMs: number;
  registeredAt: number;
  active: boolean;
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

function toService(vs: ViemService): Service {
  return {
    provider: vs.provider,
    metadataURI: vs.metadataURI,
    pricePerRequest: vs.pricePerRequest,
    maxResponseMs: vs.maxResponseMs,
    registeredAt: vs.registeredAt,
    active: vs.active,
  };
}

/**
 * The main entry point for the Agent Settlement Protocol SDK.
 * Provides methods for service registration, discovery, payment
 * channels, and spending policy management.
 */
export class AgentPay {
  private wallet: WalletClient;
  private publicClient: PublicClient;
  private serviceRegistryAddress: `0x${string}`;
  private paymentChannelAddress: `0x${string}`;
  private spendingPolicyAddress: `0x${string}` | undefined;
  private indexerUrl: string | undefined;

  constructor(config: AgentPayConfig) {
    this.wallet = config.wallet;
    this.publicClient = config.publicClient;
    this.serviceRegistryAddress = config.serviceRegistryAddress;
    this.paymentChannelAddress = config.paymentChannelAddress;
    this.spendingPolicyAddress = config.spendingPolicyAddress;
    this.indexerUrl = config.indexerUrl;
  }

  // ── Service Registry ────────────────────────────────────────────

  /**
   * Registers a new service on the ServiceRegistry contract.
   * @returns The assigned serviceId (bytes32) and transaction hash.
   */
  async registerService(params: RegisterServiceParams): Promise<{
    serviceId: `0x${string}`;
    txHash: `0x${string}`;
  }> {
    if (!this.wallet.account) {
      throw new Error('Wallet has no account configured');
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.serviceRegistryAddress,
      abi: SERVICE_REGISTRY_ABI,
      functionName: 'register',
      args: [params.metadataURI, params.pricePerRequest, params.maxResponseMs],
      account: this.wallet.account,
    });

    const txHash = await this.wallet.writeContract(request);

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    const serviceId = this.parseServiceRegisteredLog(receipt.logs);
    if (!serviceId) {
      throw new Error('Failed to parse ServiceRegistered event from receipt');
    }

    return { serviceId, txHash };
  }

  /**
   * Updates an existing service's metadata and pricing parameters.
   */
  async updateService(params: UpdateServiceParams): Promise<{
    txHash: `0x${string}`;
  }> {
    if (!this.wallet.account) {
      throw new Error('Wallet has no account configured');
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.serviceRegistryAddress,
      abi: SERVICE_REGISTRY_ABI,
      functionName: 'updateService',
      args: [params.serviceId, params.metadataURI, params.pricePerRequest, params.maxResponseMs],
      account: this.wallet.account,
    });

    const txHash = await this.wallet.writeContract(request);

    return { txHash };
  }

  /**
   * Deactivates a service, removing it from active discovery listings.
   */
  async deactivateService(serviceId: `0x${string}`): Promise<{
    txHash: `0x${string}`;
  }> {
    if (!this.wallet.account) {
      throw new Error('Wallet has no account configured');
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.serviceRegistryAddress,
      abi: SERVICE_REGISTRY_ABI,
      functionName: 'deactivateService',
      args: [serviceId],
      account: this.wallet.account,
    });

    const txHash = await this.wallet.writeContract(request);

    return { txHash };
  }

  /**
   * Fetches a single service from the registry by its bytes32 ID.
   * @throws {ServiceNotFoundError} if the provider address is zero (non-existent).
   */
  async getService(serviceId: `0x${string}`): Promise<Service> {
    try {
      const result = await this.publicClient.readContract({
        address: this.serviceRegistryAddress,
        abi: SERVICE_REGISTRY_ABI,
        functionName: 'getService',
        args: [serviceId],
      });

      const service = result as unknown as ViemService;

      if (!service.provider || service.provider === '0x0000000000000000000000000000000000000000') {
        throw new ServiceNotFoundError(serviceId);
      }

      return toService(service);
    } catch (err) {
      if (err instanceof ServiceNotFoundError) throw err;
      throw new ServiceNotFoundError(serviceId);
    }
  }

  // ── Discovery ───────────────────────────────────────────────────

  /**
   * Discovers registered services. If an indexer URL was configured,
   * uses the GraphQL endpoint for efficient querying. Otherwise falls
   * back to on-chain iteration.
   *
   * Filters supported:
   * - `serviceType`: matches against the descriptor's service.id
   * - `provider`: matches against the provider address
   * - `maxPrice`: filters services with pricePerRequest <= maxPrice
   * - `active`: filters by active status
   */
  async discover(params: {
    serviceType?: string;
    provider?: `0x${string}`;
    maxPrice?: bigint;
    active?: boolean;
  } = {}): Promise<DiscoveredService[]> {
    if (this.indexerUrl) {
      return this.discoverViaIndexer(params);
    }
    return this.discoverOnChain(params);
  }

  private async discoverViaIndexer(params: {
    serviceType?: string;
    provider?: `0x${string}`;
    maxPrice?: bigint;
    active?: boolean;
  }): Promise<DiscoveredService[]> {
    const conditions: string[] = [];
    const variables: Record<string, unknown> = {};

    if (params.serviceType) {
      conditions.push('serviceType: $serviceType');
      variables.serviceType = params.serviceType;
    }
    if (params.provider) {
      conditions.push('provider: $provider');
      variables.provider = params.provider;
    }
    if (params.maxPrice !== undefined) {
      conditions.push('pricePerRequest_lte: $maxPrice');
      variables.maxPrice = params.maxPrice.toString();
    }
    if (params.active !== undefined) {
      conditions.push('active: $active');
      variables.active = params.active;
    }

    const whereClause = conditions.length > 0
      ? `where: { ${conditions.join(', ')} }`
      : '';

    const variableDecls = Object.keys(variables)
      .map(k => `$${k}: ${this.getGraphQLType(k, variables[k])}`)
      .join(', ');

    const query = `
      query DiscoverServices${variableDecls ? `(${variableDecls})` : ''} {
        services(first: 100, ${whereClause}) {
          id
          provider
          metadataURI
          pricePerRequest
          maxResponseMs
          registeredAt
          active
        }
      }
    `;

    const response = await fetch(this.indexerUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`Indexer query failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    if (json.errors) {
      throw new Error(`Indexer returned errors: ${JSON.stringify(json.errors)}`);
    }

    const results: DiscoveredService[] = [];

    for (const s of json.data?.services ?? []) {
      const service: DiscoveredService = {
        serviceId: s.id as `0x${string}`,
        provider: s.provider as `0x${string}`,
        metadataURI: s.metadataURI,
        pricePerRequest: BigInt(s.pricePerRequest),
        maxResponseMs: Number(s.maxResponseMs),
        registeredAt: Number(s.registeredAt),
        active: s.active,
      };

      if (s.metadataURI) {
        try {
          service.descriptor = await this.resolveMetadata(s.metadataURI);
        } catch {
          // metadata resolution is best-effort
        }
      }

      results.push(service);
    }

    return results;
  }

  private getGraphQLType(_name: string, value: unknown): string {
    if (typeof value === 'boolean') return 'Boolean';
    return 'String';
  }

  private async discoverOnChain(params: {
    serviceType?: string;
    provider?: `0x${string}`;
    maxPrice?: bigint;
    active?: boolean;
  }): Promise<DiscoveredService[]> {
    const count = await this.publicClient.readContract({
      address: this.serviceRegistryAddress,
      abi: SERVICE_REGISTRY_ABI,
      functionName: 'getServiceCount',
      args: [],
    }) as unknown as bigint;

    const total = Number(count);

    const results: DiscoveredService[] = [];

    for (let i = 0; i < total; i++) {
      try {
        const tuple = await this.publicClient.readContract({
          address: this.serviceRegistryAddress,
          abi: SERVICE_REGISTRY_ABI,
          functionName: 'getServiceAtIndex',
          args: [BigInt(i)],
        }) as unknown as readonly [`0x${string}`, ViemService];

        const serviceId = tuple[0];
        const serviceData = toService(tuple[1]);

        if (params.provider && serviceData.provider.toLowerCase() !== params.provider.toLowerCase()) {
          continue;
        }
        if (params.maxPrice !== undefined && serviceData.pricePerRequest > params.maxPrice) {
          continue;
        }
        if (params.active !== undefined && serviceData.active !== params.active) {
          continue;
        }

        const discovered: DiscoveredService = {
          serviceId,
          ...serviceData,
        };

        if (serviceData.metadataURI) {
          try {
            discovered.descriptor = await this.resolveMetadata(serviceData.metadataURI);
            if (params.serviceType && discovered.descriptor?.service?.id !== params.serviceType) {
              continue;
            }
          } catch {
            if (params.serviceType) continue;
          }
        } else if (params.serviceType) {
          continue;
        }

        results.push(discovered);
      } catch {
        continue;
      }
    }

    return results;
  }

  /**
   * Fetches and parses a ServiceDescriptor from a metadata URI.
   * Supports ipfs://, ar://, https://, and http:// URIs.
   * @throws {MetadataResolutionError} if the URI cannot be resolved or parsed.
   */
  async resolveMetadata(uri: string): Promise<ServiceDescriptor> {
    let url: string;
    if (uri.startsWith('ipfs://')) {
      url = `https://ipfs.io/ipfs/${uri.slice(7)}`;
    } else if (uri.startsWith('ar://')) {
      url = `https://arweave.net/${uri.slice(5)}`;
    } else if (uri.startsWith('http://') || uri.startsWith('https://')) {
      url = uri;
    } else {
      throw new MetadataResolutionError(uri, 'Unsupported URI scheme');
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new MetadataResolutionError(uri, `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data as ServiceDescriptor;
  }

  // ── Payment Channels ────────────────────────────────────────────

  /**
   * Opens a new payment channel between the wallet's account and the
   * specified provider, funding it with the given deposit amount.
   * @returns A ChannelSession ready for making paid requests.
   */
  async openChannel(params: OpenChannelParams): Promise<ChannelSession> {
    if (!this.wallet.account) {
      throw new Error('Wallet has no account configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + params.expiresIn;
    const policyAddress =
      params.policy ??
      this.spendingPolicyAddress ??
      '0x0000000000000000000000000000000000000000';
    const metadata =
      params.metadata ??
      '0x';

    const { request } = await this.publicClient.simulateContract({
      address: this.paymentChannelAddress,
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'openChannel',
      args: [
        params.provider,
        params.token,
        params.deposit,
        expiresAt,
        policyAddress,
        metadata,
      ],
      account: this.wallet.account,
    });

    const txHash = await this.wallet.writeContract(request);

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    const channelId = this.parseChannelOpenedLog(receipt.logs);
    if (!channelId) {
      throw new Error('ChannelOpened event not found in transaction receipt');
    }

    return new ChannelSession({
      channelId,
      payer: this.wallet,
      publicClient: this.publicClient,
      payeeEndpoint: '',
      pricePerRequest: 0n,
      token: params.token,
      deposit: params.deposit,
      verifyingContract: this.paymentChannelAddress,
      paymentChannelAddress: this.paymentChannelAddress,
    });
  }

  /**
   * Fetches the current on-chain state of a payment channel.
   */
  async getChannel(channelId: bigint): Promise<{
    payer: `0x${string}`;
    payee: `0x${string}`;
    token: `0x${string}`;
    deposit: bigint;
    spent: bigint;
    openedAt: number;
    expiresAt: number;
    policy: `0x${string}`;
    metadata: `0x${string}`;
    status: ChannelStatus;
  }> {
    const result = await this.publicClient.readContract({
      address: this.paymentChannelAddress,
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'getChannel',
      args: [channelId],
    });

    const channel = result as unknown as ViemChannel;

    return {
      payer: channel.payer,
      payee: channel.payee,
      token: channel.token,
      deposit: channel.deposit,
      spent: channel.spent,
      openedAt: channel.openedAt,
      expiresAt: channel.expiresAt,
      policy: channel.policy,
      metadata: channel.metadata,
      status: channel.status as ChannelStatus,
    };
  }

  // ── Spending Policy ─────────────────────────────────────────────

  /**
   * Sets the spending policy for the wallet's account on the
   * configured SpendingPolicy contract.
   * Note: The contract sets `active: true` internally; the `active`
   * field in PolicyConfig is ignored when writing to the contract.
   */
  async setSpendingPolicy(config: PolicyConfig): Promise<{
    txHash: `0x${string}`;
  }> {
    if (!this.wallet.account) {
      throw new Error('Wallet has no account configured');
    }
    if (!this.spendingPolicyAddress) {
      throw new Error('SpendingPolicy address not configured');
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.spendingPolicyAddress,
      abi: SPENDING_POLICY_ABI,
      functionName: 'setPolicy',
      args: [
        config.maxSpendPerDay,
        config.maxChannelDeposit,
        BigInt(config.maxChannelDuration),
        config.requireRegisteredService,
      ],
      account: this.wallet.account,
    });

    const txHash = await this.wallet.writeContract(request);

    return { txHash };
  }

  /**
   * Adds a service ID to the allowed list in the spending policy.
   */
  async addAllowedService(serviceId: `0x${string}`): Promise<{
    txHash: `0x${string}`;
  }> {
    if (!this.wallet.account) {
      throw new Error('Wallet has no account configured');
    }
    if (!this.spendingPolicyAddress) {
      throw new Error('SpendingPolicy address not configured');
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.spendingPolicyAddress,
      abi: SPENDING_POLICY_ABI,
      functionName: 'addAllowedService',
      args: [serviceId],
      account: this.wallet.account,
    });

    const txHash = await this.wallet.writeContract(request);

    return { txHash };
  }

  /**
   * Adds a provider address to the allowed list in the spending policy.
   */
  async addAllowedProvider(provider: `0x${string}`): Promise<{
    txHash: `0x${string}`;
  }> {
    if (!this.wallet.account) {
      throw new Error('Wallet has no account configured');
    }
    if (!this.spendingPolicyAddress) {
      throw new Error('SpendingPolicy address not configured');
    }

    const { request } = await this.publicClient.simulateContract({
      address: this.spendingPolicyAddress,
      abi: SPENDING_POLICY_ABI,
      functionName: 'addAllowedProvider',
      args: [provider],
      account: this.wallet.account,
    });

    const txHash = await this.wallet.writeContract(request);

    return { txHash };
  }

  // ── Internal helpers ────────────────────────────────────────────

  private parseServiceRegisteredLog(
    logs: readonly { address: string; topics: readonly string[]; data: string }[],
  ): `0x${string}` | null {
    for (const log of logs) {
      if (log.address.toLowerCase() !== this.serviceRegistryAddress.toLowerCase()) {
        continue;
      }

      try {
        const decoded = decodeEventLog({
          abi: SERVICE_REGISTRY_ABI,
          data: log.data as `0x${string}`,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });

        if (decoded.eventName === 'ServiceRegistered') {
          return (decoded.args as Record<string, unknown>).serviceId as `0x${string}`;
        }
      } catch {
        if (log.topics.length > 1 && log.topics[1]) {
          return `0x${log.topics[1].slice(26)}` as `0x${string}`;
        }
      }
    }
    return null;
  }

  private parseChannelOpenedLog(
    logs: readonly { address: string; topics: readonly string[]; data: string }[],
  ): bigint | null {
    for (const log of logs) {
      if (log.address.toLowerCase() !== this.paymentChannelAddress.toLowerCase()) {
        continue;
      }

      try {
        const decoded = decodeEventLog({
          abi: PAYMENT_CHANNEL_ABI,
          data: log.data as `0x${string}`,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });

        if (decoded.eventName === 'ChannelOpened') {
          return (decoded.args as Record<string, unknown>).channelId as bigint;
        }
      } catch {
        if (log.topics.length > 1 && log.topics[1]) {
          return BigInt(log.topics[1]);
        }
      }
    }
    return null;
  }
}
