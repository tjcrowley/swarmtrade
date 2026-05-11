import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwarmTradeClient, SwarmTradeError } from '../index';
import type {
  AssetManifest,
  Trade,
  LockEscrowResult,
  ConfirmDeliveryResult,
  DisputeResult,
  ResolveEscrowResult,
  EscrowRecord,
  Subscription,
  AgentReputation,
  TradeRating,
  HealthResponse,
} from '../index';

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function makeClient(fetchFn: ReturnType<typeof vi.fn>) {
  return new SwarmTradeClient({
    baseUrl: 'https://swarmtrade.store',
    agentId: 'agent-test-1',
    fetch: fetchFn as unknown as typeof globalThis.fetch,
  });
}

// Helpers to inspect calls
function lastUrl(fetchFn: ReturnType<typeof vi.fn>): string {
  return fetchFn.mock.calls[0][0];
}
function lastInit(fetchFn: ReturnType<typeof vi.fn>): RequestInit {
  return fetchFn.mock.calls[0][1];
}
function lastBody(fetchFn: ReturnType<typeof vi.fn>): unknown {
  const init = lastInit(fetchFn);
  return init.body ? JSON.parse(init.body as string) : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SwarmTradeClient', () => {
  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  it('strips trailing slash from baseUrl', () => {
    const f = mockFetch(200, { status: 'healthy' });
    const client = new SwarmTradeClient({
      baseUrl: 'https://swarmtrade.store/',
      agentId: 'a',
      fetch: f as any,
    });
    client.health();
    expect(lastUrl(f)).toBe('https://swarmtrade.store/health');
  });

  it('sends x-agent-id header on every request', async () => {
    const f = mockFetch(200, { status: 'healthy' });
    const client = makeClient(f);
    await client.health();
    const headers = lastInit(f).headers as Record<string, string>;
    expect(headers['x-agent-id']).toBe('agent-test-1');
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it('throws SwarmTradeError on non-2xx with error field', async () => {
    const f = mockFetch(400, { error: 'Bad request' });
    const client = makeClient(f);
    await expect(client.health()).rejects.toThrow(SwarmTradeError);
    try {
      await client.health();
    } catch (e) {
      const err = e as SwarmTradeError;
      expect(err.status).toBe(400);
      expect(err.message).toBe('Bad request');
      expect(err.body).toEqual({ error: 'Bad request' });
    }
  });

  it('throws SwarmTradeError with HTTP status when no error field', async () => {
    const f = mockFetch(500, { unexpected: true });
    const client = makeClient(f);
    try {
      await client.health();
    } catch (e) {
      const err = e as SwarmTradeError;
      expect(err.status).toBe(500);
      expect(err.message).toBe('HTTP 500');
    }
  });

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  describe('health()', () => {
    it('calls GET /health', async () => {
      const body: HealthResponse = {
        status: 'healthy',
        timestamp: '2026-05-10T00:00:00Z',
        db_connected: true,
        escrow_ready: true,
        checks: { database: 'OK', escrow: 'Ready (6 adapters)' },
        adapters: [{ chainId: 'off-chain', name: 'ConfirmationEscrow' }],
      };
      const f = mockFetch(200, body);
      const client = makeClient(f);
      const result = await client.health();
      expect(lastUrl(f)).toBe('https://swarmtrade.store/health');
      expect(result.status).toBe('healthy');
      expect(result.db_connected).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Registry
  // -----------------------------------------------------------------------

  describe('announce()', () => {
    it('calls POST /registry/announce with asset manifest', async () => {
      const f = mockFetch(200, { status: 'registered', id: 'abc-123' });
      const client = makeClient(f);
      const asset: AssetManifest = {
        asset_id: 'sha256-abc',
        type: 'service',
        metadata: { tier: 'premium' },
        status: 'available',
        agent_card: {
          id: 'agent-test-1',
          name: 'Test Agent',
          capabilities: ['data-analysis'],
          description: 'A test agent',
          metadata: {},
        },
      };
      const result = await client.announce(asset);
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/announce');
      expect((lastInit(f) as any).method).toBe('POST');
      expect(lastBody(f)).toEqual(asset);
      expect(result.status).toBe('registered');
      expect(result.id).toBe('abc-123');
    });
  });

  describe('search()', () => {
    it('calls GET /registry/search with query params', async () => {
      const f = mockFetch(200, []);
      const client = makeClient(f);
      await client.search({ type: 'service', limit: 10 });
      expect(lastUrl(f)).toContain('/registry/search?');
      expect(lastUrl(f)).toContain('type=service');
      expect(lastUrl(f)).toContain('limit=10');
    });

    it('omits empty params', async () => {
      const f = mockFetch(200, []);
      const client = makeClient(f);
      await client.search();
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/search');
    });
  });

  // -----------------------------------------------------------------------
  // Negotiation
  // -----------------------------------------------------------------------

  describe('createHandshake()', () => {
    it('calls POST /registry/handshake', async () => {
      const trade: Trade = {
        id: 'trade-1',
        buyer_id: 'buyer',
        seller_id: 'seller',
        asset_id: 'asset-1',
        status: 'proposed',
        quote: null,
        trade_value: null,
        currency: null,
        fee_bps: null,
        fee_amount: null,
        version: 1,
      };
      const f = mockFetch(200, trade);
      const client = makeClient(f);
      const result = await client.createHandshake({
        buyer_id: 'buyer',
        seller_id: 'seller',
        asset_id: 'asset-1',
      });
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/handshake');
      expect(lastBody(f)).toEqual({ buyer_id: 'buyer', seller_id: 'seller', asset_id: 'asset-1' });
      expect(result.status).toBe('proposed');
    });
  });

  describe('getTrade()', () => {
    it('calls GET /registry/handshake/:id', async () => {
      const trade: Trade = {
        id: 'trade-1', buyer_id: 'b', seller_id: 's', asset_id: 'a',
        status: 'accepted', quote: null, trade_value: 100, currency: 'USD',
        fee_bps: null, fee_amount: null, version: 3,
      };
      const f = mockFetch(200, trade);
      const client = makeClient(f);
      const result = await client.getTrade('trade-1');
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/handshake/trade-1');
      expect(result.id).toBe('trade-1');
    });
  });

  describe('transition()', () => {
    it('calls POST /registry/negotiation/:id/transition', async () => {
      const trade: Trade = {
        id: 'trade-1', buyer_id: 'b', seller_id: 's', asset_id: 'a',
        status: 'accepted', quote: null, trade_value: null, currency: null,
        fee_bps: null, fee_amount: null, version: 2,
      };
      const f = mockFetch(200, trade);
      const client = makeClient(f);
      const result = await client.transition('trade-1', { fromVersion: 1, nextState: 'accepted' });
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/negotiation/trade-1/transition');
      expect(lastBody(f)).toEqual({ fromVersion: 1, nextState: 'accepted' });
      expect(result.status).toBe('accepted');
    });

    it('includes quote when provided', async () => {
      const f = mockFetch(200, { id: 'trade-1', status: 'countered', version: 2 });
      const client = makeClient(f);
      await client.transition('trade-1', {
        fromVersion: 1,
        nextState: 'countered',
        quote: { trade_value: 200, currency: 'USD' },
      });
      expect(lastBody(f)).toEqual({
        fromVersion: 1,
        nextState: 'countered',
        quote: { trade_value: 200, currency: 'USD' },
      });
    });
  });

  // -----------------------------------------------------------------------
  // Escrow
  // -----------------------------------------------------------------------

  describe('lockEscrow()', () => {
    it('calls POST /registry/escrow/lock', async () => {
      const result: LockEscrowResult = { escrowId: 'esc-1', txHash: 'tx-abc', status: 'escrowed' };
      const f = mockFetch(200, result);
      const client = makeClient(f);
      const res = await client.lockEscrow({
        handshake_id: 'trade-1',
        buyer_address: 'buyer-addr',
        seller_address: 'seller-addr',
        amount: '10000',
      });
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/escrow/lock');
      expect(lastBody(f)).toEqual({
        handshake_id: 'trade-1',
        buyer_address: 'buyer-addr',
        seller_address: 'seller-addr',
        amount: '10000',
      });
      expect(res.escrowId).toBe('esc-1');
    });

    it('passes chain_id and metadata for on-chain locks', async () => {
      const f = mockFetch(200, { escrowId: 'esc-2', txHash: '0x...', status: 'escrowed' });
      const client = makeClient(f);
      await client.lockEscrow({
        handshake_id: 'trade-2',
        chain_id: '8453',
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '1000000000000000000',
        token: 'native',
        metadata: { deposit_tx_hash: '0xdeposit123' },
      });
      const body = lastBody(f) as any;
      expect(body.chain_id).toBe('8453');
      expect(body.metadata.deposit_tx_hash).toBe('0xdeposit123');
    });
  });

  describe('confirmDelivery()', () => {
    it('calls POST /registry/escrow/:escrowId/confirm-delivery', async () => {
      const settled: ConfirmDeliveryResult = {
        status: 'settled',
        txHash: 'tx-release',
        trade: { id: 't-1', buyer_id: 'b', seller_id: 's', asset_id: 'a', status: 'settled', quote: null, trade_value: 100, currency: 'USD', fee_bps: 150, fee_amount: 1.5, version: 5 },
      };
      const f = mockFetch(200, settled);
      const client = makeClient(f);
      const result = await client.confirmDelivery('esc-1');
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/escrow/esc-1/confirm-delivery');
      expect(result.status).toBe('settled');
      expect(result.trade.fee_amount).toBe(1.5);
    });
  });

  describe('dispute()', () => {
    it('calls POST /registry/escrow/:escrowId/dispute', async () => {
      const result: DisputeResult = {
        status: 'disputed',
        trade: { id: 't-1', buyer_id: 'b', seller_id: 's', asset_id: 'a', status: 'disputed', quote: null, trade_value: 100, currency: 'USD', fee_bps: null, fee_amount: null, version: 4 },
      };
      const f = mockFetch(200, result);
      const client = makeClient(f);
      const res = await client.dispute('esc-1');
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/escrow/esc-1/dispute');
      expect(res.status).toBe('disputed');
    });
  });

  describe('resolveEscrow()', () => {
    it('calls POST /registry/escrow/:escrowId/resolve with resolution', async () => {
      const result: ResolveEscrowResult = {
        status: 'resolved',
        resolution: 'refund',
        txHash: 'tx-refund',
        trade: { id: 't-1', buyer_id: 'b', seller_id: 's', asset_id: 'a', status: 'resolved', quote: null, trade_value: 100, currency: 'USD', fee_bps: null, fee_amount: null, version: 5 },
      };
      const f = mockFetch(200, result);
      const client = makeClient(f);
      const res = await client.resolveEscrow('esc-1', 'refund');
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/escrow/esc-1/resolve');
      expect(lastBody(f)).toEqual({ resolution: 'refund' });
      expect(res.resolution).toBe('refund');
    });
  });

  describe('getEscrow()', () => {
    it('calls GET /registry/escrow/:escrowId', async () => {
      const record: EscrowRecord = {
        escrow_id: 'esc-1', trade_id: 't-1', adapter: 'off-chain', chain_id: 'off-chain',
        buyer_address: 'b', seller_address: 's', amount: '10000', token: 'native',
        status: 'locked', tx_hash: 'tx-1', created_at: '2026-05-10T00:00:00Z', updated_at: '2026-05-10T00:00:00Z',
      };
      const f = mockFetch(200, record);
      const client = makeClient(f);
      const res = await client.getEscrow('esc-1');
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/escrow/esc-1');
      expect(res.status).toBe('locked');
    });
  });

  // -----------------------------------------------------------------------
  // Notifications
  // -----------------------------------------------------------------------

  describe('subscribe()', () => {
    it('calls POST /registry/notifications/subscribe', async () => {
      const sub: Subscription = {
        id: 'sub-1', agent_id: 'agent-test-1', webhook_url: 'https://hook.example.com',
        email: null, events: ['trade.settled'], active: true,
        created_at: '2026-05-10T00:00:00Z', updated_at: '2026-05-10T00:00:00Z',
      };
      const f = mockFetch(200, sub);
      const client = makeClient(f);
      const result = await client.subscribe({
        webhook_url: 'https://hook.example.com',
        events: ['trade.settled'],
      });
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/notifications/subscribe');
      expect(lastBody(f)).toEqual({ webhook_url: 'https://hook.example.com', events: ['trade.settled'] });
      expect(result.id).toBe('sub-1');
    });
  });

  describe('unsubscribe()', () => {
    it('calls DELETE /registry/notifications/:id', async () => {
      const f = mockFetch(200, { ok: true });
      const client = makeClient(f);
      const result = await client.unsubscribe('sub-1');
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/notifications/sub-1');
      expect(lastInit(f).method).toBe('DELETE');
      expect(result.ok).toBe(true);
    });
  });

  describe('listSubscriptions()', () => {
    it('calls GET /registry/notifications/subscriptions', async () => {
      const f = mockFetch(200, { subscriptions: [] });
      const client = makeClient(f);
      const result = await client.listSubscriptions();
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/notifications/subscriptions');
      expect(result.subscriptions).toEqual([]);
    });
  });

  describe('notificationLog()', () => {
    it('calls GET /registry/notifications/log with params', async () => {
      const f = mockFetch(200, { notifications: [], total: 0 });
      const client = makeClient(f);
      await client.notificationLog({ limit: 10, offset: 5 });
      expect(lastUrl(f)).toContain('limit=10');
      expect(lastUrl(f)).toContain('offset=5');
    });

    it('omits params when not provided', async () => {
      const f = mockFetch(200, { notifications: [], total: 0 });
      const client = makeClient(f);
      await client.notificationLog();
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/notifications/log');
    });
  });

  // -----------------------------------------------------------------------
  // Reputation
  // -----------------------------------------------------------------------

  describe('getReputation()', () => {
    it('calls GET /registry/reputation/:agentId', async () => {
      const rep: AgentReputation = {
        agent_id: 'agent-x', total_trades: 10, successful_trades: 9,
        disputed_trades: 1, disputes_lost: 0, avg_rating: 4.5, trust_score: 85,
        last_trade_at: '2026-05-10T00:00:00Z',
      };
      const f = mockFetch(200, rep);
      const client = makeClient(f);
      const result = await client.getReputation('agent-x');
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/reputation/agent-x');
      expect(result.trust_score).toBe(85);
    });
  });

  describe('getRatings()', () => {
    it('calls GET /registry/reputation/:agentId/ratings', async () => {
      const f = mockFetch(200, []);
      const client = makeClient(f);
      await client.getRatings('agent-x', 5);
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/reputation/agent-x/ratings?limit=5');
    });

    it('omits limit when not provided', async () => {
      const f = mockFetch(200, []);
      const client = makeClient(f);
      await client.getRatings('agent-x');
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/reputation/agent-x/ratings');
    });
  });

  describe('rate()', () => {
    it('calls POST /registry/reputation/rate', async () => {
      const rating: TradeRating = {
        id: 'r-1', trade_id: 't-1', rater_id: 'agent-test-1',
        ratee_id: 'agent-x', rating: 5, comment: 'Great trade!',
        created_at: '2026-05-10T00:00:00Z',
      };
      const f = mockFetch(200, rating);
      const client = makeClient(f);
      const result = await client.rate({
        trade_id: 't-1',
        ratee_id: 'agent-x',
        rating: 5,
        comment: 'Great trade!',
      });
      expect(lastUrl(f)).toBe('https://swarmtrade.store/registry/reputation/rate');
      expect(lastBody(f)).toEqual({
        trade_id: 't-1',
        ratee_id: 'agent-x',
        rating: 5,
        comment: 'Great trade!',
      });
      expect(result.rating).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // Full lifecycle integration test (mock)
  // -----------------------------------------------------------------------

  describe('full trade lifecycle', () => {
    it('announce → handshake → accept → lock → confirm → rate', async () => {
      let callIndex = 0;
      const responses = [
        { status: 'registered', id: 'asset-1' },                                    // announce
        { id: 't-1', buyer_id: 'buyer', seller_id: 'seller', asset_id: 'a-1', status: 'proposed', quote: null, trade_value: null, currency: null, fee_bps: null, fee_amount: null, version: 1 }, // handshake
        { id: 't-1', buyer_id: 'buyer', seller_id: 'seller', asset_id: 'a-1', status: 'accepted', quote: null, trade_value: null, currency: null, fee_bps: null, fee_amount: null, version: 2 }, // accept
        { escrowId: 'esc-1', txHash: 'tx-lock', status: 'escrowed' },               // lock
        { status: 'settled', txHash: 'tx-release', trade: { id: 't-1', status: 'settled', fee_amount: 1.5, version: 5 } }, // confirm
        { id: 'r-1', trade_id: 't-1', rater_id: 'buyer', ratee_id: 'seller', rating: 5, comment: null, created_at: '2026-05-10T00:00:00Z' }, // rate
      ];

      const f = vi.fn().mockImplementation(() => {
        const body = responses[callIndex++];
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(body)),
        });
      });

      const client = new SwarmTradeClient({
        baseUrl: 'https://swarmtrade.store',
        agentId: 'buyer',
        fetch: f as any,
      });

      // 1. Announce
      const announced = await client.announce({
        asset_id: 'sha256-test',
        type: 'service',
        metadata: {},
        status: 'available',
        agent_card: { id: 'seller', name: 'Seller', capabilities: [], description: '', metadata: {} },
      });
      expect(announced.status).toBe('registered');

      // 2. Create handshake
      const trade = await client.createHandshake({ buyer_id: 'buyer', seller_id: 'seller', asset_id: 'a-1' });
      expect(trade.status).toBe('proposed');

      // 3. Accept
      const accepted = await client.transition('t-1', { fromVersion: 1, nextState: 'accepted' });
      expect(accepted.status).toBe('accepted');

      // 4. Lock escrow
      const locked = await client.lockEscrow({
        handshake_id: 't-1',
        buyer_address: 'buyer',
        seller_address: 'seller',
        amount: '10000',
      });
      expect(locked.escrowId).toBe('esc-1');

      // 5. Confirm delivery → settled
      const settled = await client.confirmDelivery('esc-1');
      expect(settled.status).toBe('settled');

      // 6. Rate counterparty
      const rated = await client.rate({ trade_id: 't-1', ratee_id: 'seller', rating: 5 });
      expect(rated.rating).toBe(5);

      expect(f).toHaveBeenCalledTimes(6);
    });
  });
});
