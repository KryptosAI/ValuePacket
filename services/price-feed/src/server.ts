import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { recoverTypedDataAddress, createPublicClient, http as viemHttp } from 'viem';
import { PAYMENT_PROOF_TYPE, PAYMENT_CHANNEL_ABI } from '@valuepacket/sdk';

const VERSION = '0.1.0';
const PORT = parseInt(process.env.PORT || '3000', 10);
const CHAIN = process.env.CHAIN || 'base-sepolia';

const DEFAULT_RPC_BY_CHAIN: Record<string, string> = {
  'base-sepolia': 'https://sepolia.base.org',
  local: 'http://localhost:8545',
};

interface DeploymentFile {
  chainId?: number;
  paymentChannel?: string;
}

function isPlaceholder(value: string | undefined): boolean {
  return !value || value === '0x...' || value.trim() === '';
}

function loadDeployment(): DeploymentFile | null {
  const explicit = process.env.DEPLOYMENT_FILE;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate =
    explicit ?? resolve(here, '..', '..', '..', 'contracts', 'deployments', `${CHAIN}.json`);
  try {
    return JSON.parse(readFileSync(candidate, 'utf-8')) as DeploymentFile;
  } catch {
    return null;
  }
}

const deployment = loadDeployment();

const resolvedChannelAddress =
  isPlaceholder(process.env.PAYMENT_CHANNEL_ADDRESS)
    ? deployment?.paymentChannel
    : process.env.PAYMENT_CHANNEL_ADDRESS;

const RPC_URL =
  process.env.RPC_URL || DEFAULT_RPC_BY_CHAIN[CHAIN] || 'http://localhost:8545';

const EXPECTED_CHAIN_ID = deployment?.chainId;

if (isPlaceholder(resolvedChannelAddress)) {
  console.error(
    `FATAL: PaymentChannel address unresolved. Set PAYMENT_CHANNEL_ADDRESS, or provide contracts/deployments/${CHAIN}.json`,
  );
  process.exit(1);
}

const CHANNEL_ADDRESS = resolvedChannelAddress as `0x${string}`;
const PRICE_PER_REQUEST = 1000n;
const MIN_CHANNEL_DEPOSIT = 1_000_000n;
const CACHE_TTL_MS = 30_000;
const DOMAIN_NAME = 'ValuePacket';
const DOMAIN_VERSION = '1';
const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd';

const PAIR_TO_COIN_ID: Record<string, string> = {
  'eth-usdc': 'ethereum',
  'btc-usdc': 'bitcoin',
};

interface ViemChannel {
  payer: `0x${string}`;
  payee: `0x${string}`;
  token: `0x${string}`;
  deposit: bigint;
  spent: bigint;
  openedAt: number;
  expiresAt: number;
  policy: `0x${string}`;
  metadata: `0x${string}`;
  status: number;
}

interface ChannelState {
  channelId: bigint;
  cumulativeSpent: bigint;
  lastNonce: bigint;
  payer: `0x${string}`;
  deposit: bigint;
}

interface PriceCacheEntry {
  data: Record<string, { usd: number }>;
  timestamp: number;
}

const publicClient = createPublicClient({
  transport: viemHttp(RPC_URL),
});

const channels: Map<string, ChannelState> = new Map();

let priceCache: PriceCacheEntry | null = null;

function channelKey(channelId: bigint): string {
  return channelId.toString();
}

function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

async function getPrice(pair: string): Promise<{ price: number; timestamp: string }> {
  const coinId = PAIR_TO_COIN_ID[pair.toLowerCase()];
  if (!coinId) {
    throw new PriceFeedError(`Unknown price pair: ${pair}`, 404);
  }

  const cached = await getCachedPrices();

  const coinData = cached[coinId];
  if (!coinData || typeof coinData.usd !== 'number') {
    throw new PriceFeedError(`Price data unavailable for ${pair}`, 503);
  }

  return {
    price: coinData.usd,
    timestamp: getCurrentTimestamp(),
  };
}

