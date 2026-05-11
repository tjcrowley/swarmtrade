// ---------------------------------------------------------------------------
// SwarmTrade SDK — Agent Client
// ---------------------------------------------------------------------------

export * from './types.js';

import type {
  SwarmTradeClientOptions,
  AssetManifest,
  AnnounceResult,
  SearchParams,
  AssetRecord,
  Trade,
  CreateHandshakeParams,
  TransitionParams,
  LockEscrowParams,
  LockEscrowResult,
  ConfirmDeliveryResult,
  DisputeResult,
  ResolveEscrowResult,
  EscrowRecord,
  SubscribeParams,
  Subscription,
  NotificationLogResult,
  AgentReputation,
  TradeRating,
  RateParams,
  HealthResponse,
} from './types.js';

import { SwarmTradeError } from './types.js';

export class SwarmTradeClient {
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(opts: SwarmTradeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.agentId = opts.agentId;
    this._fetch = opts.fetch ?? globalThis.fetch;
  }

  // -------------------------------------------------------------------------
  // Internal HTTP helpers
  // -------------------------------------------------------------------------

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this._fetch(url, {
      ...init,
      headers: {
        'x-agent-id': this.agentId,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    const body = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }

    if (!res.ok) {
      const msg = typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
      throw new SwarmTradeError(msg, res.status, parsed);
    }

    return parsed as T;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  private del<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  /** Check API health, DB connectivity, and escrow adapter status. */
  async health(): Promise<HealthResponse> {
    return this.get('/health');
  }

  // -------------------------------------------------------------------------
  // Registry — Asset Announcements
  // -------------------------------------------------------------------------

  /** Announce an asset to the registry. */
  async announce(asset: AssetManifest): Promise<AnnounceResult> {
    return this.post('/registry/announce', asset);
  }

  /** Search registered assets. */
  async search(params: SearchParams = {}): Promise<AssetRecord[]> {
    const qs = new URLSearchParams();
    if (params.type) qs.set('type', params.type);
    if (params.status) qs.set('status', params.status);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return this.get(`/registry/search${q ? `?${q}` : ''}`);
  }

  // -------------------------------------------------------------------------
  // Negotiation — Trade lifecycle
  // -------------------------------------------------------------------------

  /** Initiate a trade handshake between buyer and seller. */
  async createHandshake(params: CreateHandshakeParams): Promise<Trade> {
    return this.post('/registry/handshake', params);
  }

  /** Get a handshake / trade by ID. */
  async getTrade(tradeId: string): Promise<Trade> {
    return this.get(`/registry/handshake/${tradeId}`);
  }

  /** Transition a trade to the next state. */
  async transition(tradeId: string, params: TransitionParams): Promise<Trade> {
    return this.post(`/registry/negotiation/${tradeId}/transition`, params);
  }

  // -------------------------------------------------------------------------
  // Escrow
  // -------------------------------------------------------------------------

  /** Lock funds in escrow for an accepted trade. */
  async lockEscrow(params: LockEscrowParams): Promise<LockEscrowResult> {
    return this.post('/registry/escrow/lock', params);
  }

  /** Confirm delivery and release escrow — settles the trade. */
  async confirmDelivery(escrowId: string): Promise<ConfirmDeliveryResult> {
    return this.post(`/registry/escrow/${escrowId}/confirm-delivery`, {});
  }

  /** Dispute an escrowed trade. */
  async dispute(escrowId: string): Promise<DisputeResult> {
    return this.post(`/registry/escrow/${escrowId}/dispute`, {});
  }

  /** Resolve a disputed escrow (release to seller or refund to buyer). */
  async resolveEscrow(escrowId: string, resolution: 'release' | 'refund'): Promise<ResolveEscrowResult> {
    return this.post(`/registry/escrow/${escrowId}/resolve`, { resolution });
  }

  /** Get escrow record by ID. */
  async getEscrow(escrowId: string): Promise<EscrowRecord> {
    return this.get(`/registry/escrow/${escrowId}`);
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /** Subscribe to trade event notifications via webhook and/or email. */
  async subscribe(params: SubscribeParams): Promise<Subscription> {
    return this.post('/registry/notifications/subscribe', params);
  }

  /** Unsubscribe from notifications. */
  async unsubscribe(subscriptionId: string): Promise<{ ok: true }> {
    return this.del(`/registry/notifications/${subscriptionId}`);
  }

  /** List active notification subscriptions for this agent. */
  async listSubscriptions(): Promise<{ subscriptions: Subscription[] }> {
    return this.get('/registry/notifications/subscriptions');
  }

  /** Get notification delivery log for this agent. */
  async notificationLog(opts?: { limit?: number; offset?: number }): Promise<NotificationLogResult> {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) qs.set('offset', String(opts.offset));
    const q = qs.toString();
    return this.get(`/registry/notifications/log${q ? `?${q}` : ''}`);
  }

  // -------------------------------------------------------------------------
  // Reputation
  // -------------------------------------------------------------------------

  /** Get an agent's reputation and trust score. */
  async getReputation(agentId: string): Promise<AgentReputation> {
    return this.get(`/registry/reputation/${agentId}`);
  }

  /** Get ratings received by an agent. */
  async getRatings(agentId: string, limit?: number): Promise<TradeRating[]> {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    return this.get(`/registry/reputation/${agentId}/ratings${qs}`);
  }

  /** Rate a trade counterparty (1-5 stars). Must be a participant in a settled/resolved trade. */
  async rate(params: RateParams): Promise<TradeRating> {
    return this.post('/registry/reputation/rate', params);
  }
}
