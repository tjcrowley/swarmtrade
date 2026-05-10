import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../build-app';
import { createInMemoryPool } from './mock-pool';

const ADMIN_KEY = 'test-admin-key';
const ADMIN_HEADER = { 'x-admin-key': ADMIN_KEY };

describe('Admin API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const pool = createInMemoryPool();
    ({ server: app } = await buildApp({ pool, adminKey: ADMIN_KEY, logger: false, skipStatic: true }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects admin routes without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/api/stats' });
    expect(res.statusCode).toBe(403);
  });

  it('allows admin routes with x-admin-key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/stats',
      headers: ADMIN_HEADER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('total_trades');
    expect(body).toHaveProperty('settled_trades');
  });

  it('login sets cookie, logout clears it', async () => {
    // Login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/api/login',
      payload: { key: ADMIN_KEY },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json().ok).toBe(true);
    const cookies = loginRes.cookies;
    const sessionCookie = cookies.find((c: any) => c.name === 'admin_session');
    expect(sessionCookie).toBeTruthy();

    // Use cookie for auth
    const statsRes = await app.inject({
      method: 'GET',
      url: '/admin/api/stats',
      cookies: { admin_session: sessionCookie!.value },
    });
    expect(statsRes.statusCode).toBe(200);

    // Logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/admin/api/logout',
      headers: ADMIN_HEADER,
    });
    expect(logoutRes.statusCode).toBe(200);
  });

  it('accepts login with password field (alias for key)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/login',
      payload: { password: ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('rejects login with wrong key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/login',
      payload: { key: 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('gets and updates fee config', async () => {
    // Get default
    const getRes = await app.inject({
      method: 'GET',
      url: '/admin/api/fee-config',
      headers: ADMIN_HEADER,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().fee_bps).toBe(150);

    // Update
    const putRes = await app.inject({
      method: 'PUT',
      url: '/admin/api/fee-config',
      headers: ADMIN_HEADER,
      payload: { fee_bps: 200, min_fee: 1, max_fee: 50 },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().fee_bps).toBe(200);
  });
});
