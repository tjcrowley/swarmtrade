export interface TrustScore {
  agent_id: string;
  score: number; // 0.0 to 1.0
  transaction_count: number;
}

export type NegotiationState = 'INIT' | 'QUOTE_PROVIDED' | 'ACCEPTED' | 'FULFILLED' | 'DISPUTED';

export interface Handshake {
  handshake_id: string;
  buyer_id: string;
  seller_id: string;
  asset_id: string;
  state: NegotiationState;
  updated_at: string;
}
