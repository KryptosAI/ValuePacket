/**
 * Reputation extension tests against MockEAS + AgentReputation on a real
 * local chain (anvil on port 8547 — never 8545).
 *
 * Note on rateService: the SDK submits the attestation directly to the EAS
 * contract and derives the attestation UID from the standard EAS `Attested`
 * event. contracts/src/mocks/MockEAS.sol intentionally emits no events, so
 * against MockEAS the attestation LANDS on-chain but the SDK reports
 * AttestationFailedError (with the txHash). Both halves are asserted here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Address, PublicClient, WalletClient } from 'viem';
import { decodeAbiParameters, parseAbiParameters, pad, toHex } from 'viem';
import {
  rateService,
  getProviderRatings,
  getProviderScore,
  InvalidRatingScoreError,
  AttestationFailedError,
} from '../src/extensions/reputation.js';
import { AgentSettlementError } from '../src/errors.js';
import {
  ACCOUNTS,
  anvilChain,
  startAnvil,
  stopAnvil,
  deployContract,
  createAnvilWallet,
  createAnvilPublicClient,
} from './helpers/chain.js';

const mockEasAbi = [
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
] as const;

const agentReputationAbi = [
  {
    type: 'function',
    name: 'rateService',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'channelId', type: 'bytes32' },
      { name: 'score', type: 'uint8' },
      { name: 'comment', type: 'string' },
    ],
    outputs: [{ name: 'uid', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
] as const;

interface MockAttestation {
  uid: `0x${string}`;
  schema: `0x${string}`;
  time: bigint;
  recipient: Address;
  attester: Address;
  revocable: boolean;
  data: `0x${string}`;
}

let anvil: ChildProcess | null = null;
let publicClient: PublicClient;
let payerWallet: WalletClient;
let secondPayerWallet: WalletClient;

let easAddress: Address;
let reputationAddress: Address;

const PAYER = ACCOUNTS.deployer.addr;
const PROVIDER = ACCOUNTS.account1.addr;
const UNRATED_PROVIDER = ACCOUNTS.account3.addr;
const EOA_TARGET = ACCOUNTS.account2.addr; // plain account, no contract code

async function getAttestation(uid: number): Promise<MockAttestation> {
  return (await publicClient.readContract({
    address: easAddress,
    abi: mockEasAbi,
    functionName: 'getAttestation',
    args: [pad(toHex(uid), { size: 32 })],
  })) as unknown as MockAttestation;
}

async function rateDirectly(
  wallet: WalletClient,
  channelId: `0x${string}`,
  score: number,
  comment: string,
): Promise<void> {
  const hash = await wallet.writeContract({
    address: reputationAddress,
    abi: agentReputationAbi,
    functionName: 'rateService',
    args: [PROVIDER, channelId, score, comment],
    chain: anvilChain,
    account: wallet.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

describe('Reputation extension (anvil:8547)', () => {
  beforeAll(async () => {
    anvil = await startAnvil();

    easAddress = await deployContract('src/mocks/MockEAS.sol:MockEAS');
    // AgentReputation's constructor performs a boot attestation → uid 1.
    reputationAddress = await deployContract(
      'src/extensions/AgentReputation.sol:AgentReputation',
      easAddress,
    );

    publicClient = createAnvilPublicClient();
    payerWallet = createAnvilWallet(ACCOUNTS.deployer.pk);
    secondPayerWallet = createAnvilWallet(ACCOUNTS.account2.pk);
  }, 300_000);

  afterAll(async () => {
    await stopAnvil(anvil);
    anvil = null;
  }, 20_000);

  // ── rateService validation (InvalidRatingScoreError paths) ────────

  it('rejects scores above 10', async () => {
    await expect(
      rateService(payerWallet, publicClient, easAddress, PROVIDER, 1n, 11, 'too good'),
    ).rejects.toThrow(InvalidRatingScoreError);
  });

  it('rejects negative scores', async () => {
    const err = await rateService(
      payerWallet, publicClient, easAddress, PROVIDER, 1n, -1, 'bad',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvalidRatingScoreError);
    expect((err as InvalidRatingScoreError).score).toBe(-1);
    expect((err as InvalidRatingScoreError).code).toBe('INVALID_RATING_SCORE');
  });

  it('rejects non-integer scores', async () => {
    await expect(
      rateService(payerWallet, publicClient, easAddress, PROVIDER, 1n, 7.5, 'meh'),
    ).rejects.toThrow(InvalidRatingScoreError);
  });

  it('rejects empty and whitespace-only comments', async () => {
    await expect(
      rateService(payerWallet, publicClient, easAddress, PROVIDER, 1n, 5, ''),
    ).rejects.toThrow(InvalidRatingScoreError);

    const err = await rateService(
      payerWallet, publicClient, easAddress, PROVIDER, 1n, 5, '   ',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRatingScoreError);
    expect((err as InvalidRatingScoreError).message).toContain('Comment must not be empty');
  });

  // ── rateService against MockEAS ────────────────────────────────────

  it('submits the attestation on-chain; MockEAS emits no Attested event so the SDK reports AttestationFailedError', async () => {
    const err = await rateService(
      payerWallet,
      publicClient,
      easAddress,
      PROVIDER,
      77n,
      9,
      'excellent latency',
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttestationFailedError);
    const failure = err as AttestationFailedError;
    expect(failure.message).toContain('Attested event not found');
    // The transaction itself succeeded — the SDK surfaces its hash.
    expect(failure.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Verify the attestation actually landed in MockEAS with the exact
    // ABI encoding the SDK produced (uid 1 = AgentReputation boot).
    const att = await getAttestation(2);
    expect(att.attester.toLowerCase()).toBe(PAYER.toLowerCase());
    expect(att.recipient.toLowerCase()).toBe(PROVIDER.toLowerCase());
    expect(att.revocable).toBe(true);

    const [provider, payer, channelId, score, comment] = decodeAbiParameters(
      parseAbiParameters(
        'address provider, address payer, bytes32 channelId, uint8 score, string comment',
      ),
      att.data,
    );
    expect(provider.toLowerCase()).toBe(PROVIDER.toLowerCase());
    expect(payer.toLowerCase()).toBe(PAYER.toLowerCase());
    expect(BigInt(channelId)).toBe(77n);
    expect(score).toBe(9);
    expect(comment).toBe('excellent latency');
  });

  // ── getProviderRatings / getProviderScore via AgentReputation ─────

  it('returns an empty list and zero score for an unrated provider', async () => {
    const ratings = await getProviderRatings(publicClient, reputationAddress, UNRATED_PROVIDER);
    expect(ratings).toEqual([]);

    const score = await getProviderScore(publicClient, reputationAddress, UNRATED_PROVIDER);
    expect(score).toEqual({ averageScore: 0, totalRatings: 0 });
  });

  it('reads ratings recorded through AgentReputation', async () => {
    await rateDirectly(payerWallet, pad(toHex(101n), { size: 32 }), 9, 'fast and correct');
    await rateDirectly(secondPayerWallet, pad(toHex(102n), { size: 32 }), 7, 'good but pricey');

    const ratings = await getProviderRatings(publicClient, reputationAddress, PROVIDER);
    expect(ratings).toHaveLength(2);

    expect(ratings[0].provider.toLowerCase()).toBe(PROVIDER.toLowerCase());
    expect(ratings[0].payer.toLowerCase()).toBe(PAYER.toLowerCase());
    expect(ratings[0].channelId).toBe(101n);
    expect(ratings[0].score).toBe(9);
    expect(ratings[0].comment).toBe('fast and correct');
    expect(ratings[0].timestamp).toBeGreaterThan(0);

    expect(ratings[1].payer.toLowerCase()).toBe(EOA_TARGET.toLowerCase());
    expect(ratings[1].channelId).toBe(102n);
    expect(ratings[1].score).toBe(7);
  });

  it('supports pagination offsets and limits', async () => {
    const firstOnly = await getProviderRatings(publicClient, reputationAddress, PROVIDER, 0, 1);
    expect(firstOnly).toHaveLength(1);
    expect(firstOnly[0].score).toBe(9);

    const secondOnly = await getProviderRatings(publicClient, reputationAddress, PROVIDER, 1, 10);
    expect(secondOnly).toHaveLength(1);
    expect(secondOnly[0].score).toBe(7);

    const beyond = await getProviderRatings(publicClient, reputationAddress, PROVIDER, 10, 10);
    expect(beyond).toEqual([]);
  });

  it('aggregates the provider score from on-chain ratings', async () => {
    const { averageScore, totalRatings } = await getProviderScore(
      publicClient,
      reputationAddress,
      PROVIDER,
    );
    // (9 + 7) / 2 = 8 (contract truncates to an integer)
    expect(averageScore).toBe(8);
    expect(totalRatings).toBe(2);
  });

  // ── error wrapping ─────────────────────────────────────────────────

  it('wraps read failures in AgentSettlementError with REPUTATION_QUERY_FAILED', async () => {
    const ratingsErr = await getProviderRatings(
      publicClient,
      EOA_TARGET, // no contract deployed here
      PROVIDER,
    ).catch((e: unknown) => e);
    expect(ratingsErr).toBeInstanceOf(AgentSettlementError);
    expect((ratingsErr as AgentSettlementError).code).toBe('REPUTATION_QUERY_FAILED');

    const scoreErr = await getProviderScore(
      publicClient,
      EOA_TARGET,
      PROVIDER,
    ).catch((e: unknown) => e);
    expect(scoreErr).toBeInstanceOf(AgentSettlementError);
    expect((scoreErr as AgentSettlementError).code).toBe('REPUTATION_QUERY_FAILED');
  });
});
