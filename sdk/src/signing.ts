/** EIP-712 signing utilities for payment channel close signatures and payment proofs */

import type { WalletClient } from 'viem';
import { keccak256, toHex } from 'viem';
import type { PaymentProofHeader } from './types.js';

export const CHANNEL_CLOSE_TYPE = {
  ChannelClose: [
    { name: 'channelId', type: 'uint256' },
    { name: 'spent', type: 'uint256' },
  ],
} as const;

export const PAYMENT_PROOF_TYPE = {
  PaymentProof: [
    { name: 'channelId', type: 'uint256' },
    { name: 'cumulativeSpent', type: 'uint256' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

const DOMAIN_NAME = 'ValuePacket';
const DOMAIN_VERSION = '1';

function buildDomain(
  chainId: number,
  verifyingContract: `0x${string}`,
) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

/**
 * Signs an EIP-712 message authorizing the closure of a payment channel
 * at a specific cumulative spent amount.
 */
export async function signChannelClose(
  wallet: WalletClient,
  verifyingContract: `0x${string}`,
  channelId: bigint,
  spent: bigint,
): Promise<`0x${string}`> {
  if (!wallet.chain) {
    throw new Error('Wallet has no chain configured');
  }
  if (!wallet.account) {
    throw new Error('Wallet has no account configured');
  }

  const chainId = await wallet.getChainId();
  const domain = buildDomain(chainId, verifyingContract);

  const signature = await wallet.signTypedData({
    account: wallet.account,
    domain,
    types: CHANNEL_CLOSE_TYPE,
    primaryType: 'ChannelClose',
    message: {
      channelId,
      spent,
    },
  });

  return signature;
}

/**
 * Signs an EIP-712 PaymentProof message for a single request within a channel.
 * The proof includes the cumulative spent up to and including this request.
 */
export async function signPaymentProof(
  wallet: WalletClient,
  verifyingContract: `0x${string}`,
  channelId: bigint,
  cumulativeSpent: bigint,
  requestBody: unknown,
  nonce: bigint,
): Promise<`0x${string}`> {
  if (!wallet.chain) {
    throw new Error('Wallet has no chain configured');
  }
  if (!wallet.account) {
    throw new Error('Wallet has no account configured');
  }

  const chainId = await wallet.getChainId();
  const domain = buildDomain(chainId, verifyingContract);
  const requestHash = hashRequest(requestBody);

  const signature = await wallet.signTypedData({
    account: wallet.account,
    domain,
    types: PAYMENT_PROOF_TYPE,
    primaryType: 'PaymentProof',
    message: {
      channelId,
      cumulativeSpent,
      requestHash,
      nonce,
    },
  });

  return signature;
}

/**
 * Produces a deterministic keccak256 hash of the request body.
 * Serializes the body as JSON with sorted keys and hashes the UTF-8 bytes.
 */
export function hashRequest(body: unknown): `0x${string}` {
  const serialized = JSON.stringify(body, sortReplacer);
  return keccak256(toHex(serialized));
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Formats a signed PaymentProof into the HTTP header representation
 * used by the ChannelServer to verify incoming requests.
 */
export function createPaymentProofHeader(
  channelId: bigint,
  cumulativeSpent: bigint,
  requestBody: unknown,
  nonce: bigint,
  signature: `0x${string}`,
): PaymentProofHeader {
  const requestHash = hashRequest(requestBody);
  return {
    channelId: channelId.toString(),
    cumulativeSpent: cumulativeSpent.toString(),
    nonce: nonce.toString(),
    proof: signature,
    requestHash,
  };
}
