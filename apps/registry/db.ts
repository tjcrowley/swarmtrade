import { Pool } from 'pg';

// DigitalOcean connections require SSL. 
// We use 'rejectUnauthorized: false' to skip CA validation for the managed instance.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

export default pool;
