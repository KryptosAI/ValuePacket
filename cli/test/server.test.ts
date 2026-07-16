import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
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
        if (opts.functionName === 'getServiceAtIndex') return Promise.resolve([{}, {}]);
        if (opts.functionName === 'getChannel') return Promise.resolve({ payer: '0x11', deposit: 5000000n });
        if (opts.functionName === 'allowance') return Promise.resolve(10000000n);
        if (opts.functionName === 'balanceOf') return Promise.resolve(100000000n);
        return Promise.resolve(0n);
      }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ blockNumber: 1n, logs: [] }),
      chain: { id: 84532 },
    })),
    createWalletClient: vi.fn(() => ({
      writeContract: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
      signTypedData: vi.fn().mockResolvedValue('0x' + 'cd'.repeat(65)),
      getChainId: vi.fn().mockResolvedValue(84532),
      chain: { id: 84532 },
      account: { address: '0x1111111111111111111111111111111111111111' },
    })),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    http: () => ({}),
  };
});

vi.mock('viem/accounts', () => ({
  generatePrivateKey: vi.fn(() => '0x' + '12'.repeat(32) as `0x${string}`),
  privateKeyToAccount: vi.fn(() => ({
    address: '0x1111111111111111111111111111111111111111' as `0x${string}`,
    publicKey: '0x' + 'cd'.repeat(32),
    type: 'local',
  })),
}));

vi.mock('viem/chains', () => ({
  baseSepolia: {
    id: 84532,
    name: 'Base Sepolia',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  },
}));

describe('Server', () => {
  let channelServer: any;
  let actualPort: number;

  afterEach(async () => {
    if (channelServer) {
      try {
        await channelServer.stop();
      } catch {}
      channelServer = null;
    }
  });

  it('starts ChannelServer and assigns a port', async () => {
    const { startServer } = await import('../src/server.js');

    channelServer = await startServer({
      rpcUrl: 'http://localhost:8545',
      privateKey: '0x' + '12'.repeat(32) as `0x${string}`,
      channelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      port: 0,
      serviceId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      registryAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    expect(channelServer).toBeDefined();
    expect(channelServer.port).toBeGreaterThan(0);
    actualPort = channelServer.port;
    expect(channelServer.server.listening).toBe(true);
  });

  it('handles requests with valid payment proof header', async () => {
    const { startServer } = await import('../src/server.js');

    channelServer = await startServer({
      rpcUrl: 'http://localhost:8545',
      privateKey: '0x' + '12'.repeat(32) as `0x${string}`,
      channelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      port: 0,
      serviceId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      registryAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    actualPort = channelServer.port;

    const proofHeader = {
      channelId: '1',
      cumulativeSpent: '50000',
      nonce: '1',
      proof: '0x' + 'cd'.repeat(65),
      requestHash: '0x' + 'ab'.repeat(32),
    };

    const res = await fetch(`http://127.0.0.1:${actualPort}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-payment-proof': JSON.stringify(proofHeader),
      },
      body: JSON.stringify({ type: 'prediction-feed', input: { asset: 'ETH-USD' } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
    expect(typeof body).toBe('object');
  });

  it('rejects requests without payment proof header', async () => {
    const { startServer } = await import('../src/server.js');

    channelServer = await startServer({
      rpcUrl: 'http://localhost:8545',
      privateKey: '0x' + '12'.repeat(32) as `0x${string}`,
      channelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      port: 0,
      serviceId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      registryAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    actualPort = channelServer.port;

    const res = await fetch(`http://127.0.0.1:${actualPort}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'prediction-feed' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Missing x-payment-proof header');
  });

  it('rejects GET requests', async () => {
    const { startServer } = await import('../src/server.js');

    channelServer = await startServer({
      rpcUrl: 'http://localhost:8545',
      privateKey: '0x' + '12'.repeat(32) as `0x${string}`,
      channelAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      port: 0,
      serviceId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      registryAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    actualPort = channelServer.port;

    const res = await fetch(`http://127.0.0.1:${actualPort}/`, { method: 'GET' });
    expect(res.status).toBe(405);
  });
});
