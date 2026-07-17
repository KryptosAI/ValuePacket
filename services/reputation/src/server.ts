import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPublicClient, http as viemHttp } from 'viem';
import type { Rating, ReputationScore } from './score.js';
import { computeScore } from './score.js';

const VERSION = '0.2.2';
const PORT = parseInt(process.env.PORT || '3003', 10);
const CHAIN = process.env.CHAIN || 'base-sepolia';
const CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_RPC_BY_CHAIN: Record<string, string> = {
  'base-sepolia': 'https://sepolia.base.org',
  local: 'http://localhost:8545',
};

const AGENT_REPUTATION_ABI = [
  {
    type: 'function',
    name: 'getRatings',
    inputs: [{ name: 'provider', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: 'ratings',
        type: 'tuple[]',
        internalType: 'struct AgentReputation.Rating[]',
        components: [
          { name: 'uid', type: 'bytes32', internalType: 'bytes32' },
          { name: 'attester', type: 'address', internalType: 'address' },
          { name: 'score', type: 'uint256', internalType: 'uint256' },
          { name: 'timestamp', type: 'uint256', internalType: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAllProviders',
    inputs: [],
    outputs: [{ name: 'providers', type: 'address[]', internalType: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'ratingCount',
    inputs: [{ name: 'provider', type: 'address', internalType: 'address' }],
    outputs: [{ name: 'count', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

interface DeploymentFile {
  chainId?: number;
  agentReputation?: string;
}

interface OnChainRating {
  uid: `0x${string}`;
  attester: `0x${string}`;
  score: bigint;
  timestamp: bigint;
}

interface CacheEntry {
  score: ReputationScore;
  cachedAt: number;
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

const resolvedReputationAddress =
  isPlaceholder(process.env.AGENT_REPUTATION_ADDRESS)
    ? deployment?.agentReputation
    : process.env.AGENT_REPUTATION_ADDRESS;

const RPC_URL =
  process.env.RPC_URL || DEFAULT_RPC_BY_CHAIN[CHAIN] || 'http://localhost:8545';

const EXPECTED_CHAIN_ID = deployment?.chainId;

const contractAvailable = !isPlaceholder(resolvedReputationAddress);
const REPUTATION_ADDRESS = (resolvedReputationAddress ?? '0x') as `0x${string}`;

const publicClient = contractAvailable
  ? createPublicClient({ transport: viemHttp(RPC_URL) })
  : null;

const scoreCache: Map<string, CacheEntry> = new Map();

function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

function normalizeAddress(raw: string): `0x${string}` {
  if (!raw.startsWith('0x') || raw.length !== 42) {
    throw new ReputationError(`Invalid address: ${raw}`, 400);
  }
  return raw.toLowerCase() as `0x${string}`;
}

async function fetchRatings(provider: `0x${string}`): Promise<Rating[]> {
  if (!publicClient || !contractAvailable) {
    return [];
  }

  try {
    const raw = await publicClient.readContract({
      address: REPUTATION_ADDRESS,
      abi: AGENT_REPUTATION_ABI,
      functionName: 'getRatings',
      args: [provider],
    });

    const ratings = raw as unknown as OnChainRating[];
    return ratings.map((r) => ({
      score: Number(r.score),
      timestamp: Number(r.timestamp) * 1000,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${getCurrentTimestamp()}] RPC read error for ${provider}: ${message}`);
    return [];
  }
}

async function getAllProviders(): Promise<`0x${string}`[]> {
  if (!publicClient || !contractAvailable) {
    return [];
  }

  try {
    const raw = await publicClient.readContract({
      address: REPUTATION_ADDRESS,
      abi: AGENT_REPUTATION_ABI,
      functionName: 'getAllProviders',
      args: [],
    });
    return (raw as `0x${string}`[]).map((a) => a.toLowerCase() as `0x${string}`);
  } catch {
    return [];
  }
}

async function getScore(provider: `0x${string}`): Promise<ReputationScore> {
  const key = provider.toLowerCase();
  const cached = scoreCache.get(key);

  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.score;
  }

  const ratings = await fetchRatings(provider);
  const score = computeScore(ratings);

  scoreCache.set(key, { score, cachedAt: Date.now() });
  return score;
}

function parseUrlPath(url: string | undefined): string[] {
  if (!url) return [];
  const path = url.split('?')[0];
  return path.split('/').filter(Boolean);
}

function parseQueryParams(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const query = url.split('?')[1] || '';
  return new URLSearchParams(query);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString(),
  });
  res.end(body);
}

class ReputationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ReputationError';
  }
}

async function handleHealth(res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    status: 'ok',
    service: 'reputation',
    version: VERSION,
    contractAvailable,
    chain: CHAIN,
  });
}

async function handleScore(
  res: ServerResponse,
  provider: string,
): Promise<void> {
  let address: `0x${string}`;
  try {
    address = normalizeAddress(provider);
  } catch (err) {
    if (err instanceof ReputationError) {
      sendJson(res, err.statusCode, { error: err.message, code: 'INVALID_ADDRESS' });
    }
    return;
  }

  const score = await getScore(address);

  console.log(
    `[${getCurrentTimestamp()}] score provider=${address} avg=${score.weightedScore} ratings=${score.totalRatings}`,
  );

  sendJson(res, 200, {
    provider: address,
    ...score,
  });
}

async function handleScores(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const params = parseQueryParams(req.url);
  const raw = params.get('providers');

  if (!raw) {
    sendJson(res, 400, {
      error: 'Missing ?providers= query parameter',
      code: 'MISSING_PROVIDERS',
    });
    return;
  }

  const addresses = raw.split(',').map((a) => a.trim());
  if (addresses.length === 0 || addresses.length > 50) {
    sendJson(res, 400, {
      error: 'Provide 1-50 comma-separated provider addresses',
      code: 'INVALID_PROVIDERS',
    });
    return;
  }

  const results: Record<string, ReputationScore> = {};
  const errors: Record<string, string> = {};

  for (const addr of addresses) {
    try {
      const normalized = normalizeAddress(addr);
      results[normalized] = await getScore(normalized);
    } catch (err) {
      errors[addr] = err instanceof Error ? err.message : 'Invalid address';
    }
  }

  console.log(
    `[${getCurrentTimestamp()}] scores batch=${Object.keys(results).length} errors=${Object.keys(errors).length}`,
  );

  sendJson(res, 200, { scores: results, ...(Object.keys(errors).length > 0 ? { errors } : {}) });
}

async function handleTop(res: ServerResponse, limit: number): Promise<void> {
  if (limit < 1 || limit > 100) {
    limit = 10;
  }

  const providers = await getAllProviders();

  if (providers.length === 0) {
    sendJson(res, 200, { top: [], note: 'No providers indexed on-chain' });
    return;
  }

  const scored: Array<{ provider: string } & ReputationScore> = [];

  for (const addr of providers) {
    const score = await getScore(addr);
    scored.push({ provider: addr, ...score });
  }

  scored.sort((a, b) => {
    const aScore = a.weightedScore ?? a.averageScore ?? 0;
    const bScore = b.weightedScore ?? b.averageScore ?? 0;
    return bScore - aScore;
  });

  const top = scored.slice(0, limit);

  console.log(
    `[${getCurrentTimestamp()}] top limit=${limit} total=${scored.length}`,
  );

  sendJson(res, 200, { top });
}

export const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const pathParts = parseUrlPath(req.url);

    if (req.method === 'GET' && pathParts[0] === 'health') {
      await handleHealth(res);
      return;
    }

    if (req.method === 'GET' && pathParts[0] === 'score' && pathParts[1]) {
      await handleScore(res, pathParts[1]);
      return;
    }

    if (req.method === 'GET' && pathParts[0] === 'scores') {
      await handleScores(req, res);
      return;
    }

    if (req.method === 'GET' && pathParts[0] === 'top') {
      const params = parseQueryParams(req.url);
      const limit = parseInt(params.get('limit') || '10', 10);
      await handleTop(res, Number.isFinite(limit) ? limit : 10);
      return;
    }

    sendJson(res, 404, {
      error: `Not found: ${req.method} ${req.url}`,
      code: 'NOT_FOUND',
      availableEndpoints: [
        'GET /health',
        'GET /score/{provider}',
        'GET /scores?providers=0x...,0x...',
        'GET /top?limit=10',
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error(`[${getCurrentTimestamp()}] Unhandled error:`, message);
    try {
      sendJson(res, 500, { error: message, code: 'INTERNAL_ERROR' });
    } catch {
      // headers may already be sent
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n  Agent Reputation Service v${VERSION}`);
  console.log(`  Listening on http://0.0.0.0:${PORT}`);
  console.log(`  Chain: ${CHAIN}${EXPECTED_CHAIN_ID ? ` (chainId ${EXPECTED_CHAIN_ID})` : ''}`);
  console.log(`  RPC: ${RPC_URL}`);
  if (contractAvailable) {
    console.log(`  AgentReputation contract: ${REPUTATION_ADDRESS}`);
  } else {
    console.log(`  AgentReputation contract: NOT CONFIGURED (set AGENT_REPUTATION_ADDRESS or add agentReputation to contracts/deployments/${CHAIN}.json)`);
  }
  console.log(`  Cache TTL: ${CACHE_TTL_MS}ms\n`);

  if (contractAvailable) {
    void verifyChainConnection();
  }
});

async function verifyChainConnection(): Promise<void> {
  if (!publicClient) return;

  try {
    const chainId = await publicClient.getChainId();
    if (EXPECTED_CHAIN_ID && chainId !== EXPECTED_CHAIN_ID) {
      console.error(
        `FATAL: RPC chainId ${chainId} does not match deployment chainId ${EXPECTED_CHAIN_ID} for '${CHAIN}'`,
      );
      process.exit(1);
    }
    const code = await publicClient.getBytecode({ address: REPUTATION_ADDRESS });
    if (!code || code === '0x') {
      console.warn(
        `WARNING: no contract bytecode at ${REPUTATION_ADDRESS} on chainId ${chainId} — serving 503 for queries`,
      );
    } else {
      console.log(
        `[${getCurrentTimestamp()}] connected: chainId=${chainId} contract bytecode=${((code.length - 2) / 2).toString()}B`,
      );
    }
  } catch (err) {
    console.warn(
      `WARNING: cannot reach RPC ${RPC_URL}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
