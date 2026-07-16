import { EventEmitter } from 'node:events';

export interface ChannelOpenedEvent {
  channelId: bigint;
  payer: `0x${string}`;
  payee: `0x${string}`;
  deposit: bigint;
  expiresAt: number;
  txHash: `0x${string}`;
}

export interface PaymentReceivedEvent {
  channelId: bigint;
  payer: `0x${string}`;
  cumulativeSpent: bigint;
  perRequestSpent: bigint;
  nonce: bigint;
  body: unknown;
}

export interface ChannelClosedEvent {
  channelId: bigint;
  spent: bigint;
  refunded: bigint;
  txHash: `0x${string}`;
}

export interface ChannelRefundedEvent {
  channelId: bigint;
  refunded: bigint;
  txHash: `0x${string}`;
}

export type ValuePacketEventMap = {
  'channel:opened': [ChannelOpenedEvent];
  'channel:closed': [ChannelClosedEvent];
  'channel:refunded': [ChannelRefundedEvent];
  'payment:received': [PaymentReceivedEvent];
  'error': [Error];
};

export class ValuePacketEvents extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  override on<K extends keyof ValuePacketEventMap>(
    event: K,
    listener: (...args: ValuePacketEventMap[K]) => void,
  ): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  override once<K extends keyof ValuePacketEventMap>(
    event: K,
    listener: (...args: ValuePacketEventMap[K]) => void,
  ): this {
    return super.once(event as string, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof ValuePacketEventMap>(
    event: K,
    listener: (...args: ValuePacketEventMap[K]) => void,
  ): this {
    return super.off(event as string, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof ValuePacketEventMap>(
    event: K,
    ...args: ValuePacketEventMap[K]
  ): boolean {
    return super.emit(event as string, ...args);
  }
}

async function postToWebhook(
  url: string,
  event: string,
  data: unknown,
  secret?: string,
): Promise<void> {
  const payload = JSON.stringify({ event, data, timestamp: Date.now() });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (secret) {
    const crypto = await import('node:crypto');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    headers['X-ValuePacket-Signature'] = sig;
  }

  fetch(url, { method: 'POST', headers, body: payload }).catch(() => {});
}

export function createWebhookForwarder(
  events: ValuePacketEvents,
  webhookUrl: string,
  options?: { secret?: string; filter?: (event: string) => boolean },
): ValuePacketEvents {
  const forwarder = new ValuePacketEvents();

  const shouldForward = (event: string): boolean =>
    !options?.filter || options.filter(event);

  events.on('channel:opened', (data) => {
    if (!shouldForward('channel:opened')) return;
    postToWebhook(webhookUrl, 'channel:opened', data, options?.secret);
    forwarder.emit('channel:opened', data);
  });

  events.on('channel:closed', (data) => {
    if (!shouldForward('channel:closed')) return;
    postToWebhook(webhookUrl, 'channel:closed', data, options?.secret);
    forwarder.emit('channel:closed', data);
  });

  events.on('channel:refunded', (data) => {
    if (!shouldForward('channel:refunded')) return;
    postToWebhook(webhookUrl, 'channel:refunded', data, options?.secret);
    forwarder.emit('channel:refunded', data);
  });

  events.on('payment:received', (data) => {
    if (!shouldForward('payment:received')) return;
    postToWebhook(webhookUrl, 'payment:received', data, options?.secret);
    forwarder.emit('payment:received', data);
  });

  events.on('error', (data) => {
    forwarder.emit('error', data);
  });

  return forwarder;
}
