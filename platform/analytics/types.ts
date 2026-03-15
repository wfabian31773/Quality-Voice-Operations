import type { TenantId } from '../core/types';

export interface CallAnalyticsSummary {
  tenantId: TenantId;
  date: string;
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  avgDurationSeconds: number;
  humanTransferRate: number;
  ticketCreationRate: number;
  avgQualityScore?: number;
  totalCostCents: number;
}

export interface CostBreakdown {
  tenantId: TenantId;
  date: string;
  openaiCostCents: number;
  twilioCostCents: number;
  totalCostCents: number;
  callCount: number;
  costPerCallCents: number;
}
