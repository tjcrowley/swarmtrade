"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const swagger_1 = __importDefault(require("@fastify/swagger"));
const swagger_ui_1 = __importDefault(require("@fastify/swagger-ui"));
const db_1 = __importStar(require("./db"));
const server = (0, fastify_1.default)({ logger: true });
// ---------------------------------------------------------------------------
// OpenAPI / Swagger
// ---------------------------------------------------------------------------
async function registerDocs() {
    await server.register(swagger_1.default, {
        openapi: {
            info: {
                title: 'SwarmTrade Registry API',
                description: 'Domain-agnostic asset registry for autonomous agent-to-agent commerce. ' +
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
    await server.register(swagger_ui_1.default, {
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
    type: 'object',
    properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        capabilities: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
    },
    required: ['id', 'name', 'capabilities', 'description', 'metadata'],
};
const AssetManifestSchema = {
    type: 'object',
    properties: {
        asset_id: { type: 'string', description: 'SHA-256 asset identifier' },
        type: {
            type: 'string',
            enum: ['physical', 'service', 'license', 'digital_data'],
        },
        metadata: { type: 'object', additionalProperties: true },
        status: {
            type: 'string',
            enum: ['available', 'pending', 'locked', 'transferred'],
        },
        agent_card: AgentCardSchema,
        created_at: { type: 'string', format: 'date-time' },
    },
    required: ['asset_id', 'type', 'metadata', 'agent_card'],
};
// ---------------------------------------------------------------------------
// Database migration
// ---------------------------------------------------------------------------
async function migrate() {
    const client = await db_1.default.connect();
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
          state TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
        console.log('[init] Database migrated.');
    }
    catch (err) {
        console.error('[init] Migration failed:', err);
        process.exit(1);
    }
    finally {
        client.release();
    }
}
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
// Health check
server.get('/health', {
    schema: {
        tags: ['health'],
        summary: 'Health check',
        response: {
            200: {
                type: 'object',
                properties: {
                    status: { type: 'string' },
                    timestamp: { type: 'string', format: 'date-time' },
                },
            },
        },
    },
}, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));
// Announce an asset
server.post('/registry/announce', {
    schema: {
        tags: ['registry'],
        summary: 'Register an asset on the marketplace',
        description: 'Agents call this endpoint to announce an asset for trade. ' +
            'The payload must include a valid A2A AgentCard.',
        body: AssetManifestSchema,
        response: {
            200: {
                type: 'object',
                properties: {
                    status: { type: 'string' },
                    id: { type: 'string', format: 'uuid' },
                },
            },
        },
    },
}, async (request) => {
    const asset = request.body;
    const client = await db_1.default.connect();
    try {
        const res = await client.query(`INSERT INTO asset_announcements
           (asset_id, agent_id, agent_card, asset_type, metadata)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`, [
            asset.asset_id,
            asset.agent_card.id,
            JSON.stringify(asset.agent_card),
            asset.type,
            JSON.stringify(asset.metadata),
        ]);
        return { status: 'registered', id: res.rows[0].id };
    }
    finally {
        client.release();
    }
});
// Search / list assets
server.get('/registry/search', {
    schema: {
        tags: ['registry'],
        summary: 'Search available assets',
        description: 'Returns all asset announcements. Filtering and vector search coming soon.',
        querystring: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['physical', 'service', 'license', 'digital_data'],
                    description: 'Filter by asset type',
                },
                status: {
                    type: 'string',
                    enum: ['available', 'pending', 'locked', 'transferred'],
                    description: 'Filter by asset status',
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 100,
                    default: 50,
                    description: 'Max results to return',
                },
            },
        },
        response: {
            200: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        asset_id: { type: 'string' },
                        agent_id: { type: 'string' },
                        agent_card: AgentCardSchema,
                        asset_type: { type: 'string' },
                        metadata: { type: 'object', additionalProperties: true },
                        status: { type: 'string' },
                        created_at: { type: 'string', format: 'date-time' },
                    },
                },
            },
        },
    },
}, async (request) => {
    const { type, status, limit } = request.query;
    const conditions = [];
    const params = [];
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
    const client = await db_1.default.connect();
    try {
        const res = await client.query(sql, params);
        return res.rows;
    }
    finally {
        client.release();
    }
});
// Expose raw OpenAPI JSON
server.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    reply.type('application/json');
    return server.swagger();
});
// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
const start = async () => {
    await registerDocs();
    await (0, db_1.verifyConnection)();
    await migrate();
    try {
        await server.listen({
            port: Number(process.env.PORT) || 8080,
            host: '0.0.0.0',
        });
        console.log('[start] SwarmTrade Registry API is live');
    }
    catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};
start();
