/**
 * SubscriptionSession lifecycle tests against a REAL local chain (anvil on
 * port 8547 — port 8545 is reserved for other agents). Contracts are deployed
 * from contracts/src with forge, so these tests exercise whatever
 * SubscriptionManager implementation is currently checked out.
 *
 * Renewals always use the SDK's period-bound salt (computeRenewalSalt), so
 * they pass against both the legacy contract (salt unchecked) and the
 * hardened contract (salt must be keccak256(abi.encode(id, period))).
 * Cancel assertions use per-subscription accounting properties that hold
 * under both the legacy global-balance refund and the hardened
 * per-subscription refund.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Address, PublicClient, WalletClient } from 'viem';
import { keccak256, encodeAbiParameters } from 'viem';
import {
  SubscriptionSession,
  SUBSCRIPTION_MANAGER_ABI,
  computeRenewalSalt,
} from '../src/extensions/subscription.js';
import {
  ACCOUNTS,
  startAnvil,
  stopAnvil,
  deployContract,
  increaseTime,
  createAnvilWallet,
  createAnvilPublicClient,
  mintUsdc,
  approveToken,
  balanceOf,
  getOnChainChannel,
  usdc,
} from './helpers/chain.js';

interface OnChainSubscription {
  payer: Address;
  payee: Address;
  token: Address;
  amountPerPeriod: bigint;
  periodDuration: number;
  maxPeriods: bigint;
  completedPeriods: bigint;
  totalDeposited: bigint;
  totalSpent: bigint;
  activeChannelId: bigint;
  currentPeriodStart: number;
  active: boolean;
  metadata: `0x${string}`;
}

let anvil: ChildProcess | null = null;
let publicClient: PublicClient;
let payerWallet: WalletClient;
let payeeWallet: WalletClient;

let usdcAddress: Address;
let channelAddress: Address;
let subscriptionManagerAddress: Address;

const PAYER = ACCOUNTS.deployer.addr;
const PAYEE = ACCOUNTS.account1.addr;

const AMOUNT_PER_PERIOD = usdc(5);
const PERIOD_DURATION = 3600;
const MAX_PERIODS = 12;
const INITIAL_DEPOSIT = usdc(60);

async function readSubscription(
  managerAddress: Address,
  subscriptionId: bigint,
): Promise<OnChainSubscription> {
  return (await publicClient.readContract({
    address: managerAddress,
    abi: SUBSCRIPTION_MANAGER_ABI,
    functionName: 'getSubscription',
    args: [subscriptionId],
  })) as unknown as OnChainSubscription;
}

function sessionConfig(managerAddress: Address, overrides: Partial<{
  amountPerPeriod: bigint;
  initialDeposit: bigint;
  maxPeriods: number;
}> = {}) {
  return {
    payee: PAYEE,
    token: usdcAddress,
    amountPerPeriod: overrides.amountPerPeriod ?? AMOUNT_PER_PERIOD,
    periodDuration: PERIOD_DURATION,
    maxPeriods: overrides.maxPeriods ?? MAX_PERIODS,
    initialDeposit: overrides.initialDeposit ?? INITIAL_DEPOSIT,
    subscriptionManagerAddress: managerAddress,
    paymentChannelAddress: channelAddress,
  };
}

describe('SubscriptionSession (anvil:8547)', () => {
  beforeAll(async () => {
    anvil = await startAnvil();

    usdcAddress = await deployContract('src/mocks/MockUSDC.sol:MockUSDC');
    channelAddress = await deployContract('src/PaymentChannel.sol:PaymentChannel');
    subscriptionManagerAddress = await deployContract(
      'src/extensions/SubscriptionManager.sol:SubscriptionManager',
      channelAddress,
    );

    publicClient = createAnvilPublicClient();
    payerWallet = createAnvilWallet(ACCOUNTS.deployer.pk);
    payeeWallet = createAnvilWallet(ACCOUNTS.account1.pk);

    await mintUsdc(payerWallet, publicClient, usdcAddress, PAYER, usdc(1000));
    await approveToken(
      payerWallet,
      publicClient,
      usdcAddress,
      subscriptionManagerAddress,
      usdc(1000),
    );
  }, 300_000);

  afterAll(async () => {
    await stopAnvil(anvil);
    anvil = null;
  }, 20_000);

  // ── computeRenewalSalt ─────────────────────────────────────────────

  it('computeRenewalSalt is keccak256(abi.encode(subscriptionId, nextPeriod))', () => {
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }],
        [42n, 7n],
      ),
    );
    expect(computeRenewalSalt(42n, 7)).toBe(expected);

    // Period-bound: changes per period and per subscription.
    expect(computeRenewalSalt(42n, 8)).not.toBe(computeRenewalSalt(42n, 7));
    expect(computeRenewalSalt(43n, 7)).not.toBe(computeRenewalSalt(42n, 7));
  });

  // ── create / load / renew / refresh (shared session) ──────────────

  let session: SubscriptionSession;
  let firstChannelId: bigint;

  it('creates a subscription on-chain and opens the first channel', async () => {
    const payerBalanceBefore = await balanceOf(publicClient, usdcAddress, PAYER);

    session = await SubscriptionSession.create(
      payerWallet,
      publicClient,
      sessionConfig(subscriptionManagerAddress),
    );

    expect(session.subscriptionId).toBeGreaterThanOrEqual(1n);
    expect(session.completedPeriods).toBe(0);
    expect(session.remainingBalance).toBe(INITIAL_DEPOSIT - AMOUNT_PER_PERIOD);

    const payerBalanceAfter = await balanceOf(publicClient, usdcAddress, PAYER);
    expect(payerBalanceBefore - payerBalanceAfter).toBe(INITIAL_DEPOSIT);

    const sub = await readSubscription(subscriptionManagerAddress, session.subscriptionId);
    expect(sub.payer.toLowerCase()).toBe(PAYER.toLowerCase());
    expect(sub.payee.toLowerCase()).toBe(PAYEE.toLowerCase());
    expect(sub.token.toLowerCase()).toBe(usdcAddress.toLowerCase());
    expect(sub.amountPerPeriod).toBe(AMOUNT_PER_PERIOD);
    expect(sub.totalDeposited).toBe(INITIAL_DEPOSIT);
    expect(sub.totalSpent).toBe(0n);
    expect(sub.active).toBe(true);
    expect(sub.activeChannelId).toBeGreaterThan(0n);

    firstChannelId = sub.activeChannelId;

    // The first period's channel is funded by the manager on the payer's behalf.
    const channel = await getOnChainChannel(publicClient, channelAddress, firstChannelId);
    expect(channel.payer.toLowerCase()).toBe(subscriptionManagerAddress.toLowerCase());
    expect(channel.payee.toLowerCase()).toBe(PAYEE.toLowerCase());
    expect(channel.deposit).toBe(AMOUNT_PER_PERIOD);
    expect(channel.status).toBe(0);
  });

  it('reports the subscription in getSubscriptionCount', async () => {
    const count = (await publicClient.readContract({
      address: subscriptionManagerAddress,
      abi: SUBSCRIPTION_MANAGER_ABI,
      functionName: 'getSubscriptionCount',
      args: [],
    })) as bigint;
    expect(count).toBeGreaterThanOrEqual(1n);
  });

  it('loads an existing subscription from chain', async () => {
    const loaded = await SubscriptionSession.load(
      payerWallet,
      publicClient,
      session.subscriptionId,
      subscriptionManagerAddress,
      channelAddress,
    );

    expect(loaded.subscriptionId).toBe(session.subscriptionId);
    expect(loaded.payee.toLowerCase()).toBe(PAYEE.toLowerCase());
    expect(loaded.amountPerPeriod).toBe(AMOUNT_PER_PERIOD);
    expect(loaded.periodDuration).toBe(PERIOD_DURATION);
    expect(loaded.maxPeriods).toBe(MAX_PERIODS);
    expect(loaded.completedPeriods).toBe(0);
    expect(loaded.totalSpent).toBe(0n);
    expect(loaded.remainingBalance).toBe(INITIAL_DEPOSIT);
  });

  it('rejects loading a nonexistent subscription', async () => {
    await expect(
      SubscriptionSession.load(
        payerWallet,
        publicClient,
        999_999n,
        subscriptionManagerAddress,
        channelAddress,
      ),
    ).rejects.toThrow();
  });

  it('renews when the PAYEE submits with an explicit payer-signed authorization', async () => {
    await increaseTime(PERIOD_DURATION + 1);

    const payeeBalanceBefore = await balanceOf(publicClient, usdcAddress, PAYEE);
    const spent = usdc(3);

    // Payer pre-signs the EIP-712 SubscriptionAuth with the period-bound salt.
    const authSignature = await session.signRenewAuthorization();

    const { txHash, newChannelId } = await session.renew(spent, payeeWallet, authSignature);

    expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(newChannelId).toBeGreaterThan(firstChannelId);

    const sub = await readSubscription(subscriptionManagerAddress, session.subscriptionId);
    expect(sub.completedPeriods).toBe(1n);
    expect(sub.totalSpent).toBe(spent);
    expect(sub.activeChannelId).toBe(newChannelId);

    const payeeBalanceAfter = await balanceOf(publicClient, usdcAddress, PAYEE);
    expect(payeeBalanceAfter - payeeBalanceBefore).toBe(spent);

    expect(session.completedPeriods).toBe(1);
    expect(session.totalSpent).toBe(spent);

    const newChannel = await getOnChainChannel(publicClient, channelAddress, newChannelId);
    expect(newChannel.status).toBe(0);
    expect(newChannel.deposit).toBe(AMOUNT_PER_PERIOD);
  });

  it('renews a second period with the default (session-signed) authorization', async () => {
    await increaseTime(PERIOD_DURATION + 1);

    const spent = usdc(2);
    const { newChannelId } = await session.renew(spent, payeeWallet);

    const sub = await readSubscription(subscriptionManagerAddress, session.subscriptionId);
    expect(sub.completedPeriods).toBe(2n);
    expect(sub.totalSpent).toBe(usdc(5));
    expect(sub.activeChannelId).toBe(newChannelId);
    expect(session.completedPeriods).toBe(2);
  });

  it('rejects renew when submitted by a non-payee', async () => {
    await increaseTime(PERIOD_DURATION + 1);

    // Default submitter is the session (payer) wallet — the contract requires the payee.
    await expect(session.renew(usdc(1))).rejects.toThrow(/NotPayee/);

    const sub = await readSubscription(subscriptionManagerAddress, session.subscriptionId);
    expect(sub.completedPeriods).toBe(2n);
  });

  it('refresh() re-syncs local state from chain', async () => {
    const before = await readSubscription(subscriptionManagerAddress, session.subscriptionId);

    // Tamper with local fields, then refresh.
    session.completedPeriods = 0;
    session.totalSpent = 0n;
    session.remainingBalance = 0n;

    await session.refresh();

    expect(session.completedPeriods).toBe(Number(before.completedPeriods));
    expect(session.totalSpent).toBe(before.totalSpent);
    expect(session.remainingBalance).toBe(before.totalDeposited - before.totalSpent);
  });

  // ── cancel: per-subscription accounting ────────────────────────────

  it('cancel() with an unexpired open channel refunds only the unlocked funds', async () => {
    // Isolated manager so residues from other subscriptions cannot leak into
    // the refund under either accounting model.
    const isolatedManager = await deployContract(
      'src/extensions/SubscriptionManager.sol:SubscriptionManager',
      channelAddress,
    );
    await approveToken(payerWallet, publicClient, usdcAddress, isolatedManager, usdc(100));

    const deposit = usdc(20);
    const locked = AMOUNT_PER_PERIOD; // held by the still-open, unexpired channel

    const s = await SubscriptionSession.create(
      payerWallet,
      publicClient,
      sessionConfig(isolatedManager, { initialDeposit: deposit }),
    );

    const payerBalanceBefore = await balanceOf(publicClient, usdcAddress, PAYER);

    const { txHash, refunded } = await s.cancel();
    expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const owed = deposit - 0n; // totalDeposited - totalSpent

    // Conservative properties that hold under both legacy and hardened cancel:
    expect(refunded).toBeGreaterThan(0n);
    expect(refunded).toBeLessThanOrEqual(owed);

    // The unexpired open channel's funds are NOT part of the immediate refund.
    expect(refunded).toBe(owed - locked);

    // Payer received exactly the amount reported by SubscriptionCancelled.
    const payerBalanceAfter = await balanceOf(publicClient, usdcAddress, PAYER);
    expect(payerBalanceAfter - payerBalanceBefore).toBe(refunded);

    const sub = await readSubscription(isolatedManager, s.subscriptionId);
    expect(sub.active).toBe(false);
  });

  it('cancel() after renewal and channel expiry refunds the remaining balance', async () => {
    const isolatedManager = await deployContract(
      'src/extensions/SubscriptionManager.sol:SubscriptionManager',
      channelAddress,
    );
    await approveToken(payerWallet, publicClient, usdcAddress, isolatedManager, usdc(100));

    const deposit = usdc(20);
    const spent = usdc(3);

    const s = await SubscriptionSession.create(
      payerWallet,
      publicClient,
      sessionConfig(isolatedManager, { initialDeposit: deposit }),
    );

    await increaseTime(PERIOD_DURATION + 1);
    await s.renew(spent, payeeWallet);

    // Let the renewal channel expire too, so its deposit is reclaimable.
    await increaseTime(PERIOD_DURATION + 1);

    const payerBalanceBefore = await balanceOf(publicClient, usdcAddress, PAYER);
    const { refunded } = await s.cancel();

    const owed = deposit - spent;

    // Conservative bounds valid under both semantics: at minimum the funds
    // never locked in a channel, at most everything not spent.
    expect(refunded).toBeGreaterThan(0n);
    expect(refunded).toBeGreaterThanOrEqual(owed - AMOUNT_PER_PERIOD);
    expect(refunded).toBeLessThanOrEqual(owed);

    const payerBalanceAfter = await balanceOf(publicClient, usdcAddress, PAYER);
    expect(payerBalanceAfter - payerBalanceBefore).toBe(refunded);

    const sub = await readSubscription(isolatedManager, s.subscriptionId);
    expect(sub.active).toBe(false);
    expect(sub.totalSpent).toBe(spent);

    // A second cancel must fail: the subscription is no longer active.
    await expect(s.cancel()).rejects.toThrow(/SubscriptionNotActive|not active/i);
  });
});
