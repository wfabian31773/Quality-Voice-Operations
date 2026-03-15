import { BudgetGuardService } from './BudgetGuardService';
import type { BudgetSpendAdapter } from './BudgetGuardService';
import type { TenantId } from '../../core/types';

/**
 * Platform-level registry holding one BudgetGuardService per tenant.
 */
export class BudgetGuardRegistry {
  private guards = new Map<TenantId, BudgetGuardService>();

  constructor(private readonly spendAdapter: BudgetSpendAdapter) {}

  getOrCreate(
    tenantId: TenantId,
    options?: { dailyBudgetCents?: number; warningThreshold?: number },
  ): BudgetGuardService {
    if (!this.guards.has(tenantId)) {
      this.guards.set(
        tenantId,
        new BudgetGuardService(tenantId, this.spendAdapter, options),
      );
    }
    return this.guards.get(tenantId)!;
  }

  get(tenantId: TenantId): BudgetGuardService | undefined {
    return this.guards.get(tenantId);
  }

  teardown(tenantId: TenantId): void {
    this.guards.delete(tenantId);
  }
}
