import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../build-app';
import { createInMemoryPool } from './mock-pool';

const AGENT = { 'x-agent-id': 'test-agent' };

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

async function lockEscrow(app: FastifyInstance, tradeId: string) {
  const res = await app.inject({
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
  return res.json();
}

describe('Escrow edge cases', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const pool = createInMemoryPool();
    app = await buildApp({ pool, logger: false, skipStatic: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('rejects double lock on the same trade', async () => {
    const { tradeId } = await createAcceptedTrade(app);

    // First lock succeeds
    const first = await app.inject({
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
    expect(first.statusCode).toBe(200);

    // Second lock fails — trade is now 'escrowed', not 'accepted'
    const second = await app.inject({
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
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toContain('accepted');
  });

  it('rejects confirm-delivery on already settled escrow', async () => {
    const { tradeId } = await createAcceptedTrade(app);
    const lock = await lockEscrow(app, tradeId);

    // First confirm succeeds
    const first = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${lock.escrowId}/confirm-delivery`,
      headers: AGENT,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('settled');

    // Second confirm fails — escrow already released
    const second = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${lock.escrowId}/confirm-delivery`,
      headers: AGENT,
    });
    expect(second.statusCode).toBe(400);
  });

  it('rejects resolve without prior dispute', async () => {
    const { tradeId } = await createAcceptedTrade(app);
    const lock = await lockEscrow(app, tradeId);

    // Try to resolve directly — trade is 'escrowed', not 'disputed'
    const res = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${lock.escrowId}/resolve`,
      headers: AGENT,
      payload: { resolution: 'release' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('disputed');
  });

  it('rejects dispute on nonexistent escrow', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registry/escrow/00000000-0000-0000-0000-000000000000/dispute',
      headers: AGENT,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects resolve on nonexistent escrow', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registry/escrow/00000000-0000-0000-0000-000000000000/resolve',
      headers: AGENT,
      payload: { resolution: 'refund' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects confirm-delivery on nonexistent escrow', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registry/escrow/00000000-0000-0000-0000-000000000000/confirm-delivery',
      headers: AGENT,
    });
    // The adapter's getEscrowStatus returns 'unknown' for missing records
    expect(res.statusCode).toBe(400);
  });

  it('rejects lock with unknown chain_id', async () => {
    const { tradeId } = await createAcceptedTrade(app);

    const res = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        chain_id: 'solana:mainnet',
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '1000000',
        token: 'native',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('No escrow adapter');
  });

  it('rejects lock on nonexistent trade', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: '00000000-0000-0000-0000-000000000000',
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '1000000',
        token: 'native',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('double dispute on same escrow fails', async () => {
    const { tradeId } = await createAcceptedTrade(app);
    const lock = await lockEscrow(app, tradeId);

    // First dispute succeeds
    const first = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${lock.escrowId}/dispute`,
      headers: AGENT,
    });
    expect(first.statusCode).toBe(200);

    // Second dispute fails — trade is now 'disputed', not 'escrowed'
    const second = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${lock.escrowId}/dispute`,
      headers: AGENT,
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toContain('escrowed');
  });
});
