import fastify from 'fastify';
import { AssetManifest } from '@a2a/types';
import pool from './db';

const server = fastify({ logger: true });

// Run migration before accepting traffic
async function initialize() {
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
    `);
    console.log('Database initialized.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

server.post<{ Body: AssetManifest }>('/registry/announce', async (request, reply) => {
  const asset = request.body;
  const client = await pool.connect();
  try {
    const res = await client.query(
      'INSERT INTO asset_announcements (asset_id, agent_id, agent_card, asset_type, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [asset.asset_id, asset.agent_card.id, JSON.stringify(asset.agent_card), asset.type, JSON.stringify(asset.metadata)]
    );
    return { status: 'registered', id: res.rows[0].id };
  } finally {
    client.release();
  }
});

server.get('/registry/search', async (request, reply) => {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT * FROM asset_announcements');
    return res.rows;
  } finally {
    client.release();
  }
});

const start = async () => {
  await initialize();
  try {
    await server.listen({ port: Number(process.env.PORT) || 8080, host: '0.0.0.0' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
