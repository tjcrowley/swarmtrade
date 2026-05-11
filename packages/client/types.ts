// ---------------------------------------------------------------------------
// SwarmTrade SDK — Types
// ---------------------------------------------------------------------------

export type AssetType = 'physical' | 'service' | 'license' | 'digital_data';
export type AssetStatus = 'available' | 'pending' | 'locked' | 'transferred';

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

export type EscrowStatus = 'locked' | 'released' | 'refunded' | 'unknown';

export type NotificationEvent =
  | 'trade.proposed' | 'trade.countered' | 'trade.accepted' | 'trade.rejected'
  | 'escrow.locked' | 'escrow.released' | 'escrow.refunded'
  | 'delivery.confirmed' | 'trade.settled'
  | 'trade.disputed' | 'trade.resolved'
  | 'trade.expired' | 'trade.cancelled';

// ---------------------------------------------------------------------------
// Request / Response shapes
// ---------------------------------------------------------------------------

export interface AgentCard {
  id: string;
  name: string;
  capabilities: string[];
  description: string;
  metadata: Record<string, unknown>;
}

export interface AssetManifest {
  asset_id: string;
  type: AssetType;
  metadata: Record<string, unknown>;
  status: AssetStatus;
  agent_card: AgentCard;
  created_at?: string;
}

export interface AnnounceResult {
  status: 'registered';
  id: string;
}

export interface SearchParams {
  type?: AssetType;
  status?: AssetStatus;
  limit?: number;
}

export interface AssetRecord {
  id: string;
  asset_id: string;
  agent_id: string;
  agent_card: AgentCard;
  asset_type: AssetType;
  metadata: Record<string, unknown>;
  status: AssetStatus;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export interface Trade {
  id: string;
  buyer_id: string;
  seller_id: string;
  asset_id: string;
  status: TradeStatus;
  quote: Record<string, unknown> | null;
  trade_value: number | null;
  currency: string | null;
  fee_bps: number | null;
  fee_amount: number | null;
  version: number;
}

export interface CreateHandshakeParams {
  buyer_id: string;
  seller_id: string;
  asset_id: string;
}

export interface TransitionParams {
  fromVersion: number;
  nextState: TradeStatus;
  quote?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Escrow
// ---------------------------------------------------------------------------

export interface LockEscrowParams {
  handshake_id: string;
  chain_id?: string;
  buyer_address: string;
  seller_address: string;
  /** Amount in smallest unit as string (for bigint support). */
  amount: string;
  token?: string;
  metadata?: Record<string, unknown>;
}

export interface LockEscrowResult {
  escrowId: string;
  txHash: string;
  status: 'escrowed';
}

export interface ConfirmDeliveryResult {
  status: 'settled';
  txHash: string;
  trade: Trade;
}

export interface DisputeResult {
  status: 'disputed';
  trade: Trade;
}

export interface ResolveEscrowResult {
  status: 'settled' | 'resolved';
  resolution: 'release' | 'refund';
  txHash: string;
  trade: Trade;
}

export interface EscrowRecord {
  escrow_id: string;
  trade_id: string;
  adapter: string;
  chain_id: string;
  buyer_address: string;
  seller_address: string;
  amount: string;
  token: string;
  status: EscrowStatus;
  tx_hash: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface SubscribeParams {
  webhook_url?: string;
  email?: string;
  events?: NotificationEvent[];
}

export interface Subscription {
  id: string;
  agent_id: string;
  webhook_url: string | null;
  email: string | null;
  events: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface NotificationLogEntry {
  id: string;
  subscription_id: string;
  trade_id: string;
  event: string;
  channel: string;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface NotificationLogResult {
  notifications: NotificationLogEntry[];
  total: number;
}

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

export interface AgentReputation {
  agent_id: string;
  total_trades: number;
  successful_trades: number;
  disputed_trades: number;
  disputes_lost: number;
  avg_rating: number | null;
  trust_score: number;
  last_trade_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface TradeRating {
  id: string;
  trade_id: string;
  rater_id: string;
  ratee_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

export interface RateParams {
  trade_id: string;
  ratee_id: string;
  rating: number;
  comment?: string;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  db_connected: boolean;
  escrow_ready: boolean;
  checks: Record<string, string>;
  adapters: { chainId: string; name: string; escrowAddress?: string }[];
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface SwarmTradeClientOptions {
  /** Base URL of the SwarmTrade API (e.g. "https://swarmtrade.store"). */
  baseUrl: string;
  /** Your agent's unique identifier. Sent as x-agent-id header. */
  agentId: string;
  /** Optional custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class SwarmTradeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'SwarmTradeError';
  }
}
