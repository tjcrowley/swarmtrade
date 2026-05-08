import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../build-app';
import { createInMemoryPool } from './mock-pool';

const AGENT = { 'x-agent-id': 'test-agent' };
const ADMIN = { 'x-admin-key': 'test-admin' };

describe('Input validation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const pool = createInMemoryPool();
    app = await buildApp({ pool, adminKey: 'test-admin', logger: false, skipStatic: true });
  });

  afterAll(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------
  describe('auth', () => {
    it('rejects registry routes without x-agent-id', async () => {
      const res = await app.inject({ method: 'GET', url: '/registry/search' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toContain('x-agent-id');
    });

    it('rejects handshake create without x-agent-id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/registry/handshake',
        payload: { buyer_id: 'b', seller_id: 's', asset_id: 'a' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects escrow lock without x-agent-id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/registry/escrow/lock',
        payload: {
          handshake_id: 'x',
          buyer_address: '0x1',
          seller_address: '0x2',
          amount: '100',
          token: 'native',
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('health endpoint does not require auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    });

    it('admin routes reject without admin key or cookie', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/api/stats' });
      expect(res.statusCode).toBe(403);
    });

    it('admin routes reject wrong admin key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/stats',
        headers: { 'x-admin-key': 'wrong-key' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // -----------------------------------------------------------------------
  // Announce
  // -----------------------------------------------------------------------
  describe('announce', () => {
    it('rejects announce with missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/registry/announce',
        headers: AGENT,
        payload: { asset_id: 'x' }, // missing type, metadata, agent_card
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects announce with invalid asset type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/registry/announce',
        headers: AGENT,
        payload: {
          asset_id: 'x',
          type: 'banana',
          metadata: {},
          agent_card: { id: 'a', name: 'b', capabilities: [], description: 'd', metadata: {} },
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Escrow lock
  // -----------------------------------------------------------------------
  describe('escrow lock validation', () => {
    it('rejects lock with missing handshake_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/registry/escrow/lock',
        headers: AGENT,
        payload: {
          buyer_address: '0x1',
          seller_address: '0x2',
          amount: '100',
          token: 'native',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects lock with missing amount', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/registry/escrow/lock',
        headers: AGENT,
        payload: {
          handshake_id: 'x',
          buyer_address: '0x1',
          seller_address: '0x2',
          token: 'native',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects lock with missing buyer_address', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/registry/escrow/lock',
        headers: AGENT,
        payload: {
          handshake_id: 'x',
          seller_address: '0x2',
          amount: '100',
          token: 'native',
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Fee config
  // -----------------------------------------------------------------------
  describe('fee config validation', () => {
    it('rejects fee_bps update with missing fee_bps', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/fee-config',
        headers: ADMIN,
        payload: { min_fee: 1 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects fee_bps > 10000', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/fee-config',
        headers: ADMIN,
        payload: { fee_bps: 15000 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative fee_bps', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/fee-config',
        headers: ADMIN,
        payload: { fee_bps: -10 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Resolve validation
  // -----------------------------------------------------------------------
  describe('resolve validation', () => {
    it('rejects resolve with invalid resolution value', async () => {
      // Create a trade to get a valid-looking URL, but the body validation should fail first
      const res = await app.inject({
        method: 'POST',
        url: '/registry/escrow/some-id/resolve',
        headers: AGENT,
        payload: { resolution: 'destroy' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects resolve with missing resolution', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/registry/escrow/some-id/resolve',
        headers: AGENT,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
