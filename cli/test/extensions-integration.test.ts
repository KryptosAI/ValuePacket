import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hash } from 'viem';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseAbi,
  keccak256,
  toHex,
  encodeAbiParameters,
  verifyTypedData,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  signChannelClose,
  CHANNEL_CLOSE_TYPE,
} from '@valuepacket/sdk';
import { paymentChannelAbi, erc20Abi } from '../src/contracts.js';
import { usdcToWei, ZERO_ADDRESS } from '../src/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ANVIL_RPC = 'http://localhost:8545';
const ANVIL_PORT = '8545';

const ACCOUNTS = {
  deployer: {
    pk: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hash,
    addr: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
  },
  account1: {
    pk: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hash,
    addr: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address,
  },
  account2: {
    pk: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hash,
    addr: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address,
  },
} as const;

const CONTRACTS_DIR = join(__dirname, '..', '..', 'contracts');
const DEPLOYMENTS_DIR = join(CONTRACTS_DIR, 'deployments');
const LOCAL_DEPLOYMENT = join(DEPLOYMENTS_DIR, 'local.json');

const anvilChain = {
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
} as const;

// ── ABIs for extension contracts ────────────────────────────────────

const mockUsdcAbi = [
  ...erc20Abi,
  {
    type: 'function',
    name: 'mint',
    inputs: [
      { name: 'to', type: 'address', internalType: 'address' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const agentReputationAbi = parseAbi([
  'function rateService(address provider, bytes32 channelId, uint8 score, string comment) external returns (bytes32 uid)',
  'function getAverageScore(address provider) external view returns (uint256)',
  'function getRatingCount(address provider) external view returns (uint256)',
  'function getScore(bytes32 uid) external view returns (uint8)',
  'function hasRated(bytes32 channelId, address payer) external view returns (bool)',
  'function EAS() external view returns (address)',
  'function SCHEMA_UID() external view returns (bytes32)',
  'event ServiceRated(address indexed provider, address indexed payer, bytes32 indexed channelId, uint8 score)',
  'error InvalidScore()',
  'error AlreadyRated()',
]);

const subscriptionManagerAbi = parseAbi([
  'constructor(address _paymentChannel)',
  'function createSubscription(address payee, address token, uint256 amountPerPeriod, uint32 periodDuration, uint256 maxPeriods, uint256 initialDeposit, bytes metadata) external returns (uint256 subscriptionId)',
  'function renew(uint256 subscriptionId, uint256 spent, bytes32 salt, bytes signature) external',
  'function cancel(uint256 subscriptionId) external returns (uint256 refunded)',
  'function getSubscription(uint256 subscriptionId) external view returns ((address payer,address payee,address token,uint256 amountPerPeriod,uint32 periodDuration,uint256 maxPeriods,uint256 completedPeriods,uint256 totalDeposited,uint256 totalSpent,uint256 activeChannelId,uint32 currentPeriodStart,bool active,bytes metadata))',
  'function getSubscriptionCount() external view returns (uint256)',
  'function SUBSCRIPTION_AUTH_TYPEHASH() external view returns (bytes32)',
  'function paymentChannel() external view returns (address)',
  'event SubscriptionCreated(uint256 indexed subscriptionId, address indexed payer, address indexed payee, uint256 amountPerPeriod)',
  'event SubscriptionRenewed(uint256 indexed subscriptionId, uint256 newChannelId, uint256 spentLastPeriod, uint256 periodNumber)',
  'event SubscriptionCancelled(uint256 indexed subscriptionId, uint256 refunded)',
  'error SubscriptionNotFound(uint256 subscriptionId)',
  'error SubscriptionNotActive(uint256 subscriptionId)',
  'error NotPayee(uint256 subscriptionId, address caller, address payee)',
  'error MaxPeriodsReached(uint256 subscriptionId, uint256 completedPeriods, uint256 maxPeriods)',
  'error SpentExceedsAmount(uint256 spent, uint256 amountPerPeriod)',
  'error InvalidSignature()',
  'error ZeroAddress()',
  'error ZeroAmount()',
  'error InsufficientDeposit(uint256 provided, uint256 required)',
]);

const crossChainSettlementAbi = parseAbi([
  'constructor(bytes32 _sourceDomainSeparator, uint256 _sourceChainId, address _axelarGateway, uint256 _timeout)',
  'function deposit(bytes32 paymentId, address payee, uint256 amount, address token) external',
  'function settleFromSource(bytes32 paymentId, uint256 channelId, uint256 spent, bytes signature) external',
  'function refund(bytes32 paymentId) external',
  'function escrows(bytes32) external view returns ((address payer,address payee,address token,uint256 deposit,uint256 spent,uint48 deadline,bool settled))',
  'function SOURCE_DOMAIN_SEPARATOR() external view returns (bytes32)',
  'function SOURCE_CHAIN_ID() external view returns (uint256)',
  'function AXELAR_GATEWAY() external view returns (address)',
  'function CHANNEL_CLOSE_TYPEHASH() external view returns (bytes32)',
  'function TIMEOUT() external view returns (uint256)',
  'event EscrowDeposited(bytes32 indexed paymentId, address indexed payer, address indexed payee, address token, uint256 amount, uint48 deadline)',
  'event EscrowSettled(bytes32 indexed paymentId, uint256 spent)',
  'error EscrowNotFound(bytes32 paymentId)',
  'error EscrowAlreadySettled(bytes32 paymentId)',
  'error NotAxelarGateway()',
  'error SpentExceedsDeposit(uint256 spent, uint256 deposit)',
  'error InvalidSignature()',
  'error ZeroDeposit()',
  'error ZeroPayee()',
  'error ZeroToken()',
]);

const mockAxelarGatewayAbi = parseAbi([
  'function relaySettleFromSource(address settlement, bytes32 paymentId, uint256 channelId, uint256 spent, bytes signature) external',
  'event SettlementRelayed(address indexed settlement, bytes32 indexed paymentId)',
]);

// ── Helpers ──────────────────────────────────────────────────────────

function runForge(args: string, extraEnv?: Record<string, string>): string {
  try {
    return execSync(`forge ${args}`, {
      cwd: CONTRACTS_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 120_000,
      env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr || '';
    throw new Error(`forge failed: ${msg}\n${stderr}`);
  }
}

function deployContract(contractPath: string, constructorArgs?: string): Address {
  let cmd = `create ${contractPath} --rpc-url ${ANVIL_RPC} --private-key ${ACCOUNTS.deployer.pk} --broadcast`;
  if (constructorArgs) {
    cmd += ` --constructor-args ${constructorArgs}`;
  }
  const output = runForge(cmd);

  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
  if (!match || !match[1]) {
    throw new Error(
      `Could not parse deployed address from forge output:\n${output.slice(0, 2000)}`,
    );
  }

  return match[1] as Address;
}

async function waitForAnvil(retries = 40, delayMs = 1000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(ANVIL_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
          id: 1,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.result) return;
      }
    } catch {
      // anvil not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Anvil did not start within the expected time');
}

async function increaseTime(seconds: number): Promise<void> {
  await fetch(ANVIL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'evm_increaseTime',
      params: [seconds],
      id: 1,
    }),
  });
  await fetch(ANVIL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'evm_mine',
      params: [],
      id: 2,
    }),
  });
}

