import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../build-app';
import { createInMemoryPool } from './mock-pool';

const AGENT = { 'x-agent-id': 'seller-agent' };
const BUYER = { 'x-agent-id': 'buyer-agent' };
const ADMIN = { 'x-admin-key': 'test-admin' };

describe('Full E2E lifecycle', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const pool = createInMemoryPool();
    app = await buildApp({ pool, adminKey: 'test-admin', logger: false, skipStatic: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('announce → handshake → counter → accept → escrow → settle', async () => {
    // 1. Seller announces an asset
    const announceRes = await app.inject({
      method: 'POST',
      url: '/registry/announce',
      headers: AGENT,
      payload: {
        asset_id: 'nft-001',
        type: 'digital_data',
        metadata: { name: 'Rare NFT', floor_price: 500 },
        agent_card: {
          id: 'seller-agent',
          name: 'NFT Dealer',
          capabilities: ['sell'],
          description: 'Sells rare NFTs',
          metadata: {},
        },
      },
    });
    expect(announceRes.statusCode).toBe(200);
    expect(announceRes.json().status).toBe('registered');

    // 2. Buyer discovers the asset
    const searchRes = await app.inject({
      method: 'GET',
      url: '/registry/search',
      headers: BUYER,
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().length).toBeGreaterThan(0);

    // 3. Buyer initiates a handshake
    const handshakeRes = await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: BUYER,
      payload: { buyer_id: 'buyer-agent', seller_id: 'seller-agent', asset_id: 'nft-001' },
    });
    expect(handshakeRes.statusCode).toBe(200);
    const trade = handshakeRes.json();
    expect(trade.status).toBe('proposed');
    expect(trade.version).toBe(1);
    const tradeId = trade.id;

    // 4. Seller counters
    const counterRes = await app.inject({
      method: 'POST',
      url: `/registry/negotiation/${tradeId}/transition`,
      headers: AGENT,
      payload: { fromVersion: 1, nextState: 'countered', quote: { price: 450, note: 'Best I can do' } },
    });
    expect(counterRes.statusCode).toBe(200);
    expect(counterRes.json().status).toBe('countered');

    // 5. Buyer accepts with trade value
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/registry/negotiation/${tradeId}/transition`,
      headers: BUYER,
      payload: { fromVersion: 2, nextState: 'accepted', quote: { trade_value: 450, currency: 'USD' } },
    });
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json().status).toBe('accepted');

    // 6. Lock escrow
    const lockRes = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: BUYER,
      payload: {
        handshake_id: tradeId,
        buyer_address: '0xBuyerWallet',
        seller_address: '0xSellerWallet',
        amount: '450000000',
        token: 'native',
      },
    });
    expect(lockRes.statusCode).toBe(200);
    const lock = lockRes.json();
    expect(lock.status).toBe('escrowed');
    expect(lock.escrowId).toBeTruthy();

    // 7. Verify escrow record
    const escrowGetRes = await app.inject({
      method: 'GET',
      url: `/registry/escrow/${lock.escrowId}`,
      headers: BUYER,
    });
    expect(escrowGetRes.statusCode).toBe(200);
    expect(escrowGetRes.json().status).toBe('locked');
    expect(escrowGetRes.json().buyer_address).toBe('0xBuyerWallet');

    // 8. Confirm delivery → settle
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${lock.escrowId}/confirm-delivery`,
      headers: BUYER,
    });
    expect(confirmRes.statusCode).toBe(200);
    const settled = confirmRes.json();
    expect(settled.status).toBe('settled');
    expect(settled.trade.status).toBe('settled');

    // 9. Verify trade is settled via GET
    const finalTradeRes = await app.inject({
      method: 'GET',
      url: `/registry/handshake/${tradeId}`,
      headers: BUYER,
    });
    expect(finalTradeRes.statusCode).toBe(200);
    expect(finalTradeRes.json().status).toBe('settled');

    // 10. Admin can see the settled trade in stats
    const statsRes = await app.inject({
      method: 'GET',
      url: '/admin/api/stats',
      headers: ADMIN,
    });
    expect(statsRes.statusCode).toBe(200);
    expect(Number(statsRes.json().settled_trades)).toBeGreaterThanOrEqual(1);
  });

  it('announce → handshake → accept → escrow → dispute → refund', async () => {
    // Announce
    await app.inject({
      method: 'POST',
      url: '/registry/announce',
      headers: AGENT,
      payload: {
        asset_id: 'service-001',
        type: 'service',
        metadata: { name: 'Consulting', rate: 200 },
        agent_card: {
          id: 'seller-agent',
          name: 'Consultant',
          capabilities: ['sell'],
          description: 'Consulting services',
          metadata: {},
        },
      },
    });

    // Handshake
    const handshakeRes = await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: BUYER,
      payload: { buyer_id: 'buyer-agent', seller_id: 'seller-agent', asset_id: 'service-001' },
    });
    const tradeId = handshakeRes.json().id;

    // Accept
    await app.inject({
      method: 'POST',
      url: `/registry/negotiation/${tradeId}/transition`,
      headers: AGENT,
      payload: { fromVersion: 1, nextState: 'accepted', quote: { trade_value: 200, currency: 'USD' } },
    });

    // Lock
    const lockRes = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: BUYER,
      payload: {
        handshake_id: tradeId,
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '200000000',
        token: 'native',
      },
    });
    const escrowId = lockRes.json().escrowId;

    // Dispute
    const disputeRes = await app.inject({
      method: 'POST',
      url: `/registry/escrow/${escrowId}/dispute`,
      headers: BUYER,
    });
    expect(disputeRes.statusCode).toBe(200);
    expect(disputeRes.json().status).toBe('disputed');

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

    // Verify trade state
    const tradeRes = await app.inject({
      method: 'GET',
      url: `/registry/handshake/${tradeId}`,
      headers: BUYER,
    });
    expect(tradeRes.json().status).toBe('resolved');
  });
});
