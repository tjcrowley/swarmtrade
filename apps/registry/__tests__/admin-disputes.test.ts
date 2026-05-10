import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../build-app';
import { createInMemoryPool } from './mock-pool';

const AGENT = { 'x-agent-id': 'test-agent' };
const ADMIN = { 'x-admin-key': 'test-admin' };

async function setupDisputedTrade(app: FastifyInstance) {
  // Create handshake
  const created = await app.inject({
    method: 'POST',
    url: '/registry/handshake',
    headers: AGENT,
    payload: { buyer_id: 'b', seller_id: 's', asset_id: 'a' },
  });
  const tradeId = created.json().id;

  // Accept
  await app.inject({
    method: 'POST',
    url: `/registry/negotiation/${tradeId}/transition`,
    headers: AGENT,
    payload: { fromVersion: 1, nextState: 'accepted', quote: { trade_value: 1000, currency: 'USD' } },
  });

  // Lock escrow
  const lock = await app.inject({
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
  const escrowId = lock.json().escrowId;

  // Dispute
  await app.inject({
    method: 'POST',
    url: `/registry/escrow/${escrowId}/dispute`,
    headers: AGENT,
    payload: {},
  });

  return { tradeId, escrowId };
}

describe('Admin disputes API', () => {
  let app: FastifyInstance;
  let pool: any;

  beforeEach(async () => {
    pool = createInMemoryPool();
    ({ server: app } = await buildApp({ pool, adminKey: 'test-admin', logger: false, skipStatic: true }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /admin/api/disputes returns disputed trades (regression: locked_at column)', async () => {
    await setupDisputedTrade(app);

    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/disputes',
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);
    expect(list[0].status).toBe('disputed');
    expect(list[0].escrow_id).toBeTruthy();
  });

  it('resolveToSeller releases escrow funds and marks trade resolved', async () => {
    const { tradeId, escrowId } = await setupDisputedTrade(app);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/disputes/${tradeId}/resolve`,
      headers: ADMIN,
      payload: { releaseToOwner: 'seller', reason: 'Seller delivered as promised' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('resolved');
    expect(body.released_to).toBe('seller');
    expect(body.escrow_id).toBe(escrowId);
    expect(body.escrow_tx_hash).toMatch(/release/);

    // Escrow record should be marked released
    const escrow = pool._escrows.get(escrowId);
    expect(escrow.status).toBe('released');
  });

  it('resolveToBuyer refunds escrow funds and marks trade resolved', async () => {
    const { tradeId, escrowId } = await setupDisputedTrade(app);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/disputes/${tradeId}/resolve`,
      headers: ADMIN,
      payload: { releaseToOwner: 'buyer', reason: 'Seller failed to deliver' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('resolved');
    expect(body.released_to).toBe('buyer');
    expect(body.escrow_tx_hash).toMatch(/refund/);

    // Escrow record should be marked refunded
    const escrow = pool._escrows.get(escrowId);
    expect(escrow.status).toBe('refunded');
  });

  it('rejects resolve on non-disputed trade', async () => {
    // Trade in 'accepted' state (no dispute)
    const created = await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: AGENT,
      payload: { buyer_id: 'b', seller_id: 's', asset_id: 'a' },
    });
    const tradeId = created.json().id;
    await app.inject({
      method: 'POST',
      url: `/registry/negotiation/${tradeId}/transition`,
      headers: AGENT,
      payload: { fromVersion: 1, nextState: 'accepted' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/disputes/${tradeId}/resolve`,
      headers: ADMIN,
      payload: { releaseToOwner: 'seller', reason: 'whatever' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unauthenticated dispute resolve', async () => {
    const { tradeId } = await setupDisputedTrade(app);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/api/disputes/${tradeId}/resolve`,
      payload: { releaseToOwner: 'seller', reason: 'no auth' },
    });
    expect(res.statusCode).toBe(403);
  });
});