function computeDomainSeparator(
  chainId: number,
  verifyingContract: Address,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        keccak256(
          toHex(
            'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
          ),
        ),
        keccak256(toHex('ValuePacket')),
        keccak256(toHex('1')),
        BigInt(chainId),
        verifyingContract,
      ],
    ),
  );
}

async function signSubscriptionAuth(
  wallet: WalletClient,
  subscriptionId: bigint,
  amountPerPeriod: bigint,
  periodDuration: number,
  maxPeriods: bigint,
  salt: `0x${string}`,
  verifyingContract: Address,
): Promise<Hash> {
  const account = wallet.account;
  if (!account) throw new Error('wallet has no account');

  return wallet.signTypedData({
    account,
    domain: {
      name: 'ValuePacket',
      version: '1',
      chainId: 31337,
      verifyingContract,
    },
    types: {
      SubscriptionAuth: [
        { name: 'subscriptionId', type: 'uint256' },
        { name: 'amountPerPeriod', type: 'uint256' },
        { name: 'periodDuration', type: 'uint32' },
        { name: 'maxPeriods', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
      ],
    },
    primaryType: 'SubscriptionAuth',
    message: { subscriptionId, amountPerPeriod, periodDuration, maxPeriods, salt },
  });
}

function createAnvilWallet(pk: Hash): WalletClient {
  const account = privateKeyToAccount(pk);
  return createWalletClient({
    chain: anvilChain,
    transport: http(ANVIL_RPC),
    account,
  });
}

async function fundEth(
  from: WalletClient,
  to: Address,
  amount: bigint,
  pc: PublicClient,
): Promise<void> {
  const hash = await from.sendTransaction({ to, value: amount });
  await pc.waitForTransactionReceipt({ hash });
}

async function mintUsdc(
  minter: WalletClient,
  to: Address,
  amount: bigint,
  pc: PublicClient,
  usdc: Address,
): Promise<void> {
  const hash = await minter.writeContract({
    address: usdc,
    abi: mockUsdcAbi,
    functionName: 'mint',
    args: [to, amount],
  });
  await pc.waitForTransactionReceipt({ hash });
}

async function approveUsdc(
  wallet: WalletClient,
  spender: Address,
  amount: bigint,
  pc: PublicClient,
  usdc: Address,
): Promise<void> {
  const hash = await wallet.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  });
  await pc.waitForTransactionReceipt({ hash });
}

async function getUsdcBalance(
  pc: PublicClient,
  usdc: Address,
  account: Address,
): Promise<bigint> {
  return (await pc.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  })) as unknown as bigint;
}

type OnChainChannel = {
  payer: Address;
  payee: Address;
  token: Address;
  deposit: bigint;
  spent: bigint;
  openedAt: number;
  expiresAt: number;
  policy: Address;
  metadata: string;
  status: number;
};

async function getOnChainChannel(
  pc: PublicClient,
  chAddr: Address,
  channelId: bigint,
): Promise<OnChainChannel> {
  return (await pc.readContract({
    address: chAddr,
    abi: paymentChannelAbi,
    functionName: 'getChannel',
    args: [channelId],
  })) as unknown as OnChainChannel;
}

async function openAndCloseChannel(
  payerWallet: WalletClient,
  payeeAddress: Address,
  tokenAddress: Address,
  depositAmount: bigint,
  spentAmount: bigint,
  pc: PublicClient,
  chAddr: Address,
  payeeWallet: WalletClient,
): Promise<bigint> {
  const openTopic = keccak256(
    toHex('ChannelOpened(uint256,address,address,address,uint256,uint32)'),
  );

  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 3600;

  const openHash = await payerWallet.writeContract({
    address: chAddr,
    abi: paymentChannelAbi,
    functionName: 'openChannel',
    args: [payeeAddress, tokenAddress, depositAmount, expiresAt, ZERO_ADDRESS, '0x'],
  });
  const openReceipt = await pc.waitForTransactionReceipt({ hash: openHash });

  const openEvent = openReceipt.logs.find(
    (l) =>
      l.address.toLowerCase() === chAddr.toLowerCase() &&
      l.topics[0] === openTopic,
  );
  if (!openEvent) throw new Error('ChannelOpened event not found');

  const channelId = BigInt(openEvent.topics[1]);

  const closeSig = await signChannelClose(
    payerWallet,
    chAddr,
    channelId,
    spentAmount,
  );

  const closeHash = await payeeWallet.writeContract({
    address: chAddr,
    abi: paymentChannelAbi,
    functionName: 'closeChannel',
    args: [channelId, spentAmount, closeSig],
  });
  await pc.waitForTransactionReceipt({ hash: closeHash });

  return channelId;
}

