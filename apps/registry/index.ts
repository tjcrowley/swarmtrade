import path from 'path';
import fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import staticPlugin from '@fastify/static';


import { AssetManifest } from '@a2a/types';
import pool, { verifyConnection } from './db';
import { PostgresNegotiationRepository } from './negotiation-repo';
import { FeeConfigRepository } from './fee-config';



const server = fastify({ logger: true });
const repo = new PostgresNegotiationRepository(pool);
const feeRepo = new FeeConfigRepository(pool);

const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'changeme';

// ---------------------------------------------------------------------------
// OpenAPI / Swagger
// ---------------------------------------------------------------------------
async function registerDocs() {
  await server.register(swagger, {
    openapi: {
      info: {
        title: 'SwarmTrade Registry API',
        description:
          'Domain-agnostic asset registry for autonomous agent-to-agent commerce.',
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
}

// ---------------------------------------------------------------------------
// Static — admin dashboard served at /admin/
// ---------------------------------------------------------------------------
async function registerStatic() {
  await server.register(staticPlugin, {
    root: path.join(__dirname, 'public'),
    prefix: '/admin/',
  });
}

// ---------------------------------------------------------------------------
// JSON Schemas
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS vector;

      CREATE TABLE IF NOT EXISTS asset_announcements (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          asset_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_card JSONB NOT NULL,
          asset_type TEXT NOT NULL,
          metadata JSONB NOT NULL,
          embedding VECTOR(768),
          status TEXT DEFAULT 'available',
          created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS handshakes (
          handshake_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          buyer_id TEXT NOT NULL,
          seller_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'proposed',
          quote JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
      ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS trade_value NUMERIC(20,8);
      ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS currency TEXT;
      ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS fee_bps INTEGER;
      ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(20,8);

      CREATE TABLE IF NOT EXISTS platform_config (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      INSERT INTO platform_config (key, value)
      VALUES ('fee_config', '{"fee_bps": 150, "min_fee": null, "max_fee": null}')
      ON CONFLICT (key) DO NOTHING;
    `);
    console.log('[init] Database migrated.');
  } catch (err) {
    console.error('[init] Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Auth hooks
// ---------------------------------------------------------------------------

// Agent routes: require x-agent-id
server.addHook('preHandler', async (request, reply) => {
  const url = request.url;
  if (url.startsWith('/admin') || url.startsWith('/health') || url.startsWith('/docs') || url.startsWith('/openapi')) return;
  if (!request.headers['x-agent-id']) {
    return reply.status(401).send({ error: 'Unauthorized: Missing x-agent-id header' });
  }
});

// Admin API routes: require x-admin-key
server.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/admin/api')) return;
  if (request.headers['x-admin-key'] !== ADMIN_KEY) {
    return reply.status(403).send({ error: 'Forbidden' });
  }
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
server.get('/health', {
  schema: {
    tags: ['health'],
    summary: 'Health check',
    response: { 200: { type: 'object' as const, properties: { status: { type: 'string' as const }, timestamp: { type: 'string' as const } } } },
  },
}, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Admin API (x-admin-key protected)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// OpenAPI JSON
// ---------------------------------------------------------------------------
server.get('/openapi.json', { schema: { hide: true } }, async (_req, reply) => {
  reply.type('application/json');
  return server.swagger();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const start = async () => {
  await registerDocs();
  await registerStatic();
  await verifyConnection();
  await migrate();
  try {
    await server.listen({ port: Number(process.env.PORT) || 8080, host: '0.0.0.0' });
    console.log('[start] SwarmTrade Registry API is live');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