async function getCachedPrices(): Promise<Record<string, { usd: number }>> {
  const now = Date.now();

  if (priceCache && now - priceCache.timestamp < CACHE_TTL_MS) {
    return priceCache.data;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(COINGECKO_URL, { signal: controller.signal });

    if (!response.ok) {
      if (priceCache) {
        console.warn(
          `CoinGecko returned ${response.status}, serving stale cache (${((now - priceCache.timestamp) / 1000).toFixed(0)}s old)`,
        );
        return priceCache.data;
      }
      throw new PriceFeedError(`CoinGecko API returned ${response.status}`, 503);
    }

    const data = (await response.json()) as Record<string, { usd: number }>;

    priceCache = { data, timestamp: now };
    return data;
  } catch (err) {
    clearTimeout(timeout);
    if (priceCache) {
      console.warn(
        `CoinGecko fetch failed: ${err instanceof Error ? err.message : String(err)}, serving stale cache`,
      );
      return priceCache.data;
    }
    throw new PriceFeedError(
      `CoinGecko API unavailable: ${err instanceof Error ? err.message : String(err)}`,
      503,
    );
  }
}

interface PaymentHeaders {
  channelId: string;
  cumulativeSpent: string;
  nonce: string;
  proof: string;
  requestHash: string;
}

function extractPaymentHeaders(req: IncomingMessage): PaymentHeaders | null {
  const channelId = req.headers['x-channel-id'];
  const cumulativeSpent = req.headers['x-cumulative-spent'];
  const proof = req.headers['x-payment-proof'];
  const nonce = req.headers['x-request-nonce'];
  const requestHash = req.headers['x-request-hash'];

  if (!channelId || !cumulativeSpent || !proof || !nonce || !requestHash) {
    return null;
  }

  return {
    channelId: Array.isArray(channelId) ? channelId[0] : channelId,
    cumulativeSpent: Array.isArray(cumulativeSpent) ? cumulativeSpent[0] : cumulativeSpent,
    nonce: Array.isArray(nonce) ? nonce[0] : nonce,
    proof: Array.isArray(proof) ? proof[0] : proof,
    requestHash: Array.isArray(requestHash) ? requestHash[0] : requestHash,
  };
}

async function verifyAndTrackPayment(headers: PaymentHeaders): Promise<{
  channelId: bigint;
  cumulativeSpent: bigint;
}> {
  const channelId = BigInt(headers.channelId);
  const cumulativeSpent = BigInt(headers.cumulativeSpent);
  const nonce = BigInt(headers.nonce);
  const proof = headers.proof as `0x${string}`;
  const requestHash = headers.requestHash as `0x${string}`;

  const chainId = await publicClient.getChainId();

  const recoveredAddress = await recoverTypedDataAddress({
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId,
      verifyingContract: CHANNEL_ADDRESS,
    },
    types: PAYMENT_PROOF_TYPE,
    primaryType: 'PaymentProof',
    message: {
      channelId,
      cumulativeSpent,
      requestHash,
      nonce,
    },
    signature: proof,
  });

  let result: unknown;
  try {
    result = await publicClient.readContract({
      address: CHANNEL_ADDRESS,
      abi: PAYMENT_CHANNEL_ABI,
      functionName: 'getChannel',
      args: [channelId],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ChannelNotFound')) {
      throw new PriceFeedError(`Channel ${channelId.toString()} not found on-chain`, 404);
    }
    if (message.includes('reverted')) {
      throw new PriceFeedError(
        `On-chain channel lookup reverted for channel ${channelId.toString()}`,
        409,
      );
    }
    throw err;
  }

  const channel = result as unknown as ViemChannel;

  if (channel.status !== 0) {
    throw new PriceFeedError(
      `Channel ${channelId.toString()} is not open (status: ${channel.status})`,
      410,
    );
  }

  if (recoveredAddress.toLowerCase() !== channel.payer.toLowerCase()) {
    throw new PriceFeedError(
      `Signature verification failed: recovered ${recoveredAddress}, expected payer ${channel.payer}`,
      401,
    );
  }

  if (channel.deposit < MIN_CHANNEL_DEPOSIT) {
    throw new PriceFeedError(
      `Channel deposit ${channel.deposit.toString()} below minimum ${MIN_CHANNEL_DEPOSIT.toString()}`,
      402,
    );
  }

  const key = channelKey(channelId);
  const existing = channels.get(key);

  if (existing) {
    if (cumulativeSpent <= existing.cumulativeSpent) {
      throw new PriceFeedError(
        `Cumulative spent ${cumulativeSpent.toString()} not greater than previous ${existing.cumulativeSpent.toString()}`,
        409,
      );
    }

    if (nonce <= existing.lastNonce) {
      throw new PriceFeedError(
        `Nonce ${nonce.toString()} not greater than previous ${existing.lastNonce.toString()}`,
        409,
      );
    }

    existing.cumulativeSpent = cumulativeSpent;
    existing.lastNonce = nonce;
  } else {
    if (cumulativeSpent < PRICE_PER_REQUEST) {
      throw new PriceFeedError(
        `First payment ${cumulativeSpent.toString()} below price per request ${PRICE_PER_REQUEST.toString()}`,
        402,
      );
    }

    if (channel.spent >= cumulativeSpent) {
      throw new PriceFeedError(
        `Payment ${cumulativeSpent.toString()} already settled (on-chain spent: ${channel.spent.toString()})`,
        409,
      );
    }

    channels.set(key, {
      channelId,
      cumulativeSpent,
      lastNonce: nonce,
      payer: channel.payer,
      deposit: channel.deposit,
    });
  }

  return { channelId, cumulativeSpent };
}

function parseRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];

    req.on('data', (chunk: Uint8Array) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
        const buffer = Buffer.concat(chunks, totalLength);
        const raw = buffer.toString('utf-8');
        if (raw.trim().length === 0) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw));
      } catch {
        reject(new PriceFeedError('Failed to parse JSON body', 400));
      }
    });

    req.on('error', (err: Error) => {
      reject(new PriceFeedError(`Body read error: ${err.message}`, 400));
    });
  });
}

function parseUrlPath(url: string | undefined): string[] {
  if (!url) return [];
  const path = url.split('?')[0];
  return path.split('/').filter(Boolean);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString(),
  });
  res.end(body);
}

class PriceFeedError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'PriceFeedError';
  }
}

async function handleHealth(res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    status: 'ok',
    service: 'price-feed',
    version: VERSION,
  });
}

async function handlePrice(
  req: IncomingMessage,
  res: ServerResponse,
  pair: string,
): Promise<void> {
  const coinId = PAIR_TO_COIN_ID[pair.toLowerCase()];
  if (!coinId) {
    sendJson(res, 404, {
      error: `Unknown price pair: ${pair}. Supported pairs: ${Object.keys(PAIR_TO_COIN_ID).join(', ')}`,
      code: 'UNKNOWN_PAIR',
    });
    return;
  }

  const headers = extractPaymentHeaders(req);
  if (!headers) {
    sendJson(res, 400, {
      error: 'Missing payment proof headers',
      code: 'MISSING_HEADERS',
      required: [
        'X-Channel-Id',
        'X-Cumulative-Spent',
        'X-Payment-Proof',
        'X-Request-Nonce',
        'X-Request-Hash',
      ],
    });
    return;
  }

  let payment: { channelId: bigint; cumulativeSpent: bigint };
  try {
    payment = await verifyAndTrackPayment(headers);
  } catch (err) {
    if (err instanceof PriceFeedError) {
      sendJson(res, err.statusCode, { error: err.message, code: 'PAYMENT_VERIFICATION_FAILED' });
    } else {
      const isRpcError =
        err instanceof Error &&
        (err.message.includes('fetch failed') || err.message.includes('HTTP request failed'));
      sendJson(res, isRpcError ? 502 : 500, {
        error: err instanceof Error ? err.message : 'Payment verification error',
        code: isRpcError ? 'RPC_UNAVAILABLE' : 'INTERNAL_ERROR',
      });
    }
    return;
  }

  let priceData: { price: number; timestamp: string };
  try {
    priceData = await getPrice(pair);
  } catch (err) {
    if (err instanceof PriceFeedError) {
      sendJson(res, err.statusCode, { error: err.message, code: 'PRICE_FETCH_FAILED' });
    } else {
      sendJson(res, 503, {
        error: err instanceof Error ? err.message : 'Price fetch error',
        code: 'PRICE_FETCH_FAILED',
      });
    }
    return;
  }

  const amountPaid = payment.cumulativeSpent;
  const prevState = channels.get(channelKey(payment.channelId));
  const incrementPaid = prevState
    ? amountPaid - prevState.cumulativeSpent
    : amountPaid;

  console.log(
    `[${getCurrentTimestamp()}] channel=${payment.channelId.toString()} amount=${amountPaid.toString()} increment=${incrementPaid.toString()} pair=${pair} price=${priceData.price}`,
  );

  sendJson(res, 200, {
    price: priceData.price,
    timestamp: priceData.timestamp,
    source: 'coingecko',
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const pathParts = parseUrlPath(req.url);

    if (req.method === 'GET' && pathParts[0] === 'health') {
      await handleHealth(res);
      return;
    }

    if (req.method === 'POST' && pathParts[0] === 'price' && pathParts[1]) {
      await handlePrice(req, res, pathParts[1]);
      return;
    }

    if (req.method === 'POST' && pathParts[0] === 'price') {
      sendJson(res, 400, {
        error: 'Missing price pair in path. Use /price/eth-usdc or /price/btc-usdc',
        code: 'MISSING_PAIR',
      });
      return;
    }

    sendJson(res, 404, {
      error: `Not found: ${req.method} ${req.url}`,
      code: 'NOT_FOUND',
      availableEndpoints: [
        'GET /health',
        'POST /price/eth-usdc',
        'POST /price/btc-usdc',
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error(`[${getCurrentTimestamp()}] Unhandled error:`, message);
    sendJson(res, 500, { error: message, code: 'INTERNAL_ERROR' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Price Feed Agent v${VERSION}`);
  console.log(`  Listening on http://0.0.0.0:${PORT}`);
  console.log(`  Chain: ${CHAIN}${EXPECTED_CHAIN_ID ? ` (chainId ${EXPECTED_CHAIN_ID})` : ''}`);
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Channel contract: ${CHANNEL_ADDRESS}`);
  console.log(`  Price per request: ${PRICE_PER_REQUEST.toString()} (USDC wei)`);
  console.log(`  Min channel deposit: ${MIN_CHANNEL_DEPOSIT.toString()} (USDC wei)`);
  console.log(`  Cache TTL: ${CACHE_TTL_MS}ms\n`);

  void verifyChainConnection();
});

async function verifyChainConnection(): Promise<void> {
  try {
    const chainId = await publicClient.getChainId();
    if (EXPECTED_CHAIN_ID && chainId !== EXPECTED_CHAIN_ID) {
      console.error(
        `FATAL: RPC chainId ${chainId} does not match deployment chainId ${EXPECTED_CHAIN_ID} for '${CHAIN}'`,
      );
      process.exit(1);
    }
    const code = await publicClient.getBytecode({ address: CHANNEL_ADDRESS });
    if (!code || code === '0x') {
      console.error(
        `FATAL: no contract bytecode at ${CHANNEL_ADDRESS} on chainId ${chainId}`,
      );
      process.exit(1);
    }
    console.log(
      `[${getCurrentTimestamp()}] connected: chainId=${chainId} channel bytecode=${((code.length - 2) / 2).toString()}B`,
    );
  } catch (err) {
    console.error(
      `FATAL: cannot reach RPC ${RPC_URL}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

function shutdown() {
  console.log('\nShutting down...');
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
