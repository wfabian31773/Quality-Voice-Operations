import { createLogger } from '../../core/logger';
import { normalizePhone } from '../../core/types';
import type { TenantId } from '../../core/types';
import type { CallerMemory, CallerHistoryEntry } from './types';

const logger = createLogger('CALLER_MEMORY');

export interface CallHistoryRecord {
  createdAt: Date | string;
  callReason?: string | null;
  agentOutcome?: string | null;
  ticketNumber?: string | null;
  agentUsed?: string | null;
  durationSeconds?: number | null;
  preferredContactMethod?: string | null;
  patientName?: string | null;
  patientDob?: string | null;
  lastProviderSeen?: string | null;
  lastLocationSeen?: string | null;
  openTickets?: string[] | null;
}

export interface CallerMemoryStorage {
  getCallHistoryByPhone(
    tenantId: TenantId,
    phone: string,
    limit: number,
  ): Promise<CallHistoryRecord[]>;
}

/**
 * Reconstructs a caller's cross-session context from persisted call logs.
 *
 * Multi-tenant: all DB lookups are scoped by tenantId so a caller on one tenant
 * cannot see history from another tenant even if phone numbers match.
 *
 * Instantiate one instance per tenant (via CallerMemoryRegistry) or pass tenantId
 * per-call if using a shared instance.
 */
export class CallerMemoryService {
  constructor(private readonly storage: CallerMemoryStorage) {}

  async getCallerMemory(
    tenantId: TenantId,
    phoneNumber: string,
    maxCalls = 5,
  ): Promise<CallerMemory | null> {
    if (!phoneNumber) return null;

    const normalized = normalizePhone(phoneNumber);
    logger.debug(`Caller memory lookup`, { tenantId, phone: `***${normalized.slice(-4)}` });

    const history = await this.storage.getCallHistoryByPhone(tenantId, normalized, maxCalls);
    if (!history || history.length === 0) return null;

    return this.buildMemory(tenantId, normalized, history);
  }

  private buildMemory(
    tenantId: TenantId,
    phone: string,
    records: CallHistoryRecord[],
  ): CallerMemory {
    const recentCalls: CallerHistoryEntry[] = records.map((r) => ({
      date: new Date(r.createdAt).toISOString().split('T')[0],
      reason: r.callReason ?? 'Unknown',
      outcome: r.agentOutcome ?? 'Unknown',
      ticketNumber: r.ticketNumber ?? undefined,
      agentUsed: r.agentUsed ?? undefined,
      duration: r.durationSeconds ?? undefined,
      preferredContactMethod: r.preferredContactMethod ?? undefined,
    }));

    const latest = records[0];

    const allOpenTickets: string[] = [];
    for (const r of records) {
      if (r.openTickets) allOpenTickets.push(...r.openTickets);
    }

    return {
      tenantId,
      phoneNumber: phone,
      totalCalls: records.length,
      lastCallDate: recentCalls[0]?.date,
      patientName: latest.patientName ?? undefined,
      patientDob: latest.patientDob ?? undefined,
      lastProviderSeen: latest.lastProviderSeen ?? undefined,
      lastLocationSeen: latest.lastLocationSeen ?? undefined,
      preferredContactMethod: latest.preferredContactMethod ?? undefined,
      recentCalls,
      openTickets: [...new Set(allOpenTickets)],
      notes: '',
    };
  }
}
