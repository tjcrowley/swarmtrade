import { Pool } from 'pg';

export interface NegotiationHandshake {
  handshake_id: string;
  buyer_id: string;
  seller_id: string;
  asset_id: string;
  state: 'INIT' | 'QUOTE_PROVIDED' | 'ACCEPTED' | 'FULFILLED' | 'DISPUTED';
}

// Logic for the state machine
export class NegotiationService {
  constructor(private pool: Pool) {}

  async createHandshake(buyer_id: string, seller_id: string, asset_id: string): Promise<string> {
    const res = await this.pool.query(
      'INSERT INTO handshakes (buyer_id, seller_id, asset_id, state) VALUES ($1, $2, $3, $4) RETURNING handshake_id',
      [buyer_id, seller_id, asset_id, 'INIT']
    );
    return res.rows[0].handshake_id;
  }
  
  async transition(handshake_id: string, newState: string): Promise<void> {
    await this.pool.query('UPDATE handshakes SET state = $1 WHERE handshake_id = $2', [newState, handshake_id]);
  }
}
