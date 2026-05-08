import { Pool } from 'pg';
import pool from './db';

export class NegotiationRepository {
  async transition(
    handshakeId: string,
    fromVersion: number,
    nextState: string,
    quote?: any
  ): Promise<any> {
    const client = await pool.connect();
    try {
      // ATOMIC CAS: Update WHERE id = ? AND version = ?
      const res = await client.query(
        `UPDATE handshakes 
         SET state = $1, 
             quote = $2, 
             version = version + 1,
             updated_at = NOW()
         WHERE handshake_id = $3 AND version = $4
         RETURNING *`,
        [nextState, quote ? JSON.stringify(quote) : null, handshakeId, fromVersion]
      );

      if (res.rowCount === 0) {
        // Either the ID doesn't exist, or the version mismatch (TOCTOU)
        throw new Error('StaleVersionError: Trade state was modified by another agent.');
      }
      return res.rows[0];
    } finally {
      client.release();
    }
  }

  async findById(handshakeId: string): Promise<any | null> {
    const client = await pool.connect();
    try {
      const res = await client.query(
        'SELECT * FROM handshakes WHERE handshake_id = $1',
        [handshakeId]
      );
      return res.rows[0] || null;
    } finally {
      client.release();
    }
  }
}
