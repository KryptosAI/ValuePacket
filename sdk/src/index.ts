/** @agent-settlement/sdk — Agent Settlement Protocol TypeScript SDK */

export { AgentPay } from './client.js';
export { ChannelSession } from './channel.js';
export { ChannelServer } from './provider.js';

export type {
  Service,
  ServiceDescriptor,
  DiscoveredService,
  Channel,
  PaymentProof,
  PolicyConfig,
  PaymentProofHeader,
  DiscoverParams,
  RegisterServiceParams,
  UpdateServiceParams,
  OpenChannelParams,
  AgentPayConfig,
  ChannelCloseResult,
} from './types.js';

export { ChannelStatus } from './types.js';

export {
  signChannelClose,
  signPaymentProof,
  hashRequest,
  createPaymentProofHeader,
  CHANNEL_CLOSE_TYPE,
  PAYMENT_PROOF_TYPE,
} from './signing.js';

export {
  SERVICE_REGISTRY_ABI,
  PAYMENT_CHANNEL_ABI,
  SPENDING_POLICY_ABI,
  getServiceRegistryContract,
  getPaymentChannelContract,
  getSpendingPolicyContract,
} from './contracts.js';

export type { ContractAddresses } from './contracts.js';

export {
  AgentSettlementError,
  InsufficientFundsError,
  InvalidSignatureError,
  ChannelExpiredError,
  ServiceNotFoundError,
  ChannelNotFoundError,
  ChannelNotOpenError,
  MetadataResolutionError,
  HttpRequestError,
  TransactionFailedError,
} from './errors.js';

export type {
  ChannelSessionConfig,
} from './channel.js';

export type {
  ChannelServerConfig,
} from './provider.js';
