export interface BudgetStatus {
  tenantId: string;
  todaySpendCents: number;
  dailyBudgetCents: number;
  percentUsed: number;
  isOverBudget: boolean;
  isWarning: boolean;
  remainingCents: number;
}
