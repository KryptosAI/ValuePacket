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
const PRICE_PER_REQUEST = 100_000n;
const MIN_CHANNEL_DEPOSIT = 1_000_000n;
const CACHE_TTL_MS = 10_000;
const MIN_LIQUIDITY_USD = 10_000;
const MAX_OPPORTUNITIES = 3;
const DOMAIN_NAME = 'ValuePacket';
const DOMAIN_VERSION = '1';
const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/search';

const CHAIN_ID_TO_PLATFORM: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avalanche',
  59144: 'linea',
  534352: 'scroll',
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

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { symbol: string };
  quoteToken: { symbol: string };
  priceUsd: string;
  liquidity: { usd: number };
}

interface DexScreenerResponse {
  pairs: DexPair[] | null;
}

interface ScanCacheEntry {
  data: DexPair[];
  timestamp: number;
}

interface ScanRequestBody {
  pair: string;
  chainId?: number;
}

interface Opportunity {
  buyDex: string;
  sellDex: string;
  buyPrice: string;
  sellPrice: string;
  spreadPct: number;
  estimatedProfit: string;
}

interface ScanResponse {
  pair: string;
  chainId: number;
  scannedAt: string;
  opportunities: Opportunity[];
}

const publicClient = createPublicClient({
  transport: viemHttp(RPC_URL),
});

const channels: Map<string, ChannelState> = new Map();

const scanCache: Map<string, ScanCacheEntry> = new Map();

function channelKey(channelId: bigint): string {
  return channelId.toString();
}

function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

function tokenMatches(symbol: string, target: string): boolean {
  const s = symbol.toUpperCase();
  const t = target.toUpperCase();
  if (s === t) return true;
  if (t === 'ETH' && (s === 'WETH' || s === 'ETH')) return true;
  if (t === 'BTC' && (s === 'WBTC' || s === 'BTC')) return true;
  return false;
}

