import type { Address, Hash, PublicClient, WalletClient } from 'viem';
import { createPublicClient, createWalletClient, http, parseEther, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { signChannelClose, signPaymentProof, hashRequest, createPaymentProofHeader } from '@williamweishuhn/valuepacket-sdk';

import { log, formatAddress, formatUsdc, usdcToWei, weiToUsdc, ZERO_ADDRESS } from './utils.js';
import { startServer, type ChannelServer } from './server.js';
import {
  serviceRegistryAbi,
  paymentChannelAbi,
  erc20Abi,
  USDC_BASE_SEPOLIA,
} from './contracts.js';

const ANVIL_DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const MINT_AMOUNT = usdcToWei(1000);

const mintAbi = [
  {
    type: 'function',
    name: 'mint',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export interface DemoConfig {
  rpcUrl: string;
  registryAddress: Address;
  channelAddress: Address;
  tokenAddress?: Address;
  chainId?: number;
  mint?: boolean;
  deployerPrivateKey?: string;
}

export interface DemoResult {
  payerAddress: string;
  providerAddress: string;
  serviceId: string;
  channelId: string;
  requestCount: number;
  totalSpent: string;
  totalRefunded: string;
  avgLatencyMs: number;
  onChainTxCount: number;
  success: boolean;
  errors: string[];
}

interface LoggablePublicClient extends PublicClient {
  getChainId(): Promise<number>;
}

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function detectChainId(rpcUrl: string): Promise<number> {
  const client = createPublicClient({ transport: http(rpcUrl) }) as unknown as LoggablePublicClient;
  return await client.getChainId();
}

function makeChain(rpcUrl: string, chainId: number) {
  const names: Record<number, string> = {
    84532: 'Base Sepolia',
    8453: 'Base',
    31337: 'Anvil',
  };
  return {
    id: chainId,
    name: names[chainId] ?? `Chain ${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
}

const SERVICE_DESCRIPTOR = {
  protocol: 'valuepacket/1.0',
  service: {
    id: 'prediction-feed',
    name: 'Volatility Prediction Feed',
    description: 'Real-time implied volatility predictions for crypto assets',
    version: '1.0.0',
  },
  provider: {
    framework: 'valuepacket-cli',
    contact: 'demo@valuepacket.dev',
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
        confidence: { type: 'number' },
      },
    },
  },
  pricing: {
    token: USDC_BASE_SEPOLIA,
    pricePerRequest: '50000',
    minChannelDeposit: '1000000',
    minChannelDuration: 3600,
  },
  sla: {
    maxResponseMs: 2000,
    uptime: '99.9%',
    rateLimit: '100/min',
  },
};

async function ensureApproval(
  publicClient: LoggablePublicClient,
  walletClient: WalletClient,
  tokenAddress: Address,
  spender: Address,
  amount: bigint,
  owner: Address,
): Promise<boolean> {
  const allowance = (await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })) as unknown as bigint;

  if (allowance >= amount) return false;

  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
    chain: publicClient.chain,
    account: walletClient.account!,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return true;
}

interface ServiceFromChain {
  provider: Address;
  metadataURI: string;
  pricePerRequest: bigint;
  maxResponseMs: number;
  registeredAt: number;
  active: boolean;
}

interface ChannelFromChain {
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
}

export async function runDemo(config: DemoConfig): Promise<DemoResult> {
  const {
    rpcUrl,
    registryAddress,
    channelAddress,
    tokenAddress = USDC_BASE_SEPOLIA,
  } = config;

  const errors: string[] = [];
  let server: ChannelServer | null = null;
  let onChainTxCount = 0;

  const chainId = config.chainId ?? (await detectChainId(rpcUrl));
  const chain = makeChain(rpcUrl, chainId);

  log('');
  log('═══════════════════════════════════');
  log('  ValuePacket Protocol Demo');
  log('═══════════════════════════════════');
  log('');
  log(`  Chain: ${chain.name} (${chainId})`);
  log(`  Token: ${tokenAddress}`);
  log('');

  // Step 1: Generate wallets
  const payerPk = generatePrivateKey();
  const providerPk = generatePrivateKey();
  const payerAccount = privateKeyToAccount(payerPk);
  const providerAccount = privateKeyToAccount(providerPk);

  const payerPublicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  }) as unknown as LoggablePublicClient;

  const providerPublicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  }) as unknown as LoggablePublicClient;

  const payerWallet = createWalletClient({
    chain,
    transport: http(rpcUrl),
    account: payerAccount,
  });

  const providerWallet = createWalletClient({
    chain,
    transport: http(rpcUrl),
    account: providerAccount,
  });

  log('✓ Generated 2 ephemeral wallets');
  log(`  Payer:    ${payerAccount.address}`);
  log(`  Provider: ${providerAccount.address}`);

  // Step 2: Check balances
  log('');
  log('Checking balances...');
  let payerEthBalance: bigint;
  let providerEthBalance: bigint;
  let payerUsdcBalance: bigint;
  let providerUsdcBalance: bigint;

  try {
    const [pEth, prEth, pUsdc, provUsdc] = await Promise.all([
      payerPublicClient.getBalance({ address: payerAccount.address }),
      providerPublicClient.getBalance({ address: providerAccount.address }),
      payerPublicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [payerAccount.address],
      }),
      providerPublicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [providerAccount.address],
      }),
    ]);
    payerEthBalance = pEth;
    providerEthBalance = prEth;
    payerUsdcBalance = pUsdc as unknown as bigint;
    providerUsdcBalance = provUsdc as unknown as bigint;

    log(`  Payer:    ${parseEther(payerEthBalance.toString()).toString()} ETH, ${formatUsdc(payerUsdcBalance)} USDC`);
    log(`  Provider: ${parseEther(providerEthBalance.toString()).toString()} ETH, ${formatUsdc(providerUsdcBalance)} USDC`);

    if (payerEthBalance === 0n && !config.mint) {
      errors.push('Payer has 0 ETH — cannot pay gas');
    }
    if (providerEthBalance === 0n && !config.mint) {
      errors.push('Provider has 0 ETH — cannot pay gas');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`⚠ Could not check balances: ${msg}`);
    errors.push(`Balance check failed: ${msg}`);
    payerEthBalance = 0n;
    providerEthBalance = 0n;
    payerUsdcBalance = 0n;
    providerUsdcBalance = 0n;
  }

  // Step 3: Fund wallets with ETH + USDC if --mint is set
  if (config.mint && (payerUsdcBalance === 0n || providerUsdcBalance === 0n || payerEthBalance === 0n || providerEthBalance === 0n)) {
    log('');
    log('Funding wallets with ETH + MockUSDC...');

    try {
      const deployerPk = (config.deployerPrivateKey ?? ANVIL_DEPLOYER_PK) as Hash;
      const deployerAccount = privateKeyToAccount(deployerPk);
      const deployerWallet = createWalletClient({
        chain,
        transport: http(rpcUrl),
        account: deployerAccount,
      });

      const deployerPublicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
      });

      // Send ETH for gas
      if (payerEthBalance < parseEther('0.01')) {
        const ethHash = await deployerWallet.sendTransaction({
          to: payerAccount.address,
          value: parseEther('0.1'),
          account: deployerAccount,
          chain,
        });
        await deployerPublicClient.waitForTransactionReceipt({ hash: ethHash });
        onChainTxCount++;
        log(`  ✓ Sent 0.1 ETH → Payer (${payerAccount.address})`);
      }

      if (providerEthBalance < parseEther('0.01')) {
        const ethHash = await deployerWallet.sendTransaction({
          to: providerAccount.address,
          value: parseEther('0.1'),
          account: deployerAccount,
          chain,
        });
        await deployerPublicClient.waitForTransactionReceipt({ hash: ethHash });
        onChainTxCount++;
        log(`  ✓ Sent 0.1 ETH → Provider (${providerAccount.address})`);
      }

      // Mint USDC
      if (payerUsdcBalance === 0n) {
        const hash = await deployerWallet.writeContract({
          address: tokenAddress,
          abi: mintAbi,
          functionName: 'mint',
          args: [payerAccount.address, MINT_AMOUNT],
          chain,
          account: deployerAccount,
        });
        await deployerPublicClient.waitForTransactionReceipt({ hash });
        onChainTxCount++;
        payerUsdcBalance = MINT_AMOUNT;
        log(`  ✓ Minted ${formatUsdc(MINT_AMOUNT)} USDC → Payer (${payerAccount.address})`);
      }

      if (providerUsdcBalance === 0n) {
        const hash = await deployerWallet.writeContract({
          address: tokenAddress,
          abi: mintAbi,
          functionName: 'mint',
          args: [providerAccount.address, MINT_AMOUNT],
          chain,
          account: deployerAccount,
        });
        await deployerPublicClient.waitForTransactionReceipt({ hash });
        onChainTxCount++;
        providerUsdcBalance = MINT_AMOUNT;
        log(`  ✓ Minted ${formatUsdc(MINT_AMOUNT)} USDC → Provider (${providerAccount.address})`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`⚠ Funding failed: ${msg}`);
      errors.push(`Funding failed: ${msg}`);
    }
  } else if (!config.mint && (payerUsdcBalance === 0n || providerUsdcBalance === 0n)) {
    log('');
    log('⚠ Some wallets have 0 USDC balance.');
    log('  Use --mint for local Anvil chains with MockUSDC deployed.');
  }

  // Step 4: Register service
  log('');
  log('Registering service...');

  const pricePerRequest = usdcToWei(0.05);
  const maxResponseMs = 2000;
  const serviceDescriptor = {
    ...SERVICE_DESCRIPTOR,
    pricing: {
      ...SERVICE_DESCRIPTOR.pricing,
      token: tokenAddress,
    },
  };
  const metadataURI = JSON.stringify(serviceDescriptor);

  let serviceId: Hash;

  try {
    const serviceIdOnChain = keccak256(
      new Uint8Array([
        ...Buffer.from(providerAccount.address.slice(2).toLowerCase(), 'hex'),
        ...Buffer.from(metadataURI),
      ]),
    );

    serviceId = serviceIdOnChain;

    const hash = await providerWallet.writeContract({
      address: registryAddress,
      abi: serviceRegistryAbi,
      functionName: 'register',
      args: [metadataURI, pricePerRequest, maxResponseMs],
      chain: providerWallet.chain,
      account: providerAccount,
    });

    await providerPublicClient.waitForTransactionReceipt({ hash });
    onChainTxCount++;

    log(`✓ Provider registered service ${serviceId.slice(0, 10)}... (prediction-feed, $${weiToUsdc(pricePerRequest).toFixed(2)}/req)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Service registration failed: ${msg}`);
    log(`✗ Service registration failed: ${msg}`);

    return {
      payerAddress: payerAccount.address,
      providerAddress: providerAccount.address,
      serviceId: '',
      channelId: '',
      requestCount: 0,
      totalSpent: '$0.00',
      totalRefunded: '$0.00',
      avgLatencyMs: 0,
      onChainTxCount,
      success: false,
      errors,
    };
  }

  // Step 5: Start provider server
  let port = 0;
  const serverPorts = [3456, 3457, 3458, 3459, 3460, 3461, 3462, 3463, 3464, 3465];
  for (const p of serverPorts) {
    try {
      const srv = await startServer({
        rpcUrl,
        privateKey: providerPk,
        channelAddress,
        port: p,
        serviceId: serviceId,
        registryAddress,
      });
      server = srv;
      port = p;
      break;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('EADDRINUSE')) {
        throw err;
      }
    }
  }

  if (!server) {
    errors.push('Could not find an available port for the server');
    log('✗ Could not find an available port for the server');
    return {
      payerAddress: payerAccount.address,
      providerAddress: providerAccount.address,
      serviceId: serviceId,
      channelId: '',
      requestCount: 0,
      totalSpent: '$0.00',
      totalRefunded: '$0.00',
      avgLatencyMs: 0,
      onChainTxCount,
      success: false,
      errors,
    };
  }

  // Step 6: Payer opens channel
  log('');
  log('Opening payment channel...');

  const depositAmount = usdcToWei(5.00);
  const expiresIn = 24 * 3600;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiresIn;

  let channelId: bigint;

  try {
    const approved = await ensureApproval(
      payerPublicClient,
      payerWallet,
      tokenAddress,
      channelAddress,
      depositAmount,
      payerAccount.address,
    );
    if (approved) onChainTxCount++;

    const hash = await payerWallet.writeContract({
      address: channelAddress,
      abi: paymentChannelAbi,
      functionName: 'openChannel',
      args: [providerAccount.address, tokenAddress, depositAmount, expiresAt, ZERO_ADDRESS, '0x'],
      chain: payerWallet.chain,
      account: payerAccount,
    });

    const receipt = await payerPublicClient.waitForTransactionReceipt({ hash });
    onChainTxCount++;

    const openEvent = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === channelAddress.toLowerCase() &&
        l.topics[0] === keccak256(
          toHex('ChannelOpened(uint256,address,address,address,uint256,uint32)'),
        ),
    );

    if (openEvent && openEvent.topics[1]) {
      channelId = BigInt(openEvent.topics[1]);
    } else {
      channelId = 1n;
    }

    const channelData = (await payerPublicClient.readContract({
      address: channelAddress,
      abi: paymentChannelAbi,
      functionName: 'getChannel',
      args: [channelId],
    })) as unknown as ChannelFromChain;

    log(`✓ Payer opened channel #${channelId} (${formatUsdc(channelData.deposit)} USDC, ${expiresIn / 3600}hr expiry)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Channel open failed: ${msg}`);
    log(`✗ Channel open failed: ${msg}`);

    await server.stop();

    return {
      payerAddress: payerAccount.address,
      providerAddress: providerAccount.address,
      serviceId: serviceId,
      channelId: '',
      requestCount: 0,
      totalSpent: '$0.00',
      totalRefunded: '$0.00',
      avgLatencyMs: 0,
      onChainTxCount,
      success: false,
      errors,
    };
  }

  // Step 7: Make requests
  log('');
  const requestCount = 10;
  const intervalMs = 1000;
  const latencies: number[] = [];
  let totalCumulativeSpent = 0n;

  for (let i = 1; i <= requestCount; i++) {
    totalCumulativeSpent = BigInt(i) * pricePerRequest;

    const requestBody = {
      type: 'prediction-feed',
      input: { asset: 'ETH-USD', horizon: '24h' },
    };

    const nonce = BigInt(Math.floor(Date.now() / 1000) * 1000 + i);

    const proofSig = await signPaymentProof(
      payerWallet,
      channelAddress,
      channelId,
      totalCumulativeSpent,
      requestBody,
      nonce,
    );

    const proofHeader = createPaymentProofHeader(
      channelId,
      totalCumulativeSpent,
      requestBody,
      nonce,
      proofSig,
    );

    const start = performance.now();
    let resultText = '';

    try {
      const res = await fetch(`http://localhost:${port}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-payment-proof': JSON.stringify(proofHeader),
        },
        body: JSON.stringify(requestBody),
      });

      const body = await res.text();
      resultText = body;
    } catch (err: unknown) {
      resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(`Request ${i} failed: ${resultText}`);
    }

    const latency = performance.now() - start;
    latencies.push(latency);

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(resultText);
    } catch {
      // raw text
    }

    const iv = parsed?.impliedVolatility
      ? (parsed.impliedVolatility as number).toFixed(4)
      : 'N/A';

    log(`→ Request ${i}/${requestCount}... { impliedVolatility: ${iv} } (${Math.round(latency)}ms)`);

    if (i < requestCount) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  log('');
  log(`✓ All ${requestCount} requests complete`);

  // Step 8: Close channel
  const totalSpent = BigInt(requestCount) * pricePerRequest;

  try {
    const closeSig = await signChannelClose(
      payerWallet,
      channelAddress,
      channelId,
      totalSpent,
    );

    const hash = await providerWallet.writeContract({
      address: channelAddress,
      abi: paymentChannelAbi,
      functionName: 'closeChannel',
      args: [channelId, totalSpent, closeSig],
      chain: providerWallet.chain,
      account: providerAccount,
    });

    await providerPublicClient.waitForTransactionReceipt({ hash });
    onChainTxCount++;

    const refunded = depositAmount - totalSpent;
    log(
      `✓ Channel closed. Provider: ${formatUsdc(totalSpent)}, Refunded: ${formatUsdc(refunded)}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Channel close failed: ${msg}`);
    log(`✗ Channel close failed: ${msg}`);
  }

  // Step 9: Stop server
  log('');
  await server.stop();

  // Step 10: Print summary
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;
  const refunded = depositAmount - totalSpent;

  log('');
  log('═══════════════════════════════════════════');
  log('              DEMO COMPLETE');
  log('───────────────────────────────────────────');
  log(`  Total requests:   ${requestCount}`);
  log(`  Total spent:      ${formatUsdc(totalSpent)} USDC`);
  log(`  Total refunded:   ${formatUsdc(refunded)} USDC`);
  log(`  Avg latency:      ${avgLatency}ms`);
  log(`  On-chain txs:     ${onChainTxCount} (register + approve? + mint? + open + close)`);
  log(`  Service:          ${serviceId.slice(0, 10)}...`);
  log('═══════════════════════════════════════════');
  log('');

  return {
    payerAddress: payerAccount.address,
    providerAddress: providerAccount.address,
    serviceId: serviceId,
    channelId: channelId.toString(),
    requestCount,
    totalSpent: formatUsdc(totalSpent),
    totalRefunded: formatUsdc(refunded),
    avgLatencyMs: avgLatency,
    onChainTxCount,
    success: errors.length === 0,
    errors,
  };
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const { stdin } = process;
    if (!stdin.isTTY) {
      resolve();
      return;
    }
    stdin.resume();
    stdin.once('data', () => {
      stdin.pause();
      resolve();
    });
  });
}

export { SERVICE_DESCRIPTOR, waitForEnter };
