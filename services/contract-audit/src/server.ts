import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { recoverTypedDataAddress, createPublicClient, http as viemHttp } from 'viem';
import { PAYMENT_PROOF_TYPE, PAYMENT_CHANNEL_ABI } from '@valuepacket/sdk';

const VERSION = '0.2.1';
const PORT = parseInt(process.env.PORT || '3001', 10);
const CHAIN = process.env.CHAIN || 'base-sepolia';

const DEFAULT_RPC_BY_CHAIN: Record<string, string> = {
  'base-sepolia': 'https://sepolia.base.org',
  local: 'http://localhost:8545',
};

const EXPLORER_BY_CHAIN_ID: Record<number, string> = {
  1: 'https://api.etherscan.io',
  11155111: 'https://api-sepolia.etherscan.io',
  8453: 'https://api.basescan.org',
  84532: 'https://api-sepolia.basescan.org',
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
const PRICE_PER_REQUEST = 2_000_000n;
const MIN_CHANNEL_DEPOSIT = 5_000_000n;
const CACHE_TTL_MS = 3_600_000;
const DOMAIN_NAME = 'ValuePacket';
const DOMAIN_VERSION = '1';

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

interface Finding {
  severity: 'high' | 'medium' | 'low' | 'info';
  description: string;
  line: number;
}

interface AuditResult {
  address: string;
  chain: number;
  verified: boolean;
  riskScore: number;
  findings: Finding[];
  summary: string;
}

interface CacheEntry {
  result: AuditResult;
  timestamp: number;
}

const publicClient = createPublicClient({
  transport: viemHttp(RPC_URL),
});

const channels: Map<string, ChannelState> = new Map();
const auditCache: Map<string, CacheEntry> = new Map();

function channelKey(channelId: bigint): string {
  return channelId.toString();
}

function cacheKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

const severityScore: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
  info: 0.5,
};

function calculateRiskScore(findings: Finding[]): number {
  const raw = findings.reduce((sum, f) => sum + (severityScore[f.severity] ?? 0), 0);
  return Math.min(raw, 10);
}

function findLine(source: string, pattern: string): number {
  const idx = source.indexOf(pattern);
  if (idx === -1) return 0;
  return source.slice(0, idx).split('\n').length;
}

