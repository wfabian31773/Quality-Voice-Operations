// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BudgetGuardService, type BudgetSpendAdapter } from '../../platform/billing/budget/BudgetGuardService';
import * as checkBudgetModule from '../../platform/billing/budget/checkBudget';

const NBSP = '\u00a0';

function normalize(s: string): string {
  return s.replace(/\u00a0/g, ' ');
}

class StubSpend implements BudgetSpendAdapter {
  constructor(private cents: number) {}
  async getDailySpendCents(): Promise<number> {
    return this.cents;
  }
}

beforeEach(() => {
  vi.spyOn(checkBudgetModule, 'checkBudget').mockResolvedValue({ allowed: true });
});

describe('BudgetGuardService — canonical currency formatting (BL-023 regression)', () => {
  it('renders the over-budget reason via formatCurrency (no raw cents/100)', async () => {
    const service = new BudgetGuardService(
      'tenant-x',
      new StubSpend(7_500),
      { dailyBudgetCents: 5_000 },
    );

    const result = await service.canMakeOutboundCall();

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
    const reason = normalize(result.reason as string);

    expect(reason).toContain('$75.00');
    expect(reason).toContain('$50.00');

    expect(reason).not.toContain('7500');
    expect(reason).not.toContain('$7500');
    expect(reason).not.toMatch(/\$5000(?!\.)/);
  });

  it('preserves NBSP-separated currency strings (Intl-formatted)', async () => {
    const service = new BudgetGuardService(
      'tenant-x',
      new StubSpend(12_345),
      { dailyBudgetCents: 5_000 },
    );

    const result = await service.canMakeOutboundCall();

    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('$123.45');
    expect(result.reason).toContain('$50.00');
    expect(result.reason?.includes(NBSP) || result.reason?.includes(' ')).toBe(true);
  });
});
