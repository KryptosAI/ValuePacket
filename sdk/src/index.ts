/** @valuepacket/sdk — ValuePacket Protocol TypeScript SDK */

export { AgentPay } from './client.js';
export { ChannelSession } from './channel.js';
export { ChannelServer } from './provider.js';
export { SubscriptionSession } from './extensions/subscription.js';
export { SettlementWorker } from './extensions/settlement.js';

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

export type { SubscriptionConfig } from './extensions/subscription.js';

export {
  SUBSCRIPTION_MANAGER_ABI,
  SUBSCRIPTION_AUTH_TYPE,
} from './extensions/subscription.js';

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

export {
  ValuePacketEvents,
  createWebhookForwarder,
} from './extensions/events.js';

export type {
  ChannelOpenedEvent,
  PaymentReceivedEvent,
  ChannelClosedEvent,
  ChannelRefundedEvent,
  ValuePacketEventMap,
} from './extensions/events.js';

export {
  rateService,
  getProviderRatings,
  getProviderScore,
  InvalidRatingScoreError,
  AttestationFailedError,
} from './extensions/reputation.js';

export type { ServiceRating } from './extensions/reputation.js';

export type {
  ChannelSessionConfig,
} from './channel.js';

export type {
  ChannelServerConfig,
} from './provider.js';

export type {
  ChannelStateStore,
  ChannelState,
} from './extensions/persistence.js';

export {
  MemoryChannelStateStore,
  FileChannelStateStore,
} from './extensions/persistence.js';