async function fetchDexScreener(query: string): Promise<DexPair[]> {
  const now = Date.now();
  const cached = scanCache.get(query);

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const url = `${DEXSCREENER_URL}?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      if (cached) {
        console.warn(
          `DexScreener returned ${response.status}, serving stale cache (${((now - cached.timestamp) / 1000).toFixed(0)}s old)`,
        );
        return cached.data;
      }
      throw new MevScannerError(`DexScreener API returned ${response.status}`, 503);
    }

    const data = (await response.json()) as DexScreenerResponse;

    if (!data.pairs || !Array.isArray(data.pairs)) {
      if (cached) {
        console.warn('DexScreener returned empty/malformed response, serving stale cache');
        return cached.data;
      }
      return [];
    }

    scanCache.set(query, { data: data.pairs, timestamp: now });
    return data.pairs;
  } catch (err) {
    clearTimeout(timeout);
    if (cached) {
      console.warn(
        `DexScreener fetch failed: ${err instanceof Error ? err.message : String(err)}, serving stale cache`,
      );
      return cached.data;
    }
    throw new MevScannerError(
      `DexScreener API unavailable: ${err instanceof Error ? err.message : String(err)}`,
      503,
    );
  }
}

function computeOpportunities(
  pairs: DexPair[],
  [baseSymbol, quoteSymbol]: [string, string],
): Opportunity[] {
  const seen = new Set<string>();
  const filtered: DexPair[] = [];

  for (const p of pairs) {
    const dexPairKey = `${p.dexId}:${p.pairAddress}`;
    if (seen.has(dexPairKey)) continue;
    seen.add(dexPairKey);

    if (!tokenMatches(p.baseToken.symbol, baseSymbol)) continue;
    if (!tokenMatches(p.quoteToken.symbol, quoteSymbol)) continue;

    const liq = p.liquidity?.usd ?? 0;
    if (liq < MIN_LIQUIDITY_USD) continue;

    const price = parseFloat(p.priceUsd);
    if (isNaN(price) || price <= 0) continue;

    filtered.push(p);
  }

  if (filtered.length < 2) return [];

  filtered.sort((a, b) => parseFloat(a.priceUsd) - parseFloat(b.priceUsd));

  const opportunities: Opportunity[] = [];

  for (let i = 0; i < filtered.length - 1 && opportunities.length < MAX_OPPORTUNITIES; i++) {
    for (let j = filtered.length - 1; j > i && opportunities.length < MAX_OPPORTUNITIES; j--) {
      const buy = filtered[i];
      const sell = filtered[j];

      const buyPrice = parseFloat(buy.priceUsd);
      const sellPrice = parseFloat(sell.priceUsd);

      if (sellPrice <= buyPrice) continue;

      const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
      const profit = sellPrice - buyPrice;

      if (spreadPct <= 0.001) continue;

      opportunities.push({
        buyDex: buy.dexId,
        sellDex: sell.dexId,
        buyPrice: buyPrice.toFixed(2),
        sellPrice: sellPrice.toFixed(2),
        spreadPct: Math.round(spreadPct * 1000) / 1000,
        estimatedProfit: profit.toFixed(2),
      });
    }
  }

  opportunities.sort((a, b) => b.spreadPct - a.spreadPct);

  return opportunities.slice(0, MAX_OPPORTUNITIES);
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
      throw new MevScannerError(`Channel ${channelId.toString()} not found on-chain`, 404);
    }
    if (message.includes('reverted')) {
      throw new MevScannerError(
        `On-chain channel lookup reverted for channel ${channelId.toString()}`,
        409,
      );
    }
    throw err;
  }

  const channel = result as unknown as ViemChannel;

  if (channel.status !== 0) {
    throw new MevScannerError(
      `Channel ${channelId.toString()} is not open (status: ${channel.status})`,
      410,
    );
  }

  if (recoveredAddress.toLowerCase() !== channel.payer.toLowerCase()) {
    throw new MevScannerError(
      `Signature verification failed: recovered ${recoveredAddress}, expected payer ${channel.payer}`,
      401,
    );
  }

  if (channel.deposit < MIN_CHANNEL_DEPOSIT) {
    throw new MevScannerError(
      `Channel deposit ${channel.deposit.toString()} below minimum ${MIN_CHANNEL_DEPOSIT.toString()}`,
      402,
    );
  }

  const key = channelKey(channelId);
  const existing = channels.get(key);

  if (existing) {
    if (cumulativeSpent <= existing.cumulativeSpent) {
      throw new MevScannerError(
        `Cumulative spent ${cumulativeSpent.toString()} not greater than previous ${existing.cumulativeSpent.toString()}`,
        409,
      );
    }

    if (nonce <= existing.lastNonce) {
      throw new MevScannerError(
        `Nonce ${nonce.toString()} not greater than previous ${existing.lastNonce.toString()}`,
        409,
      );
    }

    existing.cumulativeSpent = cumulativeSpent;
    existing.lastNonce = nonce;
  } else {
    if (cumulativeSpent < PRICE_PER_REQUEST) {
      throw new MevScannerError(
        `First payment ${cumulativeSpent.toString()} below price per request ${PRICE_PER_REQUEST.toString()}`,
        402,
      );
    }

    if (channel.spent >= cumulativeSpent) {
      throw new MevScannerError(
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
        reject(new MevScannerError('Failed to parse JSON body', 400));
      }
    });

    req.on('error', (err: Error) => {
      reject(new MevScannerError(`Body read error: ${err.message}`, 400));
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

class MevScannerError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'MevScannerError';
  }
}

async function handleHealth(res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    status: 'ok',
    service: 'mev-scanner',
    version: VERSION,
  });
}

function parsePair(pair: string): [string, string] | null {
  const trimmed = pair.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return [parts[0].trim(), parts[1].trim()];
  }

  const dashParts = trimmed.split('-');
  if (dashParts.length === 2 && dashParts[0] && dashParts[1]) {
    return [dashParts[0].trim(), dashParts[1].trim()];
  }

  return null;
}

async function handleScan(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await parseRequestBody(req);
  } catch (err) {
    if (err instanceof MevScannerError) {
      sendJson(res, err.statusCode, { error: err.message, code: 'INVALID_BODY' });
    }
    return;
  }

  const raw = body as ScanRequestBody;

  if (!raw.pair || typeof raw.pair !== 'string') {
    sendJson(res, 400, {
      error: 'Missing or invalid "pair" field in request body',
      code: 'MISSING_PAIR',
      example: { pair: 'ETH/USDC', chainId: 8453 },
    });
    return;
  }

  const pairTokens = parsePair(raw.pair);
  if (!pairTokens) {
    sendJson(res, 400, {
      error: `Invalid pair format "${raw.pair}". Use format "ETH/USDC" or "ETH-USDC"`,
      code: 'INVALID_PAIR_FORMAT',
    });
    return;
  }

  const chainId = raw.chainId ?? 8453;
  const platform = CHAIN_ID_TO_PLATFORM[chainId];
  if (!platform) {
    sendJson(res, 400, {
      error: `Unsupported chainId: ${chainId}. Supported: ${Object.keys(CHAIN_ID_TO_PLATFORM).join(', ')}`,
      code: 'UNSUPPORTED_CHAIN',
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
    if (err instanceof MevScannerError) {
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

  let pairs: DexPair[];
  try {
    pairs = await fetchDexScreener(raw.pair);
  } catch (err) {
    if (err instanceof MevScannerError) {
      sendJson(res, err.statusCode, { error: err.message, code: 'DEXSCREENER_UNAVAILABLE' });
    } else {
      sendJson(res, 503, {
        error: err instanceof Error ? err.message : 'DEX API error',
        code: 'DEXSCREENER_UNAVAILABLE',
      });
    }
    return;
  }

  const chainFiltered = pairs.filter(
    (p) => p.chainId.toLowerCase() === platform,
  );

  const opportunities = computeOpportunities(chainFiltered, pairTokens);

  const scannedAt = getCurrentTimestamp();
  const response: ScanResponse = {
    pair: raw.pair,
    chainId,
    scannedAt,
    opportunities,
  };

  const amountPaid = payment.cumulativeSpent;
  const prevState = channels.get(channelKey(payment.channelId));
  const incrementPaid = prevState
    ? amountPaid - prevState.cumulativeSpent
    : amountPaid;

  console.log(
    `[${scannedAt}] channel=${payment.channelId.toString()} amount=${amountPaid.toString()} increment=${incrementPaid.toString()} pair=${raw.pair} chainId=${chainId} opportunities=${opportunities.length}`,
  );

  sendJson(res, 200, response);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const pathParts = parseUrlPath(req.url);

    if (req.method === 'GET' && pathParts[0] === 'health') {
      await handleHealth(res);
      return;
    }

    if (req.method === 'POST' && pathParts[0] === 'scan') {
      await handleScan(req, res);
      return;
    }

    sendJson(res, 404, {
      error: `Not found: ${req.method} ${req.url}`,
      code: 'NOT_FOUND',
      availableEndpoints: [
        'GET /health',
        'POST /scan',
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error(`[${getCurrentTimestamp()}] Unhandled error:`, message);
    sendJson(res, 500, { error: message, code: 'INTERNAL_ERROR' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  MEV Scanner Agent v${VERSION}`);
  console.log(`  Listening on http://0.0.0.0:${PORT}`);
  console.log(`  Chain: ${CHAIN}${EXPECTED_CHAIN_ID ? ` (chainId ${EXPECTED_CHAIN_ID})` : ''}`);
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Channel contract: ${CHANNEL_ADDRESS}`);
  console.log(`  Price per request: ${PRICE_PER_REQUEST.toString()} (USDC wei)`);
  console.log(`  Min channel deposit: ${MIN_CHANNEL_DEPOSIT.toString()} (USDC wei)`);
  console.log(`  Cache TTL: ${CACHE_TTL_MS}ms`);
  console.log(`  Min liquidity: $${MIN_LIQUIDITY_USD.toLocaleString()}`);
  console.log(`  Data source: DexScreener (free tier)\n`);

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
