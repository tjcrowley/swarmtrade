-- Fee columns on handshakes
ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS trade_value NUMERIC(20,8);
ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS fee_bps INTEGER;
ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(20,8);

-- Platform-wide config store (key/value)
CREATE TABLE IF NOT EXISTS platform_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default fee config: 150 bps (1.5%), no min/max cap
INSERT INTO platform_config (key, value)
VALUES ('fee_config', '{"fee_bps": 150, "min_fee": null, "max_fee": null}')
ON CONFLICT (key) DO NOTHING;
