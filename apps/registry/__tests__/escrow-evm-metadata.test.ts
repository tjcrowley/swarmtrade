import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../build-app';
import { createInMemoryPool } from './mock-pool';
import {
  EscrowAdapter,
  LockFundsParams,
  LockFundsResult,
  ReleaseFundsParams,
  RefundFundsParams,
  EscrowStatus,
} from '../escrow/types';

const AGENT = { 'x-agent-id': 'metadata-test' };

/**
 * Spy adapter that captures the LockFundsParams it receives.
 * Used to prove that the HTTP route passes `metadata` through to the adapter.
 */
class SpyEvmAdapter implements EscrowAdapter {
  readonly chainId = 'eip155:84532'; // Base Sepolia
  readonly name = 'Spy EVM';
  lastParams: LockFundsParams | undefined;

  async lockFunds(params: LockFundsParams): Promise<LockFundsResult> {
    this.lastParams = params;
    if (!params.metadata?.deposit_tx_hash) {
      throw new Error('metadata.deposit_tx_hash is required for EVM escrow lock');
    }
    return { txHash: String(params.metadata.deposit_tx_hash), escrowId: 'spy-escrow-1' };
  }
  async releaseFunds(_: ReleaseFundsParams) { return { txHash: '0xrelease' }; }
  async refundFunds(_: RefundFundsParams) { return { txHash: '0xrefund' }; }
  async getEscrowStatus(_: string): Promise<EscrowStatus> {
    return { status: 'locked', amount: 0n, token: 'native' };
  }
}

async function createAccepted(app: FastifyInstance): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/registry/handshake',
    headers: AGENT,
    payload: { buyer_id: 'b', seller_id: 's', asset_id: 'a' },
  });
  const tradeId = created.json().id;
  await app.inject({
    method: 'POST',
    url: `/registry/negotiation/${tradeId}/transition`,
    headers: AGENT,
    payload: { fromVersion: 1, nextState: 'accepted', quote: { trade_value: 50, currency: 'USD' } },
  });
  return tradeId;
}

describe('Escrow lock metadata wiring (EVM)', () => {
  let app: FastifyInstance;
  let spy: SpyEvmAdapter;

  beforeEach(async () => {
    const pool = createInMemoryPool();
    const result = await buildApp({ pool, adminKey: 'test-admin', logger: false, skipStatic: true });
    app = result.server;
    spy = new SpyEvmAdapter();
    result.escrowRegistry.register(spy);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('forwards metadata.deposit_tx_hash to the EVM adapter', async () => {
    const tradeId = await createAccepted(app);
    const txHash = '0x' + 'a'.repeat(64);

    const res = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        chain_id: 'eip155:84532',
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '1000',
        token: 'native',
        metadata: { deposit_tx_hash: txHash },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(spy.lastParams?.metadata).toEqual({ deposit_tx_hash: txHash });
    expect(res.json().txHash).toBe(txHash);
  });

  it('returns 400 (not 500) when EVM adapter rejects missing deposit_tx_hash', async () => {
    const tradeId = await createAccepted(app);
    const res = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        chain_id: 'eip155:84532',
        buyer_address: '0xBuyer',
        seller_address: '0xSeller',
        amount: '1000',
        token: 'native',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/deposit_tx_hash/);
  });

  it('off-chain adapter still works when no metadata supplied', async () => {
    const tradeId = await createAccepted(app);
    const res = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        buyer_address: '0xB',
        seller_address: '0xS',
        amount: '1000',
        token: 'native',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('escrowed');
  });

  it('rejects oversized metadata (>1KB)', async () => {
    const tradeId = await createAccepted(app);
    const bigBlob = 'x'.repeat(2000);
    const res = await app.inject({
      method: 'POST',
      url: '/registry/escrow/lock',
      headers: AGENT,
      payload: {
        handshake_id: tradeId,
        chain_id: 'eip155:84532',
        buyer_address: '0xB',
        seller_address: '0xS',
        amount: '1000',
        token: 'native',
        metadata: { deposit_tx_hash: '0x' + 'a'.repeat(64), blob: bigBlob },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/1KB|exceeds/i);
  });
});
