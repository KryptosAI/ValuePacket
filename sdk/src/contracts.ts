/** ABI definitions for the Agent Settlement Protocol smart contracts */

import type { PublicClient, WalletClient, Abi } from 'viem';
import { getContract } from 'viem';

// ─── ServiceRegistry ABI ────────────────────────────────────────────

export const SERVICE_REGISTRY_ABI = [
  {"type":"function","name":"deactivateService","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"getService","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"","type":"tuple","internalType":"struct ServiceRegistry.Service","components":[{"name":"provider","type":"address","internalType":"address"},{"name":"metadataURI","type":"string","internalType":"string"},{"name":"pricePerRequest","type":"uint256","internalType":"uint256"},{"name":"maxResponseMs","type":"uint32","internalType":"uint32"},{"name":"registeredAt","type":"uint32","internalType":"uint32"},{"name":"active","type":"bool","internalType":"bool"}]}],"stateMutability":"view"},
  {"type":"function","name":"getServiceAtIndex","inputs":[{"name":"index","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"},{"name":"svc","type":"tuple","internalType":"struct ServiceRegistry.Service","components":[{"name":"provider","type":"address","internalType":"address"},{"name":"metadataURI","type":"string","internalType":"string"},{"name":"pricePerRequest","type":"uint256","internalType":"uint256"},{"name":"maxResponseMs","type":"uint32","internalType":"uint32"},{"name":"registeredAt","type":"uint32","internalType":"uint32"},{"name":"active","type":"bool","internalType":"bool"}]}],"stateMutability":"view"},
  {"type":"function","name":"getServiceCount","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"register","inputs":[{"name":"metadataURI","type":"string","internalType":"string"},{"name":"pricePerRequest","type":"uint256","internalType":"uint256"},{"name":"maxResponseMs","type":"uint32","internalType":"uint32"}],"outputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}],"stateMutability":"nonpayable"},
  {"type":"function","name":"updateService","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"},{"name":"metadataURI","type":"string","internalType":"string"},{"name":"pricePerRequest","type":"uint256","internalType":"uint256"},{"name":"maxResponseMs","type":"uint32","internalType":"uint32"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"event","name":"ServiceDeactivated","inputs":[{"name":"serviceId","type":"bytes32","indexed":true,"internalType":"bytes32"}],"anonymous":false},
  {"type":"event","name":"ServiceRegistered","inputs":[{"name":"serviceId","type":"bytes32","indexed":true,"internalType":"bytes32"},{"name":"provider","type":"address","indexed":true,"internalType":"address"}],"anonymous":false},
  {"type":"event","name":"ServiceUpdated","inputs":[{"name":"serviceId","type":"bytes32","indexed":true,"internalType":"bytes32"}],"anonymous":false},
  {"type":"error","name":"InvalidMetadataURI","inputs":[]},
  {"type":"error","name":"InvalidPrice","inputs":[]},
  {"type":"error","name":"NotProvider","inputs":[{"name":"caller","type":"address","internalType":"address"},{"name":"provider","type":"address","internalType":"address"}]},
  {"type":"error","name":"ServiceAlreadyRegistered","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}]},
  {"type":"error","name":"ServiceInactive","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}]},
  {"type":"error","name":"ServiceNotFound","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}]}
] as const;

// ─── PaymentChannel ABI ─────────────────────────────────────────────

export const PAYMENT_CHANNEL_ABI = [
  {"type":"constructor","inputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"CHANNEL_CLOSE_TYPEHASH","inputs":[],"outputs":[{"name":"","type":"bytes32","internalType":"bytes32"}],"stateMutability":"view"},
  {"type":"function","name":"closeChannel","inputs":[{"name":"channelId","type":"uint256","internalType":"uint256"},{"name":"spent","type":"uint256","internalType":"uint256"},{"name":"signature","type":"bytes","internalType":"bytes"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"extendChannel","inputs":[{"name":"channelId","type":"uint256","internalType":"uint256"},{"name":"newExpiry","type":"uint32","internalType":"uint32"},{"name":"additionalDeposit","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"getChannel","inputs":[{"name":"channelId","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"tuple","internalType":"struct PaymentChannel.Channel","components":[{"name":"payer","type":"address"},{"name":"payee","type":"address"},{"name":"token","type":"address"},{"name":"deposit","type":"uint256"},{"name":"spent","type":"uint256"},{"name":"openedAt","type":"uint32"},{"name":"expiresAt","type":"uint32"},{"name":"policy","type":"address"},{"name":"metadata","type":"bytes"},{"name":"status","type":"uint8"}]}],"stateMutability":"view"},
  {"type":"function","name":"getChannelCount","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"openChannel","inputs":[{"name":"payee","type":"address","internalType":"address"},{"name":"token","type":"address","internalType":"address"},{"name":"deposit","type":"uint256","internalType":"uint256"},{"name":"expiresAt","type":"uint32","internalType":"uint32"},{"name":"policy","type":"address","internalType":"address"},{"name":"metadata","type":"bytes","internalType":"bytes"}],"outputs":[{"name":"channelId","type":"uint256","internalType":"uint256"}],"stateMutability":"nonpayable"},
  {"type":"function","name":"refundChannel","inputs":[{"name":"channelId","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"event","name":"ChannelClosed","inputs":[{"name":"channelId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"spent","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"ChannelExtended","inputs":[{"name":"channelId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"newExpiry","type":"uint32","indexed":false,"internalType":"uint32"},{"name":"additionalDeposit","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},
  {"type":"event","name":"ChannelOpened","inputs":[{"name":"channelId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"payer","type":"address","indexed":true,"internalType":"address"},{"name":"payee","type":"address","indexed":true,"internalType":"address"},{"name":"token","type":"address","indexed":false,"internalType":"address"},{"name":"deposit","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"expiresAt","type":"uint32","indexed":false,"internalType":"uint32"}],"anonymous":false},
  {"type":"event","name":"ChannelRefunded","inputs":[{"name":"channelId","type":"uint256","indexed":true,"internalType":"uint256"}],"anonymous":false},
  {"type":"error","name":"ChannelNotExpired","inputs":[{"name":"channelId","type":"uint256","internalType":"uint256"},{"name":"expiresAt","type":"uint32","internalType":"uint32"},{"name":"currentTime","type":"uint32","internalType":"uint32"}]},
  {"type":"error","name":"ChannelNotFound","inputs":[{"name":"channelId","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"ChannelNotOpen","inputs":[{"name":"channelId","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"ExpiryInPast","inputs":[{"name":"expiresAt","type":"uint32","internalType":"uint32"},{"name":"currentTime","type":"uint32","internalType":"uint32"}]},
  {"type":"error","name":"InvalidExpiry","inputs":[{"name":"newExpiry","type":"uint32","internalType":"uint32"},{"name":"currentExpiry","type":"uint32","internalType":"uint32"}]},
  {"type":"error","name":"InvalidSignature","inputs":[]},
  {"type":"error","name":"NotPayee","inputs":[{"name":"channelId","type":"uint256","internalType":"uint256"},{"name":"caller","type":"address","internalType":"address"},{"name":"payee","type":"address","internalType":"address"}]},
  {"type":"error","name":"NotPayer","inputs":[{"name":"channelId","type":"uint256","internalType":"uint256"},{"name":"caller","type":"address","internalType":"address"},{"name":"payer","type":"address","internalType":"address"}]},
  {"type":"error","name":"PolicyRejected","inputs":[{"name":"policy","type":"address","internalType":"address"}]},
  {"type":"error","name":"ReentrancyGuardReentrantCall","inputs":[]},
  {"type":"error","name":"SafeERC20FailedOperation","inputs":[{"name":"token","type":"address","internalType":"address"}]},
  {"type":"error","name":"SpentExceedsDeposit","inputs":[{"name":"spent","type":"uint256","internalType":"uint256"},{"name":"deposit","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"TransferFailed","inputs":[]},
  {"type":"error","name":"ZeroDeposit","inputs":[]},
  {"type":"error","name":"ZeroPayee","inputs":[]},
  {"type":"error","name":"ZeroToken","inputs":[]}
] as const;

// ─── SpendingPolicy ABI ─────────────────────────────────────────────

export const SPENDING_POLICY_ABI = [
  {"type":"constructor","inputs":[{"name":"_serviceRegistry","type":"address","internalType":"address"}],"stateMutability":"nonpayable"},
  {"type":"function","name":"addAllowedProvider","inputs":[{"name":"provider","type":"address","internalType":"address"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"addAllowedService","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"getAllowedProviderCount","inputs":[{"name":"user","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"getAllowedServiceCount","inputs":[{"name":"user","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},
  {"type":"function","name":"policies","inputs":[{"name":"","type":"address","internalType":"address"}],"outputs":[{"name":"maxSpendPerDay","type":"uint256","internalType":"uint256"},{"name":"maxChannelDeposit","type":"uint256","internalType":"uint256"},{"name":"maxChannelDuration","type":"uint256","internalType":"uint256"},{"name":"requireRegisteredService","type":"bool","internalType":"bool"},{"name":"active","type":"bool","internalType":"bool"}],"stateMutability":"view"},
  {"type":"function","name":"removeAllowedProvider","inputs":[{"name":"provider","type":"address","internalType":"address"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"removeAllowedService","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"serviceRegistry","inputs":[],"outputs":[{"name":"","type":"address","internalType":"contract ServiceRegistry"}],"stateMutability":"view"},
  {"type":"function","name":"setPolicy","inputs":[{"name":"maxSpendPerDay","type":"uint256","internalType":"uint256"},{"name":"maxChannelDeposit","type":"uint256","internalType":"uint256"},{"name":"maxChannelDuration","type":"uint256","internalType":"uint256"},{"name":"requireRegisteredService","type":"bool","internalType":"bool"}],"outputs":[],"stateMutability":"nonpayable"},
  {"type":"function","name":"validateChannelClose","inputs":[{"name":"payer","type":"address","internalType":"address"},{"name":"payee","type":"address","internalType":"address"},{"name":"deposit","type":"uint256","internalType":"uint256"},{"name":"spent","type":"uint256","internalType":"uint256"},{"name":"metadata","type":"bytes","internalType":"bytes"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},
  {"type":"function","name":"validateChannelOpen","inputs":[{"name":"payer","type":"address","internalType":"address"},{"name":"payee","type":"address","internalType":"address"},{"name":"deposit","type":"uint256","internalType":"uint256"},{"name":"expiresAt","type":"uint256","internalType":"uint256"},{"name":"","type":"bytes","internalType":"bytes"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},
  {"type":"event","name":"AllowedProviderAdded","inputs":[{"name":"user","type":"address","indexed":true,"internalType":"address"},{"name":"provider","type":"address","indexed":true,"internalType":"address"}],"anonymous":false},
  {"type":"event","name":"AllowedProviderRemoved","inputs":[{"name":"user","type":"address","indexed":true,"internalType":"address"},{"name":"provider","type":"address","indexed":true,"internalType":"address"}],"anonymous":false},
  {"type":"event","name":"AllowedServiceAdded","inputs":[{"name":"user","type":"address","indexed":true,"internalType":"address"},{"name":"serviceId","type":"bytes32","indexed":true,"internalType":"bytes32"}],"anonymous":false},
  {"type":"event","name":"AllowedServiceRemoved","inputs":[{"name":"user","type":"address","indexed":true,"internalType":"address"},{"name":"serviceId","type":"bytes32","indexed":true,"internalType":"bytes32"}],"anonymous":false},
  {"type":"event","name":"PolicySet","inputs":[{"name":"user","type":"address","indexed":true,"internalType":"address"}],"anonymous":false},
  {"type":"error","name":"DepositTooHigh","inputs":[{"name":"deposit","type":"uint256","internalType":"uint256"},{"name":"maxDeposit","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"DurationTooLong","inputs":[{"name":"duration","type":"uint256","internalType":"uint256"},{"name":"maxDuration","type":"uint256","internalType":"uint256"}]},
  {"type":"error","name":"PayeeNotRegistered","inputs":[{"name":"payee","type":"address","internalType":"address"}]},
  {"type":"error","name":"PolicyNotActive","inputs":[{"name":"user","type":"address","internalType":"address"}]},
  {"type":"error","name":"ProviderAlreadyAllowed","inputs":[{"name":"provider","type":"address","internalType":"address"}]},
  {"type":"error","name":"ProviderNotAllowed","inputs":[{"name":"provider","type":"address","internalType":"address"}]},
  {"type":"error","name":"ServiceAlreadyAllowed","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}]},
  {"type":"error","name":"ServiceNotAllowed","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}]},
  {"type":"error","name":"ServiceNotRegistered","inputs":[{"name":"serviceId","type":"bytes32","internalType":"bytes32"}]},
  {"type":"error","name":"SpendTooHigh","inputs":[{"name":"spent","type":"uint256","internalType":"uint256"},{"name":"maxSpendForPeriod","type":"uint256","internalType":"uint256"}]}
] as const;

// ─── Contract address types ─────────────────────────────────────────

export interface ContractAddresses {
  serviceRegistry: `0x${string}`;
  paymentChannel: `0x${string}`;
  spendingPolicy?: `0x${string}`;
}

// ─── Helper: create viem contract instances ─────────────────────────

/**
 * Creates a viem contract instance for the ServiceRegistry.
 */
export function getServiceRegistryContract(
  address: `0x${string}`,
  client: PublicClient | WalletClient,
) {
  return getContract({
    address,
    abi: SERVICE_REGISTRY_ABI,
    client,
  });
}

/**
 * Creates a viem contract instance for the PaymentChannel.
 */
export function getPaymentChannelContract(
  address: `0x${string}`,
  client: PublicClient | WalletClient,
) {
  return getContract({
    address,
    abi: PAYMENT_CHANNEL_ABI as Abi,
    client,
  });
}

/**
 * Creates a viem contract instance for the SpendingPolicy.
 */
export function getSpendingPolicyContract(
  address: `0x${string}`,
  client: PublicClient | WalletClient,
) {
  return getContract({
    address,
    abi: SPENDING_POLICY_ABI as Abi,
    client,
  });
}
