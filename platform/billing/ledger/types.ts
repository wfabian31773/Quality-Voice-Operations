import type { TenantId } from '../../core/types';

export type LedgerEntryType = 'openai_usage' | 'twilio_usage' | 'platform_fee' | 'credit';

export interface LedgerEntry {
  id: string;
  tenantId: TenantId;
  type: LedgerEntryType;
  amountCents: number;
  description: string;
  callLogId?: string;
  date: string;
  createdAt: Date;
}
