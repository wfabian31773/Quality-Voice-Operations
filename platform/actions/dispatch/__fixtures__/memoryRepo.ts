import { randomUUID } from 'node:crypto';
import { formattedAndNormalized, type DispatchJobRecord, type DispatchRepoFactory } from '../repo';
import { isOpenJobStatus, type DispatchJobStatus } from '../transitions';

export interface MemoryDispatchJob extends DispatchJobRecord {
  tenantId: string;
  normalizedAddress: string;
}

export interface MemoryDispatchEvent {
  tenantId: string;
  jobId: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string;
  performedBy: string | null;
  notes: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface MemoryDispatchState {
  jobs: MemoryDispatchJob[];
  events: MemoryDispatchEvent[];
  locks: string[];
}

function digitsOf(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export function createMemoryDispatchRepo(): { state: MemoryDispatchState; repo: DispatchRepoFactory } {
  const state: MemoryDispatchState = { jobs: [], events: [], locks: [] };

  const repo: DispatchRepoFactory = (_tx, tenantId) => {
    const own = () => state.jobs.filter((job) => job.tenantId === tenantId);
    return {
      async lockAddress(normalizedAddress) {
        state.locks.push(`${tenantId}\0${normalizedAddress}`);
      },
      async findDuplicate(normalizedAddress, windowStart, windowEnd) {
        return (
          own().find(
            (job) =>
              isOpenJobStatus(job.status)
              && job.normalizedAddress === normalizedAddress
              && job.etaStart != null
              && job.etaEnd != null
              && job.etaStart < windowEnd
              && job.etaEnd > windowStart,
          ) ?? null
        );
      },
      async insertJob(job) {
        const { formattedAddress, normalizedAddress } = formattedAndNormalized(job.input);
        const record: MemoryDispatchJob = {
          id: randomUUID(),
          tenantId,
          status: 'pending',
          etaStart: new Date(job.input.window.start),
          etaEnd: new Date(job.input.window.end),
          scheduledAt: new Date(job.input.window.start),
          createdAt: job.now,
          contactName: job.input.contact.name,
          contactPhone: job.input.contact.phone,
          address: formattedAddress,
          normalizedAddress,
        };
        state.jobs.push(record);
        const { tenantId: _t, normalizedAddress: _n, ...publicJob } = record;
        return publicJob;
      },
      async insertEvent(event) {
        state.events.push({
          tenantId,
          jobId: event.jobId,
          eventType: event.eventType,
          fromStatus: event.fromStatus ?? null,
          toStatus: event.toStatus,
          performedBy: event.performedBy,
          notes: event.notes,
          metadata: event.metadata ?? {},
          createdAt: event.now,
        });
      },
      async getForUpdate(jobId) {
        const job = own().find((row) => row.id === jobId);
        if (!job) return null;
        const { tenantId: _t, normalizedAddress: _n, ...publicJob } = job;
        return publicJob;
      },
      async updateStatus({ jobId, fromStatus, toStatus, etaEnd, now }) {
        const job = state.jobs.find((row) => row.tenantId === tenantId && row.id === jobId);
        if (!job || job.status !== fromStatus) return null;
        job.status = toStatus as DispatchJobStatus;
        if (etaEnd) job.etaEnd = etaEnd;
        void now;
        const { tenantId: _t, normalizedAddress: _n, ...publicJob } = job;
        return publicJob;
      },
      async findByPhone(phone) {
        const want = digitsOf(phone);
        return own()
          .filter((job) => digitsOf(job.contactPhone) === want)
          .sort((a, b) => {
            const openA = isOpenJobStatus(a.status) ? 0 : 1;
            const openB = isOpenJobStatus(b.status) ? 0 : 1;
            if (openA !== openB) return openA - openB;
            const startA = (a.etaStart ?? a.scheduledAt ?? a.createdAt).getTime();
            const startB = (b.etaStart ?? b.scheduledAt ?? b.createdAt).getTime();
            return startA - startB;
          })
          .map(({ tenantId: _t, normalizedAddress: _n, ...job }) => job);
      },
    };
  };

  return { state, repo };
}
