import { Pool } from 'pg';
import * as nearAPI from 'near-api-js';
import {
  EscrowAdapter,
  LockFundsParams,
  LockFundsResult,
  ReleaseFundsParams,
  RefundFundsParams,
  EscrowStatus,
} from './types';

const { connect, keyStores, KeyPair } = nearAPI;

export class NearEscrowAdapter implements EscrowAdapter {
  readonly chainId: string;
  readonly name = 'NEAR';

  private readonly pool: Pool;
  readonly escrowAddress: string; // NEAR account ID
  private readonly privateKey: string;
  private readonly networkId: string;
  private readonly rpcUrl: string;

  private nearConnection: nearAPI.Near | null = null;

  constructor(pool: Pool) {
    const accountId = process.env.NEAR_ESCROW_ACCOUNT_ID;
    if (!accountId) {
      throw new Error(
        'NEAR_ESCROW_ACCOUNT_ID environment variable is required'
      );
    }
    const pk = process.env.NEAR_ESCROW_PRIVATE_KEY;
    if (!pk) {
      throw new Error(
        'NEAR_ESCROW_PRIVATE_KEY environment variable is required'
      );
    }

    this.pool = pool;
    this.escrowAddress = accountId;
    this.privateKey = pk;
    this.networkId = process.env.NEAR_NETWORK || 'mainnet';
    this.chainId = `near:${this.networkId}`;

    const defaultRpc =
      this.networkId === 'testnet'
        ? 'https://rpc.testnet.near.org'
        : 'https://rpc.mainnet.near.org';
    this.rpcUrl = process.env.NEAR_RPC_URL || defaultRpc;
  }

  private async getConnection(): Promise<nearAPI.Near> {
    if (this.nearConnection) return this.nearConnection;

    const keyStore = new keyStores.InMemoryKeyStore();
    const keyPair = KeyPair.fromString(this.privateKey as any);
    await keyStore.setKey(this.networkId, this.escrowAddress, keyPair);

    this.nearConnection = await connect({
      networkId: this.networkId,
      keyStore,
      nodeUrl: this.rpcUrl,
    });
    return this.nearConnection;
  }

  private async getAccount(): Promise<nearAPI.Account> {
    const near = await this.getConnection();
    return near.account(this.escrowAddress);
  }

