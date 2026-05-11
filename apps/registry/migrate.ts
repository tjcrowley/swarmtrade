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

      ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS quote JSONB;
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
          amount NUMERIC(78,0) NOT NULL,
          token TEXT NOT NULL DEFAULT 'native',
          status TEXT NOT NULL DEFAULT 'locked',
          tx_hash TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      INSERT INTO platform_config (key, value)
      VALUES ('fee_config', '{"fee_bps": 150, "min_fee": null, "max_fee": null}')
      ON CONFLICT (key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS agent_reputation (
          agent_id TEXT PRIMARY KEY,
          total_trades INTEGER DEFAULT 0,
          successful_trades INTEGER DEFAULT 0,
          disputed_trades INTEGER DEFAULT 0,
          disputes_lost INTEGER DEFAULT 0,
          avg_rating NUMERIC(3,2),
          trust_score INTEGER DEFAULT 50,
          last_trade_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trade_ratings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          trade_id UUID NOT NULL REFERENCES handshakes(handshake_id),
          rater_id TEXT NOT NULL,
          ratee_id TEXT NOT NULL,
          rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
          comment TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT unique_rating_per_trade UNIQUE (trade_id, rater_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ratings_ratee ON trade_ratings (ratee_id);
      CREATE INDEX IF NOT EXISTS idx_reputation_score ON agent_reputation (trust_score DESC);

      CREATE TABLE IF NOT EXISTS notification_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id TEXT NOT NULL,
        webhook_url TEXT,
        email TEXT,
        events TEXT[] DEFAULT '{}',
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT sub_has_target CHECK (webhook_url IS NOT NULL OR email IS NOT NULL)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_agent_webhook ON notification_subscriptions (agent_id, webhook_url) WHERE webhook_url IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_agent_email ON notification_subscriptions (agent_id, email) WHERE email IS NOT NULL;

      CREATE TABLE IF NOT EXISTS notification_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscription_id UUID REFERENCES notification_subscriptions(id),
        trade_id UUID,
        event TEXT NOT NULL,
        channel TEXT NOT NULL,
        payload JSONB,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
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
