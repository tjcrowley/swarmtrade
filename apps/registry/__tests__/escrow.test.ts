import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../build-app';
import { createInMemoryPool } from './mock-pool';

const AGENT = { 'x-agent-id': 'test-agent' };

/**
 * Helper: creates a handshake and advances it to 'accepted' state,
 * ready for escrow lock.
 */
async function createAcceptedTrade(app: FastifyInstance): Promise<{ tradeId: string; version: number }> {
  const create = await app.inject({
    method: 'POST',
    url: '/registry/handshake',
    headers: AGENT,
    payload: { buyer_id: 'buyer', seller_id: 'seller', asset_id: 'asset-1' },
  });
  const tradeId = create.json().id;

  await app.inject({
    method: 'POST',
    url: `/registry/negotiation/${tradeId}/transition`,
    headers: AGENT,
    payload: { fromVersion: 1, nextState: 'accepted', quote: { trade_value: 1000, currency: 'USD' } },
  });

  return { tradeId, version: 2 };
}

describe('Escrow happy path', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const pool = createInMemoryPool();
    ({ server: app } = await buildApp({ pool, adminKey: 'test-key', logger: false, skipStatic: true }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lock → confirm-delivery → settled', async () => {
    const { tradeId } = await createAcceptedTrade(app);

    // Lock escrow
    const lockRes = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '1000000',
        token: 'native',
      },
    });
    expect(lockRes.statusCode).toBe(200);
    const lock = lockRes.json();
    expect(lock.status).toBe('escrowed');
    expect(lock.escrowId).toBeTruthy();
    expect(lock.txHash).toContain('confirmation:');

    // Confirm delivery
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${lock.escrowId}/confirm-delivery`,
      headers: AGENT,
    });
    expect(confirmRes.statusCode).toBe(200);
    const settled = confirmRes.json();
    expect(settled.status).toBe('settled');
    expect(settled.trade.status).toBe('settled');
    expect(settled.txHash).toContain('release');
  });

  it('rejects lock when trade is not in accepted state', async () => {
    // Create a trade but don't accept it
    const create = await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: AGENT,
      payload: { buyer_id: 'buyer', seller_id: 'seller', asset_id: 'asset-1' },
    });
    const tradeId = create.json().id;

    const lockRes = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '1000000',
        token: 'native',
      },
    });
    expect(lockRes.statusCode).toBe(400);
    expect(lockRes.json().error).toContain('accepted');
  });
});

describe('Escrow dispute path', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const pool = createInMemoryPool();
    ({ server: app } = await buildApp({ pool, adminKey: 'test-key', logger: false, skipStatic: true }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lock → dispute → resolve (release)', async () => {
    const { tradeId } = await createAcceptedTrade(app);

    // Lock
    const lockRes = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '500000',
        token: 'native',
      },
    });
    const escrowId = lockRes.json().escrowId;

    // Dispute
    const disputeRes = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${escrowId}/dispute`,
      headers: AGENT,
    });
    expect(disputeRes.statusCode).toBe(200);
    expect(disputeRes.json().status).toBe('disputed');

    // Resolve with release
    const resolveRes = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${escrowId}/resolve`,
      headers: AGENT,
      payload: { resolution: 'release' },
    });
    expect(resolveRes.statusCode).toBe(200);
    const resolved = resolveRes.json();
    expect(resolved.status).toBe('settled');
    expect(resolved.resolution).toBe('release');
  });

  it('lock → dispute → resolve (refund)', async () => {
    const { tradeId } = await createAcceptedTrade(app);

    const lockRes = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '500000',
        token: 'native',
      },
    });
    const escrowId = lockRes.json().escrowId;

    // Dispute
    await app.inject({
      method: 'POST',
      url: `/registry/escrow/${escrowId}/dispute`,
      headers: AGENT,
    });

    // Resolve with refund
    const resolveRes = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${escrowId}/resolve`,
      headers: AGENT,
      payload: { resolution: 'refund' },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().status).toBe('resolved');
    expect(resolveRes.json().resolution).toBe('refund');
  });

  it('rejects dispute on non-escrowed trade', async () => {
    const { tradeId } = await createAcceptedTrade(app);

    // Lock
    const lockRes = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '500000',
        token: 'native',
      },
    });
    const escrowId = lockRes.json().escrowId;

    // Confirm delivery first (moves to settled)
    await app.inject({
      method: 'POST',
      url: `/registry/escrow/${escrowId}/confirm-delivery`,
      headers: AGENT,
    });

    // Now try to dispute — should fail
    const disputeRes = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${escrowId}/dispute`,
      headers: AGENT,
    });
    expect(disputeRes.statusCode).toBe(400);
    expect(disputeRes.json().error).toContain('escrowed');
  });
});

describe('Escrow GET', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const pool = createInMemoryPool();
    ({ server: app } = await buildApp({ pool, adminKey: 'test-key', logger: false, skipStatic: true }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns 404 for nonexistent escrow', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/registry/escrow/00000000-0000-0000-0000-000000000000',
      headers: AGENT,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns escrow record after lock', async () => {
    const { tradeId } = await createAcceptedTrade(app);

    const lockRes = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '750000',
        token: 'native',
      },
    });
    const escrowId = lockRes.json().escrowId;

    const res = await app.inject({
      method: 'GET',
      url: `/registry/escrow/${escrowId}`,
      headers: AGENT,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.escrow_id).toBe(escrowId);
    expect(body.status).toBe('locked');
    expect(body.buyer_address).toBe('0xBuyer');
  });
});
