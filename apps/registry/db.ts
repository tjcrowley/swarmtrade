import { Pool } from 'pg';

// Use DATABASE_URL from environment if available
const connectionString = process.env.DATABASE_URL || 'postgresql://a2a_admin:secure_a2a_password@localhost:5433/a2a_hub';

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false // Required for DigitalOcean managed DBs unless you provide the CA cert
  }
});

export default pool;
