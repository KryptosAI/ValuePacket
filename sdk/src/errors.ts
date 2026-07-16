/** Custom error classes for the Agent Settlement Protocol SDK */

export class AgentSettlementError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AgentSettlementError';
  }
}

export class InsufficientFundsError extends AgentSettlementError {
  constructor(public readonly required: bigint, public readonly available: bigint) {
    super(
      `Insufficient funds: required ${required.toString()}, available ${available.toString()}`,
      'INSUFFICIENT_FUNDS',
    );
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidSignatureError extends AgentSettlementError {
  constructor(message = 'Invalid payment proof signature') {
    super(message, 'INVALID_SIGNATURE');
    this.name = 'InvalidSignatureError';
  }
}

export class ChannelExpiredError extends AgentSettlementError {
  constructor(public readonly channelId: bigint, public readonly expiresAt: number) {
    super(
      `Channel ${channelId.toString()} expired at ${new Date(expiresAt * 1000).toISOString()}`,
      'CHANNEL_EXPIRED',
    );
    this.name = 'ChannelExpiredError';
  }
}

export class ServiceNotFoundError extends AgentSettlementError {
  constructor(public readonly serviceId: `0x${string}`) {
    super(`Service not found: ${serviceId}`, 'SERVICE_NOT_FOUND');
    this.name = 'ServiceNotFoundError';
  }
}

export class ChannelNotFoundError extends AgentSettlementError {
  constructor(public readonly channelId: bigint) {
    super(`Channel not found: ${channelId.toString()}`, 'CHANNEL_NOT_FOUND');
    this.name = 'ChannelNotFoundError';
  }
}

export class ChannelNotOpenError extends AgentSettlementError {
  constructor(public readonly channelId: bigint) {
    super(`Channel ${channelId.toString()} is not in Open state`, 'CHANNEL_NOT_OPEN');
    this.name = 'ChannelNotOpenError';
  }
}

export class MetadataResolutionError extends AgentSettlementError {
  constructor(public readonly uri: string, cause?: string) {
    super(`Failed to resolve metadata from URI: ${uri}${cause ? ` (${cause})` : ''}`, 'METADATA_RESOLUTION_FAILED');
    this.name = 'MetadataResolutionError';
  }
}

export class HttpRequestError extends AgentSettlementError {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    body: string,
  ) {
    super(`HTTP ${status} from ${endpoint}: ${body.slice(0, 200)}`, 'HTTP_REQUEST_FAILED');
    this.name = 'HttpRequestError';
  }
}

export class TransactionFailedError extends AgentSettlementError {
  constructor(message: string, public readonly txHash?: `0x${string}`) {
    super(message, 'TRANSACTION_FAILED');
    this.name = 'TransactionFailedError';
  }
}
