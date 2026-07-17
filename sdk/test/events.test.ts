import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  ValuePacketEvents,
  createWebhookForwarder,
} from '../src/extensions/events.js';
import type {
  PaymentReceivedEvent,
  ChannelClosedEvent,
} from '../src/extensions/events.js';

const WEBHOOK_URL = 'https://webhook.example.com/vp';

function makePaymentEvent(overrides: Partial<PaymentReceivedEvent> = {}): PaymentReceivedEvent {
  return {
    channelId: 7n,
    payer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    cumulativeSpent: 3_000n,
    perRequestSpent: 1_000n,
    nonce: 3n,
    body: { prompt: 'hello' },
    ...overrides,
  };
}

function makeClosedEvent(): ChannelClosedEvent {
  return {
    channelId: 9n,
    spent: 500n,
    refunded: 1_500n,
    txHash: '0x' + 'aa'.repeat(32) as `0x${string}`,
  };
}

describe('ValuePacketEvents', () => {
  it('delivers typed events to on() listeners', () => {
    const events = new ValuePacketEvents();
    const received: PaymentReceivedEvent[] = [];
    events.on('payment:received', (e) => received.push(e));

    const emitted = events.emit('payment:received', makePaymentEvent());

    expect(emitted).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].channelId).toBe(7n);
    expect(received[0].perRequestSpent).toBe(1_000n);
  });

  it('emit returns false when nobody listens', () => {
    const events = new ValuePacketEvents();
    expect(events.emit('channel:closed', makeClosedEvent())).toBe(false);
  });

  it('once() only fires a single time', () => {
    const events = new ValuePacketEvents();
    const fn = vi.fn();
    events.once('channel:closed', fn);

    events.emit('channel:closed', makeClosedEvent());
    events.emit('channel:closed', makeClosedEvent());

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('off() removes a listener', () => {
    const events = new ValuePacketEvents();
    const fn = vi.fn();
    events.on('payment:received', fn);
    events.off('payment:received', fn);

    events.emit('payment:received', makePaymentEvent());
    expect(fn).not.toHaveBeenCalled();
  });

  it('supports many listeners without maxListeners warnings', () => {
    const events = new ValuePacketEvents();
    expect(events.getMaxListeners()).toBe(100);
    for (let i = 0; i < 50; i++) {
      events.on('payment:received', () => {});
    }
    expect(events.listenerCount('payment:received')).toBe(50);
  });
});

describe('createWebhookForwarder', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs payment:received events to the webhook with bigints serialized', async () => {
    const events = new ValuePacketEvents();
    createWebhookForwarder(events, WEBHOOK_URL);

    events.emit('payment:received', makePaymentEvent());

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const payload = JSON.parse(init.body as string) as {
      event: string;
      data: Record<string, unknown>;
      timestamp: number;
    };
    expect(payload.event).toBe('payment:received');
    expect(payload.data.channelId).toBe('7');
    expect(payload.data.cumulativeSpent).toBe('3000');
    expect(payload.data.nonce).toBe('3');
    expect(payload.data.body).toEqual({ prompt: 'hello' });
    expect(typeof payload.timestamp).toBe('number');
  });

  it('forwards channel lifecycle events and re-emits them on the forwarder', async () => {
    const events = new ValuePacketEvents();
    const forwarder = createWebhookForwarder(events, WEBHOOK_URL);

    const reEmitted = vi.fn();
    forwarder.on('channel:closed', reEmitted);

    const closed = makeClosedEvent();
    events.emit('channel:closed', closed);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(reEmitted).toHaveBeenCalledTimes(1);
    expect(reEmitted.mock.calls[0][0]).toBe(closed);

    const payload = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { event: string; data: Record<string, unknown> };
    expect(payload.event).toBe('channel:closed');
    expect(payload.data.spent).toBe('500');
    expect(payload.data.refunded).toBe('1500');
  });

  it('signs the payload with an HMAC when a secret is configured', async () => {
    const secret = 'shhh-do-not-tell';
    const events = new ValuePacketEvents();
    createWebhookForwarder(events, WEBHOOK_URL, { secret });

    events.emit('channel:refunded', {
      channelId: 3n,
      refunded: 42n,
      txHash: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = init.body as string;
    const headers = init.headers as Record<string, string>;

    const expected = createHmac('sha256', secret).update(body).digest('hex');
    expect(headers['X-ValuePacket-Signature']).toBe(expected);
  });

  it('does not sign when no secret is configured', async () => {
    const events = new ValuePacketEvents();
    createWebhookForwarder(events, WEBHOOK_URL);

    events.emit('channel:opened', {
      channelId: 1n,
      payer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      payee: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      deposit: 10n,
      expiresAt: 1_900_000_000,
      txHash: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-ValuePacket-Signature']).toBeUndefined();
  });

  it('respects the filter option', async () => {
    const events = new ValuePacketEvents();
    const forwarder = createWebhookForwarder(events, WEBHOOK_URL, {
      filter: (event) => event !== 'payment:received',
    });

    const paymentListener = vi.fn();
    const closedListener = vi.fn();
    forwarder.on('payment:received', paymentListener);
    forwarder.on('channel:closed', closedListener);

    events.emit('payment:received', makePaymentEvent());
    events.emit('channel:closed', makeClosedEvent());

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const payload = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { event: string };
    expect(payload.event).toBe('channel:closed');
    expect(paymentListener).not.toHaveBeenCalled();
    expect(closedListener).toHaveBeenCalledTimes(1);
  });

  it('forwards error events without posting to the webhook', async () => {
    const events = new ValuePacketEvents();
    const forwarder = createWebhookForwarder(events, WEBHOOK_URL);

    const errorListener = vi.fn();
    forwarder.on('error', errorListener);

    const err = new Error('kaboom');
    events.emit('error', err);

    await new Promise((r) => setTimeout(r, 20));
    expect(errorListener).toHaveBeenCalledWith(err);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows webhook delivery failures', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const events = new ValuePacketEvents();
    const forwarder = createWebhookForwarder(events, WEBHOOK_URL);
    const reEmitted = vi.fn();
    forwarder.on('payment:received', reEmitted);

    events.emit('payment:received', makePaymentEvent());

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(reEmitted).toHaveBeenCalledTimes(1);
  });
});
