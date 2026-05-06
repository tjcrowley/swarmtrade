import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgresql://a2a_admin:secure_a2a_password@localhost:5433/a2a_hub';

// Ensure SSL is properly configured for DO
const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test connection on startup
pool.query('SELECT 1')
  .then(() => console.log('Database connected successfully'))
  .catch(err => console.error('Database connection failed', err));

export default pool;
