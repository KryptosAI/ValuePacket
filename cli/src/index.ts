import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { log, formatAddress, formatUsdc, usdcToWei, weiToUsdc, truncate, ZERO_ADDRESS } from './utils.js';
import { runDemo, type DemoConfig } from './demo.js';
import { startServer } from './server.js';
import {
  serviceRegistryAbi,
  paymentChannelAbi,
  erc20Abi,
  USDC_BASE_SEPOLIA,
  SERVICE_REGISTRY_ADDRESS_DEFAULT,
  PAYMENT_CHANNEL_ADDRESS_DEFAULT,
} from './contracts.js';

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

const BASE_SEPOLIA = {
  id: 84532,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
} as const;

function getChain(rpcUrl: string) {
  return { ...BASE_SEPOLIA, rpcUrls: { default: { http: [rpcUrl] } } };
}

function isLocalRpc(rpcUrl: string): boolean {
  return rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1');
}

function isBaseSepoliaRpc(rpcUrl: string): boolean {
  return rpcUrl.includes('sepolia.base.org') || rpcUrl.includes('base-sepolia');
}

function readLocalDeployments(): Record<string, string> | null {
  const paths = [
    resolve('contracts', 'deployments', 'local.json'),
    resolve('..', 'contracts', 'deployments', 'local.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function readBaseSepoliaDeployments(): Record<string, string> | null {
  const paths = [
    resolve('contracts', 'deployments', 'base-sepolia.json'),
    resolve('..', 'contracts', 'deployments', 'base-sepolia.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const program = new Command();

program
  .name('valuepacket')
  .description('ValuePacket CLI — the payment protocol for autonomous agents')
  .version('0.2.2');

// ─── register ──────────────────────────────────────────────

program
  .command('register')
  .description('Register an agent service on the ServiceRegistry')
  .requiredOption('--metadata <path>', 'Path to service descriptor JSON file')
  .requiredOption('--price <number>', 'Price per request in USDC (e.g. 0.05)')
  .option('--max-response-ms <number>', 'Max response time in ms', '2000')
  .option('--rpc <url>', 'RPC URL', process.env.RPC_URL || 'https://sepolia.base.org')
  .option('--private-key <key>', 'Agent private key (0x-prefixed)', process.env.AGENT_PRIVATE_KEY)
  .option(
    '--registry <address>',
    'ServiceRegistry contract address',
    process.env.SERVICE_REGISTRY_ADDRESS,
  )
  .action(async (options) => {
    const {
      metadata: metadataPath,
      price,
      maxResponseMs,
      rpc,
      privateKey,
      registry,
    } = options;

    if (!privateKey) {
      log('✗ Error: --private-key is required. Set AGENT_PRIVATE_KEY env variable or pass --private-key.');
      process.exit(1);
    }
    if (!registry || registry === SERVICE_REGISTRY_ADDRESS_DEFAULT) {
      log('✗ Error: --registry is required. Set SERVICE_REGISTRY_ADDRESS env variable or pass --registry.');
      process.exit(1);
    }

    const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

    const absPath = resolve(metadataPath);
    if (!existsSync(absPath)) {
      log(`✗ Error: Metadata file not found: ${absPath}`);
      process.exit(1);
    }

    let metadataURI: string;
    try {
      const content = readFileSync(absPath, 'utf-8');
      JSON.parse(content);
      metadataURI = content;
    } catch (err: unknown) {
      log(`✗ Error: Invalid metadata JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    try {
      const account = privateKeyToAccount(key as Hash);
      const chain = getChain(rpc);
      const walletClient = createWalletClient({
        chain,
        transport: http(rpc),
        account,
      });
      const publicClient = createPublicClient({
        chain,
        transport: http(rpc),
      });

      const priceWei = usdcToWei(Number(price));
      const maxMs = Number(maxResponseMs);

      log(`Registering service from ${absPath}...`);
      log(`  Price: $${price}/req (${priceWei} wei)`);
      log(`  Max response: ${maxMs}ms`);
      log(`  Provider: ${account.address}`);

      const hash = await walletClient.writeContract({
        address: registry as Address,
        abi: serviceRegistryAbi,
        functionName: 'register',
        args: [metadataURI, priceWei, maxMs],
        chain,
        account,
      });

      log(`  Transaction: ${hash}`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      log(`✓ Service registered in block ${receipt.blockNumber}`);

      const { keccak256 } = await import('viem');
      const serviceId = keccak256(
        new Uint8Array([
          ...Buffer.from(account.address.slice(2).toLowerCase(), 'hex'),
          ...Buffer.from(metadataURI),
        ]),
      );
      log(`  Service ID: ${serviceId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✗ Registration failed: ${msg}`);
      process.exit(1);
    }
  });

// ─── discover ──────────────────────────────────────────────

program
  .command('discover')
  .description('Discover agent services')
  .option('--type <string>', 'Filter by service type')
  .option('--max-price <number>', 'Max price per request in USDC')
  .option('--rpc <url>', 'RPC URL', process.env.RPC_URL || 'https://sepolia.base.org')
  .option('--indexer <url>', 'Indexer GraphQL URL')
  .option(
    '--registry <address>',
    'ServiceRegistry contract address',
    process.env.SERVICE_REGISTRY_ADDRESS,
  )
  .action(async (options) => {
    const { type: serviceType, maxPrice, rpc, indexer, registry } = options;

    if (!registry || registry === SERVICE_REGISTRY_ADDRESS_DEFAULT) {
      log('✗ Error: --registry is required. Set SERVICE_REGISTRY_ADDRESS env variable or pass --registry.');
      process.exit(1);
    }

    try {
      const chain = getChain(rpc);
      const publicClient = createPublicClient({
        chain,
        transport: http(rpc),
      });

      const count = (await publicClient.readContract({
        address: registry as Address,
        abi: serviceRegistryAbi,
        functionName: 'getServiceCount',
      })) as unknown as bigint;

      if (count === 0n) {
        log('No services registered yet.');
        return;
      }

      const services: {
        id: string;
        provider: string;
        price: string;
        maxResponseMs: number;
        active: boolean;
        type: string;
      }[] = [];

      const countNum = Number(count);
      for (let i = 0; i < countNum; i++) {
        const [sId, svc] = (await publicClient.readContract({
          address: registry as Address,
          abi: serviceRegistryAbi,
          functionName: 'getServiceAtIndex',
          args: [BigInt(i)],
        })) as unknown as [string, ServiceFromChain];

        const priceUsdc = weiToUsdc(svc.pricePerRequest);
        if (maxPrice !== undefined && priceUsdc > Number(maxPrice)) continue;
        if (!svc.active) continue;

        let svcType = '';
        try {
          const desc = JSON.parse(svc.metadataURI);
          svcType = desc?.service?.id || desc?.type || '';
        } catch {
          svcType = '';
        }

        if (serviceType && svcType !== serviceType) continue;

        services.push({
          id: sId,
          provider: svc.provider,
          price: formatUsdc(svc.pricePerRequest),
          maxResponseMs: svc.maxResponseMs,
          active: svc.active,
          type: svcType || 'unknown',
        });
      }

      if (services.length === 0) {
        log('No matching services found.');
        return;
      }

      log('');
      log('┌──────┬──────────────────────────────────────────┬──────────────┬────────────┬──────────────┬──────────┐');
      log('│  #   │ Service ID                               │ Provider     │ Price/Req  │ Max Resp.    │ Type     │');
      log('├──────┼──────────────────────────────────────────┼──────────────┼────────────┼──────────────┼──────────┤');

      services.forEach((s, idx) => {
        const idShort = s.id.slice(0, 20) + '...';
        const provider = formatAddress(s.provider);
        const price = s.price.padStart(12);
        const maxMs = `${s.maxResponseMs}ms`.padStart(12);
        const sType = (s.type || 'unknown').padEnd(8);
        log(`│ ${String(idx + 1).padEnd(4)} │ ${idShort.padEnd(40)} │ ${provider.padEnd(12)} │ ${price} │ ${maxMs} │ ${sType} │`);
      });

      log('└──────┴──────────────────────────────────────────┴──────────────┴────────────┴──────────────┴──────────┘');
      log(`\n${services.length} service(s) found.`);

      if (indexer) {
        log(`\nIndexer query also available at: ${indexer}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✗ Discovery failed: ${msg}`);
      process.exit(1);
    }
  });

// ─── subscribe ─────────────────────────────────────────────

program
  .command('subscribe')
  .description('Open a channel and start consuming a service')
  .requiredOption('--provider <address>', 'Provider address')
  .requiredOption('--deposit <number>', 'Total deposit in USDC')
  .option('--expires <hours>', 'Channel expiry in hours', '24')
  .option('--requests <number>', 'Number of requests to make', '10')
  .option('--interval <ms>', 'Interval between requests in ms', '1000')
  .option('--body <json>', 'Request body as JSON string')
  .option('--endpoint <url>', 'Provider endpoint URL', 'http://localhost:3456')
  .option('--rpc <url>', 'RPC URL', process.env.RPC_URL || 'https://sepolia.base.org')
  .option('--private-key <key>', 'Agent private key (0x-prefixed)', process.env.AGENT_PRIVATE_KEY)
  .option(
    '--channels <address>',
    'PaymentChannel contract address',
    process.env.PAYMENT_CHANNEL_ADDRESS,
  )
  .option('--token <address>', 'Token address (USDC)', USDC_BASE_SEPOLIA)
  .action(async (options) => {
    const {
      provider,
      deposit,
      expires,
      requests,
      interval,
      body,
      endpoint,
      rpc,
      privateKey,
      channels,
      token,
    } = options;

    if (!privateKey) {
      log('✗ Error: --private-key is required.');
      process.exit(1);
    }
    if (!channels || channels === PAYMENT_CHANNEL_ADDRESS_DEFAULT) {
      log('✗ Error: --channels is required.');
      process.exit(1);
    }

    const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const depositAmount = usdcToWei(Number(deposit));
    const expiresIn = Number(expires) * 3600;
    const requestCount = Number(requests);
    const intervalMs = Number(interval);
    const channelAddress = channels as Address;
    const tokenAddress = token as Address;
    const providerAddress = provider as Address;

    let requestBody: Record<string, unknown>;
    if (body) {
      try {
        requestBody = JSON.parse(body);
      } catch {
        log('✗ Error: Invalid --body JSON');
        process.exit(1);
      }
    } else {
      requestBody = { type: 'prediction-feed', input: { asset: 'ETH-USD' } };
    }

    try {
      const account = privateKeyToAccount(key as Hash);
      const chain = getChain(rpc);
      const publicClient = createPublicClient({
        chain,
        transport: http(rpc),
      });
      const walletClient = createWalletClient({
        chain,
        transport: http(rpc),
        account,
      });

      // Approve USDC
      const allowance = (await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account.address, channelAddress],
      })) as unknown as bigint;

      if (allowance < depositAmount) {
        log(`Approving ${formatUsdc(depositAmount)} USDC spending...`);
        const approveHash = await walletClient.writeContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args: [channelAddress, depositAmount],
          chain,
          account,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
        log('✓ USDC approved');
      }

      // Open channel
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + expiresIn;

      log(`Opening channel: ${formatUsdc(depositAmount)} USDC, ${expires}hr expiry...`);

      const openHash = await walletClient.writeContract({
        address: channelAddress,
        abi: paymentChannelAbi,
        functionName: 'openChannel',
        args: [providerAddress, tokenAddress, depositAmount, expiresAt, ZERO_ADDRESS, '0x'],
        chain,
        account,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: openHash });

      const { keccak256, toHex } = await import('viem');
      const openTopic = keccak256(
        toHex('ChannelOpened(uint256,address,address,address,uint256,uint32)'),
      );
      const eventLog = receipt.logs.find(
        (l) =>
          l.address.toLowerCase() === channelAddress.toLowerCase() &&
          l.topics[0] === openTopic,
      );

      let channelId = 1n;
      if (eventLog && eventLog.topics[1]) {
        channelId = BigInt(eventLog.topics[1]);
      }

      log(`✓ Channel #${channelId} opened`);

      // Make requests
      log('');
      log(`Making ${requestCount} requests to ${endpoint}...`);

      const { signPaymentProof, createPaymentProofHeader } = await import(
        '@valuepacket/sdk'
      );

      const latencies: number[] = [];
      const results: string[] = [];

      for (let i = 1; i <= requestCount; i++) {
        const cumulativeSpent = BigInt(i) * (depositAmount / BigInt(requestCount));
        const nonce = BigInt(Math.floor(Date.now() / 1000) * 1000 + i);

        const proofSig = await signPaymentProof(
          walletClient,
          channelAddress,
          channelId,
          cumulativeSpent,
          requestBody,
          nonce,
        );

        const proofHeader = createPaymentProofHeader(
          channelId,
          cumulativeSpent,
          requestBody,
          nonce,
          proofSig,
        );

        const start = performance.now();

        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-payment-proof': JSON.stringify(proofHeader),
            },
            body: JSON.stringify(requestBody),
          });

          const respText = await res.text();
          results.push(respText);
          latencies.push(performance.now() - start);

          log(`→ Request ${i}/${requestCount}: ${res.status} (${Math.round(latencies[latencies.length - 1])}ms)`);
        } catch (err: unknown) {
          log(`→ Request ${i}/${requestCount}: Error - ${err instanceof Error ? err.message : String(err)}`);
          results.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (i < requestCount) {
          await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        }
      }

      // Close channel
      log('');
      const totalSpent = BigInt(requestCount) * (depositAmount / BigInt(requestCount));

      const { signChannelClose } = await import('@valuepacket/sdk');
      const closeSig = await signChannelClose(
        walletClient,
        channelAddress,
        channelId,
        totalSpent,
      );

      log('Closing channel...');
      log(`  NOTE: Only the payee can submit closeChannel. The signature has been generated.`);
      log(`  Signature: ${closeSig}`);
      log(`  Have the provider call closeChannel(${channelId}, ${totalSpent}, <this-signature>)`);

      const avgLatency = latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;

      log('');
      log('═══════════════════════════════════════════');
      log('            SUBSCRIPTION SUMMARY');
      log('───────────────────────────────────────────');
      log(`  Channel:     #${channelId}`);
      log(`  Deposit:     ${formatUsdc(depositAmount)} USDC`);
      log(`  Spent:       ${formatUsdc(totalSpent)} USDC`);
      log(`  Refundable:  ${formatUsdc(depositAmount - totalSpent)} USDC`);
      log(`  Requests:    ${requestCount}`);
      log(`  Avg latency: ${avgLatency}ms`);
      log('═══════════════════════════════════════════');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✗ Subscribe failed: ${msg}`);
      process.exit(1);
    }
  });

// ─── serve ─────────────────────────────────────────────────

program
  .command('serve')
  .description('Start a service provider server')
  .requiredOption('--service-id <hex>', 'Registered service ID (0x-prefixed)')
  .option('--port <number>', 'Port to listen on', '3456')
  .option('--rpc <url>', 'RPC URL', process.env.RPC_URL || 'https://sepolia.base.org')
  .option('--private-key <key>', 'Agent private key (0x-prefixed)', process.env.AGENT_PRIVATE_KEY)
  .option(
    '--channels <address>',
    'PaymentChannel contract address',
    process.env.PAYMENT_CHANNEL_ADDRESS,
  )
  .option(
    '--registry <address>',
    'ServiceRegistry contract address',
    process.env.SERVICE_REGISTRY_ADDRESS,
  )
  .option('--token <address>', 'Token address (USDC)', USDC_BASE_SEPOLIA)
  .action(async (options) => {
    const { serviceId, port, rpc, privateKey, channels, registry, token } = options;

    if (!privateKey) {
      log('✗ Error: --private-key is required.');
      process.exit(1);
    }
    if (!channels || channels === PAYMENT_CHANNEL_ADDRESS_DEFAULT) {
      log('✗ Error: --channels is required.');
      process.exit(1);
    }
    if (!registry || registry === SERVICE_REGISTRY_ADDRESS_DEFAULT) {
      log('✗ Error: --registry is required.');
      process.exit(1);
    }

    const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

    try {
      const srv = await startServer({
        rpcUrl: rpc,
        privateKey: key as Hash,
        channelAddress: channels as Address,
        port: Number(port),
        serviceId: serviceId as `0x${string}`,
        registryAddress: registry as Address,
        tokenAddress: token as Address,
      });

      log(`Server running on http://localhost:${srv.port}`);
      log('Press Ctrl+C to stop');

      const shutdown = async () => {
        log('');
        await srv.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✗ Server failed: ${msg}`);
      process.exit(1);
    }
  });

// ─── demo ──────────────────────────────────────────────────

program
  .command('demo')
  .description('Run the full end-to-end demo')
  .option('--rpc <url>', 'RPC URL', process.env.RPC_URL || 'https://sepolia.base.org')
  .option(
    '--registry <address>',
    'ServiceRegistry contract address',
    process.env.SERVICE_REGISTRY_ADDRESS,
  )
  .option(
    '--channels <address>',
    'PaymentChannel contract address',
    process.env.PAYMENT_CHANNEL_ADDRESS,
  )
  .option('--token <address>', 'Token address (USDC)', USDC_BASE_SEPOLIA)
  .option('--mint', 'Auto-mint USDC using Anvil deployer account (local chain only)')
  .action(async (options) => {
    let { rpc, registry, channels, token, mint } = options;

    if (isLocalRpc(rpc)) {
      log('Local chain detected. Looking for local deployments...');
      const local = readLocalDeployments();
      if (local) {
        if (!registry || registry === SERVICE_REGISTRY_ADDRESS_DEFAULT) {
          registry = local.serviceRegistry || local.ServiceRegistry;
        }
        if (!channels || channels === PAYMENT_CHANNEL_ADDRESS_DEFAULT) {
          channels = local.paymentChannel || local.PaymentChannel;
        }
        if (!token || token === USDC_BASE_SEPOLIA) {
          const localToken = local.mockERC20 || local.MockERC20 || local.usdc || local.USDC;
          if (localToken) {
            token = localToken;
          }
        }
        mint = true;
        log(`  Using local deployments:`);
        log(`    ServiceRegistry: ${registry}`);
        log(`    PaymentChannel:  ${channels}`);
        log(`    Token (USDC):    ${token}`);
      }
    } else if (isBaseSepoliaRpc(rpc)) {
      log('Base Sepolia detected. Looking for Base Sepolia deployments...');
      const sepolia = readBaseSepoliaDeployments();
      if (sepolia) {
        if (!registry || registry === SERVICE_REGISTRY_ADDRESS_DEFAULT) {
          registry = sepolia.serviceRegistry;
        }
        if (!channels || channels === PAYMENT_CHANNEL_ADDRESS_DEFAULT) {
          channels = sepolia.paymentChannel;
        }
        if (!token || token === USDC_BASE_SEPOLIA) {
          token = sepolia.usdcToken || USDC_BASE_SEPOLIA;
        }
        log(`  Using Base Sepolia deployments:`);
        log(`    ServiceRegistry: ${registry}`);
        log(`    PaymentChannel:  ${channels}`);
        log(`    Token (USDC):    ${token}`);
      }
    } else if (mint) {
      log('⚠ --mint flag is set but RPC does not appear to be a local chain (use localhost:8545).');
    }

    if (!registry || registry === SERVICE_REGISTRY_ADDRESS_DEFAULT) {
      log('✗ Error: --registry is required for the demo. Set SERVICE_REGISTRY_ADDRESS env variable or pass --registry.');
      log('');
      log('To deploy contracts locally for testing:');
      log('  1. cd contracts');
      log('  2. forge script script/Deploy.s.sol --rpc-url <RPC> --broadcast');
      log('  3. Copy the deployed addresses to .env');
      process.exit(1);
    }
    if (!channels || channels === PAYMENT_CHANNEL_ADDRESS_DEFAULT) {
      log('✗ Error: --channels is required for the demo. Set PAYMENT_CHANNEL_ADDRESS env variable or pass --channels.');
      process.exit(1);
    }

    const config: DemoConfig = {
      rpcUrl: rpc,
      registryAddress: registry as Address,
      channelAddress: channels as Address,
      tokenAddress: token as Address,
      chainId: isLocalRpc(rpc) ? 31337 : 84532,
      mint,
    };

    try {
      const result = await runDemo(config);

      if (!result.success) {
        log('');
        log(`⚠ Demo completed with ${result.errors.length} error(s):`);
        result.errors.forEach((e) => log(`  - ${e}`));
        process.exit(1);
      }

      process.exit(0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`\n✗ Demo failed: ${msg}`);
      log('\nTroubleshooting:');
      log('  - Ensure RPC endpoint is reachable');
      log('  - Verify contract addresses are correct');
      log('  - Check that wallets have sufficient ETH + USDC');
      log('  - Ensure contracts are deployed on the target chain');
      process.exit(1);
    }
  });

// ─── local-demo ────────────────────────────────────────────

program
  .command('local-demo')
  .description('Run demo against local Anvil chain (shorthand)')
  .action(async () => {
    const local = readLocalDeployments();
    if (!local) {
      log('✗ Error: local.json not found at contracts/deployments/local.json');
      log('');
      log('Deploy contracts locally first:');
      log('  cd contracts');
      log('  forge script script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast');
      log('');
      log('Then create contracts/deployments/local.json with the deployed addresses, e.g.:');
      log('  {');
      log('    "serviceRegistry": "0x...",');
      log('    "paymentChannel": "0x...",');
      log('    "mockERC20": "0x..."');
      log('  }');
      process.exit(1);
    }

    const registry = local.serviceRegistry || local.ServiceRegistry;
    const channels = local.paymentChannel || local.PaymentChannel;
    const token = local.mockERC20 || local.MockERC20 || local.usdc || local.USDC;

    if (!registry || !channels || !token) {
      log('✗ Error: Missing required addresses in local.json.');
      log(`  Found: ${JSON.stringify(local, null, 2)}`);
      log('  Expected keys: serviceRegistry, paymentChannel, mockERC20');
      process.exit(1);
    }

    log('Running local demo with:');
    log(`  RPC:              http://localhost:8545`);
    log(`  ServiceRegistry:  ${registry}`);
    log(`  PaymentChannel:   ${channels}`);
    log(`  Token (USDC):     ${token}`);
    log(`  Auto-mint:        enabled`);
    log('');

    const config: DemoConfig = {
      rpcUrl: 'http://localhost:8545',
      registryAddress: registry as Address,
      channelAddress: channels as Address,
      tokenAddress: token as Address,
      chainId: 31337,
      mint: true,
    };

    try {
      const result = await runDemo(config);

      if (!result.success) {
        log('');
        log(`⚠ Demo completed with ${result.errors.length} error(s):`);
        result.errors.forEach((e) => log(`  - ${e}`));
        process.exit(1);
      }

      process.exit(0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`\n✗ Local demo failed: ${msg}`);
      log('\nTroubleshooting:');
      log('  - Ensure Anvil is running: anvil --host 0.0.0.0');
      log('  - Ensure contracts are deployed on Anvil');
      process.exit(1);
    }
  });

// ─── balance ───────────────────────────────────────────────

program
  .command('balance')
  .description('Check ETH and USDC balances for a wallet')
  .option('--address <address>', 'Wallet address (defaults to --private-key derived address)')
  .option('--rpc <url>', 'RPC URL', process.env.RPC_URL || 'https://sepolia.base.org')
  .option('--private-key <key>', 'Agent private key (0x-prefixed)', process.env.AGENT_PRIVATE_KEY)
  .option('--token <address>', 'Token address (USDC)', USDC_BASE_SEPOLIA)
  .action(async (options) => {
    const { address, rpc, privateKey: pk, token } = options;

    let addr: Address;
    if (address) {
      addr = address as Address;
    } else if (pk) {
      const key = pk.startsWith('0x') ? pk : `0x${pk}`;
      addr = privateKeyToAccount(key as Hash).address;
    } else {
      log('✗ Error: Provide either --address or --private-key.');
      process.exit(1);
    }

    try {
      const chain = getChain(rpc);
      const publicClient = createPublicClient({
        chain,
        transport: http(rpc),
      });

      const [ethBalance, usdcBalance] = await Promise.all([
        publicClient.getBalance({ address: addr }),
        publicClient.readContract({
          address: token as Address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [addr],
        }),
      ]);

      log('');
      log(`Wallet: ${addr}`);
      log(`  ETH:  ${parseEther(ethBalance.toString())}`);
      log(`  USDC: ${formatUsdc(usdcBalance as unknown as bigint)}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✗ Balance check failed: ${msg}`);
      process.exit(1);
    }
  });

// ─── parse ─────────────────────────────────────────────────

program.parse();
