import { describe, it, expect, vi } from 'vitest';

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  let writeCount = 0;
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
      getChainId: vi.fn().mockResolvedValue(84532),
      readContract: vi.fn().mockImplementation((opts: any) => {
        if (opts.functionName === 'getService') {
          return Promise.resolve({
            provider: '0x1111111111111111111111111111111111111111',
            metadataURI: JSON.stringify({
              service: { id: 'prediction-feed' },
              type: 'prediction-feed',
            }),
            pricePerRequest: 50000n,
            maxResponseMs: 2000,
            registeredAt: 1700000000,
            active: true,
          });
        }
        if (opts.functionName === 'getServiceCount') return Promise.resolve(1n);
        if (opts.functionName === 'getChannel') {
          return Promise.resolve({
            payer: '0x1111111111111111111111111111111111111111',
            payee: '0x2222222222222222222222222222222222222222',
            token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            deposit: 5000000n,
            spent: 0n,
            openedAt: 1700000000,
            expiresAt: 1800000000,
            policy: '0x0000000000000000000000000000000000000000',
            metadata: '0x',
            status: 0,
          });
        }
        if (opts.functionName === 'allowance') return Promise.resolve(10000000n);
        if (opts.functionName === 'balanceOf') return Promise.resolve(100000000n);
        return Promise.resolve(0n);
      }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        blockNumber: 1n,
        logs: [
          {
            address: '0xcccccccccccccccccccccccccccccccccccccccc',
            topics: [
              '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
              '0x0000000000000000000000000000000000000000000000000000000000000001',
            ],
          },
        ],
      }),
      chain: { id: 84532 },
    })),
    createWalletClient: vi.fn(() => {
      writeCount++;
      return {
        writeContract: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
        signTypedData: vi.fn().mockResolvedValue('0x' + 'cd'.repeat(65)),
        getChainId: vi.fn().mockResolvedValue(84532),
        chain: { id: 84532 },
        account: { address: `0x${writeCount.toString(16).padStart(40, '0')}` as `0x${string}` },
      };
    }),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    http: () => ({}),
  };
});

vi.mock('viem/accounts', () => {
  let genCount = 0;
  return {
    generatePrivateKey: vi.fn(() => {
      genCount++;
      return `0x${genCount.toString(16).padStart(64, '0')}` as `0x${string}`;
    }),
    privateKeyToAccount: vi.fn((pk: string) => {
      genCount++;
      return {
        address: `0x${genCount.toString(16).padStart(40, '0')}` as `0x${string}`,
        publicKey: '0x' + 'cd'.repeat(32),
        type: 'local',
      };
    }),
  };
});

vi.mock('viem/chains', () => ({
  baseSepolia: {
    id: 84532,
    name: 'Base Sepolia',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  },
}));

vi.mock('@valuepacket/sdk', () => ({
  signChannelClose: vi.fn().mockResolvedValue('0x' + 'ef'.repeat(65)),
  signPaymentProof: vi.fn().mockResolvedValue('0x' + 'cd'.repeat(65)),
  hashRequest: vi.fn(() => '0x' + 'ab'.repeat(32)),
  createPaymentProofHeader: vi.fn(
    (channelId: bigint, cumulativeSpent: bigint, _body: unknown, nonce: bigint, signature: string) => ({
      channelId: channelId.toString(),
      cumulativeSpent: cumulativeSpent.toString(),
      nonce: nonce.toString(),
      proof: signature,
      requestHash: '0x' + 'ab'.repeat(32),
    }),
  ),
  SERVICE_REGISTRY_ABI: [{ type: 'function', name: 'register', inputs: [], outputs: [{ name: 'serviceId', type: 'bytes32' }] }],
  PAYMENT_CHANNEL_ABI: [{ type: 'function', name: 'openChannel', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes' }], outputs: [] }],
  ServiceNotFoundError: class extends Error { constructor(public readonly serviceId: string) { super(`Service not found: ${serviceId}`); } },
}));

describe('Demo', () => {
  it('runDemo produces a valid DemoResult structure', async () => {
    const { runDemo } = await import('../src/demo.js');

    const result = await runDemo({
      rpcUrl: 'http://localhost:8545',
      registryAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      channelAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      port: 0,
    });

    expect(result).toBeDefined();
    expect(result.payerAddress).toBeTruthy();
    expect(typeof result.payerAddress).toBe('string');
    expect(result.providerAddress).toBeTruthy();
    expect(typeof result.providerAddress).toBe('string');
    expect(result.payerAddress).not.toBe(result.providerAddress);
    expect(result.serviceId).toBeTruthy();
    expect(result.requestCount).toBe(10);
    expect(result.totalSpent).toBeTruthy();
    expect(result.totalRefunded).toBeTruthy();
    expect(result.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.onChainTxCount).toBeGreaterThanOrEqual(0);
    expect(typeof result.success).toBe('boolean');
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('runDemo serviceId is a valid hex string', async () => {
    const { runDemo } = await import('../src/demo.js');

    const result = await runDemo({
      rpcUrl: 'http://localhost:8545',
      registryAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      channelAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      port: 0,
    });

    expect(result.serviceId).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });

  it('runDemo returns 10 requests', async () => {
    const { runDemo } = await import('../src/demo.js');

    const result = await runDemo({
      rpcUrl: 'http://localhost:8545',
      registryAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      channelAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      port: 0,
    });

    expect(result.requestCount).toBe(10);
  });
});
