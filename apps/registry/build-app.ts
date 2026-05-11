import path from 'path';
import fastify, { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import staticPlugin from '@fastify/static';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { Pool } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UINT64 = BigInt('18446744073709551615');
const META_MAX_BYTES = 1024; // 1 KB

/** Sanitize adapter/viem errors to avoid leaking RPC URLs, stack traces, or Cloudflare HTML. */
function sanitizeAdapterError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Known application-level messages we authored — safe to surface
  const safePatterns = [
    /^metadata\.deposit_tx_hash is required/,
    /^Invalid deposit_tx_hash format/,
    /^Deposit transaction .{10,70} failed on-chain$/,
    /^Deposit tx recipient .+ does not match escrow address/,
    /^Deposit amount .+ is less than required/,
    /^Escrow .+ is not in locked state/,
    /^Escrow record .+ not found$/,
    /^Failed to update escrow/,
  ];
  if (safePatterns.some(p => p.test(raw))) return raw;
  // Everything else (viem internals, RPC errors, Cloudflare pages) gets scrubbed
  return fallback;
}

import { AssetManifest } from '@a2a/types';
import { PostgresNegotiationRepository } from './negotiation-repo';
import { FeeConfigRepository } from './fee-config';
import { EscrowRegistry, ConfirmationEscrowAdapter } from './escrow';
import { recordResponse } from './alert';
import { NotificationService, STATUS_EVENT_MAP } from './notifications';
import { ReputationService } from './reputation';
import { registerAnalyticsRoutes } from './analytics';

export interface AppDeps {
  pool: Pool;
  adminKey?: string;
  cookieSecret?: string;
  logger?: boolean;
  skipStatic?: boolean;
}

export interface AppResult {
  server: FastifyInstance;
  escrowRegistry: EscrowRegistry;
  notificationService: NotificationService;
  reputationService: ReputationService;
}

