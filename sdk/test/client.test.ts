import { vi, describe, it, expect, beforeEach } from 'vitest';
import { AgentPay, ServiceNotFoundError, InsufficientFundsError } from '../src/index.js';
import { ChannelSession } from '../src/channel.js';
import { hashRequest } from '../src/signing.js';

// ── Mock decodeEventLog ─────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  decodeEventLog: vi.fn(),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    decodeEventLog: mocks.decodeEventLog,
  };
});

// ── Constants ───────────────────────────────────────────────────────

const SERVICE_REGISTRY_ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const PAYMENT_CHANNEL_ADDRESS = '0x2222222222222222222222222222222222222222' as const;
const SPENDING_POLICY_ADDRESS = '0x3333333333333333333333333333333333333333' as const;
const PAYER_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const PROVIDER_ADDRESS = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const TOKEN_ADDRESS = '0xcccccccccccccccccccccccccccccccccccccccc' as const;
const SERVICE_ID = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const;
const TX_HASH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;
const SIGNATURE = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;

// ── Mock objects ────────────────────────────────────────────────────

let mockPublicClient: ReturnType<typeof createMockPublicClient>;
let mockWallet: ReturnType<typeof createMockWallet>;

function createMockPublicClient() {
  return {
    readContract: vi.fn(),
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getChainId: vi.fn().mockResolvedValue(31337),
  };
}

function createMockWallet() {
  return {
    account: { address: PAYER_ADDRESS },
    chain: { id: 31337 },
    getChainId: vi.fn().mockResolvedValue(31337),
    writeContract: vi.fn().mockResolvedValue(TX_HASH),
    signTypedData: vi.fn().mockResolvedValue(SIGNATURE),
  };
}

function createAgentPay(overrides: {
  publicClient?: ReturnType<typeof createMockPublicClient>;
  wallet?: ReturnType<typeof createMockWallet>;
  spendingPolicyAddress?: `0x${string}`;
  indexerUrl?: string;
} = {}) {
  return new AgentPay({
    wallet: (overrides.wallet ?? mockWallet) as any,
    publicClient: (overrides.publicClient ?? mockPublicClient) as any,
    serviceRegistryAddress: SERVICE_REGISTRY_ADDRESS,
    paymentChannelAddress: PAYMENT_CHANNEL_ADDRESS,
    spendingPolicyAddress: overrides.spendingPolicyAddress ?? SPENDING_POLICY_ADDRESS,
    indexerUrl: overrides.indexerUrl,
  });
}

function mockServiceData(overrides: Partial<{
  provider: `0x${string}`;
  metadataURI: string;
  pricePerRequest: bigint;
  maxResponseMs: number;
  registeredAt: number;
  active: boolean;
}> = {}) {
  return {
    provider: overrides.provider ?? PROVIDER_ADDRESS,
    metadataURI: overrides.metadataURI ?? 'ipfs://QmTest',
    pricePerRequest: overrides.pricePerRequest ?? 1000000n,
    maxResponseMs: overrides.maxResponseMs ?? 500,
    registeredAt: overrides.registeredAt ?? 1000,
    active: overrides.active ?? true,
  };
}

function mockGetServiceAtIndexResponses(
  count: number,
): Array<readonly [`0x${string}`, ReturnType<typeof mockServiceData>]> {
  const results: Array<readonly [`0x${string}`, ReturnType<typeof mockServiceData>]> = [];
  for (let i = 0; i < count; i++) {
    results.push([
      `0x${SERVICE_ID.slice(2, 10)}${String(i).padStart(56, '0')}` as `0x${string}`,
      mockServiceData(),
    ]);
  }
  return results;
}

// ── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  mockPublicClient = createMockPublicClient();
  mockWallet = createMockWallet();
  mocks.decodeEventLog.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

// ══════════════════════════════════════════════════════════════════════
// AgentPay tests
// ══════════════════════════════════════════════════════════════════════

