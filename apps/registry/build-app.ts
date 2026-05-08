import path from 'path';
import fastify, { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import staticPlugin from '@fastify/static';
import cookie from '@fastify/cookie';
import { Pool } from 'pg';

import { AssetManifest } from '@a2a/types';
import { PostgresNegotiationRepository } from './negotiation-repo';
import { FeeConfigRepository } from './fee-config';
import { EscrowRegistry, ConfirmationEscrowAdapter } from './escrow';

export interface AppDeps {
  pool: Pool;
  adminKey?: string;
  cookieSecret?: string;
  logger?: boolean;
  skipStatic?: boolean;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool, logger = true, skipStatic = false } = deps;
  const adminKey = deps.adminKey ?? process.env.ADMIN_API_KEY ?? 'changeme';
  const cookieSecret = deps.cookieSecret ?? process.env.COOKIE_SECRET ?? adminKey;

  const server = fastify({ logger });
  const repo = new PostgresNegotiationRepository(pool);
  const feeRepo = new FeeConfigRepository(pool);
  const confirmationEscrow = new ConfirmationEscrowAdapter(pool);
  const escrowRegistry = new EscrowRegistry(confirmationEscrow);

  // Register chain-specific escrow adapters (opt-in via env vars)
  // Deferred to caller / startup code to avoid importing heavy deps in tests

  // -------------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------------
  await server.register(cookie, { secret: cookieSecret });

  await server.register(swagger, {
    openapi: {
      info: {
        title: 'SwarmTrade Registry API',
        description: 'Domain-agnostic asset registry for autonomous agent-to-agent commerce.',
        version: '0.1.0',
        contact: { name: 'SwarmTrade', url: 'https://swarmtrade.store' },
      },
      servers: [
        { url: 'https://swarmtrade.store', description: 'Production' },
        { url: 'http://localhost:8080', description: 'Local development' },
      ],
      tags: [
        { name: 'registry', description: 'Asset announcement & discovery' },
        { name: 'negotiation', description: 'Handshake & settlement protocol' },
        { name: 'admin', description: 'Platform administration' },
        { name: 'health', description: 'Service health' },
      ],
    },
  });
  await server.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  if (!skipStatic) {
    await server.register(staticPlugin, {
      root: path.join(__dirname, 'public'),
      prefix: '/admin/',
    });
  }

  // -------------------------------------------------------------------------
  // JSON Schemas
  // -------------------------------------------------------------------------
  const AgentCardSchema = {
    type: 'object' as const,
    properties: {
      id: { type: 'string' as const },
      name: { type: 'string' as const },
      capabilities: { type: 'array' as const, items: { type: 'string' as const } },
      description: { type: 'string' as const },
      metadata: { type: 'object' as const, additionalProperties: true },
    },
    required: ['id', 'name', 'capabilities', 'description', 'metadata'],
  };

  const AssetManifestSchema = {
    type: 'object' as const,
    properties: {
      asset_id: { type: 'string' as const },
      type: { type: 'string' as const, enum: ['physical', 'service', 'license', 'digital_data'] },
      metadata: { type: 'object' as const, additionalProperties: true },
      status: { type: 'string' as const, enum: ['available', 'pending', 'locked', 'transferred'] },
      agent_card: AgentCardSchema,
      created_at: { type: 'string' as const, format: 'date-time' },
    },
    required: ['asset_id', 'type', 'metadata', 'agent_card'],
  };

  const FeeConfigSchema = {
    type: 'object' as const,
    properties: {
      fee_bps: { type: 'integer' as const, minimum: 0, maximum: 10000, description: 'Fee in basis points (100 = 1%)' },
      min_fee: { type: 'number' as const, nullable: true, description: 'Minimum fee amount (null = no floor)' },
      max_fee: { type: 'number' as const, nullable: true, description: 'Maximum fee amount (null = no cap)' },
    },
    required: ['fee_bps'],
  };

  // -------------------------------------------------------------------------
  // Auth hooks
  // -------------------------------------------------------------------------
  server.addHook('preHandler', async (request, reply) => {
    const url = request.url;
    if (url.startsWith('/admin') || url.startsWith('/health') || url.startsWith('/docs') || url.startsWith('/openapi')) return;
    if (!request.headers['x-agent-id']) {
      return reply.status(401).send({ error: 'Unauthorized: Missing x-agent-id header' });
    }
  });

  server.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/admin/api')) return;
    if (request.url === '/admin/api/login' && request.method === 'POST') return;
    if (request.headers['x-admin-key'] === adminKey) return;
    const sessionCookie = request.cookies['admin_session'];
    if (sessionCookie) {
      const unsigned = request.unsignCookie(sessionCookie);
      if (unsigned.valid && unsigned.value) {
        try {
          const payload = JSON.parse(unsigned.value);
          if (payload.authenticated === true) return;
        } catch { /* invalid cookie data */ }
      }
    }
    return reply.status(403).send({ error: 'Forbidden' });
  });

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------
  server.get('/health', {
    schema: {
      tags: ['health'],
      summary: 'Health check',
      response: { 200: { type: 'object' as const, properties: { status: { type: 'string' as const }, timestamp: { type: 'string' as const } } } },
    },
  }, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------
  server.post<{ Body: AssetManifest }>('/registry/announce', {
    schema: { tags: ['registry'], summary: 'Announce an asset', body: AssetManifestSchema },
  }, async (request) => {
    const asset = request.body;
    const client = await pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO asset_announcements (asset_id, agent_id, agent_card, asset_type, metadata)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [asset.asset_id, asset.agent_card.id, JSON.stringify(asset.agent_card), asset.type, JSON.stringify(asset.metadata)]
      );
      return { status: 'registered', id: res.rows[0].id };
    } finally {
      client.release();
    }
  });

  server.get('/registry/search', {
    schema: {
      tags: ['registry'],
      summary: 'Search available assets',
      querystring: {
        type: 'object' as const,
        properties: {
          type: { type: 'string' as const, enum: ['physical', 'service', 'license', 'digital_data'] },
          status: { type: 'string' as const, enum: ['available', 'pending', 'locked', 'transferred'] },
          limit: { type: 'integer' as const, minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
  }, async (request) => {
    const { type, status, limit } = request.query as { type?: string; status?: string; limit?: number };
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (type) { conditions.push(`asset_type = $${idx++}`); params.push(type); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit || 50);
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT * FROM asset_announcements ${where} ORDER BY created_at DESC LIMIT $${idx}`, params);
      return res.rows;
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // Negotiation
  // -------------------------------------------------------------------------
  server.post('/registry/handshake', {
    schema: { tags: ['negotiation'], summary: 'Initiate a trade handshake' },
  }, async (request) => {
    return await repo.create(request.body as any);
  });

  server.get('/registry/handshake/:id', {
    schema: { tags: ['negotiation'], summary: 'Get handshake by ID' },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const trade = await repo.findById(id);
    if (!trade) return reply.status(404).send({ error: 'Not found' });
    return trade;
  });

  server.post('/registry/negotiation/:id/transition', {
    schema: {
      tags: ['negotiation'],
      summary: 'Transition negotiation state',
      description: 'Include trade_value and currency in quote when transitioning to "settled" to trigger fee calculation.',
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const { fromVersion, nextState, quote } = request.body as any;
    try {
      return await repo.transition(id, fromVersion, nextState, quote);
    } catch (err: any) {
      if (err.message === 'StaleVersionError') {
        return reply.status(409).send({ error: 'Conflict: negotiation state has changed.' });
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // Escrow
  // -------------------------------------------------------------------------
  server.post('/registry/escrow/lock', {
    schema: {
      tags: ['negotiation'],
      summary: 'Lock funds in escrow for a trade',
      body: {
        type: 'object' as const,
        required: ['handshake_id', 'buyer_address', 'seller_address', 'amount', 'token'],
        properties: {
          handshake_id: { type: 'string' as const },
          chain_id: { type: 'string' as const, default: 'off-chain' },
          buyer_address: { type: 'string' as const },
          seller_address: { type: 'string' as const },
          amount: { type: 'string' as const, description: 'Amount in smallest unit as string (for bigint support)' },
          token: { type: 'string' as const, default: 'native' },
        },
      },
    },
  }, async (request, reply) => {
    const { handshake_id, chain_id = 'off-chain', buyer_address, seller_address, amount, token = 'native' } =
      request.body as { handshake_id: string; chain_id?: string; buyer_address: string; seller_address: string; amount: string; token?: string };

    const trade = await repo.findById(handshake_id);
    if (!trade) return reply.status(404).send({ error: 'Trade not found' });
    if (trade.status !== 'accepted') {
      return reply.status(400).send({ error: `Trade must be in 'accepted' state, currently '${trade.status}'` });
    }

    const adapter = escrowRegistry.get(chain_id);
    if (!adapter) {
      return reply.status(400).send({ error: `No escrow adapter for chain '${chain_id}'. Available: ${escrowRegistry.list().map(a => a.chainId).join(', ')}` });
    }

    const result = await adapter.lockFunds({
      tradeId: handshake_id,
      buyer: buyer_address,
      seller: seller_address,
      amount: BigInt(amount),
      token,
    });

    await repo.transition(handshake_id, trade.version, 'escrowed');
    return { escrowId: result.escrowId, txHash: result.txHash, status: 'escrowed' };
  });

  server.post<{ Params: { escrowId: string } }>('/registry/escrow/:escrowId/confirm-delivery', {
    schema: { tags: ['negotiation'], summary: 'Confirm delivery and release escrowed funds' },
  }, async (request, reply) => {
    const { escrowId } = request.params;
    const escrowStatus = await confirmationEscrow.getEscrowStatus(escrowId);
    if (escrowStatus.status !== 'locked') {
      return reply.status(400).send({ error: `Escrow is not locked (status: ${escrowStatus.status})` });
    }

    const client = await pool.connect();
    try {
      const escrowRes = await client.query('SELECT trade_id FROM escrow_records WHERE escrow_id = $1', [escrowId]);
      if (escrowRes.rowCount === 0) return reply.status(404).send({ error: 'Escrow record not found' });

      const tradeId: string = escrowRes.rows[0].trade_id;
      const trade = await repo.findById(tradeId);
      if (!trade) return reply.status(404).send({ error: 'Trade not found' });
      if (trade.status !== 'escrowed') {
        return reply.status(400).send({ error: `Trade must be in 'escrowed' state, currently '${trade.status}'` });
      }

      const confirmed = await repo.transition(tradeId, trade.version, 'delivery_confirmed');

      const adapter = escrowRegistry.get('off-chain') || confirmationEscrow;
      const releaseResult = await adapter.releaseFunds({ escrowId, tradeId });

      const settleQuote: Record<string, any> = {};
      if (confirmed.trade_value !== null) settleQuote.trade_value = confirmed.trade_value;
      if (confirmed.currency !== null) settleQuote.currency = confirmed.currency;
      const settled = await repo.transition(tradeId, confirmed.version, 'settled', Object.keys(settleQuote).length > 0 ? settleQuote : undefined);

      return { status: 'settled', txHash: releaseResult.txHash, trade: settled };
    } finally {
      client.release();
    }
  });

  server.post<{ Params: { escrowId: string } }>('/registry/escrow/:escrowId/dispute', {
    schema: { tags: ['negotiation'], summary: 'Dispute an escrowed trade' },
  }, async (request, reply) => {
    const { escrowId } = request.params;

    const client = await pool.connect();
    try {
      const escrowRes = await client.query('SELECT trade_id FROM escrow_records WHERE escrow_id = $1', [escrowId]);
      if (escrowRes.rowCount === 0) return reply.status(404).send({ error: 'Escrow record not found' });

      const tradeId: string = escrowRes.rows[0].trade_id;
      const trade = await repo.findById(tradeId);
      if (!trade) return reply.status(404).send({ error: 'Trade not found' });
      if (trade.status !== 'escrowed') {
        return reply.status(400).send({ error: `Trade must be in 'escrowed' state, currently '${trade.status}'` });
      }

      const updated = await repo.transition(tradeId, trade.version, 'disputed');
      return { status: 'disputed', trade: updated };
    } finally {
      client.release();
    }
  });

  server.post<{ Params: { escrowId: string }; Body: { resolution: 'release' | 'refund' } }>('/registry/escrow/:escrowId/resolve', {
    schema: {
      tags: ['negotiation'],
      summary: 'Resolve a disputed escrow',
      body: {
        type: 'object' as const,
        required: ['resolution'],
        properties: {
          resolution: { type: 'string' as const, enum: ['release', 'refund'] },
        },
      },
    },
  }, async (request, reply) => {
    const { escrowId } = request.params;
    const { resolution } = request.body;

    const client = await pool.connect();
    try {
      const escrowRes = await client.query('SELECT trade_id FROM escrow_records WHERE escrow_id = $1', [escrowId]);
      if (escrowRes.rowCount === 0) return reply.status(404).send({ error: 'Escrow record not found' });

      const tradeId: string = escrowRes.rows[0].trade_id;
      const trade = await repo.findById(tradeId);
      if (!trade) return reply.status(404).send({ error: 'Trade not found' });
      if (trade.status !== 'disputed') {
        return reply.status(400).send({ error: `Trade must be in 'disputed' state, currently '${trade.status}'` });
      }

      const adapter = escrowRegistry.get('off-chain') || confirmationEscrow;
      let txHash: string;

      if (resolution === 'release') {
        const result = await adapter.releaseFunds({ escrowId, tradeId });
        txHash = result.txHash;
      } else {
        const result = await adapter.refundFunds({ escrowId, tradeId });
        txHash = result.txHash;
      }

      const resolved = await repo.transition(tradeId, trade.version, 'resolved');

      if (resolution === 'release') {
        const settleQuote: Record<string, any> = {};
        if (resolved.trade_value !== null) settleQuote.trade_value = resolved.trade_value;
        if (resolved.currency !== null) settleQuote.currency = resolved.currency;
        const settled = await repo.transition(tradeId, resolved.version, 'settled', Object.keys(settleQuote).length > 0 ? settleQuote : undefined);
        return { status: 'settled', resolution, txHash, trade: settled };
      }

      return { status: 'resolved', resolution, txHash, trade: resolved };
    } finally {
      client.release();
    }
  });

  server.get<{ Params: { escrowId: string } }>('/registry/escrow/:escrowId', {
    schema: { tags: ['negotiation'], summary: 'Get escrow status' },
  }, async (request, reply) => {
    const { escrowId } = request.params;

    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT escrow_id, trade_id, adapter, chain_id, buyer_address, seller_address,
                amount, token, status, tx_hash, created_at, updated_at
         FROM escrow_records WHERE escrow_id = $1`,
        [escrowId]
      );
      if (res.rowCount === 0) return reply.status(404).send({ error: 'Escrow record not found' });
      return res.rows[0];
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // Admin API
  // -------------------------------------------------------------------------
  server.get('/admin/api/stats', {
    schema: { tags: ['admin'], summary: 'Platform statistics' },
  }, async () => {
    return await repo.getStats();
  });

  server.get('/admin/api/trades', {
    schema: { tags: ['admin'], summary: 'Recent trades' },
  }, async (request) => {
    const { limit } = request.query as { limit?: number };
    return await repo.getRecentTrades(limit || 20);
  });

  server.get('/admin/api/fee-config', {
    schema: { tags: ['admin'], summary: 'Get fee configuration' },
  }, async () => {
    return await feeRepo.get();
  });

  server.put<{ Body: { fee_bps: number; min_fee?: number | null; max_fee?: number | null } }>(
    '/admin/api/fee-config',
    {
      schema: {
        tags: ['admin'],
        summary: 'Update fee configuration',
        body: FeeConfigSchema,
      },
    },
    async (request) => {
      const { fee_bps, min_fee = null, max_fee = null } = request.body;
      return await feeRepo.set({ fee_bps, min_fee, max_fee });
    }
  );

  server.get('/admin/api/disputes', {
    schema: { tags: ['admin'], summary: 'List all disputed trades awaiting resolution' },
  }, async () => {
    return await repo.getDisputedTrades();
  });

  server.post<{ Params: { id: string }; Body: { releaseToOwner: 'buyer' | 'seller'; reason: string } }>(
    '/admin/api/disputes/:id/resolve',
    {
      schema: {
        tags: ['admin'],
        summary: 'Resolve a disputed trade',
        body: {
          type: 'object' as const,
          required: ['releaseToOwner', 'reason'],
          properties: {
            releaseToOwner: { type: 'string' as const, enum: ['buyer', 'seller'], description: 'Release funds to buyer or refund to seller' },
            reason: { type: 'string' as const, description: 'Reason for resolution' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { releaseToOwner, reason } = request.body;
      const trade = await repo.findById(id);
      if (!trade) return reply.status(404).send({ error: 'Trade not found' });
      if (trade.status !== 'disputed') {
        return reply.status(400).send({ error: `Trade is not disputed (status: ${trade.status})` });
      }
      return await repo.resolveDispute(id, trade.version, releaseToOwner, reason);
    }
  );

  // -------------------------------------------------------------------------
  // Admin Auth
  // -------------------------------------------------------------------------
  server.post('/admin/api/login', {
    schema: { tags: ['admin'], summary: 'Authenticate with admin key', hide: true },
  }, async (request, reply) => {
    const { key } = request.body as { key?: string };
    if (key !== adminKey) {
      return reply.status(401).send({ error: 'Invalid admin key' });
    }
    const value = JSON.stringify({ authenticated: true, ts: Date.now() });
    reply.setCookie('admin_session', value, {
      path: '/admin',
      signed: true,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 86400,
    });
    return { ok: true };
  });

  server.post('/admin/api/logout', {
    schema: { tags: ['admin'], summary: 'Log out admin session', hide: true },
  }, async (_request, reply) => {
    reply.clearCookie('admin_session', { path: '/admin' });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // OpenAPI JSON
  // -------------------------------------------------------------------------
  server.get('/openapi.json', { schema: { hide: true } }, async (_req, reply) => {
    reply.type('application/json');
    return server.swagger();
  });

  return server;
}
