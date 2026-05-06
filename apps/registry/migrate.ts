import pool from './db';

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');
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
    console.log('Migration successful.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

migrate();
