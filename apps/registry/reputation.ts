import { Pool } from 'pg';

export interface AgentReputation {
  agent_id: string;
  total_trades: number;
  successful_trades: number;
  disputed_trades: number;
  disputes_lost: number;
  avg_rating: number | null;
  trust_score: number; // 0-100
  last_trade_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TradeRating {
  id: string;
  trade_id: string;
  rater_id: string;
  ratee_id: string;
  rating: number; // 1-5
  comment: string | null;
  created_at: string;
}

/**
 * Trust score formula:
 *   base = (successful / total) * 60           — completion rate (max 60 pts)
 *   volume_bonus = min(total / 20, 1) * 20     — trade volume maturity (max 20 pts)
 *   rating_bonus = ((avg_rating - 1) / 4) * 20 — avg rating scaled (max 20 pts)
 *   dispute_penalty = disputes_lost * 5         — deducted
 *   recency_decay = days since last trade > 90 ? max(0, score - (days-90)*0.1) : 0
 *
 * Final = clamp(base + volume_bonus + rating_bonus - dispute_penalty - recency_decay, 0, 100)
 */
function computeTrustScore(rep: {
  total_trades: number;
  successful_trades: number;
  disputes_lost: number;
  avg_rating: number | null;
  last_trade_at: string | null;
}): number {
  if (rep.total_trades === 0) return 50; // neutral starting score

  const completionRate = rep.successful_trades / rep.total_trades;
  const base = completionRate * 60;

  const volumeBonus = Math.min(rep.total_trades / 20, 1) * 20;

  const avgRating = rep.avg_rating ?? 3; // neutral if unrated
  const ratingBonus = ((avgRating - 1) / 4) * 20;

  const disputePenalty = rep.disputes_lost * 5;

  let recencyDecay = 0;
  if (rep.last_trade_at) {
    const daysSince = (Date.now() - new Date(rep.last_trade_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 90) {
      recencyDecay = (daysSince - 90) * 0.1;
    }
  }

  const raw = base + volumeBonus + ratingBonus - disputePenalty - recencyDecay;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

export class ReputationService {
  constructor(private readonly pool: Pool) {}

  /**
   * Get or create reputation record for an agent.
   */
  async getReputation(agentId: string): Promise<AgentReputation> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT * FROM agent_reputation WHERE agent_id = $1`,
        [agentId]
      );
      if (res.rowCount === 0) {
        // Return a default (new agent)
        return {
          agent_id: agentId,
          total_trades: 0,
          successful_trades: 0,
          disputed_trades: 0,
          disputes_lost: 0,
          avg_rating: null,
          trust_score: 50,
          last_trade_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
      const row = res.rows[0];
      return {
        agent_id: row.agent_id,
        total_trades: parseInt(row.total_trades),
        successful_trades: parseInt(row.successful_trades),
        disputed_trades: parseInt(row.disputed_trades),
        disputes_lost: parseInt(row.disputes_lost),
        avg_rating: row.avg_rating ? parseFloat(row.avg_rating) : null,
        trust_score: parseInt(row.trust_score),
        last_trade_at: row.last_trade_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Record a completed trade for both parties.
   * Called when a trade transitions to 'settled'.
   */
  async recordSettlement(buyerId: string, sellerId: string): Promise<void> {
    await this.incrementCounter(buyerId, 'successful_trades');
    await this.incrementCounter(sellerId, 'successful_trades');
  }

  /**
   * Record a dispute filed. Increments disputed count for both parties.
   */
  async recordDispute(buyerId: string, sellerId: string): Promise<void> {
    await this.incrementCounter(buyerId, 'disputed_trades');
    await this.incrementCounter(sellerId, 'disputed_trades');
  }

  /**
   * Record dispute resolution. The loser gets disputes_lost incremented.
   */
  async recordDisputeResolution(loserId: string): Promise<void> {
    await this.incrementCounter(loserId, 'disputes_lost');
  }

  /**
   * Submit a rating for a trade counterparty.
   */
  async submitRating(params: {
    tradeId: string;
    raterId: string;
    rateeId: string;
    rating: number;
    comment?: string;
  }): Promise<TradeRating> {
    if (params.rating < 1 || params.rating > 5) {
      throw new Error('Rating must be between 1 and 5');
    }
    if (params.raterId === params.rateeId) {
      throw new Error('Cannot rate yourself');
    }

    const client = await this.pool.connect();
    try {
      // Check for duplicate rating
      const existing = await client.query(
        `SELECT id FROM trade_ratings WHERE trade_id = $1 AND rater_id = $2`,
        [params.tradeId, params.raterId]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        throw new Error('Already rated this trade');
      }

      // Insert rating
      const res = await client.query(
        `INSERT INTO trade_ratings (trade_id, rater_id, ratee_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, trade_id, rater_id, ratee_id, rating, comment, created_at`,
        [params.tradeId, params.raterId, params.rateeId, params.rating, params.comment ?? null]
      );

      // Recalculate avg_rating for ratee
      await this.recalculateRating(params.rateeId);

      return {
        id: res.rows[0].id,
        trade_id: res.rows[0].trade_id,
        rater_id: res.rows[0].rater_id,
        ratee_id: res.rows[0].ratee_id,
        rating: res.rows[0].rating,
        comment: res.rows[0].comment,
        created_at: res.rows[0].created_at.toISOString(),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get ratings received by an agent.
   */
  async getRatings(agentId: string, limit = 20): Promise<TradeRating[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT id, trade_id, rater_id, ratee_id, rating, comment, created_at
         FROM trade_ratings WHERE ratee_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [agentId, limit]
      );
      return res.rows.map((r: any) => ({
        id: r.id,
        trade_id: r.trade_id,
        rater_id: r.rater_id,
        ratee_id: r.ratee_id,
        rating: r.rating,
        comment: r.comment,
        created_at: r.created_at.toISOString(),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Upsert reputation record, increment a counter, and recalculate trust score.
   */
  private async incrementCounter(
    agentId: string,
    field: 'successful_trades' | 'disputed_trades' | 'disputes_lost'
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO agent_reputation (agent_id, ${field}, total_trades, last_trade_at)
         VALUES ($1, 1, 1, NOW())
         ON CONFLICT (agent_id) DO UPDATE SET
           ${field} = agent_reputation.${field} + 1,
           total_trades = CASE
             WHEN '${field}' = 'successful_trades' THEN agent_reputation.total_trades + 1
             ELSE agent_reputation.total_trades
           END,
           last_trade_at = CASE
             WHEN '${field}' = 'successful_trades' THEN NOW()
             ELSE agent_reputation.last_trade_at
           END,
           updated_at = NOW()`,
        [agentId]
      );
      await this.recalculateTrustScore(agentId);
    } finally {
      client.release();
    }
  }

  private async recalculateRating(agentId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT AVG(rating)::numeric(3,2) as avg_rating FROM trade_ratings WHERE ratee_id = $1`,
        [agentId]
      );
      const avgRating = res.rows[0]?.avg_rating ? parseFloat(res.rows[0].avg_rating) : null;

      await client.query(
        `UPDATE agent_reputation SET avg_rating = $1, updated_at = NOW() WHERE agent_id = $2`,
        [avgRating, agentId]
      );
      await this.recalculateTrustScore(agentId);
    } finally {
      client.release();
    }
  }

  private async recalculateTrustScore(agentId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT total_trades, successful_trades, disputes_lost, avg_rating, last_trade_at
         FROM agent_reputation WHERE agent_id = $1`,
        [agentId]
      );
      if (res.rowCount === 0) return;

      const row = res.rows[0];
      const score = computeTrustScore({
        total_trades: parseInt(row.total_trades),
        successful_trades: parseInt(row.successful_trades),
        disputes_lost: parseInt(row.disputes_lost),
        avg_rating: row.avg_rating ? parseFloat(row.avg_rating) : null,
        last_trade_at: row.last_trade_at?.toISOString() ?? null,
      });

      await client.query(
        `UPDATE agent_reputation SET trust_score = $1, updated_at = NOW() WHERE agent_id = $2`,
        [score, agentId]
      );
    } finally {
      client.release();
    }
  }
}

// Export for testing
export { computeTrustScore };
