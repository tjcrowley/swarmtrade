import pool, { verifyConnection } from './db';
import { buildApp } from './build-app';
import { EvmEscrowAdapter, NearEscrowAdapter } from './escrow';

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

      CREATE TABLE IF NOT EXISTS escrow_records (
        escrow_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trade_id UUID NOT NULL REFERENCES handshakes(handshake_id),
        adapter TEXT NOT NULL,
        chain_id TEXT,
        buyer_address TEXT NOT NULL,
        seller_address TEXT NOT NULL,
        amount NUMERIC(30,18) NOT NULL,
        token TEXT NOT NULL DEFAULT 'native',
        status TEXT NOT NULL DEFAULT 'locked',
        tx_hash TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
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

const start = async () => {
  await verifyConnection();
  await migrate();

  const server = await buildApp({ pool, logger: true });

  // Register chain-specific escrow adapters (opt-in via env vars)
  // Access the escrow registry via decorator would be cleaner, but for now
  // we register them after build since they need heavy deps (near-api-js, viem)
  // TODO: expose escrowRegistry from buildApp for external adapter registration

  try {
    await server.listen({ port: Number(process.env.PORT) || 8080, host: '0.0.0.0' });
    console.log('[start] SwarmTrade Registry API is live');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
