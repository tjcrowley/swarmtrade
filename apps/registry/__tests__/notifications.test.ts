import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../build-app';
import { createInMemoryPool } from './mock-pool';
import { NotificationService } from '../notifications';

const BUYER = { 'x-agent-id': 'buyer-agent' };
const SELLER = { 'x-agent-id': 'seller-agent' };
const ADMIN = { 'x-admin-key': 'test-admin' };

describe('Notification subscriptions API', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createInMemoryPool>;

  beforeEach(async () => {
    pool = createInMemoryPool();
    ({ server: app } = await buildApp({ pool, adminKey: 'test-admin', logger: false, skipStatic: true }));
  });

  afterEach(async () => {
    await app?.close();
  });

  it('subscribes with webhook_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { webhook_url: 'https://example.com/hook' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.agent_id).toBe('buyer-agent');
    expect(body.webhook_url).toBe('https://example.com/hook');
    expect(body.active).toBe(true);
  });

  it('subscribes with email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: SELLER,
      payload: { email: 'seller@example.com' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe('seller@example.com');
    expect(body.active).toBe(true);
  });

  it('subscribes with specific events filter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { webhook_url: 'https://example.com/hook', events: ['trade.settled', 'escrow.locked'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toEqual(['trade.settled', 'escrow.locked']);
  });

  it('rejects subscribe without webhook_url or email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('unsubscribes (soft delete)', async () => {
    // Subscribe first
    const subRes = await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { webhook_url: 'https://example.com/hook' },
    });
    const subId = subRes.json().id;

    // Unsubscribe
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/registry/notifications/${subId}`,
      headers: BUYER,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().ok).toBe(true);

    // Verify it no longer appears in listing
    const listRes = await app.inject({
      method: 'GET',
      url: '/registry/notifications/subscriptions',
      headers: BUYER,
    });
    expect(listRes.json().subscriptions.length).toBe(0);
  });

  it('lists active subscriptions', async () => {
    // Create two subscriptions
    await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { webhook_url: 'https://example.com/hook1' },
    });
    await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { email: 'buyer@example.com' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/registry/notifications/subscriptions',
      headers: BUYER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().subscriptions.length).toBe(2);
  });

  it('handles duplicate subscription (upsert)', async () => {
    await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { webhook_url: 'https://example.com/hook', events: ['trade.proposed'] },
    });

    // Subscribe again with same webhook_url but different events
    const res = await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { webhook_url: 'https://example.com/hook', events: ['trade.settled'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual(['trade.settled']);

    // Should still be just one subscription
    const listRes = await app.inject({
      method: 'GET',
      url: '/registry/notifications/subscriptions',
      headers: BUYER,
    });
    expect(listRes.json().subscriptions.length).toBe(1);
  });
});

describe('Notification firing on state changes', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createInMemoryPool>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    pool = createInMemoryPool();
    ({ server: app } = await buildApp({ pool, adminKey: 'test-admin', logger: false, skipStatic: true }));

    // Mock global fetch for webhook delivery
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }));
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await app?.close();
  });

  it('fires notification on trade.proposed', async () => {
    // Subscribe buyer
    await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { webhook_url: 'https://buyer.example.com/hook' },
    });

    // Create handshake
    const handshakeRes = await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: BUYER,
      payload: { buyer_id: 'buyer-agent', seller_id: 'seller-agent', asset_id: 'test-001' },
    });
    expect(handshakeRes.statusCode).toBe(200);

    // Wait a tick for async notify to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://buyer.example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-SwarmTrade-Event': 'trade.proposed',
        }),
      })
    );
  });

  it('fires notification on state transition', async () => {
    // Subscribe seller
    await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: SELLER,
      payload: { webhook_url: 'https://seller.example.com/hook' },
    });

    // Create handshake
    const handshakeRes = await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: BUYER,
      payload: { buyer_id: 'buyer-agent', seller_id: 'seller-agent', asset_id: 'test-002' },
    });
    const tradeId = handshakeRes.json().id;

    // Transition to accepted
    await app.inject({
      method: 'POST',
      url: `/registry/negotiation/${tradeId}/transition`,
      headers: BUYER,
      payload: { fromVersion: 1, nextState: 'accepted' },
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Should have called fetch for 'trade.proposed' and 'trade.accepted'
    const calls = fetchSpy.mock.calls.filter(
      (c: any) => c[0] === 'https://seller.example.com/hook'
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('respects event filtering — only receives subscribed events', async () => {
    // Subscribe buyer for only trade.settled
    await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { webhook_url: 'https://filtered.example.com/hook', events: ['trade.settled'] },
    });

    // Create handshake (trade.proposed)
    const handshakeRes = await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: BUYER,
      payload: { buyer_id: 'buyer-agent', seller_id: 'seller-agent', asset_id: 'test-003' },
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Should NOT have called fetch for the filtered hook — trade.proposed is not in their filter
    const filteredCalls = fetchSpy.mock.calls.filter(
      (c: any) => c[0] === 'https://filtered.example.com/hook'
    );
    expect(filteredCalls.length).toBe(0);
  });

  it('logs notification deliveries', async () => {
    // Subscribe buyer
    await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { webhook_url: 'https://logged.example.com/hook' },
    });

    // Create handshake
    await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: BUYER,
      payload: { buyer_id: 'buyer-agent', seller_id: 'seller-agent', asset_id: 'test-004' },
    });

    // Wait for async delivery and logging
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check notification log
    const logRes = await app.inject({
      method: 'GET',
      url: '/registry/notifications/log',
      headers: BUYER,
    });
    expect(logRes.statusCode).toBe(200);
    const logBody = logRes.json();
    expect(logBody.notifications.length).toBeGreaterThanOrEqual(1);
    expect(logBody.notifications[0].event).toBe('trade.proposed');
    expect(logBody.notifications[0].channel).toBe('webhook');
    expect(logBody.notifications[0].status).toBe('delivered');
  });
});

describe('Admin notifications view', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createInMemoryPool>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    pool = createInMemoryPool();
    ({ server: app } = await buildApp({ pool, adminKey: 'test-admin', logger: false, skipStatic: true }));
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }));
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await app?.close();
  });

  it('returns all notification log entries for admin', async () => {
    // Subscribe and trigger a notification
    await app.inject({
      method: 'POST',
      url: '/registry/notifications/subscribe',
      headers: BUYER,
      payload: { webhook_url: 'https://admin-test.example.com/hook' },
    });

    await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: BUYER,
      payload: { buyer_id: 'buyer-agent', seller_id: 'seller-agent', asset_id: 'admin-test' },
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/notifications',
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.notifications).toBeDefined();
    expect(body.total).toBeGreaterThanOrEqual(0);
  });
});

describe('NotificationService unit tests', () => {
  it('constructs without error', () => {
    const pool = createInMemoryPool();
    const service = new NotificationService(pool);
    expect(service).toBeTruthy();
  });

  it('subscribe and getSubscriptions round-trip', async () => {
    const pool = createInMemoryPool();
    const service = new NotificationService(pool);

    const sub = await service.subscribe('agent-1', { webhook_url: 'https://test.com/hook' });
    expect(sub.agent_id).toBe('agent-1');
    expect(sub.webhook_url).toBe('https://test.com/hook');

    const subs = await service.getSubscriptions('agent-1');
    expect(subs.length).toBe(1);
    expect(subs[0].webhook_url).toBe('https://test.com/hook');
  });

  it('unsubscribe removes from active list', async () => {
    const pool = createInMemoryPool();
    const service = new NotificationService(pool);

    const sub = await service.subscribe('agent-1', { webhook_url: 'https://test.com/hook' });
    await service.unsubscribe('agent-1', sub.id);

    const subs = await service.getSubscriptions('agent-1');
    expect(subs.length).toBe(0);
  });

  it('throws when neither webhook_url nor email provided', async () => {
    const pool = createInMemoryPool();
    const service = new NotificationService(pool);

    await expect(service.subscribe('agent-1', {})).rejects.toThrow('Either webhook_url or email must be provided');
  });
});