// ── Module-level state ───────────────────────────────────────────────

let anvilProcess: ChildProcess | null = null;
let publicClient: PublicClient;
let wallet0: WalletClient;
let wallet1: WalletClient;
let wallet2: WalletClient;

let usdcAddress: Address;
let easAddress: Address;
let registryAddress: Address;
let channelAddress: Address;
let policyAddress: Address;
let reputationAddress: Address;
let subscriptionAddress: Address;
let settlementAddress: Address;
let axelarGatewayAddress: Address;

let sourceDomainSeparator: `0x${string}`;

const USDC_FUND = usdcToWei(1000); // $1000 USDC per account

describe('ValuePacket Extensions Integration', () => {
  beforeAll(async () => {
    // ── Start anvil ──────────────────────────────────────────────────
    anvilProcess = spawn('anvil', ['--port', ANVIL_PORT, '--chain-id', '31337'], {
      stdio: 'pipe',
      detached: false,
    });

    let anvilStderr = '';
    anvilProcess.stderr?.on('data', (data: Buffer) => {
      anvilStderr += data.toString();
    });

    anvilProcess.on('error', (err: Error) => {
      throw new Error(`Failed to start anvil: ${err.message}`);
    });

    if (anvilProcess.exitCode !== null) {
      throw new Error(
        `Anvil exited immediately with code ${anvilProcess.exitCode}\n${anvilStderr}`,
      );
    }

    await waitForAnvil();

    // ── Build forge project ──────────────────────────────────────────
    runForge('build');

    // ── Deploy contracts in dependency order ─────────────────────────
    // Core contracts
    usdcAddress = deployContract('src/mocks/MockUSDC.sol:MockUSDC');
    registryAddress = deployContract('src/ServiceRegistry.sol:ServiceRegistry');
    channelAddress = deployContract('src/PaymentChannel.sol:PaymentChannel');
    policyAddress = deployContract('src/SpendingPolicy.sol:SpendingPolicy');

    // MockEAS (needed by AgentReputation)
    easAddress = deployContract('src/mocks/MockEAS.sol:MockEAS');

    // AgentReputation(address eas)
    const encodedEasArg = encodeAbiParameters(
      [{ type: 'address' }],
      [easAddress],
    );
    reputationAddress = deployContract(
      'src/extensions/AgentReputation.sol:AgentReputation',
      encodedEasArg,
    );

    // SubscriptionManager(address paymentChannel)
    const encodedChannelArg = encodeAbiParameters(
      [{ type: 'address' }],
      [channelAddress],
    );
    subscriptionAddress = deployContract(
      'src/extensions/SubscriptionManager.sol:SubscriptionManager',
      encodedChannelArg,
    );

    // MockAxelarGateway
    axelarGatewayAddress = deployContract(
      'src/mocks/MockAxelarGateway.sol:MockAxelarGateway',
    );

    // CrossChainSettlement(bytes32 sourceDomainSeparator, uint256 sourceChainId,
    //                       address axelarGateway, uint256 timeout)
    const sourceChainId = 1;
    sourceDomainSeparator = computeDomainSeparator(sourceChainId, channelAddress);
    const timeout = 7n * 24n * 3600n; // 1 week

    const encodedSettlementArg = encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [sourceDomainSeparator, BigInt(sourceChainId), axelarGatewayAddress, timeout],
    );
    settlementAddress = deployContract(
      'src/extensions/CrossChainSettlement.sol:CrossChainSettlement',
      encodedSettlementArg,
    );

    // ── Write local.json ─────────────────────────────────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) {
      mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    }

    writeFileSync(
      LOCAL_DEPLOYMENT,
      JSON.stringify(
        {
          serviceRegistry: registryAddress,
          paymentChannel: channelAddress,
          spendingPolicy: policyAddress,
          usdc: usdcAddress,
          agentReputation: reputationAddress,
          subscriptionManager: subscriptionAddress,
          crossChainSettlement: settlementAddress,
          mockAxelarGateway: axelarGatewayAddress,
          mockEAS: easAddress,
          chainId: 31337,
          network: 'local',
        },
        null,
        2,
      ),
    );

    // ── Initialize wallets ───────────────────────────────────────────
    wallet0 = createAnvilWallet(ACCOUNTS.deployer.pk);
    wallet1 = createAnvilWallet(ACCOUNTS.account1.pk);
    wallet2 = createAnvilWallet(ACCOUNTS.account2.pk);

    publicClient = createPublicClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
    });

    // ── Fund accounts with ETH ───────────────────────────────────────
    await fundEth(wallet0, ACCOUNTS.account1.addr, parseEther('100'), publicClient);
    await fundEth(wallet0, ACCOUNTS.account2.addr, parseEther('100'), publicClient);

    // ── Mint USDC to all three accounts ──────────────────────────────
    await mintUsdc(wallet0, ACCOUNTS.deployer.addr, USDC_FUND, publicClient, usdcAddress);
    await mintUsdc(wallet0, ACCOUNTS.account1.addr, USDC_FUND, publicClient, usdcAddress);
    await mintUsdc(wallet0, ACCOUNTS.account2.addr, USDC_FUND, publicClient, usdcAddress);

    // ── Approve USDC for PaymentChannel ──────────────────────────────
    await approveUsdc(wallet0, channelAddress, USDC_FUND, publicClient, usdcAddress);
    await approveUsdc(wallet1, channelAddress, USDC_FUND, publicClient, usdcAddress);
    await approveUsdc(wallet2, channelAddress, USDC_FUND, publicClient, usdcAddress);

    // ── Approve USDC for SubscriptionManager ─────────────────────────
    await approveUsdc(wallet0, subscriptionAddress, USDC_FUND, publicClient, usdcAddress);
    await approveUsdc(wallet1, subscriptionAddress, USDC_FUND, publicClient, usdcAddress);
    await approveUsdc(wallet2, subscriptionAddress, USDC_FUND, publicClient, usdcAddress);

    // ── Approve USDC for CrossChainSettlement ────────────────────────
    await approveUsdc(wallet0, settlementAddress, USDC_FUND, publicClient, usdcAddress);
    await approveUsdc(wallet1, settlementAddress, USDC_FUND, publicClient, usdcAddress);
    await approveUsdc(wallet2, settlementAddress, USDC_FUND, publicClient, usdcAddress);
  }, 300_000);

  afterAll(async () => {
    if (anvilProcess && anvilProcess.pid) {
      anvilProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 5000);
        anvilProcess!.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      anvilProcess = null;
    }
  }, 15_000);

  // ── Sanity check ───────────────────────────────────────────────────

  it('should deploy all contracts', () => {
    const addrs: Record<string, Address> = {
      MockUSDC: usdcAddress,
      MockEAS: easAddress,
      ServiceRegistry: registryAddress,
      PaymentChannel: channelAddress,
      SpendingPolicy: policyAddress,
      AgentReputation: reputationAddress,
      SubscriptionManager: subscriptionAddress,
      CrossChainSettlement: settlementAddress,
      MockAxelarGateway: axelarGatewayAddress,
    };

    for (const [, addr] of Object.entries(addrs)) {
      expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(addr).not.toBe(ZERO_ADDRESS);
    }

    const addrSet = new Set(Object.values(addrs).map((a) => a.toLowerCase()));
    expect(addrSet.size).toBe(Object.keys(addrs).length);

    // Verify deployments/local.json
    const deployed = JSON.parse(readFileSync(LOCAL_DEPLOYMENT, 'utf-8'));
    expect(deployed.serviceRegistry).toBe(registryAddress);
    expect(deployed.paymentChannel).toBe(channelAddress);
    expect(deployed.usdc).toBe(usdcAddress);
    expect(deployed.agentReputation).toBe(reputationAddress);
    expect(deployed.subscriptionManager).toBe(subscriptionAddress);
    expect(deployed.crossChainSettlement).toBe(settlementAddress);
    expect(deployed.mockAxelarGateway).toBe(axelarGatewayAddress);
  });

  it('should have funded all accounts', async () => {
    for (const acct of [
      ACCOUNTS.deployer,
      ACCOUNTS.account1,
      ACCOUNTS.account2,
    ]) {
      const ethBal = await publicClient.getBalance({ address: acct.addr });
      expect(ethBal).toBeGreaterThan(parseEther('10'));

      const usdcBal = await getUsdcBalance(publicClient, usdcAddress, acct.addr);
      expect(usdcBal).toBeGreaterThanOrEqual(USDC_FUND);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Test 1: Reputation — rate a service after payment
  // ═══════════════════════════════════════════════════════════════════

  it('Test 1: Reputation — rate a service after payment', async () => {
    const payer = wallet0;
    const payee = wallet1;
    const depositAmount = usdcToWei(10);

    // Open first channel, complete 3 requests ($0.15 spent), close
    const channelId1 = await openAndCloseChannel(
      payer,
      ACCOUNTS.account1.addr,
      usdcAddress,
      depositAmount,
      usdcToWei(0.15),
      publicClient,
      channelAddress,
      payee,
    );

    // Payer rates with score 9
    let receipt = await publicClient.waitForTransactionReceipt({
      hash: await payer.writeContract({
        address: reputationAddress,
        abi: agentReputationAbi,
        functionName: 'rateService',
        args: [
          ACCOUNTS.account1.addr,
          toHex(channelId1, { size: 32 }),
          9,
          'Excellent service',
        ],
      }),
    });
    expect(receipt.status).toBe('success');

    // Open second channel (different channelId), close, rate with score 7
    const channelId2 = await openAndCloseChannel(
      payer,
      ACCOUNTS.account1.addr,
      usdcAddress,
      depositAmount,
      usdcToWei(0.15),
      publicClient,
      channelAddress,
      payee,
    );

    expect(channelId2).not.toBe(channelId1);

    receipt = await publicClient.waitForTransactionReceipt({
      hash: await payer.writeContract({
        address: reputationAddress,
        abi: agentReputationAbi,
        functionName: 'rateService',
        args: [
          ACCOUNTS.account1.addr,
          toHex(channelId2, { size: 32 }),
          7,
          'Good but could improve',
        ],
      }),
    });
    expect(receipt.status).toBe('success');

    // Verify getAverageScore returns 8  (9 + 7) / 2 = 8
    const avgScore = (await publicClient.readContract({
      address: reputationAddress,
      abi: agentReputationAbi,
      functionName: 'getAverageScore',
      args: [ACCOUNTS.account1.addr],
    })) as unknown as bigint;

    expect(avgScore).toBe(8n);

    // Verify getRatingCount returns 2
    const ratingCount = (await publicClient.readContract({
      address: reputationAddress,
      abi: agentReputationAbi,
      functionName: 'getRatingCount',
      args: [ACCOUNTS.account1.addr],
    })) as unknown as bigint;

    expect(ratingCount).toBe(2n);

    // Verify payer cannot re-rate the same channel
    const alreadyRated = (await publicClient.readContract({
      address: reputationAddress,
      abi: agentReputationAbi,
      functionName: 'hasRated',
      args: [toHex(channelId1, { size: 32 }), ACCOUNTS.deployer.addr],
    })) as unknown as boolean;

    expect(alreadyRated).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Test 2: Subscription — auto-renewing channel
  // ═══════════════════════════════════════════════════════════════════

  it('Test 2: Subscription — auto-renewing periods', async () => {
    const payer = wallet0;
    const payerAddr = ACCOUNTS.deployer.addr;
    const provider = wallet1;
    const providerAddr = ACCOUNTS.account1.addr;

    const amountPerPeriod = usdcToWei(5);
    const periodDuration = 3600;
    const maxPeriods = 2n; // 2 renewals possible → total 3 periods
    const initialDeposit = usdcToWei(15); // $5 × 3 buffer

    // ── Create subscription ──────────────────────────────────────────
    const payerUsdcBefore = await getUsdcBalance(publicClient, usdcAddress, payerAddr);

    const subHash = await payer.writeContract({
      address: subscriptionAddress,
      abi: subscriptionManagerAbi,
      functionName: 'createSubscription',
      args: [
        providerAddr,
        usdcAddress,
        amountPerPeriod,
        periodDuration,
        maxPeriods,
        initialDeposit,
        '0x',
      ],
    });
    const subReceipt = await publicClient.waitForTransactionReceipt({ hash: subHash });

    // Extract subscriptionId from SubscriptionCreated event
    const subCreatedTopic = keccak256(
      toHex(
        'SubscriptionCreated(uint256,address,address,address,uint256)',
      ),
    );
    const subEvent = subReceipt.logs.find(
      (l) =>
        l.address.toLowerCase() === subscriptionAddress.toLowerCase() &&
        l.topics[0] === subCreatedTopic,
    );
    expect(subEvent).toBeDefined();
    const subscriptionId = BigInt(subEvent!.topics[1]);

    // Verify USDC deposited ($15 taken from payer)
    const payerUsdcAfterCreate = await getUsdcBalance(
      publicClient,
      usdcAddress,
      payerAddr,
    );
    expect(payerUsdcBefore - payerUsdcAfterCreate).toBe(initialDeposit);

    // Verify subscription state
    const sub = (await publicClient.readContract({
      address: subscriptionAddress,
      abi: subscriptionManagerAbi,
      functionName: 'getSubscription',
      args: [subscriptionId],
    })) as unknown as {
      payer: Address;
      payee: Address;
      token: Address;
      amountPerPeriod: bigint;
      periodDuration: number;
      maxPeriods: bigint;
      completedPeriods: bigint;
      totalDeposited: bigint;
      totalSpent: bigint;
      activeChannelId: bigint;
      currentPeriodStart: number;
      active: boolean;
    };

    expect(sub.payer.toLowerCase()).toBe(payerAddr.toLowerCase());
    expect(sub.payee.toLowerCase()).toBe(providerAddr.toLowerCase());
    expect(sub.amountPerPeriod).toBe(amountPerPeriod);
    expect(sub.maxPeriods).toBe(maxPeriods);
    expect(sub.completedPeriods).toBe(0n);
    expect(sub.totalSpent).toBe(0n);
    expect(sub.active).toBe(true);

    // First channel opened by SubscriptionManager on PaymentChannel
    const firstChannelId = sub.activeChannelId;
    expect(firstChannelId).toBeGreaterThan(0n);

    const firstChannel = await getOnChainChannel(
      publicClient,
      channelAddress,
      firstChannelId,
    );
    expect(firstChannel.payer.toLowerCase()).toBe(subscriptionAddress.toLowerCase());
    expect(firstChannel.payee.toLowerCase()).toBe(providerAddr.toLowerCase());
    expect(firstChannel.status).toBe(0); // Open

    // ── Renew 1: settle period 1, advance to period 2 ─────────────────
    await increaseTime(periodDuration + 1);

    const salt1 = keccak256(toHex('salt-renew-1'));
    const renewSig1 = await signSubscriptionAuth(
      payer,
      subscriptionId,
      amountPerPeriod,
      periodDuration,
      maxPeriods,
      salt1,
      subscriptionAddress,
    );

    const providerUsdcBefore1 = await getUsdcBalance(publicClient, usdcAddress, providerAddr);

    await publicClient.waitForTransactionReceipt({
      hash: await provider.writeContract({
        address: subscriptionAddress,
        abi: subscriptionManagerAbi,
        functionName: 'renew',
        args: [subscriptionId, amountPerPeriod, salt1, renewSig1],
      }),
    });

    // Verify state after renew 1
    const sub1 = (await publicClient.readContract({
      address: subscriptionAddress,
      abi: subscriptionManagerAbi,
      functionName: 'getSubscription',
      args: [subscriptionId],
    })) as unknown as {
      completedPeriods: bigint;
      totalSpent: bigint;
      activeChannelId: bigint;
      active: boolean;
    };

    expect(sub1.completedPeriods).toBe(1n);
    expect(sub1.totalSpent).toBe(usdcToWei(5));
    expect(sub1.active).toBe(true);

    // Provider received $5
    const providerUsdcAfter1 = await getUsdcBalance(publicClient, usdcAddress, providerAddr);
    expect(providerUsdcAfter1 - providerUsdcBefore1).toBe(amountPerPeriod);

    // Old channel closed, new channel opened
    expect(sub1.activeChannelId).toBeGreaterThan(0n);
    expect(sub1.activeChannelId).not.toBe(firstChannelId);

    const secondChannel = await getOnChainChannel(
      publicClient,
      channelAddress,
      sub1.activeChannelId,
    );
    expect(secondChannel.status).toBe(0); // Open
    expect(secondChannel.deposit).toBe(amountPerPeriod);

    // ── Renew 2: settle period 2, advance to period 3 ─────────────────
    await increaseTime(periodDuration + 1);

    const salt2 = keccak256(toHex('salt-renew-2'));
    const renewSig2 = await signSubscriptionAuth(
      payer,
      subscriptionId,
      amountPerPeriod,
      periodDuration,
      maxPeriods,
      salt2,
      subscriptionAddress,
    );

    const providerUsdcBefore2 = await getUsdcBalance(publicClient, usdcAddress, providerAddr);

    await publicClient.waitForTransactionReceipt({
      hash: await provider.writeContract({
        address: subscriptionAddress,
        abi: subscriptionManagerAbi,
        functionName: 'renew',
        args: [subscriptionId, amountPerPeriod, salt2, renewSig2],
      }),
    });

    // "should be period 3 of 3"
    const sub2 = (await publicClient.readContract({
      address: subscriptionAddress,
      abi: subscriptionManagerAbi,
      functionName: 'getSubscription',
      args: [subscriptionId],
    })) as unknown as {
      completedPeriods: bigint;
      totalSpent: bigint;
      activeChannelId: bigint;
      active: boolean;
    };

    expect(sub2.completedPeriods).toBe(2n); // 2 completed, period 3 active
    expect(sub2.totalSpent).toBe(usdcToWei(10));
    expect(sub2.active).toBe(true);

    const providerUsdcAfter2 = await getUsdcBalance(publicClient, usdcAddress, providerAddr);
    expect(providerUsdcAfter2 - providerUsdcBefore2).toBe(amountPerPeriod);

    // ── Renew 3 attempt: should revert (max 2 completed) ──────────────
    await increaseTime(periodDuration + 1);

    const salt3 = keccak256(toHex('salt-renew-3'));
    const renewSig3 = await signSubscriptionAuth(
      payer,
      subscriptionId,
      amountPerPeriod,
      periodDuration,
      maxPeriods,
      salt3,
      subscriptionAddress,
    );

    await expect(
      provider.writeContract({
        address: subscriptionAddress,
        abi: subscriptionManagerAbi,
        functionName: 'renew',
        args: [subscriptionId, amountPerPeriod, salt3, renewSig3],
      }),
    ).rejects.toThrow();

    // Verify total spent = $10 across all settled periods
    const subFinal = (await publicClient.readContract({
      address: subscriptionAddress,
      abi: subscriptionManagerAbi,
      functionName: 'getSubscription',
      args: [subscriptionId],
    })) as unknown as { totalSpent: bigint; completedPeriods: bigint; active: boolean };

    expect(subFinal.totalSpent).toBe(usdcToWei(10));
    expect(subFinal.completedPeriods).toBe(2n);
    expect(subFinal.active).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Test 3: Cross-Chain Settlement
  // ═══════════════════════════════════════════════════════════════════

  it('Test 3: Cross-Chain Settlement — deposit, sign, settle', async () => {
    const payer = wallet0;
    const payerAddr = ACCOUNTS.deployer.addr;
    const payeeAddr = ACCOUNTS.account1.addr;
    const depositAmount = usdcToWei(20);
    const spentAmount = usdcToWei(8);

    const paymentId = keccak256(toHex(`cross-chain-${Date.now()}`));

    const payerUsdcBefore = await getUsdcBalance(publicClient, usdcAddress, payerAddr);
    const payeeUsdcBefore = await getUsdcBalance(publicClient, usdcAddress, payeeAddr);

    // Step 1: Deposit USDC into CrossChainSettlement
    await publicClient.waitForTransactionReceipt({
      hash: await payer.writeContract({
        address: settlementAddress,
        abi: crossChainSettlementAbi,
        functionName: 'deposit',
        args: [paymentId, payeeAddr, depositAmount, usdcAddress],
      }),
    });

    // Verify deposit on-chain
    const deposit = (await publicClient.readContract({
      address: settlementAddress,
      abi: crossChainSettlementAbi,
      functionName: 'escrows',
      args: [paymentId],
    })) as unknown as {
      payer: Address;
      payee: Address;
      token: Address;
      deposit: bigint;
      spent: bigint;
      settled: boolean;
    };

    expect(deposit.payer.toLowerCase()).toBe(payerAddr.toLowerCase());
    expect(deposit.payee.toLowerCase()).toBe(payeeAddr.toLowerCase());
    expect(deposit.token.toLowerCase()).toBe(usdcAddress.toLowerCase());
    expect(deposit.deposit).toBe(depositAmount);
    expect(deposit.settled).toBe(false);

    // Verify USDC left payer
    const payerUsdcAfterDeposit = await getUsdcBalance(publicClient, usdcAddress, payerAddr);
    expect(payerUsdcBefore - payerUsdcAfterDeposit).toBe(depositAmount);

    // Step 2: Verify pre-stored source domain separator matches
    const storedSeparator = (await publicClient.readContract({
      address: settlementAddress,
      abi: crossChainSettlementAbi,
      functionName: 'SOURCE_DOMAIN_SEPARATOR',
    })) as unknown as `0x${string}`;

    expect(storedSeparator).toBe(sourceDomainSeparator);

    // Also verify CHANNEL_CLOSE_TYPEHASH matches
    const typehash = (await publicClient.readContract({
      address: settlementAddress,
      abi: crossChainSettlementAbi,
      functionName: 'CHANNEL_CLOSE_TYPEHASH',
    })) as unknown as `0x${string}`;

    expect(typehash).toBe(
      keccak256(toHex('ChannelClose(uint256 channelId,uint256 spent)')),
    );

    // Step 3: Sign EIP-712 ChannelClose with source chain domain
    // (simulating the payer signing on the source chain)
    const sourceChainId = 1;
    const sourceChannelId = 42n;

    const domain = {
      name: 'ValuePacket',
      version: '1',
      chainId: sourceChainId,
      verifyingContract: channelAddress,
    };

    const account = payer.account;
    if (!account) throw new Error('payer wallet has no account');

    const closeSig = await payer.signTypedData({
      account,
      domain,
      types: {
        ChannelClose: [
          { name: 'channelId', type: 'uint256' },
          { name: 'spent', type: 'uint256' },
        ],
      },
      primaryType: 'ChannelClose',
      message: { channelId: sourceChannelId, spent: spentAmount },
    });

    // Verify signature locally
    const localValid = await verifyTypedData({
      address: payerAddr,
      domain,
      types: CHANNEL_CLOSE_TYPE,
      primaryType: 'ChannelClose',
      message: { channelId: sourceChannelId, spent: spentAmount },
      signature: closeSig,
    });
    expect(localValid).toBe(true);

    // Step 4: Call settleFromSource via MockAxelarGateway (simulates relay)
    await publicClient.waitForTransactionReceipt({
      hash: await wallet2.writeContract({
        address: axelarGatewayAddress,
        abi: mockAxelarGatewayAbi,
        functionName: 'relaySettleFromSource',
        args: [settlementAddress, paymentId, sourceChannelId, spentAmount, closeSig],
      }),
    });

    // Step 5: Verify deposit settled
    const depositAfter = (await publicClient.readContract({
      address: settlementAddress,
      abi: crossChainSettlementAbi,
      functionName: 'escrows',
      args: [paymentId],
    })) as unknown as { settled: boolean; spent: bigint };

    expect(depositAfter.settled).toBe(true);
    expect(depositAfter.spent).toBe(spentAmount);

    // Verify USDC transferred: $8 to payee, $12 refunded to payer
    const payerUsdcAfter = await getUsdcBalance(publicClient, usdcAddress, payerAddr);
    const payeeUsdcAfter = await getUsdcBalance(publicClient, usdcAddress, payeeAddr);

    const refundAmount = depositAmount - spentAmount;
    expect(payerUsdcAfter - payerUsdcAfterDeposit).toBe(refundAmount);
    expect(payeeUsdcAfter - payeeUsdcBefore).toBe(spentAmount);

    // Verify cannot double-settle
    await expect(
      wallet2.writeContract({
        address: axelarGatewayAddress,
        abi: mockAxelarGatewayAbi,
        functionName: 'relaySettleFromSource',
        args: [settlementAddress, paymentId, sourceChannelId, spentAmount, closeSig],
      }),
    ).rejects.toThrow();
  });

  // ═══════════════════════════════════════════════════════════════════
  // Test 4: Full flow — reputation + subscription + cross-chain
  // ═══════════════════════════════════════════════════════════════════

  it('Test 4: Full flow — reputation + subscription + cross-chain settlement', async () => {
    const payer = wallet0;
    const payerAddr = ACCOUNTS.deployer.addr;
    const provider = wallet1;
    const providerAddr = ACCOUNTS.account1.addr;

    const amountPerPeriod = usdcToWei(5);
    const periodDuration = 3600;
    const maxPeriods = 2n;

    // ── 4a: Create subscription ────────────────────────────────────────
    const subHash = await payer.writeContract({
      address: subscriptionAddress,
      abi: subscriptionManagerAbi,
      functionName: 'createSubscription',
      args: [
        providerAddr,
        usdcAddress,
        amountPerPeriod,
        periodDuration,
        maxPeriods,
        usdcToWei(15),
        '0x',
      ],
    });
    const subReceipt = await publicClient.waitForTransactionReceipt({ hash: subHash });

    const subCreatedTopic = keccak256(
      toHex('SubscriptionCreated(uint256,address,address,address,uint256)'),
    );
    const subEvent = subReceipt.logs.find(
      (l) =>
        l.address.toLowerCase() === subscriptionAddress.toLowerCase() &&
        l.topics[0] === subCreatedTopic,
    );
    expect(subEvent).toBeDefined();
    const subId = BigInt(subEvent!.topics[1]);

    // ── 4b: Period 1 — payer makes paid requests, then rates ──────────
    const period1ChannelId = await openAndCloseChannel(
      payer,
      providerAddr,
      usdcAddress,
      usdcToWei(10),
      usdcToWei(0.15), // 3 requests @ $0.05
      publicClient,
      channelAddress,
      provider,
    );

    await publicClient.waitForTransactionReceipt({
      hash: await payer.writeContract({
        address: reputationAddress,
        abi: agentReputationAbi,
        functionName: 'rateService',
        args: [
          providerAddr,
          toHex(period1ChannelId, { size: 32 }),
          8,
          'Good period 1 service',
        ],
      }),
    });

    // Advance time and renew
    await increaseTime(periodDuration + 1);

    const salt1 = keccak256(toHex('fullflow-salt-1'));
    const renewSig1 = await signSubscriptionAuth(
      payer,
      subId,
      amountPerPeriod,
      periodDuration,
      maxPeriods,
      salt1,
      subscriptionAddress,
    );

    await publicClient.waitForTransactionReceipt({
      hash: await provider.writeContract({
        address: subscriptionAddress,
        abi: subscriptionManagerAbi,
        functionName: 'renew',
        args: [subId, amountPerPeriod, salt1, renewSig1],
      }),
    });

    // ── 4c: Period 2 — more requests, rate again ──────────────────────
    const period2ChannelId = await openAndCloseChannel(
      payer,
      providerAddr,
      usdcAddress,
      usdcToWei(10),
      usdcToWei(0.10), // 2 requests @ $0.05
      publicClient,
      channelAddress,
      provider,
    );

    await publicClient.waitForTransactionReceipt({
      hash: await payer.writeContract({
        address: reputationAddress,
        abi: agentReputationAbi,
        functionName: 'rateService',
        args: [
          providerAddr,
          toHex(period2ChannelId, { size: 32 }),
          9,
          'Even better',
        ],
      }),
    });

    // Advance time and renew → period 3
    await increaseTime(periodDuration + 1);

    const salt2 = keccak256(toHex('fullflow-salt-2'));
    const renewSig2 = await signSubscriptionAuth(
      payer,
      subId,
      amountPerPeriod,
      periodDuration,
      maxPeriods,
      salt2,
      subscriptionAddress,
    );

    await publicClient.waitForTransactionReceipt({
      hash: await provider.writeContract({
        address: subscriptionAddress,
        abi: subscriptionManagerAbi,
        functionName: 'renew',
        args: [subId, amountPerPeriod, salt2, renewSig2],
      }),
    });

    // ── 4d: Period 3 — requests, rate, verify reputation ──────────────
    const period3ChannelId = await openAndCloseChannel(
      payer,
      providerAddr,
      usdcAddress,
      usdcToWei(10),
      usdcToWei(0.15),
      publicClient,
      channelAddress,
      provider,
    );

    await publicClient.waitForTransactionReceipt({
      hash: await payer.writeContract({
        address: reputationAddress,
        abi: agentReputationAbi,
        functionName: 'rateService',
        args: [
          providerAddr,
          toHex(period3ChannelId, { size: 32 }),
          7,
          'Average this period',
        ],
      }),
    });

    // Verify reputation: scores 8, 9, 7 → average = 8, count = 3
    const avgScore = (await publicClient.readContract({
      address: reputationAddress,
      abi: agentReputationAbi,
      functionName: 'getAverageScore',
      args: [providerAddr],
    })) as unknown as bigint;

    expect(avgScore).toBe(8n);

    const ratingCount = (await publicClient.readContract({
      address: reputationAddress,
      abi: agentReputationAbi,
      functionName: 'getRatingCount',
      args: [providerAddr],
    })) as unknown as bigint;

    expect(ratingCount).toBe(3n);

    // Verify subscription: 2 completed periods, $10 total spent
    const subState = (await publicClient.readContract({
      address: subscriptionAddress,
      abi: subscriptionManagerAbi,
      functionName: 'getSubscription',
      args: [subId],
    })) as unknown as {
      completedPeriods: bigint;
      totalSpent: bigint;
      active: boolean;
    };

    expect(subState.completedPeriods).toBe(2n);
    expect(subState.totalSpent).toBe(usdcToWei(10));
    expect(subState.active).toBe(true);

    // ── 4e: Verify cannot renew past max ──────────────────────────────
    await increaseTime(periodDuration + 1);

    const salt3 = keccak256(toHex('fullflow-salt-3'));
    const renewSig3 = await signSubscriptionAuth(
      payer,
      subId,
      amountPerPeriod,
      periodDuration,
      maxPeriods,
      salt3,
      subscriptionAddress,
    );

    await expect(
      provider.writeContract({
        address: subscriptionAddress,
        abi: subscriptionManagerAbi,
        functionName: 'renew',
        args: [subId, amountPerPeriod, salt3, renewSig3],
      }),
    ).rejects.toThrow();

    // ── 4f: Cross-chain settlement for the final period ────────────────
    const settlementPaymentId = keccak256(
      toHex(`fullflow-settlement-${Date.now()}`),
    );
    const settlementDeposit = usdcToWei(30);
    const settlementSpent = usdcToWei(15);
    const sourceChainId = 1;
    const sourceChannelId = 99n;

    const payerUsdcBefore = await getUsdcBalance(publicClient, usdcAddress, payerAddr);
    const providerUsdcBefore = await getUsdcBalance(publicClient, usdcAddress, providerAddr);

    // Deposit
    await publicClient.waitForTransactionReceipt({
      hash: await payer.writeContract({
        address: settlementAddress,
        abi: crossChainSettlementAbi,
        functionName: 'deposit',
        args: [settlementPaymentId, providerAddr, settlementDeposit, usdcAddress],
      }),
    });

    // Sign EIP-712 ChannelClose for source chain
    const account = payer.account;
    if (!account) throw new Error('payer wallet has no account');

    const crossChainSig = await payer.signTypedData({
      account,
      domain: {
        name: 'ValuePacket',
        version: '1',
        chainId: sourceChainId,
        verifyingContract: channelAddress,
      },
      types: {
        ChannelClose: [
          { name: 'channelId', type: 'uint256' },
          { name: 'spent', type: 'uint256' },
        ],
      },
      primaryType: 'ChannelClose',
      message: { channelId: sourceChannelId, spent: settlementSpent },
    });

    // Settle via MockAxelarGateway
    await publicClient.waitForTransactionReceipt({
      hash: await wallet2.writeContract({
        address: axelarGatewayAddress,
        abi: mockAxelarGatewayAbi,
        functionName: 'relaySettleFromSource',
        args: [
          settlementAddress,
          settlementPaymentId,
          sourceChannelId,
          settlementSpent,
          crossChainSig,
        ],
      }),
    });

    // Verify final balances
    const payerUsdcAfter = await getUsdcBalance(publicClient, usdcAddress, payerAddr);
    const providerUsdcAfter = await getUsdcBalance(publicClient, usdcAddress, providerAddr);

    // Payer: deposited $30, got $15 refund, net = -$15
    // Provider: gained $15
    expect(providerUsdcAfter - providerUsdcBefore).toBe(settlementSpent);

    // Verify deposit settled
    const finalDeposit = (await publicClient.readContract({
      address: settlementAddress,
      abi: crossChainSettlementAbi,
      functionName: 'escrows',
      args: [settlementPaymentId],
    })) as unknown as { settled: boolean; spent: bigint };

    expect(finalDeposit.settled).toBe(true);
    expect(finalDeposit.spent).toBe(settlementSpent);
  });
});
