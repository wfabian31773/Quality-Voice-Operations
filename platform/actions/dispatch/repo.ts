import { createHash } from 'node:crypto';
import type { TenantTx } from '../core';
import { formatAddress, normalizeAddress } from './address';
import type { CreateJobPrepareInput, DispatchAddress } from './schemas';
import type { DispatchJobStatus } from './transitions';

export interface DispatchJobRecord {
  id: string;
  status: DispatchJobStatus;
  etaStart: Date | null;
  etaEnd: Date | null;
  scheduledAt: Date | null;
  createdAt: Date;
  contactName: string;
  contactPhone: string;
  address: string;
}

export interface NewDispatchJob {
  input: CreateJobPrepareInput;
  formattedAddress: string;
  normalizedAddress: string;
  callId: string | null;
  now: Date;
}

export interface NewDispatchEvent {
  jobId: string;
  eventType: string;
  fromStatus?: string | null;
  toStatus: string;
  performedBy: string | null;
  notes: string;
  metadata?: Record<string, unknown>;
  now: Date;
}

export interface DispatchRepo {
  lockAddress(normalizedAddress: string): Promise<void>;
  findDuplicate(normalizedAddress: string, windowStart: Date, windowEnd: Date): Promise<DispatchJobRecord | null>;
  insertJob(job: NewDispatchJob): Promise<DispatchJobRecord>;
  insertEvent(event: NewDispatchEvent): Promise<void>;
  getForUpdate(jobId: string): Promise<DispatchJobRecord | null>;
  updateStatus(args: {
    jobId: string;
    fromStatus: string;
    toStatus: DispatchJobStatus;
    etaEnd?: Date;
    now: Date;
  }): Promise<DispatchJobRecord | null>;
  findByPhone(phone: string): Promise<DispatchJobRecord[]>;
}

export type DispatchRepoFactory = (tx: TenantTx, tenantId: string) => DispatchRepo;

