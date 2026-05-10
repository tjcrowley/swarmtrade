import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../build-app';
import { createInMemoryPool } from './mock-pool';

const AGENT = { 'x-agent-id': 'test-agent' };
const ADMIN = { 'x-admin-key': 'test-admin' };

describe('Admin trades API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const pool = createInMemoryPool();
    ({ server: app } = await buildApp({ pool, adminKey: 'test-admin', logger: false, skipStatic: true }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns empty trades list when no trades exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/trades',
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns trades after creation', async () => {
    // Create two trades
    await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: AGENT,
      payload: { buyer_id: 'buyer-1', seller_id: 'seller-1', asset_id: 'asset-1' },
    });
    await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: AGENT,
      payload: { buyer_id: 'buyer-2', seller_id: 'seller-2', asset_id: 'asset-2' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/trades',
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('stats reflect correct counts', async () => {
    // Create a trade and settle it
    const createRes = await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: AGENT,
      payload: { buyer_id: 'buyer', seller_id: 'seller', asset_id: 'asset-1' },
    });
    const tradeId = createRes.json().id;

    // Accept
    await app.inject({
      method: 'POST',
      url: `/registry/negotiation/${tradeId}/transition`,
      headers: AGENT,
      payload: { fromVersion: 1, nextState: 'accepted', quote: { trade_value: 1000, currency: 'USD' } },
    });

    // Escrow
    const lockRes = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        buyer_address: '0xB',
        seller_address: '0xS',
        amount: '1000000',
        token: 'native',
      },
    });
    const escrowId = lockRes.json().escrowId;

    // Settle
    await app.inject({
      method: 'POST',
      url: `/registry/escrow/${escrowId}/confirm-delivery`,
      headers: AGENT,
    });

    // Create another trade that's still proposed (active)
    await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: AGENT,
      payload: { buyer_id: 'buyer-2', seller_id: 'seller-2', asset_id: 'asset-2' },
    });

    const stats = await app.inject({
      method: 'GET',
      url: '/admin/api/stats',
      headers: ADMIN,
    });
    expect(stats.statusCode).toBe(200);
    const body = stats.json();
    expect(body.total_trades).toBe(2);
    expect(body.settled_trades).toBe(1);
    expect(body.active_negotiations).toBe(1);
  });

  it('rejects trades endpoint without admin auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/trades',
    });
    expect(res.statusCode).toBe(403);
  });
});
