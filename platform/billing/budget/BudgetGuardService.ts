import { createLogger } from '../../core/logger';
import type { BudgetStatus } from './types';
import type { TenantId } from '../../core/types';
import { checkBudget, type BudgetCheckResult } from './checkBudget';

const logger = createLogger('BUDGET_GUARD');

const DEFAULT_DAILY_BUDGET_CENTS = 5_000; // $50
const DEFAULT_WARNING_THRESHOLD = 0.8; // 80%

export interface BudgetSpendAdapter {
  getDailySpendCents(tenantId: TenantId, date: string): Promise<number>;
}

export class BudgetGuardService {
  private dailyBudgetCents: number;
  private warningThreshold: number;
  private lastWarningDate: string | null = null;

  constructor(
    private readonly tenantId: TenantId,
    private readonly spendAdapter: BudgetSpendAdapter,
    options?: { dailyBudgetCents?: number; warningThreshold?: number },
  ) {
    this.dailyBudgetCents = options?.dailyBudgetCents ?? DEFAULT_DAILY_BUDGET_CENTS;
    this.warningThreshold = options?.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
    logger.info(`Budget initialized`, {
      tenantId,
      budget: `$${(this.dailyBudgetCents / 100).toFixed(2)}`,
      warningAt: `${(this.warningThreshold * 100).toFixed(0)}%`,
    });
  }

  private getTodayDate(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  }

  async checkSubscriptionBudget(): Promise<BudgetCheckResult> {
    return checkBudget(this.tenantId);
  }

  async getStatus(): Promise<BudgetStatus> {
    const today = this.getTodayDate();
    const todaySpendCents = await this.spendAdapter.getDailySpendCents(this.tenantId, today);
    const percentUsed = this.dailyBudgetCents > 0 ? todaySpendCents / this.dailyBudgetCents : 0;
    const isOverBudget = todaySpendCents >= this.dailyBudgetCents;
    const isWarning = percentUsed >= this.warningThreshold && !isOverBudget;
    const remainingCents = Math.max(0, this.dailyBudgetCents - todaySpendCents);

    if (isWarning && this.lastWarningDate !== today) {
      this.lastWarningDate = today;
      logger.warn(`Daily spend warning`, {
        tenantId: this.tenantId,
        percentUsed: `${(percentUsed * 100).toFixed(1)}%`,
        spend: `$${(todaySpendCents / 100).toFixed(2)}`,
        budget: `$${(this.dailyBudgetCents / 100).toFixed(2)}`,
      });
    }

    if (isOverBudget) {
      logger.warn(`Daily budget exceeded`, {
        tenantId: this.tenantId,
        spend: `$${(todaySpendCents / 100).toFixed(2)}`,
        budget: `$${(this.dailyBudgetCents / 100).toFixed(2)}`,
      });
    }

    return {
      tenantId: this.tenantId,
      todaySpendCents,
      dailyBudgetCents: this.dailyBudgetCents,
      percentUsed,
      isOverBudget,
      isWarning,
      remainingCents,
    };
  }

  async canMakeOutboundCall(): Promise<{ allowed: boolean; reason?: string }> {
    const subBudget = await this.checkSubscriptionBudget();
    if (!subBudget.allowed) {
      return { allowed: false, reason: subBudget.reason };
    }

    const status = await this.getStatus();
    if (status.isOverBudget) {
      return {
        allowed: false,
        reason: `Daily budget exceeded ($${(status.todaySpendCents / 100).toFixed(2)} / $${(status.dailyBudgetCents / 100).toFixed(2)}). Outbound paused until tomorrow.`,
      };
    }
    return { allowed: true };
  }

  setDailyBudget(cents: number): void {
    this.dailyBudgetCents = cents;
    logger.info(`Budget updated`, { tenantId: this.tenantId, budget: `$${(cents / 100).toFixed(2)}` });
  }

  getDailyBudgetCents(): number {
    return this.dailyBudgetCents;
  }
}
