import { vi } from 'vitest';

/**
 * Creates a mock pg.Pool that routes queries to handler functions.
 *
 * Usage:
 *   const pool = createMockPool((sql, params) => {
 *     if (sql.includes('INSERT INTO handshakes')) return { rows: [...], rowCount: 1 };
 *     return { rows: [], rowCount: 0 };
 *   });
 */
export type QueryHandler = (sql: string, params?: any[]) => { rows: any[]; rowCount: number };

export function createMockPool(handler: QueryHandler) {
  const mockClient = {
    query: vi.fn((sql: string, params?: any[]) => Promise.resolve(handler(sql, params))),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(() => Promise.resolve(mockClient)),
    query: vi.fn((sql: string, params?: any[]) => Promise.resolve(handler(sql, params))),
    on: vi.fn(),
    end: vi.fn(),
    // Expose for assertions
    _mockClient: mockClient,
  };

  return pool as any;
}

// ---------------------------------------------------------------------------
// In-memory store that simulates Postgres for integration tests
// ---------------------------------------------------------------------------
export function createInMemoryPool() {
  const handshakes = new Map<string, any>();
  const assets = new Map<string, any>();
  const escrows = new Map<string, any>();
  const config = new Map<string, any>([
    ['fee_config', { fee_bps: 150, min_fee: null, max_fee: null }],
  ]);
  const notificationSubs = new Map<string, any>();
  const notificationLogs: any[] = [];

  let idCounter = 0;
  const nextId = () => `00000000-0000-0000-0000-${String(++idCounter).padStart(12, '0')}`;

  function handleQuery(sql: string, params?: any[]): { rows: any[]; rowCount: number } {
    const s = sql.replace(/\s+/g, ' ').trim();

    // --- notification_subscriptions ---
    if (s.includes('INSERT INTO notification_subscriptions')) {
      // Upsert logic: check for existing sub
      const agentId = params?.[0];
      const webhookUrl = params?.[1] ?? null;
      const email = params?.[1] === undefined ? params?.[1] : (params?.[2] ?? null);
      const events = params?.[2] !== undefined ? params?.[2] : (params?.[1] !== undefined ? params?.[2] : []);

      // Determine params based on which INSERT variant
      let subAgentId: string;
      let subWebhookUrl: string | null;
      let subEmail: string | null;
      let subEvents: string[];

      if (s.includes('webhook_url, email, events') && s.includes('ON CONFLICT (agent_id, webhook_url)')) {
        // INSERT with webhook: params = [agentId, webhook_url, email, events]
        subAgentId = params?.[0];
        subWebhookUrl = params?.[1];
        subEmail = params?.[2];
        subEvents = params?.[3] || [];
      } else if (s.includes('ON CONFLICT (agent_id, email)')) {
        // INSERT with email only: params = [agentId, email, events]
        subAgentId = params?.[0];
        subWebhookUrl = null;
        subEmail = params?.[1];
        subEvents = params?.[2] || [];
      } else {
        subAgentId = params?.[0];
        subWebhookUrl = params?.[1];
        subEmail = params?.[2];
        subEvents = params?.[3] || [];
      }

      // Check for existing
      const existing = Array.from(notificationSubs.values()).find(sub => {
        if (subWebhookUrl) return sub.agent_id === subAgentId && sub.webhook_url === subWebhookUrl;
        if (subEmail) return sub.agent_id === subAgentId && sub.email === subEmail;
        return false;
      });

      if (existing) {
        // Upsert — update in place
        if (subEmail && subWebhookUrl) existing.email = subEmail;
        existing.events = subEvents;
        existing.active = true;
        existing.updated_at = new Date().toISOString();
        return { rows: [{ ...existing }], rowCount: 1 };
      }

      const id = nextId();
      const sub = {
        id,
        agent_id: subAgentId,
        webhook_url: subWebhookUrl,
        email: subEmail,
        events: subEvents,
        active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      notificationSubs.set(id, sub);
      return { rows: [{ ...sub }], rowCount: 1 };
    }

    if (s.includes('UPDATE notification_subscriptions') && s.includes('active = false')) {
      const subId = params?.[0];
      const agentId = params?.[1];
      const sub = notificationSubs.get(subId);
      if (sub && sub.agent_id === agentId) {
        sub.active = false;
        sub.updated_at = new Date().toISOString();
        return { rows: [{ ...sub }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (s.includes('FROM notification_subscriptions') && s.includes('agent_id = ANY')) {
      const agentIds: string[] = params?.[0] || [];
      const rows = Array.from(notificationSubs.values())
        .filter(sub => agentIds.includes(sub.agent_id) && sub.active);
      return { rows, rowCount: rows.length };
    }

    if (s.includes('FROM notification_subscriptions') && s.includes('agent_id =') && s.includes('active = true')) {
      const agentId = params?.[0];
      const rows = Array.from(notificationSubs.values())
        .filter(sub => sub.agent_id === agentId && sub.active);
      return { rows, rowCount: rows.length };
    }

    // --- notification_log ---
    if (s.includes('INSERT INTO notification_log')) {
      const id = nextId();
      const log = {
        id,
        subscription_id: params?.[0],
        trade_id: params?.[1],
        event: params?.[2],
        channel: params?.[3],
        payload: params?.[4] ? JSON.parse(params[4]) : null,
        status: params?.[5],
        attempts: params?.[6],
        last_error: params?.[7],
        created_at: new Date().toISOString(),
      };
      notificationLogs.push(log);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (s.includes('FROM notification_log nl') && s.includes('JOIN notification_subscriptions ns') && s.includes('COUNT(*)')) {
      const agentId = params?.[0];
      const count = notificationLogs.filter(log => {
        const sub = notificationSubs.get(log.subscription_id);
        return sub && sub.agent_id === agentId;
      }).length;
      return { rows: [{ total: String(count) }], rowCount: 1 };
    }

    if (s.includes('FROM notification_log nl') && s.includes('JOIN notification_subscriptions ns')) {
      const agentId = params?.[0];
      const limit = params?.[1] ?? 50;
      const offset = params?.[2] ?? 0;
      const rows = notificationLogs
        .filter(log => {
          const sub = notificationSubs.get(log.subscription_id);
          return sub && sub.agent_id === agentId;
        })
        .reverse()
        .slice(Number(offset), Number(offset) + Number(limit));
      return { rows, rowCount: rows.length };
    }

    if (s.includes('FROM notification_log') && s.includes('COUNT(*)') && !s.includes('JOIN')) {
      return { rows: [{ total: String(notificationLogs.length) }], rowCount: 1 };
    }

    if (s.includes('FROM notification_log') && !s.includes('JOIN')) {
      const limit = params?.[0] ?? 50;
      const offset = params?.[1] ?? 0;
      const rows = [...notificationLogs]
        .reverse()
        .slice(Number(offset), Number(offset) + Number(limit));
      return { rows, rowCount: rows.length };
    }

    // --- handshakes ---
    if (s.includes('INSERT INTO handshakes')) {
      const id = nextId();
      const trade = {
        id,
        handshake_id: id,
        buyer_id: params?.[0],
        seller_id: params?.[1],
        asset_id: params?.[2],
        state: 'proposed',
        status: 'proposed',
        quote: null,
        trade_value: null,
        currency: null,
        fee_bps: null,
        fee_amount: null,
        version: 1,
      };
      handshakes.set(id, trade);
      return { rows: [trade], rowCount: 1 };
    }

    if (s.includes('UPDATE handshakes') && /SET state\s*=\s*'resolved'/.test(s)) {
      // resolveDispute: SET state='resolved', quote=$1::jsonb WHERE handshake_id=$2 AND version=$3
      const quoteJson = params?.[0] ? JSON.parse(params[0]) : null;
      const hid = params?.[1];
      const fromVersion = params?.[2];
      const trade = handshakes.get(hid);
      if (!trade || trade.version !== fromVersion) {
        return { rows: [], rowCount: 0 };
      }
      trade.state = 'resolved';
      trade.status = 'resolved';
      if (quoteJson) trade.quote = quoteJson;
      trade.version += 1;
      return { rows: [{ ...trade, id: trade.handshake_id }], rowCount: 1 };
    }

    if (s.includes('UPDATE handshakes') && s.includes('SET state')) {
      const nextState = params?.[0];
      const quoteJson = params?.[1] ? JSON.parse(params[1]) : null;
      const tradeValue = params?.[2];
      const currency = params?.[3];
      const feeBps = params?.[4];
      const feeAmount = params?.[5];
      const hid = params?.[6];
      const fromVersion = params?.[7];
      const trade = handshakes.get(hid);
      if (!trade || trade.version !== fromVersion) {
        return { rows: [], rowCount: 0 };
      }
      trade.state = nextState;
      trade.status = nextState;
      if (quoteJson) trade.quote = quoteJson;
      if (tradeValue !== null && tradeValue !== undefined) trade.trade_value = tradeValue;
      if (currency !== null && currency !== undefined) trade.currency = currency;
      if (feeBps !== null && feeBps !== undefined) trade.fee_bps = feeBps;
      if (feeAmount !== null && feeAmount !== undefined) trade.fee_amount = feeAmount;
      trade.version += 1;
      return { rows: [{ ...trade, id: trade.handshake_id }], rowCount: 1 };
    }

    if (s.includes('FROM handshakes WHERE handshake_id')) {
      const hid = params?.[0];
      const trade = handshakes.get(hid);
      if (!trade) return { rows: [], rowCount: 0 };
      return { rows: [{ ...trade, id: trade.handshake_id }], rowCount: 1 };
    }

    if (s.includes('FROM handshakes ORDER BY')) {
      const limit = params?.[0] ?? 20;
      const rows = Array.from(handshakes.values()).slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    if (s.includes('FROM handshakes') && s.includes('COUNT(*)')) {
      const all = Array.from(handshakes.values());
      return {
        rows: [{
          total_trades: String(all.length),
          active_negotiations: String(all.filter(t => !['settled', 'rejected', 'expired', 'cancelled'].includes(t.state)).length),
          settled_trades: String(all.filter(t => t.state === 'settled').length),
          total_volume: String(all.filter(t => t.state === 'settled').reduce((s, t) => s + (t.trade_value || 0), 0)),
          total_fees_collected: String(all.filter(t => t.state === 'settled').reduce((s, t) => s + (t.fee_amount || 0), 0)),
        }],
        rowCount: 1,
      };
    }

    // --- asset_announcements ---
    if (s.includes('INSERT INTO asset_announcements')) {
      const id = nextId();
      const asset = {
        id,
        asset_id: params?.[0],
        agent_id: params?.[1],
        agent_card: JSON.parse(params?.[2]),
        asset_type: params?.[3],
        metadata: JSON.parse(params?.[4]),
        status: 'available',
        created_at: new Date().toISOString(),
      };
      assets.set(id, asset);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (s.includes('FROM asset_announcements')) {
      const rows = Array.from(assets.values());
      return { rows, rowCount: rows.length };
    }

    // --- escrow_records ---
    if (s.includes('INSERT INTO escrow_records')) {
      const id = nextId();
      const escrow = {
        escrow_id: id,
        trade_id: params?.[0],
        adapter: params?.[1],
        chain_id: params?.[2],
        buyer_address: params?.[3],
        seller_address: params?.[4],
        amount: params?.[5],
        token: params?.[6],
        status: 'locked',
      };
      escrows.set(id, escrow);
      return { rows: [{ escrow_id: id }], rowCount: 1 };
    }

    if (s.includes('UPDATE escrow_records') && s.includes("status = 'released'")) {
      const eid = params?.[0];
      const escrow = escrows.get(eid);
      if (!escrow || escrow.status !== 'locked') return { rows: [], rowCount: 0 };
      escrow.status = 'released';
      return { rows: [{ escrow_id: eid }], rowCount: 1 };
    }

    if (s.includes('UPDATE escrow_records') && s.includes("status = 'refunded'")) {
      const eid = params?.[0];
      const escrow = escrows.get(eid);
      if (!escrow || escrow.status !== 'locked') return { rows: [], rowCount: 0 };
      escrow.status = 'refunded';
      return { rows: [{ escrow_id: eid }], rowCount: 1 };
    }

    if (s.includes('FROM escrow_records WHERE escrow_id')) {
      const eid = params?.[0];
      const escrow = escrows.get(eid);
      if (!escrow) return { rows: [], rowCount: 0 };
      return { rows: [escrow], rowCount: 1 };
    }

    if (s.includes('FROM escrow_records WHERE trade_id')) {
      const tradeId = params?.[0];
      const match = Array.from(escrows.values()).find(e => e.trade_id === tradeId);
      if (!match) return { rows: [], rowCount: 0 };
      return { rows: [match], rowCount: 1 };
    }

    // Escrows admin listing (ORDER BY with LIMIT/OFFSET)
    if (s.includes('FROM escrow_records e') && s.includes('ORDER BY')) {
      const limit = params?.[0] ?? 25;
      const offset = params?.[1] ?? 0;
      const rows = Array.from(escrows.values())
        .slice(Number(offset), Number(offset) + Number(limit));
      return { rows, rowCount: rows.length };
    }

    if (s.includes('COUNT(*)') && s.includes('FROM escrow_records') && !s.includes('WHERE')) {
      return { rows: [{ total: String(escrows.size) }], rowCount: 1 };
    }

    // Disputes admin query (joins handshakes + escrow_records WHERE state='disputed')
    if (s.includes('FROM handshakes h') && s.includes("state = 'disputed'")) {
      const rows = Array.from(handshakes.values())
        .filter(t => t.state === 'disputed')
        .map(t => {
          const escrow = Array.from(escrows.values()).find(e => e.trade_id === t.handshake_id);
          return {
            id: t.handshake_id,
            buyer_id: t.buyer_id,
            seller_id: t.seller_id,
            asset_id: t.asset_id,
            status: t.state,
            trade_value: t.trade_value,
            currency: t.currency,
            fee_amount: t.fee_amount,
            version: t.version,
            updated_at: t.updated_at,
            escrow_id: escrow?.escrow_id,
            escrow_amount: escrow?.amount,
            escrow_locked_at: escrow?.created_at,
          };
        });
      return { rows, rowCount: rows.length };
    }

    // --- platform_config ---
    if (s.includes("FROM platform_config WHERE key = 'fee_config'")) {
      const val = config.get('fee_config');
      return { rows: val ? [{ value: val }] : [], rowCount: val ? 1 : 0 };
    }

    if (s.includes('INSERT INTO platform_config')) {
      const value = JSON.parse(params?.[0]);
      config.set('fee_config', value);
      return { rows: [], rowCount: 1 };
    }

    // fallback
    return { rows: [], rowCount: 0 };
  }

  const mockClient = {
    query: vi.fn((sql: string, params?: any[]) => Promise.resolve(handleQuery(sql, params))),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(() => Promise.resolve(mockClient)),
    query: vi.fn((sql: string, params?: any[]) => Promise.resolve(handleQuery(sql, params))),
    on: vi.fn(),
    end: vi.fn(),
    _mockClient: mockClient,
    // Expose stores for assertions
    _handshakes: handshakes,
    _escrows: escrows,
    _assets: assets,
    _config: config,
    _notificationSubs: notificationSubs,
    _notificationLogs: notificationLogs,
  };

  return pool as any;
}
