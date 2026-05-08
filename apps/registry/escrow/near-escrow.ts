import { EscrowAdapter, LockFundsParams, LockFundsResult, ReleaseFundsParams, RefundFundsParams, EscrowStatus } from './types';

export class NearEscrowAdapter implements EscrowAdapter {
  readonly chainId = 'near:mainnet';
  readonly name = 'NEAR';

  async lockFunds(_params: LockFundsParams): Promise<LockFundsResult> {
    throw new Error('NEAR escrow not yet implemented — requires deployed smart contract');
  }

  async releaseFunds(_params: ReleaseFundsParams): Promise<{ txHash: string }> {
    throw new Error('NEAR escrow not yet implemented — requires deployed smart contract');
  }

  async refundFunds(_params: RefundFundsParams): Promise<{ txHash: string }> {
    throw new Error('NEAR escrow not yet implemented — requires deployed smart contract');
  }

  async getEscrowStatus(_escrowId: string): Promise<EscrowStatus> {
    throw new Error('NEAR escrow not yet implemented — requires deployed smart contract');
  }
}
