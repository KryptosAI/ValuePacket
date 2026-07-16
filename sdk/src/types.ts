/** Core types for the Agent Settlement Protocol SDK */

export interface Service {
  provider: `0x${string}`;
  metadataURI: string;
  pricePerRequest: bigint;
  maxResponseMs: number;
  registeredAt: number;
  active: boolean;
}

export interface ServiceDescriptor {
  protocol: string;
  service: { id: string; name: string; description: string; version: string };
  provider: { framework: string; contact?: string; attestation?: string | null };
  api: {
    endpoint: string;
    method: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  };
  pricing: {
    token: `0x${string}`;
    pricePerRequest: string;
    minChannelDeposit: string;
    minChannelDuration: number;
  };
  sla: { maxResponseMs: number; uptime: string; rateLimit: string };
}

export enum ChannelStatus {
  Open = 0,
  Settled = 1,
  Refunded = 2,
}

export interface Channel {
  payer: `0x${string}`;
  payee: `0x${string}`;
  token: `0x${string}`;
  deposit: bigint;
  spent: bigint;
  openedAt: number;
  expiresAt: number;
  policy: `0x${string}`;
  metadata: `0x${string}`;
  status: ChannelStatus;
}

export interface PaymentProof {
  channelId: bigint;
  cumulativeSpent: bigint;
  requestHash: `0x${string}`;
  nonce: bigint;
}

export interface PolicyConfig {
  maxSpendPerDay: bigint;
  maxChannelDeposit: bigint;
  maxChannelDuration: number;
  requireRegisteredService: boolean;
  active: boolean;
}

export interface DiscoverParams {
  serviceType?: string;
  provider?: `0x${string}`;
  maxPrice?: bigint;
  active?: boolean;
}

export interface DiscoveredService extends Service {
  serviceId: `0x${string}`;
  descriptor?: ServiceDescriptor;
}

export interface RegisterServiceParams {
  metadataURI: string;
  pricePerRequest: bigint;
  maxResponseMs: number;
}

export interface UpdateServiceParams {
  serviceId: `0x${string}`;
  metadataURI: string;
  pricePerRequest: bigint;
  maxResponseMs: number;
}

export interface OpenChannelParams {
  provider: `0x${string}`;
  token: `0x${string}`;
  deposit: bigint;
  expiresIn: number;
  policy?: `0x${string}`;
  metadata?: `0x${string}`;
}

export interface AgentPayConfig {
  wallet: WalletClient;
  publicClient: PublicClient;
  serviceRegistryAddress: `0x${string}`;
  paymentChannelAddress: `0x${string}`;
  spendingPolicyAddress?: `0x${string}`;
  indexerUrl?: string;
}

export interface PaymentProofHeader {
  channelId: string;
  cumulativeSpent: string;
  nonce: string;
  proof: string;
  requestHash: string;
}

export interface ChannelCloseResult {
  txHash: `0x${string}`;
  spent: bigint;
  refunded: bigint;
}

import type { WalletClient, PublicClient } from 'viem';
