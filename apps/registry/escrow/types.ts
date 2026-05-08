export interface LockFundsParams {
  tradeId: string;
  buyer: string;
  seller: string;
  amount: bigint;
  token: string; // 'native' | ERC-20 contract address | NEAR token
}

export interface LockFundsResult {
  txHash: string;
  escrowId: string;
}

export interface ReleaseFundsParams {
  escrowId: string;
  tradeId: string;
}

export interface RefundFundsParams {
  escrowId: string;
  tradeId: string;
}

export interface EscrowStatus {
  status: 'locked' | 'released' | 'refunded' | 'unknown';
  amount: bigint;
  token: string;
}

export interface EscrowAdapter {
  readonly chainId: string;
  readonly name: string;

  lockFunds(params: LockFundsParams): Promise<LockFundsResult>;
  releaseFunds(params: ReleaseFundsParams): Promise<{ txHash: string }>;
  refundFunds(params: RefundFundsParams): Promise<{ txHash: string }>;
  getEscrowStatus(escrowId: string): Promise<EscrowStatus>;
}