async function fetchSourceCode(chainId: number, address: string): Promise<string> {
  const baseUrl = EXPLORER_BY_CHAIN_ID[chainId];
  if (!baseUrl) {
    throw new AuditError(`No block explorer configured for chain ${chainId}`, 400);
  }

  let apiKey = '';
  if (chainId === 1 || chainId === 11155111) {
    apiKey = process.env.ETHERSCAN_API_KEY ?? '';
  } else if (chainId === 8453 || chainId === 84532) {
    apiKey = process.env.BASESCAN_API_KEY ?? '';
  }

  const keyParam = apiKey ? `&apikey=${apiKey}` : '';
  const url = `${baseUrl}/api?module=contract&action=getsourcecode&address=${address}${keyParam}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new AuditError(`Explorer API returned ${response.status}`, 502);
    }

    const data = (await response.json()) as {
      status: string;
      message: string;
      result: Array<{
        SourceCode: string;
        ABI: string;
        ContractName: string;
        CompilerVersion: string;
        OptimizationUsed: string;
        Runs: string;
        ConstructorArguments: string;
        EVMVersion: string;
        Library: string;
        LicenseType: string;
        Proxy: string;
        Implementation: string;
        SwarmSource: string;
      }>;
    };

    if (data.status !== '1') {
      throw new AuditError(
        `Explorer API error: ${data.message || 'Contract not verified or not found'}`,
        404,
      );
    }

    const result = data.result[0];
    if (!result) {
      throw new AuditError(`No result for address ${address}`, 404);
    }

    if (result.Proxy !== '0' && result.Implementation) {
      throw new AuditError(
        `Contract ${address} is a proxy. Provide the implementation address ${result.Implementation} for a full audit.`,
        422,
      );
    }

    const sourceCode = result.SourceCode;
    if (!sourceCode || sourceCode.trim() === '') {
      throw new AuditError(`No source code available for ${address}`, 404);
    }

    if (sourceCode.startsWith('{{') || sourceCode.startsWith('{')) {
      try {
        const parsed = JSON.parse(sourceCode.slice(1, -1) || sourceCode);
        if (parsed.sources) {
          return Object.entries(parsed.sources)
            .map(([name, src]: [string, unknown]) => {
              const content = (src as { content?: string }).content ?? '';
              return `// File: ${name}\n${content}`;
            })
            .join('\n\n');
        }
      } catch {
        // not JSON-wrapped, use as-is
      }
    }

    return sourceCode;
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof AuditError) throw err;
    throw new AuditError(
      `Failed to fetch source from explorer: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
}

function hasStateChangingFunctions(source: string): boolean {
  const funcPattern = /\bfunction\s+\w+\s*\([^)]*\)\s*([\s\S]*?)\{/g;
  let match: RegExpExecArray | null;
  while ((match = funcPattern.exec(source)) !== null) {
    const signature = match[0];
    if (/\bexternal\b/.test(signature) || /\bpublic\b/.test(signature)) {
      if (!/\bview\b/.test(signature) && !/\bpure\b/.test(signature)) {
        return true;
      }
    }
  }
  return false;
}

function analyzeSolidity(source: string): Finding[] {
  const findings: Finding[] = [];

  if (source.includes('selfdestruct')) {
    findings.push({
      severity: 'high',
      description: 'Contains selfdestruct — contract can be destroyed, potentially losing all funds',
      line: findLine(source, 'selfdestruct'),
    });
  }

  if (source.includes('tx.origin')) {
    findings.push({
      severity: 'high',
      description: 'Uses tx.origin for authorization — vulnerable to phishing attacks',
      line: findLine(source, 'tx.origin'),
    });
  }

  if (source.includes('call{value:') || source.includes('call{ value:')) {
    findings.push({
      severity: 'high',
      description: 'Contains low-level call with value — potentially unchecked external call that could drain funds',
      line: findLine(source, 'call{'),
    });
  }

  if (source.includes('delegatecall')) {
    findings.push({
      severity: 'medium',
      description: 'Contains delegatecall — can execute arbitrary code in contract context',
      line: findLine(source, 'delegatecall'),
    });
  }

  if (source.includes('bytes calldata') && /\bexternal\b/.test(source)) {
    findings.push({
      severity: 'medium',
      description: 'Accepts arbitrary bytes calldata in external function — could enable unauthorized calls',
      line: findLine(source, 'bytes calldata'),
    });
  }

  if (source.includes('assembly')) {
    findings.push({
      severity: 'medium',
      description: 'Contains inline assembly block — bypasses Solidity safety checks and type system',
      line: findLine(source, 'assembly'),
    });
  }

  if (!source.includes('nonReentrant') && hasStateChangingFunctions(source)) {
    findings.push({
      severity: 'medium',
      description: 'Missing nonReentrant modifier on state-changing external/public functions — vulnerable to reentrancy attacks',
      line: 0,
    });
  }

  if (/\bblock\.timestamp\b/.test(source)) {
    findings.push({
      severity: 'low',
      description: 'Uses block.timestamp — can be manipulated by miners within ~15 seconds',
      line: findLine(source, 'block.timestamp'),
    });
  }

  if (/\bblockhash\b/.test(source)) {
    findings.push({
      severity: 'low',
      description: 'Uses blockhash for randomness — predictable and manipulable',
      line: findLine(source, 'blockhash'),
    });
  }

  if (source.includes('onlyOwner')) {
    findings.push({
      severity: 'low',
      description: 'Uses onlyOwner modifier — centralized control risk',
      line: findLine(source, 'onlyOwner'),
    });
  }

  if (/\btransfer\s*\(/.test(source) || /\.transfer\(/.test(source)) {
    findings.push({
      severity: 'low',
      description: 'Uses .transfer() for ETH — fixed 2300 gas stipend may fail with evolving gas costs',
      line: findLine(source, 'transfer('),
    });
  }

  if (/\bextcodesize\b/.test(source)) {
    findings.push({
      severity: 'low',
      description: 'Uses extcodesize to check if address is a contract — unreliable (contract in constructor returns 0)',
      line: findLine(source, 'extcodesize'),
    });
  }

  const dcCount = (source.match(/delegatecall/g) || []).length;
  if (dcCount >= 2) {
    findings.push({
      severity: 'info',
      description: `Possible proxy pattern detected (${dcCount} delegatecall uses)`,
      line: 0,
    });
  }

  // sort by severity: high > medium > low > info
  const order: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  return findings;
}

function buildSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings detected';
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  return `${findings.length} finding${findings.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

class AuditError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AuditError';
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
      throw new AuditError(`Channel ${channelId.toString()} not found on-chain`, 404);
    }
    if (message.includes('reverted')) {
      throw new AuditError(
        `On-chain channel lookup reverted for channel ${channelId.toString()}`,
        409,
      );
    }
    throw err;
  }

  const channel = result as unknown as ViemChannel;

  if (channel.status !== 0) {
    throw new AuditError(
      `Channel ${channelId.toString()} is not open (status: ${channel.status})`,
      410,
    );
  }

  if (recoveredAddress.toLowerCase() !== channel.payer.toLowerCase()) {
    throw new AuditError(
      `Signature verification failed: recovered ${recoveredAddress}, expected payer ${channel.payer}`,
      401,
    );
  }

  if (channel.deposit < MIN_CHANNEL_DEPOSIT) {
    throw new AuditError(
      `Channel deposit ${channel.deposit.toString()} below minimum ${MIN_CHANNEL_DEPOSIT.toString()}`,
      402,
    );
  }

  const key = channelKey(channelId);
  const existing = channels.get(key);

  if (existing) {
    if (cumulativeSpent <= existing.cumulativeSpent) {
      throw new AuditError(
        `Cumulative spent ${cumulativeSpent.toString()} not greater than previous ${existing.cumulativeSpent.toString()}`,
        409,
      );
    }

    if (nonce <= existing.lastNonce) {
      throw new AuditError(
        `Nonce ${nonce.toString()} not greater than previous ${existing.lastNonce.toString()}`,
        409,
      );
    }

    existing.cumulativeSpent = cumulativeSpent;
    existing.lastNonce = nonce;
  } else {
    if (cumulativeSpent < PRICE_PER_REQUEST) {
      throw new AuditError(
        `First payment ${cumulativeSpent.toString()} below price per request ${PRICE_PER_REQUEST.toString()}`,
        402,
      );
    }

    if (channel.spent >= cumulativeSpent) {
      throw new AuditError(
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
        reject(new AuditError('Failed to parse JSON body', 400));
      }
    });

    req.on('error', (err: Error) => {
      reject(new AuditError(`Body read error: ${err.message}`, 400));
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

async function handleHealth(res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    status: 'ok',
    service: 'contract-audit',
    version: VERSION,
  });
}

