import { Pool } from 'pg';
import { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VolumeRow {
  date: string;
  trade_count: number;
  volume: number;
  fees: number;
}

export interface TopAgentRow {
  agent_id: string;
  metric_value: number;
  rank: number;
}

export interface TopAssetRow {
  asset_type: string;
  trade_count: number;
  total_volume: number;
}

export interface PlatformSummary {
  total_trades: number;
  settled_trades: number;
  active_negotiations: number;
  total_volume: number;
  total_fees: number;
  avg_trade_value: number;
  unique_agents: number;
  period_comparison: {
    current_week_volume: number;
    previous_week_volume: number;
    change_pct: number;
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_PERIODS = ['day', 'week', 'month'] as const;
type Period = (typeof VALID_PERIODS)[number];

const VALID_METRICS = ['volume', 'trades', 'rating'] as const;
type Metric = (typeof VALID_METRICS)[number];

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// AnalyticsRepo — all queries are parameterised; no string interpolation of
// user input into SQL.
// ---------------------------------------------------------------------------

export class AnalyticsRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * Trade-volume time series grouped by the requested period.
   * Only considers settled handshakes.
   */
  async getVolume(period: Period, days: number): Promise<VolumeRow[]> {
    const client = await this.pool.connect();
    try {
      // date_trunc accepts 'day', 'week', 'month' — matches our Period type.
      const res = await client.query(
        `SELECT
           date_trunc($1, updated_at)::date AS date,
           COUNT(*)::int                    AS trade_count,
           COALESCE(SUM(trade_value), 0)    AS volume,
           COALESCE(SUM(fee_amount), 0)     AS fees
         FROM handshakes
         WHERE state = 'settled'
           AND updated_at >= NOW() - ($2 || ' days')::interval
         GROUP BY 1
         ORDER BY 1`,
        [period, days]
      );
      return res.rows.map((r: any) => ({
        date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
        trade_count: Number(r.trade_count),
        volume: parseFloat(r.volume),
        fees: parseFloat(r.fees),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Agent leaderboard by volume, trade count, or reputation rating.
   */
  async getTopAgents(metric: Metric, limit: number): Promise<TopAgentRow[]> {
    const client = await this.pool.connect();
    try {
      if (metric === 'rating') {
        const res = await client.query(
          `SELECT
             agent_id,
             trust_score AS metric_value,
             ROW_NUMBER() OVER (ORDER BY trust_score DESC)::int AS rank
           FROM agent_reputation
           ORDER BY trust_score DESC
           LIMIT $1`,
          [limit]
        );
        return res.rows.map((r: any) => ({
          agent_id: r.agent_id,
          metric_value: Number(r.metric_value),
          rank: Number(r.rank),
        }));
      }

      // volume or trades — union buyer_id + seller_id from settled handshakes
      const valueExpr = metric === 'volume'
        ? 'COALESCE(SUM(trade_value), 0)'
        : 'COUNT(*)::int';

      const res = await client.query(
        `WITH agents AS (
           SELECT buyer_id AS agent_id, trade_value FROM handshakes WHERE state = 'settled'
           UNION ALL
           SELECT seller_id AS agent_id, trade_value FROM handshakes WHERE state = 'settled'
         )
         SELECT
           agent_id,
           ${valueExpr} AS metric_value,
           ROW_NUMBER() OVER (ORDER BY ${valueExpr} DESC)::int AS rank
         FROM agents
         GROUP BY agent_id
         ORDER BY metric_value DESC
         LIMIT $1`,
        [limit]
      );
      return res.rows.map((r: any) => ({
        agent_id: r.agent_id,
        metric_value: Number(r.metric_value),
        rank: Number(r.rank),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Most-traded asset types by trade count and total volume.
   * Joins handshakes with asset_announcements on asset_id.
   */
  async getTopAssets(limit: number): Promise<TopAssetRow[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT
           a.asset_type,
           COUNT(*)::int                  AS trade_count,
           COALESCE(SUM(h.trade_value), 0) AS total_volume
         FROM handshakes h
         JOIN asset_announcements a ON h.asset_id = a.asset_id
         WHERE h.state = 'settled'
         GROUP BY a.asset_type
         ORDER BY trade_count DESC
         LIMIT $1`,
        [limit]
      );
      return res.rows.map((r: any) => ({
        asset_type: r.asset_type,
        trade_count: Number(r.trade_count),
        total_volume: parseFloat(r.total_volume),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Enhanced platform summary with week-over-week comparison.
   */
  async getSummary(): Promise<PlatformSummary> {
    const client = await this.pool.connect();
    try {
      // Core totals
      const totalsRes = await client.query(`
        SELECT
          COUNT(*)::int                                                          AS total_trades,
          COUNT(*) FILTER (WHERE state = 'settled')::int                        AS settled_trades,
          COUNT(*) FILTER (WHERE state NOT IN
            ('settled','rejected','expired','cancelled','resolved'))::int        AS active_negotiations,
          COALESCE(SUM(trade_value) FILTER (WHERE state = 'settled'), 0)        AS total_volume,
          COALESCE(SUM(fee_amount)  FILTER (WHERE state = 'settled'), 0)        AS total_fees,
          COALESCE(AVG(trade_value) FILTER (WHERE state = 'settled'), 0)        AS avg_trade_value
        FROM handshakes
      `);

      // Unique agents (union of buyer + seller across all trades)
      const agentsRes = await client.query(`
        SELECT COUNT(DISTINCT agent_id)::int AS unique_agents
        FROM (
          SELECT buyer_id AS agent_id FROM handshakes
          UNION
          SELECT seller_id AS agent_id FROM handshakes
        ) sub
      `);

      // Week-over-week volume comparison
      const weekRes = await client.query(`
        SELECT
          COALESCE(SUM(trade_value) FILTER (
            WHERE updated_at >= date_trunc('week', NOW())
          ), 0) AS current_week_volume,
          COALESCE(SUM(trade_value) FILTER (
            WHERE updated_at >= date_trunc('week', NOW()) - INTERVAL '7 days'
              AND updated_at <  date_trunc('week', NOW())
          ), 0) AS previous_week_volume
        FROM handshakes
        WHERE state = 'settled'
      `);

      const t = totalsRes.rows[0];
      const a = agentsRes.rows[0];
      const w = weekRes.rows[0];

      const currentWeek = parseFloat(w.current_week_volume);
      const previousWeek = parseFloat(w.previous_week_volume);
      const changePct = previousWeek === 0
        ? (currentWeek > 0 ? 100 : 0)
        : ((currentWeek - previousWeek) / previousWeek) * 100;

      return {
        total_trades: Number(t.total_trades),
        settled_trades: Number(t.settled_trades),
        active_negotiations: Number(t.active_negotiations),
        total_volume: parseFloat(t.total_volume),
        total_fees: parseFloat(t.total_fees),
        avg_trade_value: parseFloat(t.avg_trade_value),
        unique_agents: Number(a.unique_agents),
        period_comparison: {
          current_week_volume: currentWeek,
          previous_week_volume: previousWeek,
          change_pct: Math.round(changePct * 100) / 100,
        },
      };
    } finally {
      client.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Route registration — called from buildApp()
// ---------------------------------------------------------------------------

export function registerAnalyticsRoutes(server: FastifyInstance, pool: Pool): void {
  const analytics = new AnalyticsRepo(pool);

  // GET /admin/api/analytics/volume
  server.get('/admin/api/analytics/volume', {
    schema: {
      tags: ['admin-analytics'],
      summary: 'Trade volume time series',
      querystring: {
        type: 'object' as const,
        properties: {
          period: { type: 'string' as const, enum: ['day', 'week', 'month'] },
          days: { type: 'integer' as const, minimum: 1, maximum: 365 },
        },
      },
    },
  }, async (request) => {
    const { period: rawPeriod, days: rawDays } = request.query as {
      period?: string;
      days?: number;
    };
    const period: Period = VALID_PERIODS.includes(rawPeriod as Period)
      ? (rawPeriod as Period)
      : 'day';
    const days = clampInt(rawDays, 1, 365, 30);
    return analytics.getVolume(period, days);
  });

  // GET /admin/api/analytics/top-agents
  server.get('/admin/api/analytics/top-agents', {
    schema: {
      tags: ['admin-analytics'],
      summary: 'Agent leaderboard',
      querystring: {
        type: 'object' as const,
        properties: {
          metric: { type: 'string' as const, enum: ['volume', 'trades', 'rating'] },
          limit: { type: 'integer' as const, minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request) => {
    const { metric: rawMetric, limit: rawLimit } = request.query as {
      metric?: string;
      limit?: number;
    };
    const metric: Metric = VALID_METRICS.includes(rawMetric as Metric)
      ? (rawMetric as Metric)
      : 'volume';
    const limit = clampInt(rawLimit, 1, 100, 10);
    return analytics.getTopAgents(metric, limit);
  });

  // GET /admin/api/analytics/top-assets
  server.get('/admin/api/analytics/top-assets', {
    schema: {
      tags: ['admin-analytics'],
      summary: 'Most traded asset types',
      querystring: {
        type: 'object' as const,
        properties: {
          limit: { type: 'integer' as const, minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request) => {
    const { limit: rawLimit } = request.query as { limit?: number };
    const limit = clampInt(rawLimit, 1, 100, 10);
    return analytics.getTopAssets(limit);
  });

  // GET /admin/api/analytics/summary
  server.get('/admin/api/analytics/summary', {
    schema: {
      tags: ['admin-analytics'],
      summary: 'Enhanced platform summary with week-over-week comparison',
    },
  }, async () => {
    return analytics.getSummary();
  });
}