/** Signed 64-bit advisory-lock key for pg_advisory_xact_lock(bigint). */
export function advisoryLockKey(key: string): string {
  return createHash('sha256').update(key).digest().readBigInt64BE(0).toString();
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function asDateOrNull(value: unknown): Date | null {
  if (value == null) return null;
  return asDate(value);
}

function mapJob(row: Record<string, unknown>): DispatchJobRecord {
  return {
    id: String(row.id),
    status: row.status as DispatchJobStatus,
    etaStart: asDateOrNull(row.eta_start),
    etaEnd: asDateOrNull(row.eta_end),
    scheduledAt: asDateOrNull(row.scheduled_at),
    createdAt: asDate(row.created_at),
    contactName: String(row.contact_name ?? ''),
    contactPhone: String(row.contact_phone ?? ''),
    address: String(row.address ?? ''),
  };
}

const JOB_COLUMNS = `id, status, eta_start, eta_end, scheduled_at, created_at, contact_name, contact_phone, address`;

function phoneDigits(phone: string): { e164: string; digits: string; digits11: string } {
  const digits = phone.replace(/\D/g, '');
  const e164 = phone.startsWith('+') ? phone : digits.length === 10 ? `+1${digits}` : `+${digits}`;
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const digits11 = national.length === 10 ? `1${national}` : digits;
  return { e164, digits: national, digits11 };
}

function priorityFor(urgency: CreateJobPrepareInput['urgency']): string {
  return urgency === 'urgent' ? 'urgent' : 'medium';
}

export function jobMetadata(input: CreateJobPrepareInput, address: DispatchAddress, normalized: string, callId: string | null) {
  return {
    qvo: {
      source: 'dispatch.create_job',
      urgency: input.urgency,
      accessNotes: input.accessNotes ?? null,
      callId,
      address: {
        line1: address.line1,
        unit: address.unit ?? null,
        city: address.city,
        region: address.region,
        postal: address.postal,
        normalized,
      },
    },
  };
}

export const sqlDispatchRepo: DispatchRepoFactory = (tx, tenantId) => ({
  async lockAddress(normalizedAddress) {
    await tx.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [
      advisoryLockKey(`dispatch-dup\0${tenantId}\0${normalizedAddress}`),
    ]);
  },

  async findDuplicate(normalizedAddress, windowStart, windowEnd) {
    const { rows } = await tx.query(
      `SELECT ${JOB_COLUMNS}
         FROM dispatch_jobs
        WHERE tenant_id = $1
          AND status NOT IN ('completed', 'cancelled', 'done', 'incomplete')
          AND metadata #>> '{qvo,address,normalized}' = $2
          AND eta_start < $4
          AND eta_end > $3
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE`,
      [tenantId, normalizedAddress, windowStart.toISOString(), windowEnd.toISOString()],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  },

  async insertJob(job) {
    const { input, formattedAddress, normalizedAddress, callId, now } = job;
    const meta = jobMetadata(input, input.address, normalizedAddress, callId);
    const { rows } = await tx.query(
      `INSERT INTO dispatch_jobs (
          tenant_id, title, description, status, priority, job_type,
          contact_name, contact_phone, address, notes,
          scheduled_at, eta_start, eta_end, metadata, created_at, updated_at
        ) VALUES (
          $1, $2, $3, 'pending', $4, $5,
          $6, $7, $8, $9,
          $10, $10, $11, $12::jsonb, $13, $13
        ) RETURNING ${JOB_COLUMNS}`,
      [
        tenantId,
        input.jobType,
        input.problem,
        priorityFor(input.urgency),
        input.jobType,
        input.contact.name,
        input.contact.phone,
        formattedAddress,
        input.accessNotes ?? '',
        input.window.start,
        input.window.end,
        JSON.stringify(meta),
        now.toISOString(),
      ],
    );
    return mapJob(rows[0]);
  },

  async insertEvent(event) {
    await tx.query(
      `INSERT INTO dispatch_job_events (
          job_id, tenant_id, event_type, from_status, to_status, performed_by, notes, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        event.jobId,
        tenantId,
        event.eventType,
        event.fromStatus ?? null,
        event.toStatus,
        event.performedBy,
        event.notes,
        JSON.stringify(event.metadata ?? {}),
        event.now.toISOString(),
      ],
    );
  },

  async getForUpdate(jobId) {
    const { rows } = await tx.query(
      `SELECT ${JOB_COLUMNS} FROM dispatch_jobs WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, jobId],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  },

  async updateStatus({ jobId, fromStatus, toStatus, etaEnd, now }) {
    const completed = toStatus === 'completed' || toStatus === 'done';
    const { rows } = await tx.query(
      `UPDATE dispatch_jobs
          SET status = $3,
              updated_at = $4,
              completed_at = CASE WHEN $5 THEN $4::timestamptz ELSE completed_at END,
              eta_end = COALESCE($6::timestamptz, eta_end)
        WHERE tenant_id = $1 AND id = $2 AND status = $7
        RETURNING ${JOB_COLUMNS}`,
      [
        tenantId,
        jobId,
        toStatus,
        now.toISOString(),
        completed,
        etaEnd?.toISOString() ?? null,
        fromStatus,
      ],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  },

  async findByPhone(phone) {
    const { e164, digits, digits11 } = phoneDigits(phone);
    const { rows } = await tx.query(
      `SELECT ${JOB_COLUMNS}
         FROM dispatch_jobs
        WHERE tenant_id = $1
          AND (
            contact_phone = $2
            OR regexp_replace(contact_phone, '[^0-9]', '', 'g') = $3
            OR regexp_replace(contact_phone, '[^0-9]', '', 'g') = $4
          )
        ORDER BY
          CASE WHEN status NOT IN ('completed', 'cancelled', 'done', 'incomplete') THEN 0 ELSE 1 END,
          COALESCE(eta_start, scheduled_at, created_at) ASC,
          created_at ASC`,
      [tenantId, e164, digits, digits11],
    );
    return rows.map(mapJob);
  },
});

export function formattedAndNormalized(input: CreateJobPrepareInput): { formattedAddress: string; normalizedAddress: string } {
  return {
    formattedAddress: formatAddress(input.address),
    normalizedAddress: normalizeAddress(input.address),
  };
}
