import type { TenantId } from '../../core/types';

export interface CallerHistoryEntry {
  date: string;
  reason: string;
  outcome: string;
  ticketNumber?: string;
  agentUsed?: string;
  duration?: number;
  preferredContactMethod?: string;
}

export interface CallerMemory {
  tenantId: TenantId;
  phoneNumber: string;
  totalCalls: number;
  lastCallDate?: string;
  patientName?: string;
  patientDob?: string;
  lastProviderSeen?: string;
  lastLocationSeen?: string;
  preferredContactMethod?: string;
  recentCalls: CallerHistoryEntry[];
  openTickets: string[];
  notes: string;
}
