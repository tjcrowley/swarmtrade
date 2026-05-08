import { EscrowAdapter } from './types';
import { ConfirmationEscrowAdapter } from './confirmation-escrow';

export { EscrowAdapter, EscrowStatus, LockFundsParams, LockFundsResult, ReleaseFundsParams, RefundFundsParams } from './types';
export { ConfirmationEscrowAdapter } from './confirmation-escrow';
export { EvmEscrowAdapter } from './evm-escrow';
export { NearEscrowAdapter } from './near-escrow';

export class EscrowRegistry {
  private adapters = new Map<string, EscrowAdapter>();
  private confirmation: ConfirmationEscrowAdapter;

  constructor(confirmationAdapter: ConfirmationEscrowAdapter) {
    this.confirmation = confirmationAdapter;
    this.register(confirmationAdapter);
  }

  register(adapter: EscrowAdapter): void {
    this.adapters.set(adapter.chainId, adapter);
  }

  get(chainId: string): EscrowAdapter | undefined {
    return this.adapters.get(chainId);
  }

  list(): { chainId: string; name: string }[] {
    return Array.from(this.adapters.values()).map((a) => ({
      chainId: a.chainId,
      name: a.name,
    }));
  }

  getConfirmation(): ConfirmationEscrowAdapter {
    return this.confirmation;
  }
}
