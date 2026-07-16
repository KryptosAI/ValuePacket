import * as http from 'node:http';
import type { Address, PublicClient } from 'viem';
import { verifyTypedData } from 'viem';
import { log, formatAddress, weiToUsdc } from './utils.js';
import { SERVICE_REGISTRY_ABI, PAYMENT_CHANNEL_ABI } from '@valuepacket/sdk';

const PAYMENT_PROOF_TYPE = {
  PaymentProof: [
    { name: 'channelId', type: 'uint256' },
    { name: 'cumulativeSpent', type: 'uint256' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

const DOMAIN = {
  name: 'ValuePacket',
  version: '1',
} as const;

export interface ServerConfig {
  rpcUrl: string;
  privateKey: `0x${string}`;
  channelAddress: Address;
  port: number;
  serviceId: `0x${string}`;
  registryAddress: Address;
  tokenAddress?: Address;
  handler?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface ChannelServer {
  server: http.Server;
  stop: () => Promise<void>;
  port: number;
}

interface ChannelState {
  channelId: bigint;
  payer: Address;
  lastNonce: bigint;
  totalSpent: bigint;
}

interface PaymentProofHeader {
  channelId: string;
  cumulativeSpent: string;
  nonce: string;
  proof: string;
  requestHash: string;
}

interface ServiceRecord {
  provider: Address;
  metadataURI: string;
  pricePerRequest: bigint;
  maxResponseMs: number;
  registeredAt: number;
  active: boolean;
}

const MOCK_HANDLERS: Record<string, (input: Record<string, unknown>) => Record<string, unknown>> = {
  'prediction-feed': () => ({
    impliedVolatility: Math.round(0.04 + Math.random() * 0.01 + Math.random() * 1e-6) / 10000,
    timestamp: Math.floor(Date.now() / 1000),
    confidence: 0.85 + Math.random() * 0.1,
  }),
  'text-generation': () => ({
    text: 'Generated response from ValuePacket Protocol.',
    tokens: 128,
    model: 'mock-model',
  }),
  'data-analysis': () => ({
    summary: 'Analysis complete.',
    metrics: { accuracy: 0.95, latency: 42 },
  }),
  default: () => ({
    result: 'ok',
    timestamp: Date.now(),
  }),
};

function getHandler(serviceType: string) {
  return (
    MOCK_HANDLERS[serviceType] ||
    (() => ({
      type: serviceType,
      result: 'ok',
      timestamp: Date.now(),
    }))
  );
}

function parseHeaders(headers: http.IncomingHttpHeaders): PaymentProofHeader | null {
  const raw = headers['x-payment-proof'] || headers['X-Payment-Proof'];
  if (!raw) return null;
  try {
    const val = Array.isArray(raw) ? raw[0] : raw;
    return JSON.parse(val) as PaymentProofHeader;
  } catch {
    return null;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function getPayerFromChannel(
  publicClient: PublicClient,
  channelAddress: Address,
  channelId: bigint,
): Promise<Address> {
  try {
    const channelData = await publicClient.readContract({
      address: channelAddress,
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'getChannel',
      args: [channelId],
    });
    if (Array.isArray(channelData)) return channelData[0] as Address;
    const obj = channelData as Record<string, unknown>;
    return (obj.payer as Address) || '0x0000000000000000000000000000000000000000';
  } catch {
    return '0x0000000000000000000000000000000000000000';
  }
}

export async function startServer(config: ServerConfig): Promise<ChannelServer> {
  const {
    rpcUrl,
    privateKey,
    channelAddress,
    port,
    serviceId,
    registryAddress,
    tokenAddress,
    handler: customHandler,
  } = config;

  let providerAddress: Address;
  let serviceType = 'default';
  let pricePerRequest = 0n;
  let publicClient: PublicClient;
  let chainId: number;

  try {
    const { createPublicClient, http: viemHttp } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');

    const account = privateKeyToAccount(privateKey);
    providerAddress = account.address;

    publicClient = createPublicClient({
      transport: viemHttp(rpcUrl),
    });

    chainId = await publicClient.getChainId();

    try {
      const serviceRecord = (await publicClient.readContract({
        address: registryAddress,
        abi: SERVICE_REGISTRY_ABI,
        functionName: 'getService',
        args: [serviceId],
      })) as unknown as ServiceRecord;

      if (serviceRecord.provider.toLowerCase() !== providerAddress.toLowerCase()) {
        throw new Error(
          `Service ${serviceId} is registered by ${serviceRecord.provider}, not ${providerAddress}`,
        );
      }

      pricePerRequest = serviceRecord.pricePerRequest;

      try {
        const descriptor = JSON.parse(serviceRecord.metadataURI);
        serviceType = descriptor?.service?.id || descriptor?.type || 'default';
      } catch {
        serviceType = 'default';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`⚠ Could not read service from registry: ${msg}`);
      log('  Server will still start — using default handler.');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to initialize server: ${msg}`);
  }

  const channels = new Map<string, ChannelState>();
  const handler = customHandler || getHandler(serviceType);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const proofHeader = parseHeaders(req.headers);
    if (!proofHeader) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing x-payment-proof header' }));
      return;
    }

    const body = await readBody(req);
    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const channelKey = proofHeader.channelId;
    const cumulativeSpent = BigInt(proofHeader.cumulativeSpent);
    const nonce = BigInt(proofHeader.nonce);

    if (nonce <= 0n) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Nonce must be positive' }));
      return;
    }

    if (!channels.has(channelKey)) {
      const channelId = BigInt(channelKey);
      const payer = await getPayerFromChannel(publicClient, channelAddress, channelId);

      channels.set(channelKey, {
        channelId,
        payer,
        lastNonce: 0n,
        totalSpent: 0n,
      });
    }

    const state = channels.get(channelKey)!;

    if (nonce <= state.lastNonce) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: `Nonce ${nonce} is not greater than last seen nonce ${state.lastNonce}`,
        }),
      );
      return;
    }

    if (cumulativeSpent <= state.totalSpent) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: 'Cumulative spent must increase',
        }),
      );
      return;
    }

    try {
      const valid = await verifyTypedData({
        address: state.payer,
        domain: { ...DOMAIN, chainId, verifyingContract: channelAddress },
        types: PAYMENT_PROOF_TYPE,
        primaryType: 'PaymentProof',
        message: {
          channelId: BigInt(proofHeader.channelId),
          cumulativeSpent,
          requestHash: proofHeader.requestHash as `0x${string}`,
          nonce,
        },
        signature: proofHeader.proof as `0x${string}`,
      });

      if (!valid) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Invalid payment proof signature' }));
        return;
      }
    } catch (err: unknown) {
      res.writeHead(403);
      res.end(
        JSON.stringify({
          error: 'Payment proof verification failed',
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    const perRequestSpent = cumulativeSpent - state.totalSpent;
    state.lastNonce = nonce;
    state.totalSpent = cumulativeSpent;

    const amountStr = pricePerRequest > 0n
      ? `$${weiToUsdc(pricePerRequest).toFixed(4)}`
      : `$${weiToUsdc(perRequestSpent).toFixed(4)}`;

    log(
      `← Request from ${formatAddress(state.payer)} | channel ${proofHeader.channelId} | ` +
        `spent ${amountStr} USDC (total: $${weiToUsdc(cumulativeSpent).toFixed(4)})`,
    );

    try {
      const result = await handler(parsedBody);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err: unknown) {
      res.writeHead(500);
      res.end(
        JSON.stringify({
          error: 'Handler error',
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  return new Promise<ChannelServer>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      const actualPort = (server.address() as { port: number }).port;
      log(`✓ Provider server started on port ${actualPort} (service: ${serviceType}, chain: ${chainId})`);
      if (tokenAddress) {
        log(`  Token: ${tokenAddress}`);
      }

      resolve({
        server,
        port: actualPort,
        stop: async () => {
          return new Promise<void>((resolveStop) => {
            server.close(() => {
              log('✓ Server stopped');
              resolveStop();
            });
          });
        },
      });
    });
  });
}

export { MOCK_HANDLERS, getHandler };
