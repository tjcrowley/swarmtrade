export type TradeStatus = 
  | 'proposed'
  | 'countered'
  | 'accepted'
  | 'settled'
  | 'rejected'
  | 'expired'
  | 'cancelled';

export interface TradeTerms {
  type: string;
  trade_value?: number;  // declared value of the trade (used for fee calculation)
  currency?: string;     // ISO 4217 or token symbol, e.g. 'USD', 'ETH', 'USDC'
}

export interface TradeProposed {
  status: 'proposed';
  id: string;
  buyer: string;
  seller: string;
  asset: string;
  terms: TradeTerms;
  expires_at: Date;
  version: number;
}

export interface TradeAccepted {
  status: 'accepted';
  id: string;
  buyer: string;
  seller: string;
  asset: string;
  terms: TradeTerms;
  expires_at: Date;
  version: number;
}

export type Trade = TradeProposed | TradeAccepted;

