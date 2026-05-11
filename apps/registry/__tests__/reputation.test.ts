import { describe, it, expect, beforeEach } from 'vitest';
import { computeTrustScore, ReputationService } from '../reputation';
import { createMockPool, type QueryHandler } from './mock-pool';

describe('computeTrustScore', () => {
  it('returns 50 for a new agent with zero trades', () => {
    expect(computeTrustScore({
      total_trades: 0,
      successful_trades: 0,
      disputes_lost: 0,
      avg_rating: null,
      last_trade_at: null,
    })).toBe(50);
  });

  it('returns 100 for a perfect agent with enough volume', () => {
    const score = computeTrustScore({
      total_trades: 20,
      successful_trades: 20,
      disputes_lost: 0,
      avg_rating: 5.0,
      last_trade_at: new Date().toISOString(),
    });
    expect(score).toBe(100);
  });

  it('penalizes disputes_lost', () => {
    const goodScore = computeTrustScore({
      total_trades: 10,
      successful_trades: 10,
      disputes_lost: 0,
      avg_rating: 4.0,
      last_trade_at: new Date().toISOString(),
    });
    const badScore = computeTrustScore({
      total_trades: 10,
      successful_trades: 10,
      disputes_lost: 3,
      avg_rating: 4.0,
      last_trade_at: new Date().toISOString(),
    });
    expect(badScore).toBeLessThan(goodScore);
    expect(goodScore - badScore).toBe(15); // 3 * 5 penalty
  });

  it('applies recency decay after 90 days', () => {
    const recent = computeTrustScore({
      total_trades: 10,
      successful_trades: 10,
      disputes_lost: 0,
      avg_rating: 4.0,
      last_trade_at: new Date().toISOString(),
    });
    const old = computeTrustScore({
      total_trades: 10,
      successful_trades: 10,
      disputes_lost: 0,
      avg_rating: 4.0,
      last_trade_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(), // 120 days ago
    });
    expect(old).toBeLessThan(recent);
    // 30 days past threshold * 0.1 = 3 points decay
    expect(recent - old).toBe(3);
  });

  it('caps score at 0 minimum', () => {
    const score = computeTrustScore({
      total_trades: 1,
      successful_trades: 0,
      disputes_lost: 20,
      avg_rating: 1.0,
      last_trade_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(score).toBe(0);
  });

  it('low completion rate reduces base score', () => {
    const score = computeTrustScore({
      total_trades: 10,
      successful_trades: 5, // 50% completion
      disputes_lost: 0,
      avg_rating: 3.0,
      last_trade_at: new Date().toISOString(),
    });
    // base = 0.5 * 60 = 30, volume = min(10/20, 1) * 20 = 10, rating = ((3-1)/4)*20 = 10
    expect(score).toBe(50);
  });
});

describe('ReputationService', () => {
  let service: ReputationService;
  let queryLog: { sql: string; params: any[] }[];

  beforeEach(() => {
    queryLog = [];
    const handler: QueryHandler = (sql, params) => {
      queryLog.push({ sql, params: params || [] });
      const s = sql.replace(/\s+/g, ' ').trim();

      // getReputation query
      if (s.includes('FROM agent_reputation WHERE agent_id')) {
        return { rows: [], rowCount: 0 }; // new agent
      }

      // incrementCounter upsert
      if (s.includes('INSERT INTO agent_reputation')) {
        return { rows: [{ agent_id: params?.[0] }], rowCount: 1 };
      }

      // recalculateTrustScore select
      if (s.includes('SELECT total_trades') && s.includes('FROM agent_reputation')) {
        return {
          rows: [{
            total_trades: '1',
            successful_trades: '1',
            disputes_lost: '0',
            avg_rating: null,
            last_trade_at: new Date(),
          }],
          rowCount: 1,
        };
      }

      // trust score update
      if (s.includes('UPDATE agent_reputation SET trust_score')) {
        return { rows: [], rowCount: 1 };
      }

      // rating insert
      if (s.includes('INSERT INTO trade_ratings')) {
        return {
          rows: [{
            id: '00000000-0000-0000-0000-000000000099',
            trade_id: params?.[0],
            rater_id: params?.[1],
            ratee_id: params?.[2],
            rating: params?.[3],
            comment: params?.[4],
            created_at: new Date(),
          }],
          rowCount: 1,
        };
      }

      // duplicate check
      if (s.includes('FROM trade_ratings WHERE trade_id') && s.includes('rater_id')) {
        return { rows: [], rowCount: 0 };
      }

      // avg rating calc
      if (s.includes('AVG(rating)')) {
        return { rows: [{ avg_rating: '4.50' }], rowCount: 1 };
      }

      // rating update on reputation
      if (s.includes('UPDATE agent_reputation SET avg_rating')) {
        return { rows: [], rowCount: 1 };
      }

      // getRatings
      if (s.includes('FROM trade_ratings WHERE ratee_id')) {
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    };

    const pool = createMockPool(handler);
    service = new ReputationService(pool);
  });

  it('getReputation returns default for unknown agent', async () => {
    const rep = await service.getReputation('agent-new');
    expect(rep.agent_id).toBe('agent-new');
    expect(rep.total_trades).toBe(0);
    expect(rep.trust_score).toBe(50);
  });

  it('recordSettlement calls incrementCounter for both parties', async () => {
    await service.recordSettlement('buyer-1', 'seller-1');
    const inserts = queryLog.filter(q => q.sql.includes('INSERT INTO agent_reputation'));
    expect(inserts.length).toBe(2);
    expect(inserts[0].params[0]).toBe('buyer-1');
    expect(inserts[1].params[0]).toBe('seller-1');
  });

  it('submitRating validates rating range', async () => {
    await expect(service.submitRating({
      tradeId: 'trade-1',
      raterId: 'agent-a',
      rateeId: 'agent-b',
      rating: 6,
    })).rejects.toThrow('Rating must be between 1 and 5');

    await expect(service.submitRating({
      tradeId: 'trade-1',
      raterId: 'agent-a',
      rateeId: 'agent-b',
      rating: 0,
    })).rejects.toThrow('Rating must be between 1 and 5');
  });

  it('submitRating prevents self-rating', async () => {
    await expect(service.submitRating({
      tradeId: 'trade-1',
      raterId: 'agent-a',
      rateeId: 'agent-a',
      rating: 5,
    })).rejects.toThrow('Cannot rate yourself');
  });

  it('submitRating inserts and recalculates', async () => {
    const result = await service.submitRating({
      tradeId: 'trade-1',
      raterId: 'agent-a',
      rateeId: 'agent-b',
      rating: 4,
      comment: 'Good trade',
    });
    expect(result.rating).toBe(4);
    expect(result.trade_id).toBe('trade-1');

    // Verify avg_rating recalculation happened
    const avgQueries = queryLog.filter(q => q.sql.includes('AVG(rating)'));
    expect(avgQueries.length).toBe(1);
  });

  it('recordDispute tracks dispute for both parties', async () => {
    await service.recordDispute('buyer-1', 'seller-1');
    const inserts = queryLog.filter(q =>
      q.sql.includes('INSERT INTO agent_reputation') && q.sql.includes('disputed_trades')
    );
    expect(inserts.length).toBe(2);
  });

  it('recordDisputeResolution penalizes the loser', async () => {
    await service.recordDisputeResolution('loser-agent');
    const inserts = queryLog.filter(q =>
      q.sql.includes('INSERT INTO agent_reputation') && q.sql.includes('disputes_lost')
    );
    expect(inserts.length).toBe(1);
    expect(inserts[0].params[0]).toBe('loser-agent');
  });
});
