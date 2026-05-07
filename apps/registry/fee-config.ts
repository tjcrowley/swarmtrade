import { Pool } from 'pg';

export interface FeeConfig {
  fee_bps: number;        // basis points — 150 = 1.5%
  min_fee: number | null; // minimum fee in trade currency (null = no floor)
  max_fee: number | null; // maximum fee in trade currency (null = no cap)
  updated_at?: string;
}

const DEFAULT_CONFIG: FeeConfig = {
  fee_bps: 150,
  min_fee: null,
  max_fee: null,
};

export class FeeConfigRepository {
  constructor(private pool: Pool) {}

  async get(): Promise<FeeConfig> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT value FROM platform_config WHERE key = 'fee_config'`
      );
      return res.rows.length > 0 ? (res.rows[0].value as FeeConfig) : DEFAULT_CONFIG;
    } finally {
      client.release();
    }
  }

  async set(config: Omit<FeeConfig, 'updated_at'>): Promise<FeeConfig> {
    const value: FeeConfig = { ...config, updated_at: new Date().toISOString() };
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO platform_config (key, value, updated_at)
         VALUES ('fee_config', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [JSON.stringify(value)]
      );
      return value;
    } finally {
      client.release();
    }
  }

  /** Returns fee amount rounded to 2 decimal places. */
  calculate(tradeValue: number, config: FeeConfig): number {
    let fee = (tradeValue * config.fee_bps) / 10_000;
    if (config.min_fee !== null) fee = Math.max(fee, config.min_fee);
    if (config.max_fee !== null) fee = Math.min(fee, config.max_fee);
    return Math.round(fee * 100) / 100;
  }
}
