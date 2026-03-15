import type { TenantId } from '../../core/types';

export type TenantPlan = 'trial' | 'starter' | 'growth' | 'enterprise';

export interface TenantConfig {
  tenantId: TenantId;
  name: string;
  plan: TenantPlan;
  active: boolean;
  settings: TenantSettings;
  integrations: TenantIntegrations;
  createdAt: Date;
}

export interface TenantSettings {
  dailyBudgetCents?: number;
  budgetWarningThreshold?: number;
  maxConcurrentCalls?: number;
  allowOutboundCalls: boolean;
  allowRecording: boolean;
  timezone?: string;
}

export interface TenantIntegrations {
  ticketing?: {
    provider: string;
    apiKey?: string;
    baseUrl?: string;
    config?: Record<string, unknown>;
  };
  crm?: {
    provider: string;
    apiKey?: string;
    config?: Record<string, unknown>;
  };
}
