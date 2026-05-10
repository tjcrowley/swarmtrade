import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../build-app';
import { createInMemoryPool } from './mock-pool';

const AGENT_HEADER = { 'x-agent-id': 'test-agent' };

const SAMPLE_ASSET = {
  asset_id: 'widget-001',
  type: 'physical',
  metadata: { name: 'Widget', description: 'A test widget', price: 100 },
  agent_card: {
    id: 'seller-agent',
    name: 'Seller Bot',
    capabilities: ['sell'],
    description: 'Sells widgets',
    metadata: {},
  },
};

describe('Negotiation happy path', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const pool = createInMemoryPool();
    app = await buildApp({ pool, adminKey: 'test-key', logger: false, skipStatic: true });
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects requests without x-agent-id', async () => {
    const res = await app.inject({ method: 'POST', url: '/registry/announce', payload: SAMPLE_ASSET });
    expect(res.statusCode).toBe(401);
  });

  it('announces an asset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registry/announce',
      headers: AGENT_HEADER,
      payload: SAMPLE_ASSET,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('registered');
    expect(body.id).toBeTruthy();
  });

  it('searches assets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/registry/search',
      headers: AGENT_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('full negotiation: propose → counter → accept', async () => {
    // Create handshake
    const createRes = await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: AGENT_HEADER,
      payload: { buyer_id: 'buyer-1', seller_id: 'seller-1', asset_id: 'widget-001' },
    });
    expect(createRes.statusCode).toBe(200);
    const trade = createRes.json();
    expect(trade.status).toBe('proposed');
    expect(trade.version).toBe(1);
    const tradeId = trade.id;

    // Counter
    const counterRes = await app.inject({
      method: 'POST',
      url: `/registry/negotiation/${tradeId}/transition`,
      headers: AGENT_HEADER,
      payload: { fromVersion: 1, nextState: 'countered', quote: { price: 90, note: 'Counter offer' } },
    });
    expect(counterRes.statusCode).toBe(200);
    const countered = counterRes.json();
    expect(countered.status).toBe('countered');
    expect(countered.version).toBe(2);

    // Accept
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/registry/negotiation/${tradeId}/transition`,
      headers: AGENT_HEADER,
      payload: { fromVersion: 2, nextState: 'accepted', quote: { trade_value: 90, currency: 'USD' } },
    });
    expect(acceptRes.statusCode).toBe(200);
    const accepted = acceptRes.json();
    expect(accepted.status).toBe('accepted');
    expect(accepted.version).toBe(3);

    // Verify via GET
    const getRes = await app.inject({
      method: 'GET',
      url: `/registry/handshake/${tradeId}`,
      headers: AGENT_HEADER,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().status).toBe('accepted');
  });

  it('returns 409 on stale version', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/registry/handshake',
      headers: AGENT_HEADER,
      payload: { buyer_id: 'buyer-2', seller_id: 'seller-2', asset_id: 'widget-002' },
    });
    const tradeId = createRes.json().id;

    // Transition with correct version
    await app.inject({
      method: 'POST',
      url: `/registry/negotiation/${tradeId}/transition`,
      headers: AGENT_HEADER,
      payload: { fromVersion: 1, nextState: 'countered' },
    });

    // Attempt transition with stale version (1 instead of 2)
    const staleRes = await app.inject({
      method: 'POST',
      url: `/registry/negotiation/${tradeId}/transition`,
      headers: AGENT_HEADER,
      payload: { fromVersion: 1, nextState: 'accepted' },
    });
    expect(staleRes.statusCode).toBe(409);
  });

  it('returns 404 for nonexistent handshake', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/registry/handshake/00000000-0000-0000-0000-000000000000',
      headers: AGENT_HEADER,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Health check', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const pool = createInMemoryPool();
    app = await buildApp({ pool, adminKey: 'test-key', logger: false, skipStatic: true });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('healthy');
    expect(body).toHaveProperty('db_connected');
    expect(body).toHaveProperty('escrow_ready');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('checks');
  });
});
