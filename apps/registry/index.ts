import fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { AssetManifest } from '@a2a/types';
import pool, { verifyConnection } from './db';
import { PostgresNegotiationRepository } from './negotiation-repo';

const server = fastify({ logger: true });
const repo = new PostgresNegotiationRepository(pool);

// ---------------------------------------------------------------------------
// OpenAPI / Swagger
// ---------------------------------------------------------------------------
async function registerDocs() {
  await server.register(swagger, {
    openapi: {
      info: {
        title: 'SwarmTrade Registry API',
        description:
          'Domain-agnostic asset registry for autonomous agent-to-agent commerce. ' +
          'Implements the A2A AgentCard pattern for capability discovery.',
        version: '0.1.0',
        contact: { name: 'SwarmTrade', url: 'https://swarmtrade.store' },
      },
      servers: [
        { url: 'https://swarmtrade.store', description: 'Production' },
        { url: 'http://localhost:8080', description: 'Local development' },
      ],
      tags: [
        { name: 'registry', description: 'Asset announcement & discovery' },
        { name: 'health', description: 'Service health' },
      ],
    },
  });

  await server.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });
}

// ---------------------------------------------------------------------------
// JSON Schemas (shared between routes and OpenAPI generation)
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
    asset_id: { type: 'string' as const, description: 'SHA-256 asset identifier' },
    type: {
      type: 'string' as const,
      enum: ['physical', 'service', 'license', 'digital_data'],
    },
    metadata: { type: 'object' as const, additionalProperties: true },
    status: {
      type: 'string' as const,
      enum: ['available', 'pending', 'locked', 'transferred'],
    },
    agent_card: AgentCardSchema,
    created_at: { type: 'string' as const, format: 'date-time' },
  },
  required: ['asset_id', 'type', 'metadata', 'agent_card'],
};

// ---------------------------------------------------------------------------
// Database migration
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
          state TEXT NOT NULL DEFAULT 'INIT',
          quote JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );
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
// Routes
// ---------------------------------------------------------------------------

// Root redirect removed (handled by landing page component in app-spec)


// Health check
server.get(
  '/health',
  {
    schema: {
      tags: ['health'],
      summary: 'Health check',
      response: {
        200: {
          type: 'object' as const,
          properties: {
            status: { type: 'string' as const },
            timestamp: { type: 'string' as const, format: 'date-time' },
          },
        },
      },
    },
  },
  async () => ({ status: 'ok', timestamp: new Date().toISOString() })
);

// Announce an asset
server.post<{ Body: AssetManifest }>(
  '/registry/announce',
  {
    schema: {
      tags: ['registry'],
      summary: 'Register an asset on the marketplace',
      description:
        'Agents call this endpoint to announce an asset for trade. ' +
        'The payload must include a valid A2A AgentCard.',
      body: AssetManifestSchema,
      response: {
        200: {
          type: 'object' as const,
          properties: {
            status: { type: 'string' as const },
            id: { type: 'string' as const, format: 'uuid' },
          },
        },
      },
    },
  },
  async (request) => {
    const asset = request.body;
    const client = await pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO asset_announcements
           (asset_id, agent_id, agent_card, asset_type, metadata)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          asset.asset_id,
          asset.agent_card.id,
          JSON.stringify(asset.agent_card),
          asset.type,
          JSON.stringify(asset.metadata),
        ]
      );
      return { status: 'registered', id: res.rows[0].id };
    } finally {
      client.release();
    }
  }
);

// Middleware for agent authentication (Basic agent_id header check)
server.addHook('preHandler', async (request, reply) => {
  const agentId = request.headers['x-agent-id'];
  if (!agentId) {
    return reply.status(401).send({ error: 'Unauthorized: Missing x-agent-id header' });
  }
});

// Handshake endpoints
server.post('/registry/handshake', async (request, reply) => {
  const params = request.body as any; // Validation logic TBD
  return await repo.create(params);
});

server.post('/registry/negotiation/:id/transition', async (request, reply) => {
  const { id } = request.params as any;
  const { fromVersion, nextState, quote } = request.body as any;
  try {
    return await repo.transition(id, fromVersion, nextState, quote);
  } catch (err: any) {
    if (err.message === 'StaleVersionError') {
      return reply.status(409).send({ error: 'Conflict: Negotiation state has changed.' });
    }
    throw err;
  }
});

// Search / list assets
server.get(
  '/registry/search',
  {
    schema: {
      tags: ['registry'],
      summary: 'Search available assets',
      description: 'Returns all asset announcements. Filtering and vector search coming soon.',
      querystring: {
        type: 'object' as const,
        properties: {
          type: {
            type: 'string' as const,
            enum: ['physical', 'service', 'license', 'digital_data'],
            description: 'Filter by asset type',
          },
          status: {
            type: 'string' as const,
            enum: ['available', 'pending', 'locked', 'transferred'],
            description: 'Filter by asset status',
          },
          limit: {
            type: 'integer' as const,
            minimum: 1,
            maximum: 100,
            default: 50,
            description: 'Max results to return',
          },
        },
      },
      response: {
        200: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              id: { type: 'string' as const, format: 'uuid' },
              asset_id: { type: 'string' as const },
              agent_id: { type: 'string' as const },
              agent_card: AgentCardSchema,
              asset_type: { type: 'string' as const },
              metadata: { type: 'object' as const, additionalProperties: true },
              status: { type: 'string' as const },
              created_at: { type: 'string' as const, format: 'date-time' },
            },
          },
        },
      },
    },
  },
  async (request) => {
    const { type, status, limit } = request.query as {
      type?: string;
      status?: string;
      limit?: number;
    };

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (type) {
      conditions.push(`asset_type = $${idx++}`);
      params.push(type);
    }
    if (status) {
      conditions.push(`status = $${idx++}`);
      params.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM asset_announcements ${where} ORDER BY created_at DESC LIMIT $${idx}`;
    params.push(limit || 50);

    const client = await pool.connect();
    try {
      const res = await client.query(sql, params);
      return res.rows;
    } finally {
      client.release();
    }
  }
);

// Expose raw OpenAPI JSON
server.get(
  '/openapi.json',
  { schema: { hide: true } },
  async (_request, reply) => {
    reply.type('application/json');
    return server.swagger();
  }
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
const start = async () => {
  await registerDocs();
  await verifyConnection();
  await migrate();

  try {
    await server.listen({
      port: Number(process.env.PORT) || 8080,
      host: '0.0.0.0',
    });
    console.log('[start] SwarmTrade Registry API is live');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
