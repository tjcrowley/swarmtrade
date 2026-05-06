import { Pool } from 'pg';

const pool = new Pool({
  user: 'a2a_admin',
  host: 'localhost',
  database: 'a2a_hub',
  password: 'secure_a2a_password',
  port: 5433,
});

export default pool;
