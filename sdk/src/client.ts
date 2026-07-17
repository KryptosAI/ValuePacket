/** Main AgentPay client — the primary developer API for the Agent Settlement Protocol */

import {
  decodeEventLog,
  createWalletClient,
  createPublicClient,
  http,
  type WalletClient,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { ValuePacketEvents } from './extensions/events.js';
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

function resolveLocalDeploymentAddresses(): {
  serviceRegistry: string;
  paymentChannel: string;
  spendingPolicy: string;
} | null {
  const searchPaths = [
    resolve(process.cwd(), 'contracts', 'deployments', 'local.json'),
    resolve(process.cwd(), '..', 'contracts', 'deployments', 'local.json'),
    resolve(process.cwd(), 'deployments', 'local.json'),
  ];
  for (const deploymentPath of searchPaths) {
    try {
      const raw = readFileSync(deploymentPath, 'utf-8');
      const data = JSON.parse(raw);
      return {
        serviceRegistry: data.serviceRegistry as string,
        paymentChannel: data.paymentChannel as string,
        spendingPolicy: data.spendingPolicy as string,
      };
    } catch {
      continue;
    }
  }
  return null;
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

  public readonly events = new ValuePacketEvents();

  constructor(config: AgentPayConfig) {
    this.wallet = config.wallet;
    this.publicClient = config.publicClient;
    this.serviceRegistryAddress = config.serviceRegistryAddress;
    this.paymentChannelAddress = config.paymentChannelAddress;
    this.spendingPolicyAddress = config.spendingPolicyAddress;
    this.indexerUrl = config.indexerUrl;
  }

  // ── Static factories ────────────────────────────────────────────

  /**
   * Creates an {@link AgentPay} instance from a private key.
   *
   * Auto-detects the chain ID from the RPC endpoint if not provided,
   * and resolves `serviceRegistryAddress` / `paymentChannelAddress`
   * from `contracts/deployments/local.json` when available.
   *
   * @example
   * ```ts
   * import { AgentPay } from '@valuepacket/sdk';
   *
   * const agentPay = await AgentPay.fromPrivateKey({
   *   privateKey: '0x...',
   *   rpcUrl: 'http://localhost:8545',
   * });
   * ```
   */
  static async fromPrivateKey(config: {
    privateKey: `0x${string}`;
    rpcUrl: string;
    serviceRegistryAddress?: `0x${string}`;
    paymentChannelAddress?: `0x${string}`;
    spendingPolicyAddress?: `0x${string}`;
    indexerUrl?: string;
    chainId?: number;
  }): Promise<AgentPay> {
    const account = privateKeyToAccount(config.privateKey);
    const transport = http(config.rpcUrl);

    // Auto-detect chain ID if not provided (validates connectivity)
    if (config.chainId === undefined) {
      const tempClient = createPublicClient({ transport });
      await tempClient.getChainId();
    }

    const wallet = createWalletClient({ account, transport }) as unknown as WalletClient;
    const publicClient = createPublicClient({ transport });

    // Auto-detect contract addresses from deployments
    let serviceRegistryAddress = config.serviceRegistryAddress;
    let paymentChannelAddress = config.paymentChannelAddress;
    let spendingPolicyAddress = config.spendingPolicyAddress;

    if (!serviceRegistryAddress || !paymentChannelAddress) {
      const deploymentAddrs = resolveLocalDeploymentAddresses();
      if (deploymentAddrs) {
        serviceRegistryAddress = serviceRegistryAddress ?? deploymentAddrs.serviceRegistry as `0x${string}`;
        paymentChannelAddress = paymentChannelAddress ?? deploymentAddrs.paymentChannel as `0x${string}`;
        spendingPolicyAddress = spendingPolicyAddress ?? deploymentAddrs.spendingPolicy as `0x${string}`;
      }
    }

    if (!serviceRegistryAddress) {
      throw new Error(
        'serviceRegistryAddress is required — provide it directly or ensure contracts/deployments/local.json exists',
      );
    }
    if (!paymentChannelAddress) {
      throw new Error(
        'paymentChannelAddress is required — provide it directly or ensure contracts/deployments/local.json exists',
      );
    }

    return new AgentPay({
      wallet,
      publicClient,
      serviceRegistryAddress,
      paymentChannelAddress,
      spendingPolicyAddress,
      indexerUrl: config.indexerUrl,
    });
  }

  /**
   * Creates an {@link AgentPay} instance from environment variables.
   *
   * | Variable                   | Required | Default                    |
   * |----------------------------|----------|----------------------------|
   * | `PRIVATE_KEY`              | yes      | —                          |
   * | `RPC_URL`                  | no       | `http://localhost:8545`    |
   * | `SERVICE_REGISTRY_ADDRESS` | no       | auto-detected              |
   * | `PAYMENT_CHANNEL_ADDRESS`  | no       | auto-detected              |
   * | `SPENDING_POLICY_ADDRESS`  | no       | auto-detected              |
   * | `INDEXER_URL`              | no       | —                          |
   *
   * @example
   * ```ts
   * import { AgentPay } from '@valuepacket/sdk';
   *
   * const agentPay = await AgentPay.fromEnv();
   * ```
   */
  static async fromEnv(): Promise<AgentPay> {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('PRIVATE_KEY environment variable is required');
    }

    return AgentPay.fromPrivateKey({
      privateKey: privateKey as `0x${string}`,
      rpcUrl: process.env.RPC_URL ?? 'http://localhost:8545',
      serviceRegistryAddress: process.env.SERVICE_REGISTRY_ADDRESS as `0x${string}` | undefined,
      paymentChannelAddress: process.env.PAYMENT_CHANNEL_ADDRESS as `0x${string}` | undefined,
      spendingPolicyAddress: process.env.SPENDING_POLICY_ADDRESS as `0x${string}` | undefined,
      indexerUrl: process.env.INDEXER_URL,
    });
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

    const payerAddress = this.wallet.account!.address as `0x${string}`;

    this.events.emit('channel:opened', {
      channelId,
      payer: payerAddress,
      payee: params.provider,
      deposit: params.deposit,
      expiresAt,
      txHash,
    });

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

  /**
   * One-call convenience method that combines service discovery,
   * channel opening, and a paid request into a single call.
   *
   * @returns The request result, the active ChannelSession, and the discovered service.
   */
  async pay<T = unknown>(params: {
    serviceType: string;
    body: Record<string, unknown>;
    deposit: bigint;
    expiresIn?: number;
    token: `0x${string}`;
    maxPrice?: bigint;
    timeoutMs?: number;
  }): Promise<{ result: T; session: ChannelSession; service: DiscoveredService }> {
    const services = await this.discover({ serviceType: params.serviceType, maxPrice: params.maxPrice, active: true });
    if (services.length === 0) throw new ServiceNotFoundError(params.serviceType);

    const service = services[0];

    const session = await this.openChannel({
      provider: service.provider,
      token: params.token,
      deposit: params.deposit,
      expiresIn: params.expiresIn ?? 3600,
    });

    if (service.descriptor?.api?.endpoint) {
      session.setEndpoint(service.descriptor.api.endpoint);
    }
    session.setPricePerRequest(service.pricePerRequest);

    const result = await session.request<T>(params.body, { timeoutMs: params.timeoutMs });

    return { result, session, service };
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
