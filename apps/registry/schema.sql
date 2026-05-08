-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Registry Table for Asset Announcements
CREATE TABLE IF NOT EXISTS asset_announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_card JSONB NOT NULL, -- Storing A2A AgentCard
    asset_type TEXT NOT NULL,
    metadata JSONB NOT NULL,
    embedding VECTOR(768), 
    status TEXT DEFAULT 'available',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asset_embedding ON asset_announcements USING ivfflat (embedding vector_cosine_ops);

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
ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE handshakes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