async function handleAudit(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
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
    if (err instanceof AuditError) {
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

  let body: unknown;
  try {
    body = await parseRequestBody(req);
  } catch (err) {
    if (err instanceof AuditError) {
      sendJson(res, err.statusCode, { error: err.message, code: 'INVALID_BODY' });
    } else {
      sendJson(res, 400, { error: 'Invalid request body', code: 'INVALID_BODY' });
    }
    return;
  }

  const data = body as Record<string, unknown>;
  const chainId = Number(data.chainId);
  const address = String(data.address || '');

  if (!chainId || !address || !address.startsWith('0x') || address.length !== 42) {
    sendJson(res, 400, {
      error: 'Request body must include { chainId: number, address: "0x..." }',
      code: 'INVALID_PARAMS',
    });
    return;
  }

  const cKey = cacheKey(chainId, address);

  const cached = auditCache.get(cKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    const amountPaid = payment.cumulativeSpent;
    const prevState = channels.get(channelKey(payment.channelId));
    const incrementPaid = prevState
      ? amountPaid - prevState.cumulativeSpent
      : amountPaid;

    console.log(
      `[${getCurrentTimestamp()}] CACHE_HIT channel=${payment.channelId.toString()} amount=${amountPaid.toString()} increment=${incrementPaid.toString()} chain=${chainId} address=${address}`,
    );

    sendJson(res, 200, cached.result);
    return;
  }

  let sourceCode = '';
  let verified = false;
  let findings: Finding[] = [];

  try {
    sourceCode = await fetchSourceCode(chainId, address);
    verified = true;
  } catch (err) {
    if (err instanceof AuditError && err.statusCode === 404) {
      verified = false;
      findings = [
        {
          severity: 'high',
          description: `Contract ${address} is not verified on chain ${chainId}`,
          line: 0,
        },
      ];
    } else {
      if (err instanceof AuditError) {
        sendJson(res, err.statusCode, { error: err.message, code: 'SOURCE_FETCH_FAILED' });
      } else {
        sendJson(res, 502, {
          error: err instanceof Error ? err.message : 'Source fetch error',
          code: 'SOURCE_FETCH_FAILED',
        });
      }
      return;
    }
  }

  if (verified) {
    findings = analyzeSolidity(sourceCode);
  }

  const riskScore = calculateRiskScore(findings);
  const summary = buildSummary(findings);

  const auditResult: AuditResult = {
    address,
    chain: chainId,
    verified,
    riskScore,
    findings,
    summary,
  };

  auditCache.set(cKey, { result: auditResult, timestamp: Date.now() });

  const amountPaid = payment.cumulativeSpent;
  const prevState = channels.get(channelKey(payment.channelId));
  const incrementPaid = prevState
    ? amountPaid - prevState.cumulativeSpent
    : amountPaid;

  console.log(
    `[${getCurrentTimestamp()}] channel=${payment.channelId.toString()} amount=${amountPaid.toString()} increment=${incrementPaid.toString()} chain=${chainId} address=${address} verified=${verified} score=${riskScore} findings=${findings.length}`,
  );

  sendJson(res, 200, auditResult);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const pathParts = parseUrlPath(req.url);

    if (req.method === 'GET' && pathParts[0] === 'health') {
      await handleHealth(res);
      return;
    }

    if (req.method === 'POST' && pathParts[0] === 'audit') {
      await handleAudit(req, res);
      return;
    }

    sendJson(res, 404, {
      error: `Not found: ${req.method} ${req.url}`,
      code: 'NOT_FOUND',
      availableEndpoints: ['GET /health', 'POST /audit'],
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
  console.log(`\n  Contract Audit Agent v${VERSION}`);
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
