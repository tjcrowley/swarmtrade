"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const db_1 = __importDefault(require("./db"));
const server = (0, fastify_1.default)({ logger: true });
server.post('/registry/announce', async (request, reply) => {
    const asset = request.body;
    const client = await db_1.default.connect();
    try {
        const res = await client.query('INSERT INTO asset_announcements (asset_id, agent_id, agent_card, asset_type, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING id', [asset.asset_id, asset.agent_card.id, JSON.stringify(asset.agent_card), asset.type, JSON.stringify(asset.metadata)]);
        return { status: 'registered', id: res.rows[0].id };
    }
    finally {
        client.release();
    }
});
server.get('/registry/search', async (request, reply) => {
    const client = await db_1.default.connect();
    try {
        const res = await client.query('SELECT * FROM asset_announcements');
        return res.rows;
    }
    finally {
        client.release();
    }
});
const start = async () => {
    try {
        await server.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
    }
    catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};
start();
