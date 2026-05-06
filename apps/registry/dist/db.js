"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyConnection = verifyConnection;
const pg_1 = require("pg");
const pg_connection_string_1 = require("pg-connection-string");
const connectionString = process.env.DATABASE_URL ||
    'postgresql://a2a_admin:secure_a2a_password@localhost:5433/a2a_hub';
const parsed = (0, pg_connection_string_1.parse)(connectionString);
/**
 * SSL configuration for DigitalOcean Managed Databases.
 *
 * Priority:
 *  1. DATABASE_CA_CERT env var — PEM-encoded CA certificate (recommended).
 *  2. DATABASE_CA_CERT_BASE64 env var — base64-encoded CA cert (for platforms
 *     that struggle with multi-line env vars).
 *  3. If DATABASE_URL contains `sslmode=require` (DO default), connect with
 *     SSL but trust the system CA bundle (Node's default TLS behaviour).
 *  4. Local dev (no SSL indicators) — skip SSL entirely.
 */
function buildSslConfig() {
    const caCertPem = process.env.DATABASE_CA_CERT;
    const caCertB64 = process.env.DATABASE_CA_CERT_BASE64;
    if (caCertPem) {
        return { rejectUnauthorized: true, ca: caCertPem };
    }
    if (caCertB64) {
        return {
            rejectUnauthorized: true,
            ca: Buffer.from(caCertB64, 'base64').toString('utf-8'),
        };
    }
    // If the connection string signals SSL (DigitalOcean default), enable SSL
    // but rely on the system/Node CA bundle rather than disabling verification.
    if (connectionString.includes('sslmode=require')) {
        return { rejectUnauthorized: true };
    }
    // Local development — no SSL
    return false;
}
const ssl = buildSslConfig();
const pool = new pg_1.Pool({
    host: parsed.host || undefined,
    user: parsed.user || undefined,
    password: parsed.password || undefined,
    database: parsed.database || undefined,
    port: Number(parsed.port) || 5432,
    ssl: ssl || undefined,
    // Connection pool tuning
    max: Number(process.env.DB_POOL_MAX) || 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
});
pool.on('error', (err) => {
    console.error('[db] Unexpected error on idle client:', err);
});
pool.on('connect', () => {
    console.log('[db] New client connected to pool');
});
/**
 * Verify connectivity at startup. Throws if the database is unreachable so
 * the process fails fast instead of accepting traffic it can't serve.
 */
async function verifyConnection() {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT NOW() AS server_time');
        console.log(`[db] Connection verified — server time: ${result.rows[0].server_time}`);
    }
    finally {
        client.release();
    }
}
exports.default = pool;
