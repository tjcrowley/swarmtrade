import { Pool } from 'pg';
import { FeeConfigRepository } from './fee-config';

export type TradeStatus =
  | 'proposed'
  | 'countered'
  | 'accepted'
  | 'escrowed'
  | 'delivery_confirmed'
  | 'settled'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'disputed'
  | 'resolved';

export interface Trade {
  id: string;
  buyer_id: string;
  seller_id: string;
  asset_id: string;
  status: TradeStatus;
  quote: Record<string, any> | null;
  trade_value: number | null;
  currency: string | null;
  fee_bps: number | null;
  fee_amount: number | null;
  version: number;
}

export interface NegotiationRepository {
  create(params: { buyer_id: string; seller_id: string; asset_id: string }): Promise<Trade>;
  transition(
    handshakeId: string,
    fromVersion: number,
    nextState: TradeStatus,
    quote?: Record<string, any>
  ): Promise<Trade>;
  findById(handshakeId: string): Promise<Trade | null>;
}

export class PostgresNegotiationRepository implements NegotiationRepository {
  private feeConfig: FeeConfigRepository;

  constructor(private readonly pool: Pool) {
    this.feeConfig = new FeeConfigRepository(pool);
  }

  async create(params: { buyer_id: string; seller_id: string; asset_id: string }): Promise<Trade> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO handshakes (buyer_id, seller_id, asset_id, state, version)
         VALUES ($1, $2, $3, 'proposed', 1)
         RETURNING handshake_id as id, buyer_id, seller_id, asset_id,
                   state as status, quote, trade_value, currency, fee_bps, fee_amount, version`,
        [params.buyer_id, params.seller_id, params.asset_id]
      );
      return res.rows[0];
    } finally {
      client.release();
    }
  }

  async transition(
    handshakeId: string,
    fromVersion: number,
    nextState: TradeStatus,
    quote?: Record<string, any>
  ): Promise<Trade> {
    const client = await this.pool.connect();
    try {
      const tradeValue: number | null = quote?.trade_value ?? null;
      const currency: string | null = quote?.currency ?? null;
      let feeBps: number | null = null;
      let feeAmount: number | null = null;

      // Snapshot fee config at settlement time
      if (nextState === 'settled' && tradeValue !== null) {
        const config = await this.feeConfig.get();
        feeBps = config.fee_bps;
        feeAmount = this.feeConfig.calculate(tradeValue, config);
      }

      const res = await client.query(
        `UPDATE handshakes
         SET state       = $1,
             quote       = COALESCE($2::jsonb, quote),
             trade_value = COALESCE($3, trade_value),
             currency    = COALESCE($4, currency),
             fee_bps     = COALESCE($5, fee_bps),
             fee_amount  = COALESCE($6, fee_amount),
             version     = version + 1,
             updated_at  = NOW()
         WHERE handshake_id = $7 AND version = $8
         RETURNING handshake_id as id, buyer_id, seller_id, asset_id,
                   state as status, quote, trade_value, currency, fee_bps, fee_amount, version`,
        [nextState, quote ? JSON.stringify(quote) : null, tradeValue, currency, feeBps, feeAmount, handshakeId, fromVersion]
      );

      if (res.rowCount === 0) {
        throw new Error('StaleVersionError');
      }
      return res.rows[0];
    } finally {
      client.release();
    }
  }

  async findById(handshakeId: string): Promise<Trade | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT handshake_id as id, buyer_id, seller_id, asset_id,
                state as status, quote, trade_value, currency, fee_bps, fee_amount, version
         FROM handshakes WHERE handshake_id = $1`,
        [handshakeId]
      );
      return res.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async getStats(): Promise<{
    total_trades: number;
    active_negotiations: number;
    settled_trades: number;
    total_volume: number;
    total_fees_collected: number;
  }> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(`
        SELECT
          COUNT(*)                                                              AS total_trades,
          COUNT(*) FILTER (WHERE state NOT IN ('settled','rejected','expired','cancelled'))
                                                                               AS active_negotiations,
          COUNT(*) FILTER (WHERE state = 'settled')                           AS settled_trades,
          COALESCE(SUM(trade_value) FILTER (WHERE state = 'settled'), 0)      AS total_volume,
          COALESCE(SUM(fee_amount)  FILTER (WHERE state = 'settled'), 0)      AS total_fees_collected
        FROM handshakes
      `);
      const row = res.rows[0];
      return {
        total_trades: parseInt(row.total_trades),
        active_negotiations: parseInt(row.active_negotiations),
        settled_trades: parseInt(row.settled_trades),
        total_volume: parseFloat(row.total_volume),
        total_fees_collected: parseFloat(row.total_fees_collected),
      };
    } finally {
      client.release();
    }
  }

  async getRecentTrades(limit = 20): Promise<Trade[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT handshake_id as id, buyer_id, seller_id, asset_id,
                state as status, trade_value, currency, fee_amount, version, updated_at
         FROM handshakes ORDER BY updated_at DESC LIMIT $1`,
        [limit]
      );
      return res.rows;
    } finally {
      client.release();
    }
  }

  async getDisputedTrades(): Promise<(Trade & { escrow_id?: string; escrow_amount?: string; escrow_locked_at?: string })[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(`
        SELECT
          h.handshake_id as id, h.buyer_id, h.seller_id, h.asset_id,
          h.state as status, h.trade_value, h.currency, h.fee_amount, h.version, h.updated_at,
          e.escrow_id, e.amount as escrow_amount, e.locked_at as escrow_locked_at
        FROM handshakes h
        LEFT JOIN escrow_records e ON h.handshake_id = e.trade_id
        WHERE h.state = 'disputed'
        ORDER BY h.updated_at DESC
      `);
      return res.rows;
    } finally {
      client.release();
    }
  }

  async resolveDispute(handshakeId: string, fromVersion: number, releaseToOwner: 'buyer' | 'seller', reason: string): Promise<Trade> {
    const client = await this.pool.connect();
    try {
      // Update trade to resolved state (reason stored in quote field for now)
      const quote = { resolution: releaseToOwner, reason, resolved_at: new Date().toISOString() };
      const res = await client.query(
        `UPDATE handshakes
         SET state       = 'resolved',
             quote       = $1::jsonb,
             version     = version + 1,
             updated_at  = NOW()
         WHERE handshake_id = $2 AND version = $3
         RETURNING handshake_id as id, buyer_id, seller_id, asset_id,
                   state as status, quote, trade_value, currency, fee_bps, fee_amount, version`,
        [JSON.stringify(quote), handshakeId, fromVersion]
      );

      if (res.rowCount === 0) {
        throw new Error('StaleVersionError');
      }

      return res.rows[0];
    } finally {
      client.release();
    }
  }
}
