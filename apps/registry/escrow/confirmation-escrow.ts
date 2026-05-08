import { Pool } from 'pg';
import { EscrowAdapter, LockFundsParams, LockFundsResult, ReleaseFundsParams, RefundFundsParams, EscrowStatus } from './types';

export class ConfirmationEscrowAdapter implements EscrowAdapter {
  readonly chainId = 'off-chain';
  readonly name = 'Confirmation (Off-Chain)';

  constructor(private readonly pool: Pool) {}

  async lockFunds(params: LockFundsParams): Promise<LockFundsResult> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO escrow_records (trade_id, adapter, chain_id, buyer_address, seller_address, amount, token, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'locked')
         RETURNING escrow_id`,
        [params.tradeId, 'confirmation', this.chainId, params.buyer, params.seller, params.amount.toString(), params.token]
      );
      const escrowId: string = res.rows[0].escrow_id;
      return { txHash: `confirmation:${escrowId}`, escrowId };
    } finally {
      client.release();
    }
  }

  async releaseFunds(params: ReleaseFundsParams): Promise<{ txHash: string }> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `UPDATE escrow_records SET status = 'released', updated_at = NOW()
         WHERE escrow_id = $1 AND status = 'locked'
         RETURNING escrow_id`,
        [params.escrowId]
      );
      if (res.rowCount === 0) {
        throw new Error(`Escrow ${params.escrowId} not found or not in locked state`);
      }
      return { txHash: `confirmation:release:${params.escrowId}` };
    } finally {
      client.release();
    }
  }

  async refundFunds(params: RefundFundsParams): Promise<{ txHash: string }> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `UPDATE escrow_records SET status = 'refunded', updated_at = NOW()
         WHERE escrow_id = $1 AND status = 'locked'
         RETURNING escrow_id`,
        [params.escrowId]
      );
      if (res.rowCount === 0) {
        throw new Error(`Escrow ${params.escrowId} not found or not in locked state`);
      }
      return { txHash: `confirmation:refund:${params.escrowId}` };
    } finally {
      client.release();
    }
  }

  async getEscrowStatus(escrowId: string): Promise<EscrowStatus> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT status, amount, token FROM escrow_records WHERE escrow_id = $1`,
        [escrowId]
      );
      if (res.rowCount === 0) {
        return { status: 'unknown', amount: BigInt(0), token: '' };
      }
      const row = res.rows[0];
      return {
        status: row.status as EscrowStatus['status'],
        amount: BigInt(row.amount),
        token: row.token,
      };
    } finally {
      client.release();
    }
  }
}