describe('AgentPay', () => {
  // ── registerService ──────────────────────────────────────────────

  describe('registerService', () => {
    it('should register a service and return serviceId + txHash', async () => {
      mockPublicClient.simulateContract.mockResolvedValue({ request: { __mock: true } });
      mocks.decodeEventLog.mockReturnValue({
        eventName: 'ServiceRegistered',
        args: { serviceId: SERVICE_ID },
      });

      const receipt = {
        logs: [
          {
            address: SERVICE_REGISTRY_ADDRESS,
            topics: ['0x00', SERVICE_ID, PAYER_ADDRESS],
            data: '0x',
          },
        ],
      };
      mockPublicClient.waitForTransactionReceipt.mockResolvedValue(receipt);

      const agentPay = createAgentPay();
      const result = await agentPay.registerService({
        metadataURI: 'ipfs://QmTest',
        pricePerRequest: 1000000n,
        maxResponseMs: 500,
      });

      expect(result.serviceId).toBe(SERVICE_ID);
      expect(result.txHash).toBe(TX_HASH);
      expect(mockPublicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: SERVICE_REGISTRY_ADDRESS,
          functionName: 'register',
          args: ['ipfs://QmTest', 1000000n, 500],
        }),
      );
      expect(mockWallet.writeContract).toHaveBeenCalled();
      expect(mockPublicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
        hash: TX_HASH,
      });
    });

    it('should throw if wallet has no account', async () => {
      const noAccountWallet = createMockWallet();
      noAccountWallet.account = undefined as any;

      const agentPay = createAgentPay({ wallet: noAccountWallet });
      await expect(
        agentPay.registerService({
          metadataURI: 'ipfs://QmTest',
          pricePerRequest: 1000000n,
          maxResponseMs: 500,
        }),
      ).rejects.toThrow('Wallet has no account configured');
    });
  });

  // ── discover ─────────────────────────────────────────────────────

  describe('discover', () => {
    it('should return all services from on-chain iteration', async () => {
      const services = mockGetServiceAtIndexResponses(2);

      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'getServiceCount') return BigInt(services.length);
        if (args.functionName === 'getServiceAtIndex') {
          const idx = Number(args.args[0]);
          return services[idx];
        }
        return null;
      });

      const agentPay = createAgentPay();
      const result = await agentPay.discover();

      expect(result).toHaveLength(2);
      expect(result[0].serviceId).toBe(services[0][0]);
      expect(result[0].provider).toBe(PROVIDER_ADDRESS);
      expect(result[1].serviceId).toBe(services[1][0]);
    });

    it('should filter by provider address', async () => {
      const otherProvider = '0x9999999999999999999999999999999999999999' as const;
      const services: Array<readonly [`0x${string}`, ReturnType<typeof mockServiceData>]> = [
        [`0x${SERVICE_ID.slice(2, 10)}${'0'.padStart(56, '0')}` as `0x${string}`, mockServiceData({ provider: PROVIDER_ADDRESS })],
        [`0x${SERVICE_ID.slice(2, 10)}${'1'.padStart(56, '0')}` as `0x${string}`, mockServiceData({ provider: otherProvider })],
      ];

      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'getServiceCount') return BigInt(services.length);
        if (args.functionName === 'getServiceAtIndex') {
          const idx = Number(args.args[0]);
          return services[idx];
        }
        return null;
      });

      const agentPay = createAgentPay();
      const result = await agentPay.discover({ provider: PROVIDER_ADDRESS });

      expect(result).toHaveLength(1);
      expect(result[0].provider).toBe(PROVIDER_ADDRESS);
    });

    it('should filter by maxPrice', async () => {
      const services: Array<readonly [`0x${string}`, ReturnType<typeof mockServiceData>]> = [
        [`0x${SERVICE_ID.slice(2, 10)}${'0'.padStart(56, '0')}` as `0x${string}`, mockServiceData({ pricePerRequest: 100n })],
        [`0x${SERVICE_ID.slice(2, 10)}${'1'.padStart(56, '0')}` as `0x${string}`, mockServiceData({ pricePerRequest: 1000n })],
      ];

      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'getServiceCount') return BigInt(services.length);
        if (args.functionName === 'getServiceAtIndex') {
          const idx = Number(args.args[0]);
          return services[idx];
        }
        return null;
      });

      const agentPay = createAgentPay();
      const result = await agentPay.discover({ maxPrice: 500n });

      expect(result).toHaveLength(1);
      expect(result[0].pricePerRequest).toBe(100n);
    });

    it('should filter by active status', async () => {
      const services: Array<readonly [`0x${string}`, ReturnType<typeof mockServiceData>]> = [
        [`0x${SERVICE_ID.slice(2, 10)}${'0'.padStart(56, '0')}` as `0x${string}`, mockServiceData({ active: true })],
        [`0x${SERVICE_ID.slice(2, 10)}${'1'.padStart(56, '0')}` as `0x${string}`, mockServiceData({ active: false })],
      ];

      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'getServiceCount') return BigInt(services.length);
        if (args.functionName === 'getServiceAtIndex') {
          const idx = Number(args.args[0]);
          return services[idx];
        }
        return null;
      });

      const agentPay = createAgentPay();
      const activeOnly = await agentPay.discover({ active: true });
      expect(activeOnly).toHaveLength(1);
      expect(activeOnly[0].active).toBe(true);

      const inactiveOnly = await agentPay.discover({ active: false });
      expect(inactiveOnly).toHaveLength(1);
      expect(inactiveOnly[0].active).toBe(false);
    });

    it('should handle no services registered (empty result)', async () => {
      mockPublicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'getServiceCount') return 0n;
        if (args.functionName === 'getServiceAtIndex') return null;
        return null;
      });

      const agentPay = createAgentPay();
      const result = await agentPay.discover();
      expect(result).toEqual([]);
    });
  });

  // ── getService ───────────────────────────────────────────────────

  describe('getService', () => {
    it('should return a parsed Service object', async () => {
      mockPublicClient.readContract.mockResolvedValue(mockServiceData());

      const agentPay = createAgentPay();
      const service = await agentPay.getService(SERVICE_ID);

      expect(service.provider).toBe(PROVIDER_ADDRESS);
      expect(service.pricePerRequest).toBe(1000000n);
      expect(service.active).toBe(true);
      expect(mockPublicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'getService',
          args: [SERVICE_ID],
        }),
      );
    });

    it('should throw ServiceNotFoundError when provider is zero address', async () => {
      mockPublicClient.readContract.mockResolvedValue(
        mockServiceData({ provider: '0x0000000000000000000000000000000000000000' }),
      );

      const agentPay = createAgentPay();
      await expect(agentPay.getService(SERVICE_ID)).rejects.toThrow(ServiceNotFoundError);
    });

    it('should throw ServiceNotFoundError when contract call throws', async () => {
      mockPublicClient.readContract.mockRejectedValue(new Error('revert'));

      const agentPay = createAgentPay();
      await expect(agentPay.getService(SERVICE_ID)).rejects.toThrow(ServiceNotFoundError);
    });
  });

  // ── deactivateService ────────────────────────────────────────────

  describe('deactivateService', () => {
    it('should call deactivateService on the contract', async () => {
      mockPublicClient.simulateContract.mockResolvedValue({ request: { __mock: true } });

      const agentPay = createAgentPay();
      const result = await agentPay.deactivateService(SERVICE_ID);

      expect(result.txHash).toBe(TX_HASH);
      expect(mockPublicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: SERVICE_REGISTRY_ADDRESS,
          functionName: 'deactivateService',
          args: [SERVICE_ID],
        }),
      );
      expect(mockWallet.writeContract).toHaveBeenCalled();
    });
  });

  // ── openChannel ──────────────────────────────────────────────────

  describe('openChannel', () => {
    it('should open a channel and return a ChannelSession', async () => {
      mockPublicClient.simulateContract.mockResolvedValue({ request: { __mock: true } });

      const channelId = 42n;
      mocks.decodeEventLog.mockReturnValue({
        eventName: 'ChannelOpened',
        args: { channelId },
      });

      const receipt = {
        logs: [
          {
            address: PAYMENT_CHANNEL_ADDRESS,
            topics: ['0x00', `0x${channelId.toString(16).padStart(64, '0')}`, PAYER_ADDRESS, PROVIDER_ADDRESS],
            data: '0x',
          },
        ],
      };
      mockPublicClient.waitForTransactionReceipt.mockResolvedValue(receipt);

      const agentPay = createAgentPay();
      const session = await agentPay.openChannel({
        provider: PROVIDER_ADDRESS,
        token: TOKEN_ADDRESS,
        deposit: 1000000n,
        expiresIn: 3600,
      });

      expect(session).toBeInstanceOf(ChannelSession);
      expect(session.channelId).toBe(channelId);
      expect(mockPublicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: PAYMENT_CHANNEL_ADDRESS,
          functionName: 'openChannel',
        }),
      );
    });

    it('should throw if wallet has no account', async () => {
      const noAccountWallet = createMockWallet();
      noAccountWallet.account = undefined as any;

      const agentPay = createAgentPay({ wallet: noAccountWallet });
      await expect(
        agentPay.openChannel({
          provider: PROVIDER_ADDRESS,
          token: TOKEN_ADDRESS,
          deposit: 1000000n,
          expiresIn: 3600,
        }),
      ).rejects.toThrow('Wallet has no account configured');
    });
  });

  // ── setSpendingPolicy ────────────────────────────────────────────

  describe('setSpendingPolicy', () => {
    it('should call setPolicy with 4 params (no active field)', async () => {
      mockPublicClient.simulateContract.mockResolvedValue({ request: { __mock: true } });

      const agentPay = createAgentPay();
      const result = await agentPay.setSpendingPolicy({
        maxSpendPerDay: 1000n,
        maxChannelDeposit: 500n,
        maxChannelDuration: 86400,
        requireRegisteredService: true,
        active: true, // should be ignored
      });

      expect(result.txHash).toBe(TX_HASH);
      expect(mockPublicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: SPENDING_POLICY_ADDRESS,
          functionName: 'setPolicy',
          args: [1000n, 500n, 86400n, true],
        }),
      );
    });

    it('should throw if spending policy address is not configured', async () => {
      const agentPay = new AgentPay({
        wallet: mockWallet as any,
        publicClient: mockPublicClient as any,
        serviceRegistryAddress: SERVICE_REGISTRY_ADDRESS,
        paymentChannelAddress: PAYMENT_CHANNEL_ADDRESS,
      });
      await expect(
        agentPay.setSpendingPolicy({
          maxSpendPerDay: 1000n,
          maxChannelDeposit: 500n,
          maxChannelDuration: 86400,
          requireRegisteredService: true,
          active: true,
        }),
      ).rejects.toThrow('SpendingPolicy address not configured');
    });
  });

  // ── getChannel ───────────────────────────────────────────────────

  describe('getChannel', () => {
    it('should return channel details from the contract', async () => {
      mockPublicClient.readContract.mockResolvedValue({
        payer: PAYER_ADDRESS,
        payee: PROVIDER_ADDRESS,
        token: TOKEN_ADDRESS,
        deposit: 1000000n,
        spent: 100n,
        openedAt: 1000,
        expiresAt: 2000,
        policy: '0x0000000000000000000000000000000000000000',
        metadata: '0x',
        status: 0,
      });

      const agentPay = createAgentPay();
      const channel = await agentPay.getChannel(1n);

      expect(channel.payer).toBe(PAYER_ADDRESS);
      expect(channel.payee).toBe(PROVIDER_ADDRESS);
      expect(channel.deposit).toBe(1000000n);
      expect(channel.spent).toBe(100n);
      expect(channel.status).toBe(0);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// ChannelSession tests
// ══════════════════════════════════════════════════════════════════════

describe('ChannelSession', () => {
  let session: ChannelSession;
  const CHANNEL_ID = 42n;
  const DEPOSIT = 1000000n;
  const PRICE_PER_REQUEST = 100n;
  const ENDPOINT = 'https://api.provider.example/v1/chat';

  beforeEach(() => {
    session = new ChannelSession({
      channelId: CHANNEL_ID,
      payer: mockWallet as any,
      publicClient: mockPublicClient as any,
      payeeEndpoint: ENDPOINT,
      pricePerRequest: PRICE_PER_REQUEST,
      token: TOKEN_ADDRESS,
      deposit: DEPOSIT,
      verifyingContract: PAYMENT_CHANNEL_ADDRESS,
      paymentChannelAddress: PAYMENT_CHANNEL_ADDRESS,
    });
  });

  // ── request ──────────────────────────────────────────────────────

  describe('request', () => {
    it('should sign a PaymentProof, POST with headers, and parse response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ reply: 'Hello from AI' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const body = { prompt: 'What is the meaning of life?' };
      const result = await session.request<{ reply: string }>(body);

      expect(result.reply).toBe('Hello from AI');
      expect(mockWallet.signTypedData).toHaveBeenCalledTimes(2); // payment proof + close sig

      expect(mockFetch).toHaveBeenCalledWith(ENDPOINT, expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Channel-Id': CHANNEL_ID.toString(),
          'X-Cumulative-Spent': String(PRICE_PER_REQUEST),
          'X-Request-Nonce': '1',
        }),
        body: JSON.stringify(body),
      }));
    });

    it('should throw InsufficientFundsError when cumulativeSpent exceeds deposit', async () => {
      session.setPricePerRequest(DEPOSIT + 1n);

      await expect(
        session.request({ prompt: 'hello' }),
      ).rejects.toThrow(InsufficientFundsError);
    });

    it('should increment nonce and cumulativeSpent on each call', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // First request
      await session.request({ ping: 1 });
      expect(session.nonce).toBe(1n);
      expect(session.cumulativeSpent).toBe(PRICE_PER_REQUEST);

      // Second request
      await session.request({ ping: 2 });
      expect(session.nonce).toBe(2n);
      expect(session.cumulativeSpent).toBe(PRICE_PER_REQUEST * 2n);
    });
  });

  // ── setState ─────────────────────────────────────────────────────

  describe('setState', () => {
    it('should restore channel state for resumed sessions', () => {
      session.setState(500n, 5n);
      expect(session.cumulativeSpent).toBe(500n);
      expect(session.nonce).toBe(5n);
    });
  });

  // ── close ────────────────────────────────────────────────────────

  describe('close', () => {
    it('should sign and submit closeChannel, return spent/refunded', async () => {
      mockPublicClient.simulateContract.mockResolvedValue({ request: { __mock: true } });

      // Make one request to have some spent
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      });
      vi.stubGlobal('fetch', mockFetch);
      await session.request({ ping: 1 });

      const result = await session.close();

      expect(result.txHash).toBe(TX_HASH);
      expect(result.spent).toBe(PRICE_PER_REQUEST);
      expect(result.refunded).toBe(DEPOSIT - PRICE_PER_REQUEST);

      expect(mockWallet.signTypedData).toHaveBeenCalledTimes(3); // two for request (proof + close sig), one for close
      expect(mockPublicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'closeChannel',
          args: [CHANNEL_ID, PRICE_PER_REQUEST, SIGNATURE],
        }),
      );
    });

    it('should throw if payer wallet has no account', async () => {
      const noAccountWallet = createMockWallet();
      noAccountWallet.account = undefined as any;

      const s = new ChannelSession({
        channelId: CHANNEL_ID,
        payer: noAccountWallet as any,
        publicClient: mockPublicClient as any,
        payeeEndpoint: ENDPOINT,
        pricePerRequest: PRICE_PER_REQUEST,
        token: TOKEN_ADDRESS,
        deposit: DEPOSIT,
        verifyingContract: PAYMENT_CHANNEL_ADDRESS,
        paymentChannelAddress: PAYMENT_CHANNEL_ADDRESS,
      });

      await expect(s.close()).rejects.toThrow('Payer wallet has no account configured');
    });
  });

  // ── closeAsPayer (expired channel) ───────────────────────────────

  describe('closeAsPayer', () => {
    it('should call refundChannel when channel has expired', async () => {
      mockPublicClient.readContract.mockResolvedValue({
        payer: PAYER_ADDRESS,
        payee: PROVIDER_ADDRESS,
        token: TOKEN_ADDRESS,
        deposit: DEPOSIT,
        spent: 0n,
        openedAt: 1000,
        expiresAt: 500, // in the past
        policy: '0x0000000000000000000000000000000000000000',
        metadata: '0x',
        status: 0,
      });

      mockPublicClient.simulateContract.mockResolvedValue({ request: { __mock: true } });

      const result = await session.closeAsPayer();

      expect(result.refunded).toBe(DEPOSIT);
      expect(mockPublicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'refundChannel',
          args: [CHANNEL_ID],
        }),
      );
    });

    it('should call closeChannel when channel is still active', async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

      mockPublicClient.readContract.mockResolvedValue({
        payer: PAYER_ADDRESS,
        payee: PROVIDER_ADDRESS,
        token: TOKEN_ADDRESS,
        deposit: DEPOSIT,
        spent: 0n,
        openedAt: 1000,
        expiresAt: futureExpiry,
        policy: '0x0000000000000000000000000000000000000000',
        metadata: '0x',
        status: 0,
      });

      mockPublicClient.simulateContract.mockResolvedValue({ request: { __mock: true } });

      const result = await session.closeAsPayer();

      expect(mockPublicClient.simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'closeChannel',
          args: [CHANNEL_ID, 0n, SIGNATURE],
        }),
      );
      expect(result.refunded).toBe(DEPOSIT);
    });

    it('should throw if channel is already closed', async () => {
      mockPublicClient.readContract.mockResolvedValue({
        payer: PAYER_ADDRESS,
        payee: PROVIDER_ADDRESS,
        token: TOKEN_ADDRESS,
        deposit: DEPOSIT,
        spent: 0n,
        openedAt: 1000,
        expiresAt: 2000,
        policy: '0x0000000000000000000000000000000000000000',
        metadata: '0x',
        status: 1, // settled
      });

      await expect(session.closeAsPayer()).rejects.toThrow('already closed');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// Signing tests
// ══════════════════════════════════════════════════════════════════════

describe('hashRequest', () => {
  it('should produce deterministic output for the same input', () => {
    const a = hashRequest({ prompt: 'hello', maxTokens: 100 });
    const b = hashRequest({ prompt: 'hello', maxTokens: 100 });
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('should produce same hash regardless of key order (sorted keys)', () => {
    const a = hashRequest({ b: 2, a: 1, c: 3 });
    const b = hashRequest({ a: 1, b: 2, c: 3 });
    const c = hashRequest({ c: 3, b: 2, a: 1 });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('should produce different hashes for different inputs', () => {
    const a = hashRequest({ prompt: 'hello' });
    const b = hashRequest({ prompt: 'world' });
    expect(a).not.toBe(b);
  });

  it('should handle nested objects with sorted keys', () => {
    const a = hashRequest({ outer: { b: 2, a: 1 } });
    const b = hashRequest({ outer: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it('should differentiate arrays from objects', () => {
    const a = hashRequest({ items: [1, 2, 3] });
    const b = hashRequest({ items: [3, 2, 1] });
    expect(a).not.toBe(b);
  });
});
