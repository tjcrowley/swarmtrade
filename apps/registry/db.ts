import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgresql://a2a_admin:secure_a2a_password@localhost:5433/a2a_hub';

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

export default pool;
