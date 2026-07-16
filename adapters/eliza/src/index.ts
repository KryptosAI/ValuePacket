import type {
  Plugin,
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from '@elizaos/core';
import {
  AgentPay,
  ChannelSession,
  type DiscoveredService,
  type ServiceDescriptor,
} from '@valuepacket/sdk';
import { createPublicClient, http, type WalletClient, type Address, type PublicClient } from 'viem';

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const RUNTIME_KEY = '__agent_settlement_pay__';

interface RuntimeExtras {
  [RUNTIME_KEY]?: AgentPay;
  __wallet?: WalletClient;
  __publicClient?: PublicClient;
}

function setPay(runtime: IAgentRuntime, pay: AgentPay): void {
  (runtime as unknown as RuntimeExtras)[RUNTIME_KEY] = pay;
}

function getPay(runtime: IAgentRuntime): AgentPay | undefined {
  return (runtime as unknown as RuntimeExtras)[RUNTIME_KEY];
}

function getWallet(runtime: IAgentRuntime): WalletClient | undefined {
  return (runtime as unknown as RuntimeExtras).__wallet;
}

function getPublicClient(runtime: IAgentRuntime): PublicClient | undefined {
  return (runtime as unknown as RuntimeExtras).__publicClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseParams(message: Memory): Record<string, unknown> {
  try {
    const raw = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as Record<string, unknown>;
  } catch { /* best-effort */ }
  return {};
}

function findAddress(text: string): string | null {
  const m = text.match(/0x[a-fA-F0-9]{40}/);
  return m ? m[0] : null;
}

function findChannelId(text: string): string | null {
  const m = text.match(/(?:channel|#)\s*(\d+)/i);
  return m ? m[1] : null;
}

function toAddress(s: string | null | undefined): Address | undefined {
  if (!s || s.length !== 42) return undefined;
  return s.toLowerCase() as Address;
}

// ---------------------------------------------------------------------------
// LIST_SERVICE
// ---------------------------------------------------------------------------

const listServiceAction: Action = {
  name: 'LIST_SERVICE',
  description:
    'Register an agent service on-chain so other agents can discover and pay for it. ' +
    'Use to offer capabilities like data feeds, oracles, computation, or custom APIs.',
  examples: [
    [
      { user: 'user', content: { text: 'Register my prediction-feed service. metadata ipfs://QmX... price 0.05 USDC, max response 2s' } },
      { user: 'assistant', content: { text: 'Service registered. ID: 0xabc... TX: 0xdef... Now discoverable.' } },
    ],
  ],
  similes: [
    'REGISTER_SERVICE', 'register a service', 'list my agent', 'publish capability',
    'add listing', 'make discoverable', 'offer my service',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!getPay(runtime)) return false;
    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    return [
      'register service', 'list service', 'list my', 'publish capability',
      'register my', 'make discoverable', 'add listing', 'offer my service',
    ].some((t) => raw.toLowerCase().includes(t));
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const pay = getPay(runtime);
    if (!pay) { callback?.({ text: 'Plugin not initialized.' }, []); return false; }

    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const p = parseParams(message);
    const metadataURI = (p.metadataURI as string) ?? raw.match(/ipfs:\/\/\S+/)?.at(0) ?? '';
    const price = (p.pricePerRequest as string) ?? '';
    const maxMs = (p.maxResponseMs as number) ?? 2000;

    if (!metadataURI || !price) {
      callback?.({ text: 'I need a metadataURI and pricePerRequest. Example: "Register my feed with metadata ipfs://Qm... at 50000 per request".' }, []);
      return false;
    }

    try {
      const { serviceId, txHash } = await pay.registerService({
        metadataURI,
        pricePerRequest: BigInt(price),
        maxResponseMs: maxMs,
      });
      callback?.({ text: `Service registered.\nID: ${serviceId}\nTX: ${txHash}\nPrice/req: ${price}\nMax resp: ${maxMs}ms` }, []);
      return true;
    } catch (err) {
      callback?.({ text: `Register failed: ${err instanceof Error ? err.message : 'error'}` }, []);
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// DISCOVER_AGENTS
// ---------------------------------------------------------------------------

const discoverAgentsAction: Action = {
  name: 'DISCOVER_AGENTS',
  description:
    'Find agents that offer a specific service type. Use to locate providers for data feeds, ' +
    'oracles, computation, or any capability registered on-chain.',
  examples: [
    [
      { user: 'user', content: { text: 'Find prediction-feed services under 0.10 USDC' } },
      { user: 'assistant', content: { text: 'Found 3 prediction-feed providers. Use SUBSCRIBE_TO_SERVICE to open a channel.' } },
    ],
  ],
  similes: [
    'FIND_SERVICES', 'find agents', 'search services', 'discover providers',
    'look up agents', 'who offers', 'search agent',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!getPay(runtime)) return false;
    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    return ['discover', 'find agent', 'find service', 'search for', 'look up agent', 'who offers', 'search agent']
      .some((t) => raw.toLowerCase().includes(t));
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const pay = getPay(runtime);
    if (!pay) { callback?.({ text: 'Plugin not initialized.' }, []); return false; }

    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const p = parseParams(message);
    const serviceType = (p.serviceType as string)
      ?? raw.match(/(?:find|discover)\s+(\w+(?:-\w+)*)/i)?.at(1)
      ?? undefined;
    const maxPriceRaw = p.maxPrice as string | undefined;

    try {
      const services = await pay.discover({
        serviceType,
        maxPrice: maxPriceRaw ? BigInt(maxPriceRaw) : undefined,
        active: true,
      });

      if (services.length === 0) {
        callback?.({ text: serviceType ? `No services found for "${serviceType}".` : 'No active services discovered.' }, []);
        return true;
      }

      const lines = services.map((s: DiscoveredService, i: number) =>
        `${i + 1}. ${s.descriptor?.service?.name ?? s.serviceId}\n   Provider: ${s.provider}\n   Price: ${s.pricePerRequest.toString()}/req\n   Max resp: ${s.maxResponseMs}ms` +
        (s.descriptor?.api?.endpoint ? `\n   Endpoint: ${s.descriptor.api.endpoint}` : ''),
      );
      callback?.({ text: `Found ${services.length} service(s):\n\n${lines.join('\n\n')}\n\nUse SUBSCRIBE_TO_SERVICE to open a payment channel.` }, []);
      return true;
    } catch (err) {
      callback?.({ text: `Discovery failed: ${err instanceof Error ? err.message : 'error'}` }, []);
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// SUBSCRIBE_TO_SERVICE
// ---------------------------------------------------------------------------

const subscribeToServiceAction: Action = {
  name: 'SUBSCRIBE_TO_SERVICE',
  description:
    'Open a payment channel with a provider and start consuming their service. ' +
    'Funds a channel on-chain; the channel stays open for repeated paid requests.',
  examples: [
    [
      { user: 'user', content: { text: 'Subscribe to 0xabc... deposit 5 USDC token 0x8335... for 24h' } },
      { user: 'assistant', content: { text: 'Channel opened. Deposit: 5000000. Ready for requests.' } },
    ],
  ],
  similes: [
    'OPEN_CHANNEL', 'subscribe to', 'pay agent', 'start using', 'consume service',
    'open channel', 'fund channel', 'start paying', 'connect provider',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!getPay(runtime)) return false;
    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    return ['subscribe to', 'open channel', 'pay agent', 'start using', 'consume service', 'fund channel', 'start paying', 'connect provider']
      .some((t) => raw.toLowerCase().includes(t));
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const pay = getPay(runtime);
    if (!pay) { callback?.({ text: 'Plugin not initialized.' }, []); return false; }

    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const p = parseParams(message);
    const provider = toAddress((p.providerAddress ?? p.provider) as string | null) ?? toAddress(findAddress(raw));
    if (!provider) { callback?.({ text: 'I need a provider address (0x...).' }, []); return false; }

    const usdcBase = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
    const token = toAddress(p.token as string | null) ?? usdcBase;
    const deposit = p.deposit as string | undefined;
    if (!deposit) { callback?.({ text: 'I need a deposit amount (e.g. "5000000" for 5 USDC).' }, []); return false; }

    const expiresInHours = (p.expiresIn as number) ?? 24;
    const expiresInSeconds = expiresInHours * 3600;

    try {
      const session = await pay.openChannel({
        provider,
        token,
        deposit: BigInt(deposit),
        expiresIn: expiresInSeconds,
        policy: toAddress(p.policy as string | null),
      });

      const idStr = session.channelId.toString();
      let descriptor: ServiceDescriptor | null = null;

      try {
        const discovered = await pay.discover({ provider });
        if (discovered.length > 0 && discovered[0].descriptor) {
          descriptor = discovered[0].descriptor;
          session.setEndpoint(descriptor.api.endpoint);
          session.setPricePerRequest(discovered[0].pricePerRequest);
        }
      } catch { /* best-effort */ }

      let text = `Channel #${idStr} opened.\nDeposit: ${deposit}\nProvider: ${provider}\nExpires in: ${expiresInHours}h`;
      if (descriptor) text += `\nEndpoint: ${descriptor.api.endpoint}`;

      if (p.requestBody && descriptor) {
        try {
          const response = await session.request(p.requestBody as Record<string, unknown>);
          text += `\n\nInitial response: ${JSON.stringify(response, null, 2)}`;
        } catch (reqErr) {
          text += `\n\nChannel open, but initial request failed: ${reqErr instanceof Error ? reqErr.message : 'error'}`;
        }
      }

      callback?.({ text }, []);
      return true;
    } catch (err) {
      callback?.({ text: `Open channel failed: ${err instanceof Error ? err.message : 'error'}` }, []);
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// CLOSE_CHANNEL
// ---------------------------------------------------------------------------

const closeChannelAction: Action = {
  name: 'CLOSE_CHANNEL',
  description:
    'Settle and close a payment channel. Provider receives the spent amount; remaining deposit is refunded.',
  examples: [
    [
      { user: 'user', content: { text: 'Close channel 42' } },
      { user: 'assistant', content: { text: 'Channel #42 closed. Spent: 2500000. Refunded: 2500000.' } },
    ],
  ],
  similes: [
    'SETTLE_CHANNEL', 'close channel', 'settle payment', 'finalize channel',
    'end subscription', 'stop paying',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!getPay(runtime)) return false;
    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    return ['close channel', 'settle channel', 'finalize channel', 'end subscription', 'stop paying']
      .some((t) => raw.toLowerCase().includes(t));
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const pay = getPay(runtime);
    if (!pay) { callback?.({ text: 'Plugin not initialized.' }, []); return false; }

    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const p = parseParams(message);
    const channelId = (p.channelId as string) ?? findChannelId(raw) ?? '';
    if (!channelId) { callback?.({ text: 'Which channel ID should I close? Provide a channel number.' }, []); return false; }

    try {
      const chId = BigInt(channelId);
      const onChain = await pay.getChannel(chId);
      const statusNames = ['Open', 'Settled', 'Refunded'];

      if (onChain.status as number !== 0) {
        callback?.({ text: `Channel #${channelId} is already ${statusNames[onChain.status as number] ?? 'closed'}.` }, []);
        return true;
      }

      const wallet = getWallet(runtime);
      const publicClient = getPublicClient(runtime);
      if (!wallet || !publicClient) {
        callback?.({ text: 'Wallet or public client not configured in the plugin.' }, []);
        return false;
      }

      const session = new ChannelSession({
        channelId: chId,
        payer: wallet,
        publicClient,
        payeeEndpoint: '',
        pricePerRequest: 0n,
        token: onChain.token,
        deposit: onChain.deposit,
        verifyingContract: onChain.payer,
        paymentChannelAddress: onChain.payer,
      });

      const { txHash, refunded } = await session.closeAsPayer();
      const spent = onChain.spent !== undefined ? (onChain as unknown as Record<string, bigint>).spent ?? 0n : 0n;
      const remaining = onChain.deposit - spent;

      callback?.({ text: `Channel #${channelId} settled.\nSpent: ${spent.toString()}\nRefunded: ${refunded.toString()}\nRemaining: ${remaining.toString()}\nTX: ${txHash}` }, []);
      return true;
    } catch (err) {
      callback?.({ text: `Close failed: ${err instanceof Error ? err.message : 'error'}` }, []);
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// GET_BALANCE
// ---------------------------------------------------------------------------

const getBalanceAction: Action = {
  name: 'GET_BALANCE',
  description: 'Check the remaining balance and status of payment channels.',
  examples: [
    [
      { user: 'user', content: { text: 'What is the balance on channel 42?' } },
      { user: 'assistant', content: { text: 'Channel #42: deposit 5000000 | spent 2500000 | remaining 2500000. Status: Open.' } },
    ],
  ],
  similes: [
    'CHECK_BALANCE', 'get balance', 'check channel', 'remaining deposit',
    'how much left', 'channel status', 'my channels', 'list channels',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!getPay(runtime)) return false;
    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    return ['get balance', 'check balance', 'channel balance', 'remaining', 'how much left', 'my channel', 'active channel', 'list channel', 'channel status']
      .some((t) => raw.toLowerCase().includes(t));
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const pay = getPay(runtime);
    if (!pay) { callback?.({ text: 'Plugin not initialized.' }, []); return false; }

    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const channelId = findChannelId(raw);
    const listAll = !channelId || raw.toLowerCase().includes('all') || raw.toLowerCase().includes('list');

    try {
      if (listAll) {
        const services = await pay.discover({ active: true });
        const lines: string[] = [];
        for (const svc of services) {
          try {
            const ch = await pay.getChannel(BigInt(svc.serviceId));
            const remaining = ch.deposit - ch.spent;
            const statuses = ['Open', 'Settled', 'Refunded'];
            lines.push(`#${svc.serviceId}: ${remaining.toString()}/${ch.deposit.toString()} — ${statuses[ch.status as number] ?? '?'} (${svc.provider})`);
          } catch { continue; }
        }
        callback?.({ text: lines.length > 0 ? `Channels:\n${lines.join('\n')}` : 'No active channels found.' }, []);
        return true;
      }

      const ch = await pay.getChannel(BigInt(channelId!));
      const remaining = ch.deposit - ch.spent;
      const statuses = ['Open', 'Settled', 'Refunded'];
      callback?.({ text: `Channel #${channelId}:\nDeposit: ${ch.deposit}\nSpent: ${ch.spent}\nRemaining: ${remaining}\nStatus: ${statuses[ch.status as number] ?? '?'}\nPayer: ${ch.payer}\nPayee: ${ch.payee}` }, []);
      return true;
    } catch (err) {
      callback?.({ text: `Balance check failed: ${err instanceof Error ? err.message : 'error'}` }, []);
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const agentPayProvider = {
  name: 'valuepacket-provider',
  description: 'Provides AgentPay context for payment channel interactions',
  get: async (runtime: IAgentRuntime): Promise<string> => {
    const pay = getPay(runtime);
    if (!pay) return 'ValuePacket Protocol is NOT configured. Initialize the plugin to enable agent payments.';
    try {
      const services = await pay.discover({ active: true });
      return `ValuePacket: Ready. ${services.length} services on registry. Actions: LIST_SERVICE | DISCOVER_AGENTS | SUBSCRIBE_TO_SERVICE | CLOSE_CHANNEL | GET_BALANCE`;
    } catch {
      return 'ValuePacket: Ready. On-chain connectivity may be limited.';
    }
  },
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * The complete ElizaOS plugin for the ValuePacket Protocol.
 *
 * @example
 * ```ts
 * import { agentSettlementPlugin } from '@valuepacket/adapter-eliza';
 * agent.plugins.push(agentSettlementPlugin);
 * ```
 */
export const agentSettlementPlugin: Plugin = {
  name: 'valuepacket',
  description:
    'Pay and get paid by other AI agents across any framework. ' +
    'Register services, discover providers, open payment channels, and settle micropayments on-chain.',
  actions: [
    listServiceAction,
    discoverAgentsAction,
    subscribeToServiceAction,
    closeChannelAction,
    getBalanceAction,
  ],
  providers: [agentPayProvider],
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Configuration for creating the ValuePacket ElizaOS plugin.
 */
export interface AgentSettlementPluginConfig {
  wallet: WalletClient;
  serviceRegistryAddress: string;
  paymentChannelAddress: string;
  spendingPolicyAddress?: string;
  indexerUrl?: string;
}

/**
 * Creates a configured ElizaOS plugin with an initialized AgentPay instance.
 * Call this during agent setup and add the returned plugin to your agent.
 *
 * @example
 * ```ts
 * import { createAgentSettlementPlugin } from '@valuepacket/adapter-eliza';
 *
 * const payPlugin = createAgentSettlementPlugin({
 *   wallet,
 *   serviceRegistryAddress: '0x...',
 *   paymentChannelAddress: '0x...',
 * });
 * // agent.plugins = [..., payPlugin];
 * ```
 */
export function createAgentSettlementPlugin(cfg: AgentSettlementPluginConfig): Plugin {
  const publicClient = createPublicClient({
    chain: cfg.wallet.chain!,
    transport: http(),
  });

  const pay = new AgentPay({
    wallet: cfg.wallet,
    publicClient,
    serviceRegistryAddress: cfg.serviceRegistryAddress as Address,
    paymentChannelAddress: cfg.paymentChannelAddress as Address,
    spendingPolicyAddress: cfg.spendingPolicyAddress as Address | undefined,
    indexerUrl: cfg.indexerUrl,
  });

  const plugin: Plugin = {
    ...agentSettlementPlugin,
    init: (runtime: IAgentRuntime) => {
      setPay(runtime, pay);
      (runtime as unknown as RuntimeExtras).__wallet = cfg.wallet;
      (runtime as unknown as RuntimeExtras).__publicClient = publicClient;
    },
  } as Plugin & { init(runtime: IAgentRuntime): void };

  return plugin;
}

/**
 * Manually inject the AgentPay instance into an ElizaOS runtime.
 */
export function initAgentSettlement(
  runtime: IAgentRuntime,
  pay: AgentPay,
  wallet: WalletClient,
  publicClient: PublicClient,
): void {
  setPay(runtime, pay);
  (runtime as unknown as RuntimeExtras).__wallet = wallet;
  (runtime as unknown as RuntimeExtras).__publicClient = publicClient;
}
