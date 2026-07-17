/** EAS-based agent reputation attestation module for the ValuePacket protocol.
 *  Allows payers to attest to service quality after a payment channel closes.
 */

import {
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  decodeEventLog,
  pad,
  toHex,
} from 'viem';
import type { WalletClient, PublicClient } from 'viem';
import { AgentSettlementError } from '../errors.js';

// ─── EAS Schema ────────────────────────────────────────────────────

const SCHEMA_STRING =
  'address provider, address payer, bytes32 channelId, uint8 score, string comment';

const RESOLVER_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

const REVOCABLE = true;

const SCHEMA_UID = keccak256(
  encodePacked(
    ['string', 'address', 'bool'],
    [SCHEMA_STRING, RESOLVER_ADDRESS, REVOCABLE],
  ),
);

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

// ─── ABIs ──────────────────────────────────────────────────────────

const EAS_ABI = [
  {
    type: 'function',
    name: 'attest',
    inputs: [
      {
        name: 'request',
        type: 'tuple',
        components: [
          { name: 'schema', type: 'bytes32' },
          {
            name: 'data',
            type: 'tuple',
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'expirationTime', type: 'uint64' },
              { name: 'revocable', type: 'bool' },
              { name: 'refUID', type: 'bytes32' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'isAttestationValid',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAttestation',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'schema', type: 'bytes32' },
          { name: 'time', type: 'uint64' },
          { name: 'expirationTime', type: 'uint64' },
          { name: 'revocationTime', type: 'uint64' },
          { name: 'refUID', type: 'bytes32' },
          { name: 'recipient', type: 'address' },
          { name: 'attester', type: 'address' },
          { name: 'revocable', type: 'bool' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'Attested',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'attester', type: 'address', indexed: true },
      { name: 'uid', type: 'bytes32', indexed: false },
      { name: 'schemaUUID', type: 'bytes32', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Revoked',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'attester', type: 'address', indexed: true },
      { name: 'uid', type: 'bytes32', indexed: false },
      { name: 'schemaUUID', type: 'bytes32', indexed: true },
    ],
  },
] as const;

const AGENT_REPUTATION_ABI = [
  {
    type: 'function',
    name: 'getRatings',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'provider', type: 'address' },
          { name: 'payer', type: 'address' },
          { name: 'channelId', type: 'bytes32' },
          { name: 'score', type: 'uint8' },
          { name: 'comment', type: 'string' },
          { name: 'timestamp', type: 'uint64' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAverageScore',
    inputs: [{ name: 'provider', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getRatingCount',
    inputs: [{ name: 'provider', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

// ─── Errors ────────────────────────────────────────────────────────

/**
 * Thrown when a rating score is outside the valid 0-10 range or is not an integer.
 */
export class InvalidRatingScoreError extends AgentSettlementError {
  constructor(
    public readonly score: number,
    detail?: string,
  ) {
    const msg = detail
      ? `Invalid rating score: ${score} - ${detail}`
      : `Invalid rating score: ${score}. Score must be an integer between 0 and 10.`;
    super(msg, 'INVALID_RATING_SCORE');
    this.name = 'InvalidRatingScoreError';
  }
}

/**
 * Thrown when an EAS attestation transaction fails or the Attested
 * event cannot be found in the receipt.
 */
export class AttestationFailedError extends AgentSettlementError {
  constructor(
    message: string,
    public readonly txHash?: `0x${string}`,
  ) {
    super(message, 'ATTESTATION_FAILED');
    this.name = 'AttestationFailedError';
  }
}

// ─── Types ─────────────────────────────────────────────────────────

/**
 * A single service quality rating attested via EAS.
 */
export interface ServiceRating {
  /** The service provider being rated. */
  provider: `0x${string}`;
  /** The payer who submitted the rating. */
  payer: `0x${string}`;
  /** The payment channel this rating references. */
  channelId: bigint;
  /** Integer score from 0 (worst) to 10 (best). */
  score: number;
  /** Free-text comment describing the service experience. */
  comment: string;
  /** Unix timestamp in seconds of when the attestation was made on-chain. */
  timestamp: number;
}

interface RawRating {
  uid: `0x${string}`;
  provider: string;
  payer: string;
  channelId: `0x${string}`;
  score: number;
  comment: string;
  timestamp: number | bigint;
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Attests to the quality of a provider's service after a payment channel
 * closes. Creates an on-chain EAS attestation with the rating data.
 *
 * @param wallet - Payer's WalletClient (must have an account).
 * @param publicClient - PublicClient for simulation and receipt polling.
 * @param easAddress - Address of the deployed EAS contract.
 * @param provider - The service provider's address being rated.
 * @param channelId - The payment channel identifier.
 * @param score - Rating score (integer 0-10).
 * @param comment - Free-text comment describing the experience.
 * @returns The attestation UID and transaction hash.
 * @throws {InvalidRatingScoreError} If score is not an integer in [0, 10] or comment is empty.
 * @throws {AttestationFailedError} If the on-chain attestation fails.
 */
export async function rateService(
  wallet: WalletClient,
  publicClient: PublicClient,
  easAddress: `0x${string}`,
  provider: `0x${string}`,
  channelId: bigint,
  score: number,
  comment: string,
): Promise<{ attestationUid: `0x${string}`; txHash: `0x${string}` }> {
  if (!wallet.account) {
    throw new Error('Wallet has no account configured');
  }

  if (!Number.isInteger(score) || score < 0 || score > 10) {
    throw new InvalidRatingScoreError(score);
  }

  if (!comment || comment.trim().length === 0) {
    throw new InvalidRatingScoreError(score, 'Comment must not be empty');
  }

  const channelIdBytes32 = pad(toHex(channelId), { size: 32 });

  const attestationData = encodeAbiParameters(
    parseAbiParameters(
      'address provider, address payer, bytes32 channelId, uint8 score, string comment',
    ),
    [provider, wallet.account.address, channelIdBytes32, score, comment.trim()],
  );

  try {
    const { request } = await publicClient.simulateContract({
      address: easAddress,
      abi: EAS_ABI,
      functionName: 'attest',
      args: [
        {
          schema: SCHEMA_UID,
          data: {
            recipient: provider,
            expirationTime: 0n,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: attestationData,
            value: 0n,
          },
        },
      ],
      account: wallet.account,
    });

    const txHash = await wallet.writeContract(request);

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status !== 'success') {
      throw new AttestationFailedError('Transaction reverted', txHash);
    }

    const attestationUid = parseAttestedUid(receipt.logs, easAddress);
    if (!attestationUid) {
      throw new AttestationFailedError(
        'Attested event not found in transaction receipt',
        txHash,
      );
    }

    return { attestationUid, txHash };
  } catch (err: unknown) {
    if (err instanceof AgentSettlementError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AttestationFailedError(`Attestation failed: ${message}`);
  }
}

/**
 * Retrieves paginated service ratings for a given provider from the
 * AgentReputation contract.
 *
 * @param publicClient - A PublicClient connected to the target chain.
 * @param agentReputationAddress - Address of the AgentReputation contract.
 * @param provider - The service provider address to query ratings for.
 * @param offset - Pagination offset (default 0).
 * @param limit - Maximum number of ratings to return (default 50).
 * @returns Array of ServiceRating objects.
 */
export async function getProviderRatings(
  publicClient: PublicClient,
  agentReputationAddress: `0x${string}`,
  provider: `0x${string}`,
  offset?: number,
  limit?: number,
): Promise<ServiceRating[]> {
  try {
    const result = (await publicClient.readContract({
      address: agentReputationAddress,
      abi: AGENT_REPUTATION_ABI,
      functionName: 'getRatings',
      args: [provider, BigInt(offset ?? 0), BigInt(limit ?? 50)],
    })) as unknown as RawRating[];

    if (!Array.isArray(result)) {
      return [];
    }

    return result.map((r: RawRating) => ({
      provider: r.provider as `0x${string}`,
      payer: r.payer as `0x${string}`,
      channelId: BigInt(r.channelId),
      score: Number(r.score),
      comment: r.comment,
      timestamp: Number(r.timestamp),
    }));
  } catch (err: unknown) {
    if (err instanceof AgentSettlementError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentSettlementError(
      `Failed to fetch provider ratings: ${message}`,
      'REPUTATION_QUERY_FAILED',
    );
  }
}

/**
 * Retrieves the aggregated reputation score for a provider from
 * the AgentReputation contract.
 *
 * @param publicClient - A PublicClient connected to the target chain.
 * @param agentReputationAddress - Address of the AgentReputation contract.
 * @param provider - The service provider address to query.
 * @returns The average score (integer 0-10, truncated on-chain) and total number of ratings.
 */
export async function getProviderScore(
  publicClient: PublicClient,
  agentReputationAddress: `0x${string}`,
  provider: `0x${string}`,
): Promise<{ averageScore: number; totalRatings: number }> {
  try {
    const [rawAverage, rawCount] = await Promise.all([
      publicClient.readContract({
        address: agentReputationAddress,
        abi: AGENT_REPUTATION_ABI,
        functionName: 'getAverageScore',
        args: [provider],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: agentReputationAddress,
        abi: AGENT_REPUTATION_ABI,
        functionName: 'getRatingCount',
        args: [provider],
      }) as Promise<bigint>,
    ]);

    return { averageScore: Number(rawAverage), totalRatings: Number(rawCount) };
  } catch (err: unknown) {
    if (err instanceof AgentSettlementError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentSettlementError(
      `Failed to fetch provider score: ${message}`,
      'REPUTATION_QUERY_FAILED',
    );
  }
}

// ─── Internal helpers ──────────────────────────────────────────────

function parseAttestedUid(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  easAddress: `0x${string}`,
): `0x${string}` | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== easAddress.toLowerCase()) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: EAS_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });

      if (decoded.eventName === 'Attested') {
        const { uid } = decoded.args as { uid: `0x${string}` };
        return uid;
      }
    } catch {
      // not an Attested event — continue scanning
    }
  }
  return null;
}
