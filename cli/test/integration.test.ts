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
  keccak256,
  toHex,
  verifyTypedData,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  signChannelClose,
  signPaymentProof,
  hashRequest,
  createPaymentProofHeader,
  CHANNEL_CLOSE_TYPE,
  PAYMENT_PROOF_TYPE,
} from '@valuepacket/sdk';
import { serviceRegistryAbi, paymentChannelAbi, erc20Abi } from '../src/contracts.js';
import { usdcToWei, ZERO_ADDRESS } from '../src/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ANVIL_RPC = 'http://localhost:8545';
const ANVIL_PORT = '8545';
const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ANVIL_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
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
    `create ${contractPath} --rpc-url ${ANVIL_RPC} --private-key ${ANVIL_PK} --broadcast`,
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

let anvilProcess: ChildProcess | null = null;
let registryAddress: Address;
let channelAddress: Address;
let usdcAddress: Address;
let publicClient: PublicClient;
let deployerWallet: WalletClient;

describe('Integration: Full Local Demo Flow', () => {
  beforeAll(async () => {
    // ── Step 1: Start anvil ────────────────────────────────────────
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
      throw new Error(`Anvil exited immediately with code ${anvilProcess.exitCode}\n${anvilStderr}`);
    }

    // ── Step 2: Wait for anvil to be ready ────────────────────────
    await waitForAnvil();

    // ── Step 3: Build & deploy contracts with forge ────────────────
    runForge('build');

    registryAddress = deployContract('src/ServiceRegistry.sol:ServiceRegistry');

    channelAddress = deployContract('src/PaymentChannel.sol:PaymentChannel');

    usdcAddress = deployContract('src/mocks/MockUSDC.sol:MockUSDC');

    // ── Step 4: Write deployments/local.json ────────────────────────
    if (!existsSync(DEPLOYMENTS_DIR)) {
      mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    }

    const deploymentData = {
      serviceRegistry: registryAddress,
      paymentChannel: channelAddress,
      spendingPolicy: ZERO_ADDRESS,
      usdc: usdcAddress,
      chainId: 31337,
      network: 'local',
    };

    writeFileSync(LOCAL_DEPLOYMENT, JSON.stringify(deploymentData, null, 2));

    // ── Step 5: Initialize clients ──────────────────────────────────
    const deployerAccount = privateKeyToAccount(ANVIL_PK);

    publicClient = createPublicClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
    });

    deployerWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: deployerAccount,
    });
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

  // ─── Test: Deploy all contracts ─────────────────────────────────

  it('should deploy all contracts', () => {
    expect(registryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(channelAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(usdcAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

    expect(registryAddress).not.toBe(ZERO_ADDRESS);
    expect(channelAddress).not.toBe(ZERO_ADDRESS);
    expect(usdcAddress).not.toBe(ZERO_ADDRESS);

    expect(registryAddress).not.toBe(channelAddress);
    expect(registryAddress).not.toBe(usdcAddress);
    expect(channelAddress).not.toBe(usdcAddress);

    // Verify deployments/local.json was written and is valid
    const deployed = JSON.parse(readFileSync(LOCAL_DEPLOYMENT, 'utf-8'));
    expect(deployed.serviceRegistry).toBe(registryAddress);
    expect(deployed.paymentChannel).toBe(channelAddress);
    expect(deployed.usdc).toBe(usdcAddress);
    expect(deployed.chainId).toBe(31337);
    expect(deployed.network).toBe('local');
  });

  // ─── Test: Mint USDC ───────────────────────────────────────────

  it('should mint USDC to a wallet', async () => {
    const payerPk = generatePrivateKey();
    const payerAccount = privateKeyToAccount(payerPk);

    const payerWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: payerAccount,
    });

    // Fund with ETH from the deployer (Anvil account #0 has 10000 ETH)
    const fundHash = await deployerWallet.sendTransaction({
      to: payerAccount.address,
      value: parseEther('10'),
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });

    const ethBalance = await publicClient.getBalance({ address: payerAccount.address });
    expect(ethBalance).toBeGreaterThan(0n);

    // Mint USDC to the payer
    const mintAmount = 100_000_000_000n; // 100,000 USDC (6 decimals)

    const mintHash = await deployerWallet.writeContract({
      address: usdcAddress,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [payerAccount.address, mintAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    // Verify USDC balance
    const usdcBalance = (await publicClient.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [payerAccount.address],
    })) as unknown as bigint;

    expect(usdcBalance).toBe(mintAmount);
  });

  // ─── Test: Register a service ───────────────────────────────────

  let serviceId: Hash;

  it('should register a service', async () => {
    const providerPk = generatePrivateKey();
    const providerAccount = privateKeyToAccount(providerPk);

    const providerWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: providerAccount,
    });

    // Fund provider with ETH
    const fundHash = await deployerWallet.sendTransaction({
      to: providerAccount.address,
      value: parseEther('10'),
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });

    const metadataURI = JSON.stringify({
      protocol: 'valuepacket/1.0',
      service: {
        id: 'integration-test-service',
        name: 'Integration Test Service',
        description: 'Service used for integration testing',
        version: '1.0.0',
      },
      provider: {
        framework: 'test',
        contact: 'test@example.com',
        attestation: null,
      },
      api: {
        endpoint: '/',
        method: 'POST',
        inputSchema: { type: 'object', properties: { asset: { type: 'string' } } },
        outputSchema: {
          type: 'object',
          properties: {
            impliedVolatility: { type: 'number' },
            timestamp: { type: 'number' },
          },
        },
      },
      pricing: {
        token: usdcAddress,
        pricePerRequest: '50000',
        minChannelDeposit: '1000000',
        minChannelDuration: 3600,
      },
      sla: {
        maxResponseMs: 2000,
        uptime: '99.9%',
        rateLimit: '100/min',
      },
    });

    const pricePerRequest = usdcToWei(0.05);
    const maxResponseMs = 2000;

    const hash = await providerWallet.writeContract({
      address: registryAddress,
      abi: serviceRegistryAbi,
      functionName: 'register',
      args: [metadataURI, pricePerRequest, maxResponseMs],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');

    // Compute expected service ID (matches on-chain keccak256(provider || metadataURI))
    serviceId = keccak256(
      new Uint8Array([
        ...Buffer.from(providerAccount.address.slice(2).toLowerCase(), 'hex'),
        ...Buffer.from(metadataURI),
      ]),
    );

    // Read back the service from the registry
    const service = (await publicClient.readContract({
      address: registryAddress,
      abi: serviceRegistryAbi,
      functionName: 'getService',
      args: [serviceId],
    })) as unknown as {
      provider: Address;
      metadataURI: string;
      pricePerRequest: bigint;
      maxResponseMs: number;
      registeredAt: number;
      active: boolean;
    };

    expect(service.provider.toLowerCase()).toBe(providerAccount.address.toLowerCase());
    expect(service.pricePerRequest).toBe(pricePerRequest);
    expect(service.maxResponseMs).toBe(maxResponseMs);
    expect(service.active).toBe(true);

    // Verify service count
    const count = (await publicClient.readContract({
      address: registryAddress,
      abi: serviceRegistryAbi,
      functionName: 'getServiceCount',
    })) as unknown as bigint;

    expect(count).toBeGreaterThanOrEqual(1n);
  });

  // ─── Test: Open and close a payment channel ─────────────────────

  let channelId: bigint;

  it('should open and close a payment channel', async () => {
    // Generate a new payer wallet for this test
    const payerPk = generatePrivateKey();
    const payerAccount = privateKeyToAccount(payerPk);
    const payerWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: payerAccount,
    });

    // Generate a new provider wallet
    const providerPk = generatePrivateKey();
    const providerAccount = privateKeyToAccount(providerPk);
    const providerWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: providerAccount,
    });

    // Fund both wallets with ETH (sequentially to avoid nonce collisions)
    const fundPayerHash = await deployerWallet.sendTransaction({
      to: payerAccount.address,
      value: parseEther('10'),
    });
    await publicClient.waitForTransactionReceipt({ hash: fundPayerHash });

    const fundProviderHash = await deployerWallet.sendTransaction({
      to: providerAccount.address,
      value: parseEther('10'),
    });
    await publicClient.waitForTransactionReceipt({ hash: fundProviderHash });

    // Mint USDC to payer
    const mintAmount = 10_000_000n; // $10 USDC

    const mintHash = await deployerWallet.writeContract({
      address: usdcAddress,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [payerAccount.address, mintAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    // Approve USDC spending by PaymentChannel contract
    const depositAmount = usdcToWei(5); // $5 deposit

    const approveHash = await payerWallet.writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [channelAddress, depositAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // Verify allowance
    const allowance = (await publicClient.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [payerAccount.address, channelAddress],
    })) as unknown as bigint;

    expect(allowance).toBeGreaterThanOrEqual(depositAmount);

    // Open the channel
    const expiresIn = 24 * 3600;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + expiresIn;

    const openHash = await payerWallet.writeContract({
      address: channelAddress,
      abi: paymentChannelAbi,
      functionName: 'openChannel',
      args: [providerAccount.address, usdcAddress, depositAmount, expiresAt, ZERO_ADDRESS, '0x'],
    });
    const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });

    // Extract channel ID from ChannelOpened event
    const openTopic = keccak256(
      toHex('ChannelOpened(uint256,address,address,address,uint256,uint32)'),
    );

    const openEvent = openReceipt.logs.find(
      (l) =>
        l.address.toLowerCase() === channelAddress.toLowerCase() &&
        l.topics[0] === openTopic,
    );

    expect(openEvent).toBeDefined();

    channelId = openEvent && openEvent.topics[1]
      ? BigInt(openEvent.topics[1])
      : 1n;

    // Read on-chain channel state
    const channel = (await publicClient.readContract({
      address: channelAddress,
      abi: paymentChannelAbi,
      functionName: 'getChannel',
      args: [channelId],
    })) as unknown as {
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

    expect(channel.payer.toLowerCase()).toBe(payerAccount.address.toLowerCase());
    expect(channel.payee.toLowerCase()).toBe(providerAccount.address.toLowerCase());
    expect(channel.token.toLowerCase()).toBe(usdcAddress.toLowerCase());
    expect(channel.deposit).toBe(depositAmount);
    expect(channel.spent).toBe(0n);
    expect(channel.status).toBe(0); // Open

    // Close the channel — payer signs, payee submits
    const spentAmount = usdcToWei(2.5); // $2.50 spent

    const closeSig = await signChannelClose(
      payerWallet,
      channelAddress,
      channelId,
      spentAmount,
    );

    // Verify the close signature is valid
    const recovered = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        name: 'ValuePacket',
        version: '1',
        chainId: 31337,
        verifyingContract: channelAddress,
      },
      types: CHANNEL_CLOSE_TYPE,
      primaryType: 'ChannelClose',
      message: { channelId, spent: spentAmount },
      signature: closeSig,
    });

    expect(recovered).toBe(true);

    // Payee submits closeChannel on-chain
    const closeHash = await providerWallet.writeContract({
      address: channelAddress,
      abi: paymentChannelAbi,
      functionName: 'closeChannel',
      args: [channelId, spentAmount, closeSig],
    });
    const closeReceipt = await publicClient.waitForTransactionReceipt({ hash: closeHash });
    expect(closeReceipt.status).toBe('success');

    // Verify channel is now settled on-chain
    const closedChannel = (await publicClient.readContract({
      address: channelAddress,
      abi: paymentChannelAbi,
      functionName: 'getChannel',
      args: [channelId],
    })) as unknown as {
      status: number;
      spent: bigint;
    };

    expect(closedChannel.status).toBe(1); // Settled
    expect(closedChannel.spent).toBe(spentAmount);
  });

  // ─── Test: Paid request through the channel ─────────────────────

  it('should make a paid request through the channel', async () => {
    // Generate a fresh payer
    const payerPk = generatePrivateKey();
    const payerAccount = privateKeyToAccount(payerPk);
    const payerWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: payerAccount,
    });

    // Generate a fresh provider
    const providerPk = generatePrivateKey();
    const providerAccount = privateKeyToAccount(providerPk);
    const providerWallet = createWalletClient({
      chain: anvilChain,
      transport: http(ANVIL_RPC),
      account: providerAccount,
    });

    // Fund both wallets (sequentially to avoid nonce collisions)
    const fundPayerHash = await deployerWallet.sendTransaction({
      to: payerAccount.address,
      value: parseEther('10'),
    });
    await publicClient.waitForTransactionReceipt({ hash: fundPayerHash });

    const fundProviderHash = await deployerWallet.sendTransaction({
      to: providerAccount.address,
      value: parseEther('10'),
    });
    await publicClient.waitForTransactionReceipt({ hash: fundProviderHash });

    // Mint and approve USDC
    const depositAmount = usdcToWei(5);

    const mintHash = await deployerWallet.writeContract({
      address: usdcAddress,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [payerAccount.address, depositAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });

    const approveHash = await payerWallet.writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [channelAddress, depositAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // Open channel
    const expiresAt = Math.floor(Date.now() / 1000) + 24 * 3600;

    const openHash = await payerWallet.writeContract({
      address: channelAddress,
      abi: paymentChannelAbi,
      functionName: 'openChannel',
      args: [
        providerAccount.address,
        usdcAddress,
        depositAmount,
        expiresAt,
        ZERO_ADDRESS,
        '0x',
      ],
    });
    const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });

    const openTopic = keccak256(
      toHex('ChannelOpened(uint256,address,address,address,uint256,uint32)'),
    );

    const openEvent = openReceipt.logs.find(
      (l) =>
        l.address.toLowerCase() === channelAddress.toLowerCase() &&
        l.topics[0] === openTopic,
    );

    expect(openEvent).toBeDefined();

    const cid = openEvent && openEvent.topics[1]
      ? BigInt(openEvent.topics[1])
      : 1n;

    // Sign a PaymentProof for 1 request ($0.05)
    const pricePerRequest = usdcToWei(0.05);
    const requestBody = {
      type: 'prediction-feed',
      input: { asset: 'ETH-USD', horizon: '24h' },
    };
    const nonce = 1n;

    const proofSig = await signPaymentProof(
      payerWallet,
      channelAddress,
      cid,
      pricePerRequest,
      requestBody,
      nonce,
    );

    // Verify the PaymentProof signature
    const requestHash = hashRequest(requestBody);

    const proofRecovered = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        name: 'ValuePacket',
        version: '1',
        chainId: 31337,
        verifyingContract: channelAddress,
      },
      types: PAYMENT_PROOF_TYPE,
      primaryType: 'PaymentProof',
      message: {
        channelId: cid,
        cumulativeSpent: pricePerRequest,
        requestHash,
        nonce,
      },
      signature: proofSig,
    });

    expect(proofRecovered).toBe(true);

    // Create the payment proof header (for HTTP requests)
    const proofHeader = createPaymentProofHeader(
      cid,
      pricePerRequest,
      requestBody,
      nonce,
      proofSig,
    );

    expect(proofHeader.channelId).toBe(cid.toString());
    expect(proofHeader.cumulativeSpent).toBe(pricePerRequest.toString());
    expect(proofHeader.nonce).toBe('1');
    expect(proofHeader.proof).toBe(proofSig);
    expect(proofHeader.requestHash).toBe(requestHash);

    // Close channel with the exact spent amount from the one "request"
    const closeSig = await signChannelClose(
      payerWallet,
      channelAddress,
      cid,
      pricePerRequest,
    );

    const closeHash = await providerWallet.writeContract({
      address: channelAddress,
      abi: paymentChannelAbi,
      functionName: 'closeChannel',
      args: [cid, pricePerRequest, closeSig],
    });
    await publicClient.waitForTransactionReceipt({ hash: closeHash });

    // Verify final on-chain state
    const closedChannel = (await publicClient.readContract({
      address: channelAddress,
      abi: paymentChannelAbi,
      functionName: 'getChannel',
      args: [cid],
    })) as unknown as {
      status: number;
      spent: bigint;
      deposit: bigint;
    };

    expect(closedChannel.status).toBe(1); // Settled
    expect(closedChannel.spent).toBe(pricePerRequest);
    expect(closedChannel.spent).toBeLessThan(closedChannel.deposit);
  });
});