  async lockFunds(params: LockFundsParams): Promise<LockFundsResult> {
    const depositTxHash = params.metadata?.deposit_tx_hash as
      | string
      | undefined;
    if (!depositTxHash) {
      throw new Error(
        'metadata.deposit_tx_hash is required for NEAR escrow lock'
      );
    }

    // Verify the deposit transaction on NEAR
    const near = await this.getConnection();
    const provider = near.connection.provider;

    // Query the transaction outcome — throws if tx doesn't exist
    const txResult = await provider.txStatus(depositTxHash, params.buyer, 'FINAL' as any);

    // Check for successful execution (no failure in status)
    const status = txResult.status as any;
    if (status.Failure) {
      throw new Error(
        `Deposit transaction ${depositTxHash} failed: ${JSON.stringify(status.Failure)}`
      );
    }

    // Verify the receiver is the escrow account
    const receiverId = txResult.transaction.receiver_id;
    if (params.token === 'native') {
      // For native NEAR transfers, receiver should be the escrow account
      if (receiverId !== this.escrowAddress) {
        throw new Error(
          `Deposit tx receiver (${receiverId}) does not match escrow account (${this.escrowAddress})`
        );
      }

      // Verify the transfer amount from the transaction actions
      const actions = txResult.transaction.actions as any[];
      const transferAction = actions.find(
        (a: any) => a.Transfer !== undefined
      );
      if (!transferAction) {
        throw new Error(
          'Deposit transaction does not contain a Transfer action'
        );
      }
      const depositAmount = BigInt(transferAction.Transfer.deposit);
      if (depositAmount < params.amount) {
        throw new Error(
          `Deposit amount (${depositAmount}) is less than required (${params.amount})`
        );
      }
    } else {
      // For fungible tokens, the receiver should be the token contract
      // and the method should be ft_transfer with receiver = escrow account
      if (receiverId !== params.token) {
        throw new Error(
          `FT deposit tx receiver (${receiverId}) does not match token contract (${params.token})`
        );
      }
      const actions = txResult.transaction.actions as any[];
      const funcCall = actions.find(
        (a: any) => a.FunctionCall !== undefined
      );
      if (
        !funcCall ||
        funcCall.FunctionCall.method_name !== 'ft_transfer'
      ) {
        throw new Error(
          'FT deposit transaction does not contain an ft_transfer call'
        );
      }
      const argsStr = Buffer.from(
        funcCall.FunctionCall.args,
        'base64'
      ).toString('utf8');
      const ftArgs = JSON.parse(argsStr);
      if (ftArgs.receiver_id !== this.escrowAddress) {
        throw new Error(
          `FT transfer receiver (${ftArgs.receiver_id}) does not match escrow account (${this.escrowAddress})`
        );
      }
      const ftAmount = BigInt(ftArgs.amount);
      if (ftAmount < params.amount) {
        throw new Error(
          `FT deposit amount (${ftAmount}) is less than required (${params.amount})`
        );
      }
    }

    // Record in database
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO escrow_records
           (trade_id, adapter, chain_id, buyer_address, seller_address, amount, token, status, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'locked', $8)
         RETURNING escrow_id`,
        [
          params.tradeId,
          'near',
          this.chainId,
          params.buyer,
          params.seller,
          params.amount.toString(),
          params.token,
          depositTxHash,
        ]
      );
      const escrowId: string = res.rows[0].escrow_id;
      return { txHash: depositTxHash, escrowId };
    } finally {
      client.release();
    }
  }

  async releaseFunds(
    params: ReleaseFundsParams
  ): Promise<{ txHash: string }> {
    const record = await this.getEscrowRecord(params.escrowId);
    if (record.status !== 'locked') {
      throw new Error(
        `Escrow ${params.escrowId} is not in locked state (current: ${record.status})`
      );
    }

    const account = await this.getAccount();
    const amount = BigInt(record.amount.split('.')[0]);
    let txHash: string;

    if (record.token === 'native') {
      const result = await account.sendMoney(
        record.seller_address,
        amount
      );
      txHash =
        result.transaction_outcome.id ||
        result.transaction.hash;
    } else {
      // FT transfer via token contract
      const result = await account.functionCall({
        contractId: record.token,
        methodName: 'ft_transfer',
        args: {
          receiver_id: record.seller_address,
          amount: amount.toString(),
        },
        attachedDeposit: BigInt(1), // 1 yoctoNEAR required for ft_transfer
      });
      txHash =
        result.transaction_outcome.id ||
        result.transaction.hash;
    }

    // Update DB
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `UPDATE escrow_records
         SET status = 'released', tx_hash = $1, updated_at = NOW()
         WHERE escrow_id = $2 AND status = 'locked'
         RETURNING escrow_id`,
        [txHash, params.escrowId]
      );
      if (res.rowCount === 0) {
        throw new Error(
          `Failed to update escrow ${params.escrowId} — concurrent modification?`
        );
      }
    } finally {
      client.release();
    }

    return { txHash };
  }

  async refundFunds(
    params: RefundFundsParams
  ): Promise<{ txHash: string }> {
    const record = await this.getEscrowRecord(params.escrowId);
    if (record.status !== 'locked') {
      throw new Error(
        `Escrow ${params.escrowId} is not in locked state (current: ${record.status})`
      );
    }

    const account = await this.getAccount();
    const amount = BigInt(record.amount.split('.')[0]);
    let txHash: string;

    if (record.token === 'native') {
      const result = await account.sendMoney(
        record.buyer_address,
        amount
      );
      txHash =
        result.transaction_outcome.id ||
        result.transaction.hash;
    } else {
      const result = await account.functionCall({
        contractId: record.token,
        methodName: 'ft_transfer',
        args: {
          receiver_id: record.buyer_address,
          amount: amount.toString(),
        },
        attachedDeposit: BigInt(1),
      });
      txHash =
        result.transaction_outcome.id ||
        result.transaction.hash;
    }

    // Update DB
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `UPDATE escrow_records
         SET status = 'refunded', tx_hash = $1, updated_at = NOW()
         WHERE escrow_id = $2 AND status = 'locked'
         RETURNING escrow_id`,
        [txHash, params.escrowId]
      );
      if (res.rowCount === 0) {
        throw new Error(
          `Failed to update escrow ${params.escrowId} — concurrent modification?`
        );
      }
    } finally {
      client.release();
    }

    return { txHash };
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
        amount: BigInt(row.amount.split('.')[0]),
        token: row.token,
      };
    } finally {
      client.release();
    }
  }

  private async getEscrowRecord(escrowId: string): Promise<{
    status: string;
    amount: string;
    token: string;
    buyer_address: string;
    seller_address: string;
  }> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT status, amount, token, buyer_address, seller_address
         FROM escrow_records WHERE escrow_id = $1`,
        [escrowId]
      );
      if (res.rowCount === 0) {
        throw new Error(`Escrow record ${escrowId} not found`);
      }
      return res.rows[0];
    } finally {
      client.release();
    }
  }
}