export async function buildApp(deps: AppDeps): Promise<AppResult> {
  const { pool, logger = true, skipStatic = false } = deps;
  const adminKey = deps.adminKey ?? process.env.ADMIN_API_KEY;
  if (!adminKey) {
    throw new Error('ADMIN_API_KEY must be set (via deps.adminKey or ADMIN_API_KEY env var)');
  }
  const cookieSecret = deps.cookieSecret ?? process.env.COOKIE_SECRET ?? adminKey;

  const server = fastify({ logger });
  const repo = new PostgresNegotiationRepository(pool);
  const feeRepo = new FeeConfigRepository(pool);
  const confirmationEscrow = new ConfirmationEscrowAdapter(pool);
  const escrowRegistry = new EscrowRegistry(confirmationEscrow);
  const notificationService = new NotificationService(pool);
  const reputationService = new ReputationService(pool);

  // Register chain-specific escrow adapters (opt-in via env vars)
  // Deferred to caller / startup code to avoid importing heavy deps in tests

  // -------------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------------

  // CORS — allow only our own origin in production; all origins in dev/test
  const allowedOrigin = process.env.NODE_ENV === 'production'
    ? 'https://swarmtrade.store'
    : true;
  await server.register(cors, {
    origin: allowedOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-agent-id', 'x-admin-key'],
    credentials: true,
  });

  // Rate limiting — global 100 req/min per IP
  await server.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({ error: 'Too many requests' }),
  });

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
        { name: 'reputation', description: 'Agent trust scores & trade ratings' },
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

    // Serve root-level public pages (index, faq, etc.)
    await server.register(staticPlugin, {
      root: path.join(__dirname, 'public'),
      prefix: '/',
      decorateReply: false,
      serve: false,  // don't auto-serve; we use explicit routes below
    });
  }

  // -------------------------------------------------------------------------
  // Public-facing pages (root level)
  // -------------------------------------------------------------------------
  server.get('/', { schema: { hide: true } }, async (_req, reply) => {
    return reply.sendFile('index.html');
  });

  server.get('/faq', { schema: { hide: true } }, async (_req, reply) => {
    return reply.sendFile('faq.html');
  });

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
  // Track 5xx rate for Slack alerting (no-op when SLACK_WEBHOOK_URL is unset)
  server.addHook('onSend', async (request, reply) => {
    recordResponse(reply.statusCode);
  });

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
      summary: 'Health check with database and escrow readiness',
      response: {
        200: {
          type: 'object' as const,
          properties: {
            status: { type: 'string' as const, enum: ['healthy', 'degraded', 'unhealthy'] },
            timestamp: { type: 'string' as const },
            db_connected: { type: 'boolean' as const },
            escrow_ready: { type: 'boolean' as const },
            checks: {
              type: 'object' as const,
              properties: {
                database: { type: 'string' as const },
                escrow: { type: 'string' as const },
              },
            },
            adapters: {
              type: 'array' as const,
              items: {
                type: 'object' as const,
                properties: {
                  chainId: { type: 'string' as const },
                  name: { type: 'string' as const },
                  escrowAddress: { type: 'string' as const },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    let dbConnected = false;
    let escrowReady = false;
    const checks: Record<string, string> = {};

    // Check database connectivity
    const client = await pool.connect().catch(() => {
      checks.database = 'Connection failed';
      return null;
    });

    if (client) {
      try {
        await client.query('SELECT 1');
        dbConnected = true;
        checks.database = 'OK';
      } catch {
        checks.database = 'Query failed';
      } finally {
        client.release();
      }
    }

    // Check escrow registry readiness
    try {
      const adapters = escrowRegistry.list();
      escrowReady = adapters.length > 0;
      checks.escrow = escrowReady ? `Ready (${adapters.length} adapters)` : 'No adapters registered';
    } catch {
      checks.escrow = 'Error checking escrow readiness';
    }

    const status = dbConnected && escrowReady ? 'healthy' : dbConnected ? 'degraded' : 'unhealthy';
    const statusCode = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;

    return reply.status(statusCode).send({
      status,
      timestamp: new Date().toISOString(),
      db_connected: dbConnected,
      escrow_ready: escrowReady,
      checks,
      adapters: escrowRegistry.list(),
    });
  });

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------
  server.post<{ Body: AssetManifest }>('/registry/announce', {
    schema: { tags: ['registry'], summary: 'Announce an asset', body: AssetManifestSchema },
  }, async (request, reply) => {
    const asset = request.body;
    const metaStr = JSON.stringify(asset.metadata ?? {});
    if (Buffer.byteLength(metaStr, 'utf8') > META_MAX_BYTES) {
      return reply.status(400).send({ error: 'metadata exceeds 1KB limit' });
    }
    const client = await pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO asset_announcements (asset_id, agent_id, agent_card, asset_type, metadata)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [asset.asset_id, asset.agent_card.id, JSON.stringify(asset.agent_card), asset.type, metaStr]
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
    const trade = await repo.create(request.body as any);
    notificationService.notify('trade.proposed', trade.id, {
      buyer_id: trade.buyer_id,
      seller_id: trade.seller_id,
      asset_id: trade.asset_id,
      status: trade.status,
      trade_value: trade.trade_value,
      currency: trade.currency,
    });
    return trade;
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
      const updated = await repo.transition(id, fromVersion, nextState, quote);
      const event = STATUS_EVENT_MAP[nextState];
      if (event) {
        notificationService.notify(event, updated.id, {
          buyer_id: updated.buyer_id,
          seller_id: updated.seller_id,
          asset_id: updated.asset_id,
          status: updated.status,
          trade_value: updated.trade_value,
          currency: updated.currency,
          fee_amount: updated.fee_amount,
        });
      }
      return updated;
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
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['negotiation'],
      summary: 'Lock funds in escrow for a trade',
      description: 'For on-chain adapters (EVM, NEAR), the buyer must first deposit funds to the platform escrow wallet on the target chain, then supply the resulting tx hash as metadata.deposit_tx_hash so the adapter can verify the deposit before locking.',
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
          metadata: {
            type: 'object' as const,
            description: 'Chain-specific metadata. For EVM/NEAR include deposit_tx_hash.',
            properties: {
              deposit_tx_hash: { type: 'string' as const, description: 'On-chain tx hash of the buyer\'s deposit to the platform wallet' },
            },
            additionalProperties: true,
          },
        },
      },
    },
  }, async (request, reply) => {
    const { handshake_id, chain_id = 'off-chain', buyer_address, seller_address, amount, token = 'native', metadata } =
      request.body as { handshake_id: string; chain_id?: string; buyer_address: string; seller_address: string; amount: string; token?: string; metadata?: Record<string, unknown> };

    if (metadata) {
      const metaSize = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
      if (metaSize > 1024) {
        return reply.status(400).send({ error: 'metadata exceeds 1KB limit' });
      }
    }

    if (!UUID_RE.test(handshake_id)) return reply.status(400).send({ error: 'Invalid handshake_id format' });
    let amountBig: bigint;
    try {
      amountBig = BigInt(amount);
    } catch {
      return reply.status(400).send({ error: 'Invalid amount: must be a non-negative integer string' });
    }
    if (amountBig <= 0n) return reply.status(400).send({ error: 'Amount must be greater than zero' });
    if (amountBig > MAX_UINT64) return reply.status(400).send({ error: 'Amount exceeds maximum allowed value' });

    const trade = await repo.findById(handshake_id);
    if (!trade) return reply.status(404).send({ error: 'Trade not found' });
    if (trade.status !== 'accepted') {
      return reply.status(400).send({ error: `Trade must be in 'accepted' state, currently '${trade.status}'` });
    }

    const adapter = escrowRegistry.get(chain_id);
    if (!adapter) {
      return reply.status(400).send({ error: `No escrow adapter for chain '${chain_id}'. Available: ${escrowRegistry.list().map(a => a.chainId).join(', ')}` });
    }

    let result;
    try {
      result = await adapter.lockFunds({
        tradeId: handshake_id,
        buyer: buyer_address,
        seller: seller_address,
        amount: amountBig,
        token,
        metadata,
      });
    } catch (err: any) {
      // Surface known validation errors; scrub RPC/viem internals
      server.log.error({ err }, 'Escrow lock adapter error');
      const msg = sanitizeAdapterError(err, 'Escrow lock failed — deposit transaction could not be verified on chain');
      return reply.status(400).send({ error: msg });
    }

    const escrowed = await repo.transition(handshake_id, trade.version, 'escrowed');
    notificationService.notify('escrow.locked', handshake_id, {
      buyer_id: escrowed.buyer_id,
      seller_id: escrowed.seller_id,
      asset_id: escrowed.asset_id,
      status: escrowed.status,
      trade_value: escrowed.trade_value,
      currency: escrowed.currency,
      escrow_id: result.escrowId,
    });
    return { escrowId: result.escrowId, txHash: result.txHash, status: 'escrowed' };
  });

  server.post<{ Params: { escrowId: string } }>('/registry/escrow/:escrowId/confirm-delivery', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['negotiation'], summary: 'Confirm delivery and release escrowed funds' },
  }, async (request, reply) => {
    const { escrowId } = request.params;
    if (!UUID_RE.test(escrowId)) return reply.status(400).send({ error: 'Invalid escrowId format' });
    const escrowStatus = await confirmationEscrow.getEscrowStatus(escrowId);
    if (escrowStatus.status !== 'locked') {
      return reply.status(400).send({ error: `Escrow is not locked (status: ${escrowStatus.status})` });
    }

    const client = await pool.connect();
    try {
      const escrowRes = await client.query('SELECT trade_id, chain_id FROM escrow_records WHERE escrow_id = $1', [escrowId]);
      if (escrowRes.rowCount === 0) return reply.status(404).send({ error: 'Escrow record not found' });

      const tradeId: string = escrowRes.rows[0].trade_id;
      const chainId: string = escrowRes.rows[0].chain_id || 'off-chain';
      const trade = await repo.findById(tradeId);
      if (!trade) return reply.status(404).send({ error: 'Trade not found' });
      if (trade.status !== 'escrowed') {
        return reply.status(400).send({ error: `Trade must be in 'escrowed' state, currently '${trade.status}'` });
      }

      const confirmed = await repo.transition(tradeId, trade.version, 'delivery_confirmed');
      notificationService.notify('delivery.confirmed', tradeId, {
        buyer_id: confirmed.buyer_id,
        seller_id: confirmed.seller_id,
        asset_id: confirmed.asset_id,
        status: confirmed.status,
        trade_value: confirmed.trade_value,
        currency: confirmed.currency,
        escrow_id: escrowId,
      });

      const adapter = escrowRegistry.get(chainId) || confirmationEscrow;
      let releaseResult;
      try {
        releaseResult = await adapter.releaseFunds({ escrowId, tradeId });
      } catch (err: any) {
        server.log.error({ err }, 'Escrow release adapter error');
        return reply.status(500).send({ error: 'Failed to release escrowed funds on chain' });
      }

      const settleQuote: Record<string, any> = {};
      if (confirmed.trade_value !== null) settleQuote.trade_value = confirmed.trade_value;
      if (confirmed.currency !== null) settleQuote.currency = confirmed.currency;
      const settled = await repo.transition(tradeId, confirmed.version, 'settled', Object.keys(settleQuote).length > 0 ? settleQuote : undefined);
      notificationService.notify('trade.settled', tradeId, {
        buyer_id: settled.buyer_id,
        seller_id: settled.seller_id,
        asset_id: settled.asset_id,
        status: settled.status,
        trade_value: settled.trade_value,
        currency: settled.currency,
        fee_amount: settled.fee_amount,
        escrow_id: escrowId,
      });

      // Update reputation for both parties
      reputationService.recordSettlement(settled.buyer_id, settled.seller_id).catch(err => {
        server.log.error({ err }, 'Failed to record reputation settlement');
      });

      return { status: 'settled', txHash: releaseResult.txHash, trade: settled };
    } finally {
      client.release();
    }
  });

  server.post<{ Params: { escrowId: string } }>('/registry/escrow/:escrowId/dispute', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['negotiation'], summary: 'Dispute an escrowed trade' },
  }, async (request, reply) => {
    const { escrowId } = request.params;
    if (!UUID_RE.test(escrowId)) return reply.status(400).send({ error: 'Invalid escrowId format' });

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
      notificationService.notify('trade.disputed', tradeId, {
        buyer_id: updated.buyer_id,
        seller_id: updated.seller_id,
        asset_id: updated.asset_id,
        status: updated.status,
        trade_value: updated.trade_value,
        currency: updated.currency,
        escrow_id: escrowId,
      });

      // Track dispute in reputation
      reputationService.recordDispute(updated.buyer_id, updated.seller_id).catch(err => {
        server.log.error({ err }, 'Failed to record reputation dispute');
      });

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
    if (!UUID_RE.test(escrowId)) return reply.status(400).send({ error: 'Invalid escrowId format' });

    const client = await pool.connect();
    try {
      const escrowRes = await client.query('SELECT trade_id, chain_id FROM escrow_records WHERE escrow_id = $1', [escrowId]);
      if (escrowRes.rowCount === 0) return reply.status(404).send({ error: 'Escrow record not found' });

      const tradeId: string = escrowRes.rows[0].trade_id;
      const chainId: string = escrowRes.rows[0].chain_id || 'off-chain';
      const trade = await repo.findById(tradeId);
      if (!trade) return reply.status(404).send({ error: 'Trade not found' });
      if (trade.status !== 'disputed') {
        return reply.status(400).send({ error: `Trade must be in 'disputed' state, currently '${trade.status}'` });
      }

      const adapter = escrowRegistry.get(chainId) || confirmationEscrow;
      let txHash: string;

      try {
        if (resolution === 'release') {
          const result = await adapter.releaseFunds({ escrowId, tradeId });
          txHash = result.txHash;
        } else {
          const result = await adapter.refundFunds({ escrowId, tradeId });
          txHash = result.txHash;
        }
      } catch (err: any) {
        server.log.error({ err }, 'Escrow resolve adapter error');
        return reply.status(500).send({ error: `Failed to ${resolution} escrowed funds on chain` });
      }

      const resolved = await repo.transition(tradeId, trade.version, 'resolved');
      notificationService.notify('trade.resolved', tradeId, {
        buyer_id: resolved.buyer_id,
        seller_id: resolved.seller_id,
        asset_id: resolved.asset_id,
        status: resolved.status,
        trade_value: resolved.trade_value,
        currency: resolved.currency,
        escrow_id: escrowId,
        resolution,
      });

      if (resolution === 'release') {
        const settleQuote: Record<string, any> = {};
        if (resolved.trade_value !== null) settleQuote.trade_value = resolved.trade_value;
        if (resolved.currency !== null) settleQuote.currency = resolved.currency;
        const settled = await repo.transition(tradeId, resolved.version, 'settled', Object.keys(settleQuote).length > 0 ? settleQuote : undefined);
        notificationService.notify('trade.settled', tradeId, {
          buyer_id: settled.buyer_id,
          seller_id: settled.seller_id,
          asset_id: settled.asset_id,
          status: settled.status,
          trade_value: settled.trade_value,
          currency: settled.currency,
          fee_amount: settled.fee_amount,
          escrow_id: escrowId,
        });
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
  // Admin Analytics API (behind admin auth hook)
  // -------------------------------------------------------------------------
  registerAnalyticsRoutes(server, pool);

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

  server.get('/admin/api/escrows', {
    schema: { tags: ['admin'], summary: 'List escrow records with pagination' },
  }, async (request) => {
    const { limit = 25, offset = 0 } = request.query as { limit?: number; offset?: number };
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT e.escrow_id, e.trade_id, e.adapter, e.chain_id,
                e.buyer_address, e.seller_address, e.amount, e.token,
                e.status, e.tx_hash, e.created_at, e.updated_at
         FROM escrow_records e
         ORDER BY e.created_at DESC
         LIMIT $1 OFFSET $2`,
        [Math.min(Number(limit), 100), Number(offset)]
      );
      const countRes = await client.query('SELECT COUNT(*) AS total FROM escrow_records');
      return { escrows: res.rows, total: parseInt(countRes.rows[0].total, 10) };
    } finally {
      client.release();
    }
  });

  server.post<{ Params: { id: string }; Body: { releaseToOwner: 'buyer' | 'seller'; reason: string } }>(
    '/admin/api/disputes/:id/resolve',
    {
      schema: {
        tags: ['admin'],
        summary: 'Resolve a disputed trade',
        description: 'releaseToOwner=seller releases funds to the seller (they delivered). releaseToOwner=buyer refunds the buyer (deal failed). Both branches call the escrow adapter to move funds.',
        body: {
          type: 'object' as const,
          required: ['releaseToOwner', 'reason'],
          properties: {
            releaseToOwner: { type: 'string' as const, enum: ['buyer', 'seller'], description: 'seller = release funds to seller; buyer = refund funds to buyer' },
            reason: { type: 'string' as const, description: 'Reason for resolution (audit trail)' },
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

      const client = await pool.connect();
      try {
        const escrowRes = await client.query(
          'SELECT escrow_id, chain_id FROM escrow_records WHERE trade_id = $1',
          [id]
        );
        if (escrowRes.rowCount === 0) {
          return reply.status(404).send({ error: 'Escrow record not found for trade' });
        }
        const escrowId: string = escrowRes.rows[0].escrow_id;
        const chainId: string = escrowRes.rows[0].chain_id || 'off-chain';
        const adapter = escrowRegistry.get(chainId) || confirmationEscrow;

        // releaseToOwner='seller' => seller wins the dispute => release escrowed funds to seller.
        // releaseToOwner='buyer'  => buyer wins the dispute  => refund escrowed funds to buyer.
        let txHash: string;
        try {
          if (releaseToOwner === 'seller') {
            const result = await adapter.releaseFunds({ escrowId, tradeId: id });
            txHash = result.txHash;
          } else {
            const result = await adapter.refundFunds({ escrowId, tradeId: id });
            txHash = result.txHash;
          }
        } catch (err: any) {
          server.log.error({ err }, 'Admin escrow resolve adapter error');
          const action = releaseToOwner === 'seller' ? 'release' : 'refund';
          return reply.status(500).send({ error: `Failed to ${action} escrowed funds on chain` });
        }

        const resolved = await repo.resolveDispute(id, trade.version, releaseToOwner, reason);
        notificationService.notify('trade.resolved', id, {
          buyer_id: resolved.buyer_id,
          seller_id: resolved.seller_id,
          asset_id: resolved.asset_id,
          status: resolved.status,
          trade_value: resolved.trade_value,
          currency: resolved.currency,
          escrow_id: escrowId,
          resolution: releaseToOwner,
        });

        // The loser of the dispute gets a disputes_lost mark
        const loserId = releaseToOwner === 'seller' ? resolved.buyer_id : resolved.seller_id;
        reputationService.recordDisputeResolution(loserId).catch(err => {
          server.log.error({ err }, 'Failed to record dispute resolution in reputation');
        });

        return { ...resolved, escrow_id: escrowId, escrow_tx_hash: txHash, released_to: releaseToOwner };
      } finally {
        client.release();
      }
    }
  );

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  server.post('/registry/notifications/subscribe', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['negotiation'],
      summary: 'Subscribe to trade notifications',
      body: {
        type: 'object' as const,
        properties: {
          webhook_url: { type: 'string' as const },
          email: { type: 'string' as const },
          events: { type: 'array' as const, items: { type: 'string' as const } },
        },
      },
    },
  }, async (request, reply) => {
    const agentId = request.headers['x-agent-id'] as string;
    const { webhook_url, email, events } = request.body as { webhook_url?: string; email?: string; events?: string[] };
    if (!webhook_url && !email) {
      return reply.status(400).send({ error: 'Either webhook_url or email must be provided' });
    }
    try {
      const sub = await notificationService.subscribe(agentId, { webhook_url, email, events });
      return sub;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  server.delete<{ Params: { id: string } }>('/registry/notifications/:id', {
    schema: { tags: ['negotiation'], summary: 'Unsubscribe from notifications' },
  }, async (request) => {
    const agentId = request.headers['x-agent-id'] as string;
    await notificationService.unsubscribe(agentId, request.params.id);
    return { ok: true };
  });

  server.get('/registry/notifications/subscriptions', {
    schema: { tags: ['negotiation'], summary: 'List active notification subscriptions' },
  }, async (request) => {
    const agentId = request.headers['x-agent-id'] as string;
    const subscriptions = await notificationService.getSubscriptions(agentId);
    return { subscriptions };
  });

  server.get('/registry/notifications/log', {
    schema: { tags: ['negotiation'], summary: 'Get notification log for this agent' },
  }, async (request) => {
    const agentId = request.headers['x-agent-id'] as string;
    const { limit, offset } = request.query as { limit?: number; offset?: number };
    return await notificationService.getNotificationLog(agentId, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Reputation
  // -------------------------------------------------------------------------

  server.get<{ Params: { agentId: string } }>('/registry/reputation/:agentId', {
    schema: {
      tags: ['reputation'],
      summary: 'Get agent reputation and trust score',
      params: {
        type: 'object' as const,
        properties: { agentId: { type: 'string' as const } },
        required: ['agentId'],
      },
      response: {
        200: {
          type: 'object' as const,
          properties: {
            agent_id: { type: 'string' as const },
            total_trades: { type: 'integer' as const },
            successful_trades: { type: 'integer' as const },
            disputed_trades: { type: 'integer' as const },
            disputes_lost: { type: 'integer' as const },
            avg_rating: { type: 'number' as const, nullable: true },
            trust_score: { type: 'integer' as const, minimum: 0, maximum: 100 },
            last_trade_at: { type: 'string' as const, nullable: true },
          },
        },
      },
    },
  }, async (request) => {
    const { agentId } = request.params;
    return await reputationService.getReputation(agentId);
  });

  server.get<{ Params: { agentId: string } }>('/registry/reputation/:agentId/ratings', {
    schema: {
      tags: ['reputation'],
      summary: 'Get ratings received by an agent',
      params: {
        type: 'object' as const,
        properties: { agentId: { type: 'string' as const } },
        required: ['agentId'],
      },
    },
  }, async (request) => {
    const { agentId } = request.params;
    const { limit } = request.query as { limit?: number };
    return await reputationService.getRatings(agentId, limit ? Number(limit) : 20);
  });

  server.post('/registry/reputation/rate', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['reputation'],
      summary: 'Rate a trade counterparty',
      description: 'Submit a 1-5 star rating for the other party in a settled trade. Each agent can only rate once per trade.',
      body: {
        type: 'object' as const,
        required: ['trade_id', 'ratee_id', 'rating'],
        properties: {
          trade_id: { type: 'string' as const },
          ratee_id: { type: 'string' as const },
          rating: { type: 'integer' as const, minimum: 1, maximum: 5 },
          comment: { type: 'string' as const, maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const agentId = request.headers['x-agent-id'] as string;
    const { trade_id, ratee_id, rating, comment } = request.body as {
      trade_id: string; ratee_id: string; rating: number; comment?: string;
    };

    // Verify the trade exists and is settled, and the rater was a participant
    const trade = await repo.findById(trade_id);
    if (!trade) return reply.status(404).send({ error: 'Trade not found' });
    if (trade.status !== 'settled' && trade.status !== 'resolved') {
      return reply.status(400).send({ error: 'Can only rate settled or resolved trades' });
    }
    if (trade.buyer_id !== agentId && trade.seller_id !== agentId) {
      return reply.status(403).send({ error: 'Only trade participants can rate' });
    }
    if (ratee_id !== trade.buyer_id && ratee_id !== trade.seller_id) {
      return reply.status(400).send({ error: 'ratee_id must be the other trade participant' });
    }

    try {
      const result = await reputationService.submitRating({
        tradeId: trade_id,
        raterId: agentId,
        rateeId: ratee_id,
        rating,
        comment,
      });
      return result;
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Admin notifications view
  server.get('/admin/api/notifications', {
    schema: { tags: ['admin'], summary: 'List all notification log entries' },
  }, async (request) => {
    const { limit, offset } = request.query as { limit?: number; offset?: number };
    return await notificationService.getAllNotificationLog({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Admin Auth
  // -------------------------------------------------------------------------
  server.post('/admin/api/login', {
    schema: { tags: ['admin'], summary: 'Authenticate with admin key', hide: true },
  }, async (request, reply) => {
    const { key, password } = request.body as { key?: string; password?: string };
    const provided = key || password;
    if (provided !== adminKey) {
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

  // -------------------------------------------------------------------------
  // Global error handler — scrub DB internals from responses
  // -------------------------------------------------------------------------
  server.setErrorHandler(async (error, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // Never expose DB messages, stack traces, or column names
      server.log.error({ err: error }, 'Unhandled error');
      return reply.status(500).send({ error: 'Internal server error' });
    }
    // 4xx: pass through the message Fastify already set (validation, rate-limit, etc.)
    return reply.status(status).send({ error: error.message ?? 'Bad request' });
  });

  return { server, escrowRegistry, notificationService, reputationService };
}
