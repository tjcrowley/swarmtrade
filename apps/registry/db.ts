import { Pool } from 'pg';

// Use DATABASE_URL from environment if available, otherwise fallback to local dev defaults
const connectionString = process.env.DATABASE_URL || 'postgresql://a2a_admin:secure_a2a_password@localhost:5433/a2a_hub';

const pool = new Pool({
  connectionString: connectionString,
});

export default pool;
