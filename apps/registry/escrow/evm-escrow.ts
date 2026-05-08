import { EscrowAdapter, LockFundsParams, LockFundsResult, ReleaseFundsParams, RefundFundsParams, EscrowStatus } from './types';

interface EvmChainConfig {
  chainId: number;
  caip2: string;
  name: string;
  rpcUrl: string;
}

const SUPPORTED_CHAINS: Record<number, { caip2: string; name: string }> = {
  1:    { caip2: 'eip155:1',    name: 'Ethereum Mainnet' },
  8453: { caip2: 'eip155:8453', name: 'Base' },
  137:  { caip2: 'eip155:137',  name: 'Polygon' },
};

export class EvmEscrowAdapter implements EscrowAdapter {
  readonly chainId: string;
  readonly name: string;
  private readonly config: EvmChainConfig;

  constructor(numericChainId: number, rpcUrl: string) {
    const chain = SUPPORTED_CHAINS[numericChainId];
    if (!chain) {
      throw new Error(`Unsupported EVM chain ID: ${numericChainId}. Supported: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`);
    }
    this.config = { chainId: numericChainId, caip2: chain.caip2, name: chain.name, rpcUrl };
    this.chainId = chain.caip2;
    this.name = chain.name;
  }

  async lockFunds(_params: LockFundsParams): Promise<LockFundsResult> {
    throw new Error('EVM escrow not yet implemented — requires deployed smart contract');
  }

  async releaseFunds(_params: ReleaseFundsParams): Promise<{ txHash: string }> {
    throw new Error('EVM escrow not yet implemented — requires deployed smart contract');
  }

  async refundFunds(_params: RefundFundsParams): Promise<{ txHash: string }> {
    throw new Error('EVM escrow not yet implemented — requires deployed smart contract');
  }

  async getEscrowStatus(_escrowId: string): Promise<EscrowStatus> {
    throw new Error('EVM escrow not yet implemented — requires deployed smart contract');
  }

  getChainConfig(): EvmChainConfig {
    return { ...this.config };
  }
}
