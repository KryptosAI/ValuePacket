import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hash } from 'viem';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  keccak256,
  toHex,
  verifyTypedData,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AgentPay,
  ChannelSession,
  signChannelClose,
  signPaymentProof,
  hashRequest,
  createPaymentProofHeader,
  CHANNEL_CLOSE_TYPE,
  PAYMENT_PROOF_TYPE,
  ChannelStatus,
  SERVICE_REGISTRY_ABI,
  PAYMENT_CHANNEL_ABI,
} from '@valuepacket/sdk';
import { createAgentSettlementPlugin } from '../../adapters/eliza/src/index.js';
import { AgentSettlementWorker } from '../../adapters/game/src/index.js';
import { erc20Abi } from '../src/contracts.js';
import { usdcToWei, ZERO_ADDRESS } from '../src/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ANVIL_RPC = 'http://localhost:8545';
const ANVIL_PORT = '8545';

// ── Anvil pre-funded accounts ──────────────────────────────────────
const ACCOUNTS = {
  deployer: {
    pk: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hash,
    addr: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
  },
  eliza: {
    pk: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hash,
    addr: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address,
  },
  game: {
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

function deployContract(contractPath: string): Address {
  const output = runForge(
    `create ${contractPath} --rpc-url ${ANVIL_RPC} --private-key ${ACCOUNTS.deployer.pk} --broadcast`,
  );

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

// ── Helpers ────────────────────────────────────────────────────────

function createAnvilAccount(pk: Hash) {
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({
    chain: anvilChain,
    transport: http(ANVIL_RPC),
    account,
  });
  return { wallet, address: account.address, account };
}

async function mintUsdc(
  mintWallet: WalletClient,
  to: Address,
  amount: bigint,
  publicClient: PublicClient,
  usdcAddress: Address,
): Promise<void> {
  const hash = await mintWallet.writeContract({
    address: usdcAddress,
    abi: mockUsdcAbi,
    functionName: 'mint',
    args: [to, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function approveUsdc(
  wallet: WalletClient,
  spender: Address,
  amount: bigint,
  usdcAddress: Address,
  publicClient: PublicClient,
): Promise<void> {
  const hash = await wallet.writeContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function fundWithEth(
  funder: WalletClient,
  to: Address,
  amount: bigint,
  publicClient: PublicClient,
): Promise<void> {
  const hash = await funder.sendTransaction({ to, value: amount });
  await publicClient.waitForTransactionReceipt({ hash });
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
  publicClient: PublicClient,
  channelAddress: Address,
  channelId: bigint,
): Promise<OnChainChannel> {
  return (await publicClient.readContract({
    address: channelAddress,
    abi: PAYMENT_CHANNEL_ABI,
    functionName: 'getChannel',
    args: [channelId],
  })) as unknown as OnChainChannel;
}

/**
 * Close a channel by having the payee submit the payer-signed close.
 * The PaymentChannel contract requires `msg.sender == channel.payee` for
 * `closeChannel`, so we sign from the payer and submit from the payee.
 */
async function submitCloseViaPayee(
  payerWallet: WalletClient,
  payeeWallet: WalletClient,
  verifyingContract: Address,
  channelId: bigint,
  spent: bigint,
): Promise<void> {
  const closeSig = await signChannelClose(payerWallet, verifyingContract, channelId, spent);
  const hash = await payeeWallet.writeContract({
    address: verifyingContract,
    abi: PAYMENT_CHANNEL_ABI,
    functionName: 'closeChannel',
    args: [channelId, spent, closeSig],
    chain: anvilChain,
  } as never);
  await publicClient.waitForTransactionReceipt({ hash });
}

// ── Module-level state ─────────────────────────────────────────────

let anvilProcess: ChildProcess | null = null;
let registryAddress: Address;
let channelAddress: Address;
let usdcAddress: Address;
let publicClient: PublicClient;
let deployerWallet: WalletClient;
let elizaWallet: WalletClient;
let gameWallet: WalletClient;
let sdkWallet: WalletClient;

const USDC_AMOUNT = usdcToWei(500); // $500 USDC

describe('Cross-Framework Integration: ElizaOS ↔ G.A.M.E ↔ Raw SDK', () => {
  beforeAll(async () => {
    // ── Kill stale anvil from previous runs ─────────────────────────
    execSync('lsof -ti tcp:8545 | xargs kill -9 2>/dev/null || true', { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 2000));

    // ── Start anvil ────────────────────────────────────────────────
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

    // ── Build & deploy contracts ───────────────────────────────────
    runForge('build');

    registryAddress = deployContract('src/ServiceRegistry.sol:ServiceRegistry');
    channelAddress = deployContract('src/PaymentChannel.sol:PaymentChannel');
    usdcAddress = deployContract('src/mocks/MockUSDC.sol:MockUSDC');

    // ── Write deployments ──────────────────────────────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) {
      mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    }

    writeFileSync(
      LOCAL_DEPLOYMENT,
      JSON.stringify(
        {
          serviceRegistry: registryAddress,
          paymentChannel: channelAddress,
          spendingPolicy: ZERO_ADDRESS,
          usdc: usdcAddress,
          chainId: 31337,
          network: 'local',
        },
        null,
        2,
      ),
    );

    // ── Initialize clients ─────────────────────────────────────────
    const deployer = createAnvilAccount(ACCOUNTS.deployer.pk);
    deployerWallet = deployer.wallet;

    const eliza = createAnvilAccount(ACCOUNTS.eliza.pk);
    elizaWallet = eliza.wallet;

    const game = createAnvilAccount(ACCOUNTS.game.pk);
    gameWallet = game.wallet;

    const sdk = createAnvilAccount(ACCOUNTS.deployer.pk);
    sdkWallet = sdk.wallet;

    publicClient = createPublicClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
    });

    // ── Fund accounts with ETH ────────────────────────────────────
    await fundWithEth(deployerWallet, ACCOUNTS.eliza.addr, parseEther('100'), publicClient);
    await fundWithEth(deployerWallet, ACCOUNTS.game.addr, parseEther('100'), publicClient);

    // ── Mint USDC to all three accounts ────────────────────────────
    await mintUsdc(deployerWallet, ACCOUNTS.deployer.addr, USDC_AMOUNT, publicClient, usdcAddress);
    await mintUsdc(deployerWallet, ACCOUNTS.eliza.addr, USDC_AMOUNT, publicClient, usdcAddress);
    await mintUsdc(deployerWallet, ACCOUNTS.game.addr, USDC_AMOUNT, publicClient, usdcAddress);

    // ── Approve USDC for channel contract ──────────────────────────
    await approveUsdc(deployerWallet, channelAddress, USDC_AMOUNT, usdcAddress, publicClient);
    await approveUsdc(elizaWallet, channelAddress, USDC_AMOUNT, usdcAddress, publicClient);
    await approveUsdc(gameWallet, channelAddress, USDC_AMOUNT, usdcAddress, publicClient);
  }, 180_000);

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

  it('should deploy all contracts', () => {
    expect(registryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(channelAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(usdcAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(registryAddress).not.toBe(ZERO_ADDRESS);
    expect(channelAddress).not.toBe(ZERO_ADDRESS);
    expect(usdcAddress).not.toBe(ZERO_ADDRESS);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Test 1: ElizaOS agent pays raw SDK agent
  // ═══════════════════════════════════════════════════════════════════

  it('Test 1: ElizaOS agent registers service, raw SDK agent opens channel and pays', async () => {
    // Step 1-3: Initialize the ElizaOS adapter plugin
    const elizaPlugin = createAgentSettlementPlugin({
      wallet: elizaWallet,
      serviceRegistryAddress: registryAddress,
      paymentChannelAddress: channelAddress,
    });

    const elizaRuntime = {} as Record<string, unknown>;
    elizaPlugin.init?.(elizaRuntime as never);

    // Step 4: Register a service via the plugin's LIST_SERVICE action
    const listAction = elizaPlugin.actions![0];
    const metadataURI = 'https://metadata.example.com/eliza-prediction-feed.json';

    let serviceId = '';
    let registerSucceeded = false;

    // The handler parses message.content as JSON for metadataURI/pricePerRequest params
    await listAction.handler(
      elizaRuntime as never,
      {
        content: JSON.stringify({
          metadataURI,
          pricePerRequest: usdcToWei(0.05).toString(),
          maxResponseMs: 2000,
        }),
      } as never,
      {} as never,
      {} as never,
      (response: { text: string } | undefined) => {
        if (response?.text) {
          registerSucceeded = response.text.includes('Service registered');
          const idMatch = response.text.match(/ID:\s*(0x[a-fA-F0-9]{64})/);
          if (idMatch) serviceId = idMatch[1];
        }
      },
    );

    expect(registerSucceeded).toBe(true);
    expect(serviceId).toBeTruthy();

    // Verify on-chain: service registered by ElizaOS (#1)
    const service = (await publicClient.readContract({
      address: registryAddress,
      abi: SERVICE_REGISTRY_ABI,
      functionName: 'getService',
      args: [serviceId as `0x${string}`],
    })) as unknown as {
      provider: Address;
      metadataURI: string;
      pricePerRequest: bigint;
      maxResponseMs: number;
      registeredAt: number;
      active: boolean;
    };

    expect(service.provider.toLowerCase()).toBe(ACCOUNTS.eliza.addr.toLowerCase());
    expect(service.active).toBe(true);
    expect(service.pricePerRequest).toBe(usdcToWei(0.05));

    // Step 5: Raw SDK agent (account #0) opens a payment channel to ElizaOS (#1)
    const sdkAgentPay = new AgentPay({
      wallet: sdkWallet,
      publicClient,
      serviceRegistryAddress: registryAddress,
      paymentChannelAddress: channelAddress,
    });

    // Discover ElizaOS service via raw SDK
    const discovered = await sdkAgentPay.discover({
      provider: ACCOUNTS.eliza.addr,
      active: true,
    });
    expect(discovered.length).toBeGreaterThanOrEqual(1);

    const depositAmount = usdcToWei(10); // $10 deposit
    const expiresIn = 24 * 3600;

    const elizaSession = await sdkAgentPay.openChannel({
      provider: ACCOUNTS.eliza.addr,
      token: usdcAddress,
      deposit: depositAmount,
      expiresIn,
    });

    expect(elizaSession.channelId).toBeGreaterThan(0n);

    // Verify on-chain: channel exists, payer = SDK (#0), payee = ElizaOS (#1)
    const channel1 = await getOnChainChannel(publicClient, channelAddress, elizaSession.channelId);
    expect(channel1.payer.toLowerCase()).toBe(ACCOUNTS.deployer.addr.toLowerCase());
    expect(channel1.payee.toLowerCase()).toBe(ACCOUNTS.eliza.addr.toLowerCase());
    expect(channel1.token.toLowerCase()).toBe(usdcAddress.toLowerCase());
    expect(channel1.deposit).toBe(depositAmount);
    expect(channel1.spent).toBe(0n);
    expect(channel1.status).toBe(ChannelStatus.Open);

    // Step 6: Make a paid request (simulated via payment proof)
    const requestBody = { type: 'prediction-feed', input: { asset: 'ETH-USD', horizon: '24h' } };
    const nonce = 1n;
    const pricePerRequest = usdcToWei(0.05);

    const proofSig = await signPaymentProof(
      sdkWallet,
      channelAddress,
      elizaSession.channelId,
      pricePerRequest,
      requestBody,
      nonce,
    );

    // Verify the PaymentProof signature
    const reqHash = hashRequest(requestBody);
    const proofValid = await verifyTypedData({
      address: ACCOUNTS.deployer.addr,
      domain: {
        name: 'ValuePacket',
        version: '1',
        chainId: 31337,
        verifyingContract: channelAddress,
      },
      types: PAYMENT_PROOF_TYPE,
      primaryType: 'PaymentProof',
      message: {
        channelId: elizaSession.channelId,
        cumulativeSpent: pricePerRequest,
        requestHash: reqHash,
        nonce,
      },
      signature: proofSig,
    });

    expect(proofValid).toBe(true);

    // Create the payment proof header (proves HTTP header interop)
    const proofHeader = createPaymentProofHeader(
      elizaSession.channelId,
      pricePerRequest,
      requestBody,
      nonce,
      proofSig,
    );

    expect(proofHeader.channelId).toBe(elizaSession.channelId.toString());
    expect(proofHeader.cumulativeSpent).toBe(pricePerRequest.toString());
    expect(proofHeader.nonce).toBe('1');
    expect(proofHeader.proof).toBe(proofSig);
    expect(proofHeader.requestHash).toBe(reqHash);

    // Close channel: payer (#0) signs, payee (#1) submits on-chain
    const spentAmount = pricePerRequest; // 1 request worth
    await submitCloseViaPayee(
      sdkWallet,
      elizaWallet,
      channelAddress,
      elizaSession.channelId,
      spentAmount,
    );

    // Verify on-chain: channel settled
    const closedChannel1 = await getOnChainChannel(
      publicClient,
      channelAddress,
      elizaSession.channelId,
    );
    expect(closedChannel1.status).toBe(ChannelStatus.Settled);
    expect(closedChannel1.spent).toBe(spentAmount);
    expect(closedChannel1.spent).toBeLessThan(closedChannel1.deposit);

    // Verify payee balance increased by spent amount
    const elizaBalanceAfter = (await publicClient.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ACCOUNTS.eliza.addr],
    })) as unknown as bigint;

    expect(elizaBalanceAfter).toBeGreaterThan(USDC_AMOUNT);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Test 2: G.A.M.E agent pays ElizaOS agent
  // ═══════════════════════════════════════════════════════════════════

  it('Test 2: G.A.M.E agent discovers ElizaOS service, opens channel, and pays', async () => {
    // Step 1: Initialize the G.A.M.E worker for account #2
    const gameWorker = new AgentSettlementWorker({
      wallet: gameWallet,
      serviceRegistryAddress: registryAddress,
      paymentChannelAddress: channelAddress,
    });

    // Step 2: Initialize ElizaOS plugin and register a new service
    const elizaPlugin = createAgentSettlementPlugin({
      wallet: elizaWallet,
      serviceRegistryAddress: registryAddress,
      paymentChannelAddress: channelAddress,
    });

    const elizaRuntime = {} as Record<string, unknown>;
    elizaPlugin.init?.(elizaRuntime as never);

    const listAction = elizaPlugin.actions![0];
    const metadataURI = 'https://metadata.example.com/eliza-oracle-feed.json';
    let serviceId2 = '';
    let registered2 = false;

    await listAction.handler(
      elizaRuntime as never,
      {
        content: JSON.stringify({
          metadataURI,
          pricePerRequest: usdcToWei(0.03).toString(),
          maxResponseMs: 1000,
        }),
      } as never,
      {} as never,
      {} as never,
      (response: { text: string } | undefined) => {
        if (response?.text) {
          registered2 = response.text.includes('Service registered');
          const m = response.text.match(/ID:\s*(0x[a-fA-F0-9]{64})/);
          if (m) serviceId2 = m[1];
        }
      },
    );

    expect(registered2).toBe(true);
    expect(serviceId2).toBeTruthy();

    // Verify on-chain
    const svc2 = (await publicClient.readContract({
      address: registryAddress,
      abi: SERVICE_REGISTRY_ABI,
      functionName: 'getService',
      args: [serviceId2 as `0x${string}`],
    })) as unknown as { provider: Address; active: boolean; pricePerRequest: bigint };

    expect(svc2.provider.toLowerCase()).toBe(ACCOUNTS.eliza.addr.toLowerCase());
    expect(svc2.active).toBe(true);

    // Step 3: G.A.M.E discovers ElizaOS agent's services
    const discoverResult = await gameWorker.discoverAgents({
      provider: ACCOUNTS.eliza.addr,
      active: true,
    });

    expect(discoverResult.result).toBeDefined();
    expect(discoverResult.result!.length).toBeGreaterThanOrEqual(2);
    expect(
      discoverResult.result!.some(
        (s) => s.provider.toLowerCase() === ACCOUNTS.eliza.addr.toLowerCase(),
      ),
    ).toBe(true);

    // Step 4: G.A.M.E opens a channel to ElizaOS
    const depositAmount = usdcToWei(20); // $20 deposit

    const subResult = await gameWorker.subscribeToService({
      provider: ACCOUNTS.eliza.addr,
      token: usdcAddress,
      deposit: depositAmount.toString(),
      expiresInHours: 24,
    });

    expect(subResult.result).toBeDefined();
    const gameChannelId = BigInt((subResult.result as Record<string, string>).channelId);
    expect(gameChannelId).toBeGreaterThan(0n);

    // Verify on-chain: channel exists, payer = G.A.M.E (#2), payee = ElizaOS (#1)
    const channel2 = await getOnChainChannel(publicClient, channelAddress, gameChannelId);
    expect(channel2.payer.toLowerCase()).toBe(ACCOUNTS.game.addr.toLowerCase());
    expect(channel2.payee.toLowerCase()).toBe(ACCOUNTS.eliza.addr.toLowerCase());
    expect(channel2.token.toLowerCase()).toBe(usdcAddress.toLowerCase());
    expect(channel2.deposit).toBe(depositAmount);
    expect(channel2.spent).toBe(0n);
    expect(channel2.status).toBe(ChannelStatus.Open);

    // Step 5-6: Simulate a paid request and generate payment proof from G.A.M.E's wallet
    const pricePerReq = usdcToWei(0.03);
    const reqBody = { type: 'oracle-feed', input: { asset: 'BTC-USD' } };
    const nonce = 1n;

    const proofSig2 = await signPaymentProof(
      gameWallet,
      channelAddress,
      gameChannelId,
      pricePerReq,
      reqBody,
      nonce,
    );

    const reqHash2 = hashRequest(reqBody);
    const proofValid = await verifyTypedData({
      address: ACCOUNTS.game.addr,
      domain: {
        name: 'ValuePacket',
        version: '1',
        chainId: 31337,
        verifyingContract: channelAddress,
      },
      types: PAYMENT_PROOF_TYPE,
      primaryType: 'PaymentProof',
      message: {
        channelId: gameChannelId,
        cumulativeSpent: pricePerReq,
        requestHash: reqHash2,
        nonce,
      },
      signature: proofSig2,
    });

    expect(proofValid).toBe(true);

    // Create header to prove HTTP interop from G.A.M.E's wallet
    const header = createPaymentProofHeader(
      gameChannelId,
      pricePerReq,
      reqBody,
      nonce,
      proofSig2,
    );
    expect(header.channelId).toBe(gameChannelId.toString());

    // Close channel: payer (G.A.M.E) signs, payee (ElizaOS) submits
    await submitCloseViaPayee(
      gameWallet,
      elizaWallet,
      channelAddress,
      gameChannelId,
      pricePerReq,
    );

    // Verify on-chain: channel settled
    const closedChannel2 = await getOnChainChannel(publicClient, channelAddress, gameChannelId);
    expect(closedChannel2.status).toBe(ChannelStatus.Settled);
    expect(closedChannel2.spent).toBe(pricePerReq);
    expect(closedChannel2.spent).toBeLessThan(depositAmount);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Test 3: Raw SDK agent pays G.A.M.E agent
  // ═══════════════════════════════════════════════════════════════════

  it('Test 3: Raw SDK agent discovers G.A.M.E service, opens channel, and pays', async () => {
    // Step 1: G.A.M.E agent registers a service via the worker
    const gameWorker = new AgentSettlementWorker({
      wallet: gameWallet,
      serviceRegistryAddress: registryAddress,
      paymentChannelAddress: channelAddress,
    });

    const listResult = await gameWorker.listService({
      metadataURI: 'https://metadata.example.com/game-mev-scanner.json',
      pricePerRequest: usdcToWei(0.07).toString(),
      maxResponseMs: 500,
    });

    expect(listResult.result).toBeDefined();
    const gameServiceId = listResult.result!.serviceId;

    // Verify on-chain: registered by G.A.M.E (#2)
    const gameService = (await publicClient.readContract({
      address: registryAddress,
      abi: SERVICE_REGISTRY_ABI,
      functionName: 'getService',
      args: [gameServiceId as `0x${string}`],
    })) as unknown as { provider: Address; active: boolean; pricePerRequest: bigint };

    expect(gameService.provider.toLowerCase()).toBe(ACCOUNTS.game.addr.toLowerCase());
    expect(gameService.active).toBe(true);
    expect(gameService.pricePerRequest).toBe(usdcToWei(0.07));

    // Step 2: Raw SDK agent (account #0) discovers G.A.M.E's service
    const sdkAgentPay = new AgentPay({
      wallet: sdkWallet,
      publicClient,
      serviceRegistryAddress: registryAddress,
      paymentChannelAddress: channelAddress,
    });

    const discovered = await sdkAgentPay.discover({
      provider: ACCOUNTS.game.addr,
      active: true,
    });

    expect(discovered.length).toBeGreaterThanOrEqual(1);
    const found = discovered.find((s) => s.serviceId === (gameServiceId as `0x${string}`));
    expect(found).toBeDefined();
    expect(found!.pricePerRequest).toBe(usdcToWei(0.07));

    // Step 3: Raw SDK opens channel to G.A.M.E
    const depositAmount = usdcToWei(15);

    const session = await sdkAgentPay.openChannel({
      provider: ACCOUNTS.game.addr,
      token: usdcAddress,
      deposit: depositAmount,
      expiresIn: 24 * 3600,
    });

    expect(session.channelId).toBeGreaterThan(0n);

    // Verify on-chain: payer = SDK (#0), payee = G.A.M.E (#2)
    const channel3 = await getOnChainChannel(publicClient, channelAddress, session.channelId);
    expect(channel3.payer.toLowerCase()).toBe(ACCOUNTS.deployer.addr.toLowerCase());
    expect(channel3.payee.toLowerCase()).toBe(ACCOUNTS.game.addr.toLowerCase());
    expect(channel3.status).toBe(ChannelStatus.Open);

    // Generate a payment proof from raw SDK to prove interop
    const spentAmount = usdcToWei(0.07); // 1 request
    const reqBody = { type: 'mev-scanner', input: { chain: 'ethereum', minProfitUsd: 100 } };
    const nonce = 1n;

    const proofSig3 = await signPaymentProof(
      sdkWallet,
      channelAddress,
      session.channelId,
      spentAmount,
      reqBody,
      nonce,
    );

    const reqHash3 = hashRequest(reqBody);
    const proofValid3 = await verifyTypedData({
      address: ACCOUNTS.deployer.addr,
      domain: {
        name: 'ValuePacket',
        version: '1',
        chainId: 31337,
        verifyingContract: channelAddress,
      },
      types: PAYMENT_PROOF_TYPE,
      primaryType: 'PaymentProof',
      message: {
        channelId: session.channelId,
        cumulativeSpent: spentAmount,
        requestHash: reqHash3,
        nonce,
      },
      signature: proofSig3,
    });

    expect(proofValid3).toBe(true);

    // Close channel: payer (#0) signs, payee (#2 G.A.M.E) submits
    await submitCloseViaPayee(
      sdkWallet,
      gameWallet,
      channelAddress,
      session.channelId,
      spentAmount,
    );

    // Verify on-chain final state
    const closedChannel3 = await getOnChainChannel(
      publicClient,
      channelAddress,
      session.channelId,
    );
    expect(closedChannel3.status).toBe(ChannelStatus.Settled);
    expect(closedChannel3.spent).toBe(spentAmount);

    // G.A.M.E worker can also read the channel info
    const chInfo = await gameWorker.getChannelInfo(session.channelId.toString());
    expect(chInfo.result).toBeDefined();
    expect(chInfo.result!.status).toBe('Settled');
    expect(chInfo.result!.spent).toBe(spentAmount.toString());
    expect(chInfo.result!.payer.toLowerCase()).toBe(ACCOUNTS.deployer.addr.toLowerCase());
    expect(chInfo.result!.provider.toLowerCase()).toBe(ACCOUNTS.game.addr.toLowerCase());
  });

  // ═══════════════════════════════════════════════════════════════════
  // Test 4: All three transact in sequence (ElizaOS → G.A.M.E → SDK)
  // ═══════════════════════════════════════════════════════════════════

  it('Test 4: Three-agent payment chain — ElizaOS → G.A.M.E → SDK', async () => {
    // Channel A: ElizaOS (#1) pays G.A.M.E (#2)
    const elizaAgentPay = new AgentPay({
      wallet: elizaWallet,
      publicClient,
      serviceRegistryAddress: registryAddress,
      paymentChannelAddress: channelAddress,
    });

    const depositA = usdcToWei(30);

    const sessionA = await elizaAgentPay.openChannel({
      provider: ACCOUNTS.game.addr,
      token: usdcAddress,
      deposit: depositA,
      expiresIn: 24 * 3600,
    });

    expect(sessionA.channelId).toBeGreaterThan(0n);

    // Channel B: G.A.M.E (#2) pays SDK (#0)
    const gameAgentPay = new AgentPay({
      wallet: gameWallet,
      publicClient,
      serviceRegistryAddress: registryAddress,
      paymentChannelAddress: channelAddress,
    });

    const depositB = usdcToWei(25);

    const sessionB = await gameAgentPay.openChannel({
      provider: ACCOUNTS.deployer.addr,
      token: usdcAddress,
      deposit: depositB,
      expiresIn: 24 * 3600,
    });

    expect(sessionB.channelId).toBeGreaterThan(0n);
    expect(sessionB.channelId).not.toBe(sessionA.channelId);

    // Prove channels are independent — verify both on-chain simultaneously
    const chA = await getOnChainChannel(publicClient, channelAddress, sessionA.channelId);
    const chB = await getOnChainChannel(publicClient, channelAddress, sessionB.channelId);

    expect(chA.payer.toLowerCase()).toBe(ACCOUNTS.eliza.addr.toLowerCase());
    expect(chA.payee.toLowerCase()).toBe(ACCOUNTS.game.addr.toLowerCase());
    expect(chA.status).toBe(ChannelStatus.Open);
    expect(chA.deposit).toBe(depositA);

    expect(chB.payer.toLowerCase()).toBe(ACCOUNTS.game.addr.toLowerCase());
    expect(chB.payee.toLowerCase()).toBe(ACCOUNTS.deployer.addr.toLowerCase());
    expect(chB.status).toBe(ChannelStatus.Open);
    expect(chB.deposit).toBe(depositB);

    // Simulate requests on both channels with different amounts
    const spentA = usdcToWei(0.15); // 3 requests @ 0.05 on channel A
    const spentB = usdcToWei(0.10); // 2 requests @ 0.05 on channel B

    // Close channel A: Elaine (#1, payer) signs, G.A.M.E (#2, payee) submits
    await submitCloseViaPayee(
      elizaWallet,
      gameWallet,
      channelAddress,
      sessionA.channelId,
      spentA,
    );

    // Verify channel A settled
    const settledA = await getOnChainChannel(publicClient, channelAddress, sessionA.channelId);
    expect(settledA.status).toBe(ChannelStatus.Settled);
    expect(settledA.spent).toBe(spentA);

    // Close channel B: G.A.M.E (#2, payer) signs, SDK (#0, payee) submits
    await submitCloseViaPayee(
      gameWallet,
      sdkWallet,
      channelAddress,
      sessionB.channelId,
      spentB,
    );

    // Verify channel B settled
    const settledB = await getOnChainChannel(publicClient, channelAddress, sessionB.channelId);
    expect(settledB.status).toBe(ChannelStatus.Settled);
    expect(settledB.spent).toBe(spentB);

    // Re-read both: prove closing B did not affect A
    const recheckA = await getOnChainChannel(publicClient, channelAddress, sessionA.channelId);
    expect(recheckA.status).toBe(ChannelStatus.Settled);
    expect(recheckA.spent).toBe(spentA);
    expect(recheckA.payer.toLowerCase()).toBe(ACCOUNTS.eliza.addr.toLowerCase());

    const recheckB = await getOnChainChannel(publicClient, channelAddress, sessionB.channelId);
    expect(recheckB.status).toBe(ChannelStatus.Settled);
    expect(recheckB.spent).toBe(spentB);
    expect(recheckB.payer.toLowerCase()).toBe(ACCOUNTS.game.addr.toLowerCase());

    // Prove channels are truly independent
    expect(sessionA.channelId).not.toBe(sessionB.channelId);
    expect(recheckA.payer.toLowerCase()).not.toBe(recheckB.payer.toLowerCase());
    expect(recheckA.payee.toLowerCase()).not.toBe(recheckB.payee.toLowerCase());
  });
});
