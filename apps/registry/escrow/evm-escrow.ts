import { Pool } from 'pg';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  decodeEventLog,
  type Chain,
  type PublicClient,
  type WalletClient,
  type TransactionReceipt,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, base, polygon, baseSepolia, sepolia } from 'viem/chains';
import {
  EscrowAdapter,
  LockFundsParams,
  LockFundsResult,
  ReleaseFundsParams,
  RefundFundsParams,
  EscrowStatus,
} from './types';

const ERC20_TRANSFER_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const ERC20_TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  137: polygon,
  11155111: sepolia,
  84532: baseSepolia,
};

export class EvmEscrowAdapter implements EscrowAdapter {
  readonly chainId: string;
  readonly name: string;

  private readonly pool: Pool;
  private readonly numericChainId: number;
  readonly escrowAddress: Address;
  private readonly privateKey: Hex;
  private readonly rpcUrl: string | undefined;

  constructor(pool: Pool, numericChainId: number) {
    const chain = CHAIN_MAP[numericChainId];
    if (!chain) {
      throw new Error(
        `Unsupported EVM chain ID: ${numericChainId}. Supported: ${Object.keys(CHAIN_MAP).join(', ')}`
      );
    }

    const pk = process.env.ESCROW_WALLET_PRIVATE_KEY;
    if (!pk) {
      throw new Error(
        'ESCROW_WALLET_PRIVATE_KEY environment variable is required'
      );
    }

    this.pool = pool;
    this.numericChainId = numericChainId;
    this.privateKey = pk as Hex;
    this.rpcUrl = process.env[`EVM_RPC_URL_${numericChainId}`];
    this.chainId = `eip155:${numericChainId}`;
    this.name = chain.name;

    if (!this.rpcUrl) {
      console.warn(
        `[evm-escrow] WARNING: EVM_RPC_URL_${numericChainId} is not set for ${chain.name}. ` +
        `Viem will fall back to a public RPC which is rate-limited and unreliable. ` +
        `Set EVM_RPC_URL_${numericChainId} to an Alchemy/Infura/QuickNode endpoint.`
      );
    }

    // Derive escrow (platform) wallet address from private key
    const account = privateKeyToAccount(this.privateKey);
    this.escrowAddress = account.address;
  }

  private getChain(): Chain {
    return CHAIN_MAP[this.numericChainId];
  }

  private getPublicClient(): PublicClient {
    const chain = this.getChain();
    return createPublicClient({
      chain,
      transport: http(this.rpcUrl),
    });
  }

  private getAccount() {
    return privateKeyToAccount(this.privateKey);
  }

  private getWalletClient() {
    const chain = this.getChain();
    const account = this.getAccount();
    return createWalletClient({
      account,
      chain,
      transport: http(this.rpcUrl),
    });
  }

