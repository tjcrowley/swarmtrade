import { describe, it, expect } from 'vitest';
import { FeeConfigRepository } from '../fee-config';

describe('FeeConfigRepository.calculate', () => {
  // No pool needed — calculate is pure math
  const repo = new FeeConfigRepository(null as any);

  it('calculates 1.5% fee (150 bps)', () => {
    expect(repo.calculate(1000, { fee_bps: 150, min_fee: null, max_fee: null })).toBe(15);
  });

  it('applies min fee floor', () => {
    // 1.5% of 10 = 0.15, but min is 1
    expect(repo.calculate(10, { fee_bps: 150, min_fee: 1, max_fee: null })).toBe(1);
  });

  it('applies max fee cap', () => {
    // 1.5% of 100000 = 1500, but max is 100
    expect(repo.calculate(100000, { fee_bps: 150, min_fee: null, max_fee: 100 })).toBe(100);
  });

  it('rounds to 2 decimal places', () => {
    // 1.5% of 33.33 = 0.49995 → 0.50
    expect(repo.calculate(33.33, { fee_bps: 150, min_fee: null, max_fee: null })).toBe(0.50);
  });

  it('returns 0 for 0 bps', () => {
    expect(repo.calculate(1000, { fee_bps: 0, min_fee: null, max_fee: null })).toBe(0);
  });
});
