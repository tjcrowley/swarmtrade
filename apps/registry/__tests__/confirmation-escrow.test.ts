import { describe, it, expect, beforeEach } from 'vitest';
import { ConfirmationEscrowAdapter } from '../escrow/confirmation-escrow';
import { createInMemoryPool } from './mock-pool';

describe('ConfirmationEscrowAdapter', () => {
  let adapter: ConfirmationEscrowAdapter;
  let pool: ReturnType<typeof createInMemoryPool>;

  beforeEach(() => {
    pool = createInMemoryPool();
    adapter = new ConfirmationEscrowAdapter(pool as any);
  });

  it('has correct chainId and name', () => {
    expect(adapter.chainId).toBe('off-chain');
    expect(adapter.name).toBe('Confirmation (Off-Chain)');
  });

  describe('lockFunds', () => {
    it('creates an escrow record and returns id + txHash', async () => {
      const result = await adapter.lockFunds({
        tradeId: 'trade-1',
        buyer: '0xBuyer',
        seller: '0xSeller',
        amount: BigInt('1000000'),
        token: 'native',
      });

      expect(result.escrowId).toBeTruthy();
      expect(result.txHash).toContain('confirmation:');
      expect(result.txHash).toContain(result.escrowId);
    });

    it('stores the escrow in the pool', async () => {
      const result = await adapter.lockFunds({
        tradeId: 'trade-2',
        buyer: '0xAlice',
        seller: '0xBob',
        amount: BigInt('500'),
        token: 'USDC',
      });

      const escrow = pool._escrows.get(result.escrowId);
      expect(escrow).toBeTruthy();
      expect(escrow.buyer_address).toBe('0xAlice');
      expect(escrow.seller_address).toBe('0xBob');
      expect(escrow.token).toBe('USDC');
      expect(escrow.status).toBe('locked');
    });
  });

  describe('releaseFunds', () => {
    it('releases a locked escrow', async () => {
      const lock = await adapter.lockFunds({
        tradeId: 'trade-3',
        buyer: '0xB',
        seller: '0xS',
        amount: BigInt('100'),
        token: 'native',
      });

      const result = await adapter.releaseFunds({ escrowId: lock.escrowId, tradeId: 'trade-3' });
      expect(result.txHash).toContain('release');
      expect(result.txHash).toContain(lock.escrowId);

      const escrow = pool._escrows.get(lock.escrowId);
      expect(escrow.status).toBe('released');
    });

    it('throws on non-locked escrow', async () => {
      const lock = await adapter.lockFunds({
        tradeId: 'trade-4',
        buyer: '0xB',
        seller: '0xS',
        amount: BigInt('100'),
        token: 'native',
      });

      // Release once
      await adapter.releaseFunds({ escrowId: lock.escrowId, tradeId: 'trade-4' });

      // Release again should throw
      await expect(adapter.releaseFunds({ escrowId: lock.escrowId, tradeId: 'trade-4' }))
        .rejects.toThrow('not found or not in locked state');
    });

    it('throws on nonexistent escrow', async () => {
      await expect(adapter.releaseFunds({ escrowId: 'fake-id', tradeId: 'trade-x' }))
        .rejects.toThrow('not found or not in locked state');
    });
  });

  describe('refundFunds', () => {
    it('refunds a locked escrow', async () => {
      const lock = await adapter.lockFunds({
        tradeId: 'trade-5',
        buyer: '0xB',
        seller: '0xS',
        amount: BigInt('200'),
        token: 'native',
      });

      const result = await adapter.refundFunds({ escrowId: lock.escrowId, tradeId: 'trade-5' });
      expect(result.txHash).toContain('refund');

      const escrow = pool._escrows.get(lock.escrowId);
      expect(escrow.status).toBe('refunded');
    });

    it('throws on already released escrow', async () => {
      const lock = await adapter.lockFunds({
        tradeId: 'trade-6',
        buyer: '0xB',
        seller: '0xS',
        amount: BigInt('300'),
        token: 'native',
      });

      await adapter.releaseFunds({ escrowId: lock.escrowId, tradeId: 'trade-6' });

      await expect(adapter.refundFunds({ escrowId: lock.escrowId, tradeId: 'trade-6' }))
        .rejects.toThrow('not found or not in locked state');
    });
  });

  describe('getEscrowStatus', () => {
    it('returns status for existing escrow', async () => {
      const lock = await adapter.lockFunds({
        tradeId: 'trade-7',
        buyer: '0xB',
        seller: '0xS',
        amount: BigInt('999'),
        token: 'ETH',
      });

      const status = await adapter.getEscrowStatus(lock.escrowId);
      expect(status.status).toBe('locked');
      expect(status.token).toBe('ETH');
    });

    it('returns unknown for nonexistent escrow', async () => {
      const status = await adapter.getEscrowStatus('does-not-exist');
      expect(status.status).toBe('unknown');
      expect(status.amount).toBe(BigInt(0));
      expect(status.token).toBe('');
    });

    it('reflects status after release', async () => {
      const lock = await adapter.lockFunds({
        tradeId: 'trade-8',
        buyer: '0xB',
        seller: '0xS',
        amount: BigInt('100'),
        token: 'native',
      });

      await adapter.releaseFunds({ escrowId: lock.escrowId, tradeId: 'trade-8' });
      const status = await adapter.getEscrowStatus(lock.escrowId);
      expect(status.status).toBe('released');
    });
  });
});