  async lockFunds(params: LockFundsParams): Promise<LockFundsResult> {
    // Custodial model: buyer has already sent funds to the platform wallet.
    // We verify the deposit tx on-chain, then record the escrow.
    const depositTxHash = params.metadata?.deposit_tx_hash as string | undefined;
    if (!depositTxHash) {
      throw new Error(
        'metadata.deposit_tx_hash is required for EVM escrow lock'
      );
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(depositTxHash)) {
      throw new Error(
        `Invalid deposit_tx_hash format: must be 0x-prefixed 64-char hex (got ${depositTxHash.slice(0, 10)}...)`
      );
    }

    const publicClient = this.getPublicClient();

    // Verify the transaction exists and is confirmed
    let receipt: TransactionReceipt;
    try {
      receipt = await publicClient.getTransactionReceipt({
        hash: depositTxHash as Hex,
      });
    } catch {
      throw new Error('Deposit transaction not found on chain');
    }

    if (receipt.status !== 'success') {
      throw new Error(`Deposit transaction ${depositTxHash} failed on-chain`);
    }

    // Verify the transaction details
    let tx;
    try {
      tx = await publicClient.getTransaction({
        hash: depositTxHash as Hex,
      });
    } catch {
      throw new Error('Failed to fetch deposit transaction details from chain');
    }

    // Verify deposit based on token type
    if (params.token === 'native') {
      // Native ETH transfer: tx.to must be escrow, tx.value must cover amount
      if (tx.to?.toLowerCase() !== this.escrowAddress.toLowerCase()) {
        throw new Error(
          `Deposit tx recipient (${tx.to}) does not match escrow address (${this.escrowAddress})`
        );
      }
      if (tx.value < params.amount) {
        throw new Error(
          `Deposit amount (${tx.value}) is less than required (${params.amount})`
        );
      }
    } else {
      // ERC-20 transfer: tx.to is the token contract, we decode Transfer event logs
      const tokenAddress = params.token.toLowerCase() as Address;

      // tx.to should be the token contract
      if (tx.to?.toLowerCase() !== tokenAddress) {
        throw new Error(
          `Deposit tx target (${tx.to}) does not match token contract (${params.token})`
        );
      }

      // Decode Transfer events from receipt logs to verify funds reached escrow
      const transferToEscrow = this.findErc20Transfer(
        receipt.logs,
        tokenAddress,
        this.escrowAddress
      );

      if (!transferToEscrow) {
        throw new Error(
          `No ERC-20 Transfer event found sending to escrow address (${this.escrowAddress}) in tx ${depositTxHash}`
        );
      }

      if (transferToEscrow.value < params.amount) {
        throw new Error(
          `ERC-20 transfer amount (${transferToEscrow.value}) is less than required (${params.amount})`
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
          'evm',
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
    // Look up escrow record
    const record = await this.getEscrowRecord(params.escrowId);
    if (record.status !== 'locked') {
      throw new Error(
        `Escrow ${params.escrowId} is not in locked state (current: ${record.status})`
      );
    }

    const walletClient = this.getWalletClient();
    const account = this.getAccount();
    const chain = this.getChain();
    const sellerAddress = record.seller_address as Address;
    const amount = BigInt(record.amount.split('.')[0]);
    let txHash: string;

    try {
      if (record.token === 'native') {
        txHash = await walletClient.sendTransaction({
          account,
          chain,
          to: sellerAddress,
          value: amount,
        });
      } else {
        txHash = await walletClient.writeContract({
          account,
          chain,
          address: record.token as Address,
          abi: ERC20_TRANSFER_ABI,
          functionName: 'transfer',
          args: [sellerAddress, amount],
        });
      }
    } catch (err) {
      console.error('[evm-escrow] Release transaction failed:', err);
      throw new Error('On-chain release transaction failed');
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

    const walletClient = this.getWalletClient();
    const account = this.getAccount();
    const chain = this.getChain();
    const buyerAddress = record.buyer_address as Address;
    const amount = BigInt(record.amount.split('.')[0]);
    let txHash: string;

    try {
      if (record.token === 'native') {
        txHash = await walletClient.sendTransaction({
          account,
          chain,
          to: buyerAddress,
          value: amount,
        });
      } else {
        txHash = await walletClient.writeContract({
          account,
          chain,
          address: record.token as Address,
          abi: ERC20_TRANSFER_ABI,
          functionName: 'transfer',
          args: [buyerAddress, amount],
        });
      }
    } catch (err) {
      console.error('[evm-escrow] Refund transaction failed:', err);
      throw new Error('On-chain refund transaction failed');
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

  /**
   * Decode ERC-20 Transfer events from tx receipt logs.
   * Returns the first Transfer where `to` matches the target address
   * and the emitting contract matches the expected token.
   */
  private findErc20Transfer(
    logs: TransactionReceipt['logs'],
    tokenAddress: string,
    toAddress: Address
  ): { from: Address; to: Address; value: bigint } | null {
    const normalizedToken = tokenAddress.toLowerCase();
    const normalizedTo = toAddress.toLowerCase();

    for (const log of logs) {
      // Only consider logs emitted by the expected token contract
      if (log.address.toLowerCase() !== normalizedToken) continue;
      // Receipt logs always have topics
      if (!('topics' in log) || !(log as any).topics?.length) continue;

      try {
        const decoded = decodeEventLog({
          abi: [ERC20_TRANSFER_EVENT],
          data: log.data,
          topics: (log as any).topics,
        });

        if (decoded.eventName !== 'Transfer') continue;
        const args = decoded.args as unknown as { from: Address; to: Address; value: bigint };

        if (args.to.toLowerCase() === normalizedTo) {
          return args;
        }
      } catch {
        // Not a Transfer event or decode failed — skip
        continue;
      }
    }

    return null;
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
