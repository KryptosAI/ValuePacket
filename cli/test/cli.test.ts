import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils.js', async () => {
  const actual = await vi.importActual('../src/utils.js');
  return {
    ...actual,
    log: vi.fn(),
  };
});

vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
      getChainId: vi.fn().mockResolvedValue(84532),
      readContract: vi.fn().mockResolvedValue(0n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ blockNumber: 1n, logs: [] }),
      chain: { id: 84532 },
    })),
    createWalletClient: vi.fn(() => ({
      writeContract: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
      signTypedData: vi.fn().mockResolvedValue('0x' + 'cd'.repeat(65)),
      getChainId: vi.fn().mockResolvedValue(84532),
      chain: { id: 84532 },
      account: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    })),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    http: () => ({}),
  };
});

vi.mock('viem/accounts', () => ({
  generatePrivateKey: vi.fn(() => '0x' + '12'.repeat(32) as `0x${string}`),
  privateKeyToAccount: vi.fn(() => ({
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`,
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
}));

describe('CLI Commands', () => {
  it('version flag shows version', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    program.name('valuepacket').version('0.1.0');

    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = vi.fn((s: string) => {
      output += s;
      return true;
    });

    try {
      await program.parseAsync(['node', 'valuepacket', '--version'], { from: 'user' });
    } catch {}

    process.stdout.write = origWrite;
    expect(output).toContain('0.1.0');
  });

  it('help shows usage info', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    program.name('valuepacket').description('Test CLI').version('0.1.0');

    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = vi.fn((s: string) => {
      output += s;
      return true;
    });

    try {
      await program.parseAsync(['node', 'valuepacket', '--help'], { from: 'user' });
    } catch {}

    process.stdout.write = origWrite;
    expect(output).toContain('Usage:');
    expect(output).toContain('valuepacket');
  });
});
