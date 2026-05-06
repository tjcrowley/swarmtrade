import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// Use DATABASE_URL from environment
const connectionString = process.env.DATABASE_URL || 'postgresql://a2a_admin:secure_a2a_password@localhost:5433/a2a_hub';

// For DigitalOcean, we often need the CA certificate, but often just disabling rejection works
// If rejectUnauthorized: false is still hitting issues, it's likely the SSL mode
// Let's force it to no-verify with a explicit object
const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false, // Required for DigitalOcean managed DBs
  }
});

export default pool;
