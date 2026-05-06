import { Pool } from 'pg';
import { parse } from 'pg-connection-string';

const connectionString = process.env.DATABASE_URL || 'postgresql://a2a_admin:secure_a2a_password@localhost:5433/a2a_hub';
const config = parse(connectionString);

const pool = new Pool({
  host: config.host,
  user: config.user,
  password: config.password,
  database: config.database,
  port: Number(config.port) || 5433,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

export default pool;
