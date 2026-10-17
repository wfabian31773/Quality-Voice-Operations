import { randomUUID } from 'node:crypto';
import { withPrivilegedClient, withTenantClient } from '../../db';
import { getTwilioCredentials, sendTwilioSms } from '../../integrations/twilio/sender';
import { resolveVoicePublicBaseUrl } from '../../runtime/processRole';
import { evaluateSmsQuietHoursForTenant, nextSmsWindowStartForTenant } from '../../sms/SmsQuietHours';
import type { TenantTx } from '../core';

export type OutboundStatus =
  | 'sending'
  | 'queued'
  | 'deferred_quiet_hours'
  | 'suppressed'
  | 'failed';

export interface OutboundSmsRecord {
  id: string;
  tenantId: string;
  from: string;
  to: string;
  body: string;
  status: OutboundStatus;
  scheduledAt: Date | null;
  metadata: Record<string, unknown>;
}

/** A deferred row returned by the release claim; `reclaimed` = it was stuck in `sending`. */
export type ClaimedSmsRecord = OutboundSmsRecord & { reclaimed: boolean };

export interface OutboundSmsPatch {
  status: OutboundStatus;
  twilioSid?: string;
  errorMessage?: string;
  scheduledAt?: Date;
  sentAt?: Date;
  /** Shallow-merged into `metadata` (JSONB `||`). */
  metadata?: Record<string, unknown>;
}

/** Per-recipient limit: at most `max` sends since `since`. */
export interface SmsRateLimitWindow {
  max: number;
  since: Date;
}

export type SmsReserveResult = { reserved: true } | { reserved: false; recent: number };

/**
 * Persistence for the chokepoint. Reads use the action's tenant transaction.
 * Writes commit in their own tenant transaction: `runAction` rolls the action
 * savepoint back on any failure result, and a failed or deferred message must
 * still be on record.
 */
export interface SmsSendStore {
  isTenantMessagingEnabled(tx: TenantTx, tenantId: string): Promise<boolean>;
  /** True when `from` is one of the tenant's own numbers. */
  isTenantSender(tx: TenantTx, tenantId: string, from: string): Promise<boolean>;
  latestConsentAction(tx: TenantTx, tenantId: string, phone: string): Promise<'opt_in' | 'opt_out' | null>;
  /**
   * Steps 4–5 in one transaction: under a per-recipient lock, count recent
   * sends and insert the row only when under the limit (`null` = no limit).
   */
  reserveOutbound(record: OutboundSmsRecord, limit: SmsRateLimitWindow | null): Promise<SmsReserveResult>;
  /**
   * Release path: the same lock and count (excluding this row). When reserved,
   * stamps `sent_at = now` so concurrent releases to the recipient see it.
   */
  reserveDeferredSend(
    msg: Pick<OutboundSmsRecord, 'id' | 'tenantId' | 'to'>,
    limit: SmsRateLimitWindow | null,
    now: Date,
  ): Promise<SmsReserveResult>;
  insertOutbound(record: OutboundSmsRecord): Promise<void>;
  updateOutbound(tenantId: string, id: string, patch: OutboundSmsPatch): Promise<void>;
  /**
   * Cross-tenant claim (sets `sending`) of due deferred messages, plus rows a
   * previous release left in `sending` with no Twilio SID since `stuckBefore`.
   * Rows with a SID are never reclaimed.
   */
  claimDueDeferred(now: Date, limit: number, stuckBefore: Date): Promise<ClaimedSmsRecord[]>;
}

export interface SmsTransport {
  defaultFromNumber(tenantId: string): Promise<string | null>;
  send(req: {
    tenantId: string;
    from: string;
    to: string;
    body: string;
    statusCallback: string | null;
  }): Promise<{ sid?: string; status?: string }>;
}

export interface SmsQuietHoursPort {
  isAllowed(tenantId: string, to: string, now: Date): Promise<boolean>;
  nextWindowStart(tenantId: string, to: string, now: Date): Promise<Date>;
}

export interface SmsSendConfig {
  /** Platform-wide kill switch: `SMS_ENABLED`. */
  smsEnabled(): boolean;
  /** Transactional sends this close to a live call skip quiet hours. 0 disables. */
  liveCallExemptSeconds(): number;
  rateLimit(): { max: number; windowMs: number };
  statusCallbackUrl(): string | null;
}

export interface SmsSendDeps {
  store: SmsSendStore;
  transport: SmsTransport;
  quietHours: SmsQuietHoursPort;
  config: SmsSendConfig;
  newId?: () => string;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function smsStatusCallbackUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const base =
    resolveVoicePublicBaseUrl(env) ||
    env.VOICE_GATEWAY_BASE_URL?.trim() ||
    (env.REPLIT_DEV_DOMAIN ? `https://${env.REPLIT_DEV_DOMAIN}` : null);
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/twilio/sms-status`;
}

export const envSmsSendConfig: SmsSendConfig = {
  smsEnabled: () => {
    const raw = (process.env.SMS_ENABLED ?? '').trim().toLowerCase();
    return raw === 'true' || raw === '1';
  },
  liveCallExemptSeconds: () => nonNegativeInt(process.env.SMS_LIVE_CALL_EXEMPT_SECONDS, 60),
  rateLimit: () => ({
    max: nonNegativeInt(process.env.SMS_RECIPIENT_RATE_LIMIT_MAX, 5),
    windowMs: nonNegativeInt(process.env.SMS_RECIPIENT_RATE_LIMIT_WINDOW_SECONDS, 3600) * 1000,
  }),
  statusCallbackUrl: () => smsStatusCallbackUrl(),
};

export const twilioSmsTransport: SmsTransport = {
  async defaultFromNumber(tenantId) {
    const creds = await getTwilioCredentials(tenantId);
    return creds?.phoneNumber ? creds.phoneNumber : null;
  },
  send: ({ tenantId, from, to, body, statusCallback }) =>
    sendTwilioSms(tenantId, to, from, body, { statusCallback }),
};

export const tenantSmsQuietHours: SmsQuietHoursPort = {
  async isAllowed(tenantId, to, now) {
    return (await evaluateSmsQuietHoursForTenant(tenantId, to, now)).allowed;
  },
  nextWindowStart: (tenantId, to, now) => nextSmsWindowStartForTenant(tenantId, to, now),
};

function rowToRecord(r: Record<string, unknown>): OutboundSmsRecord {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    from: r.from_number as string,
    to: r.to_number as string,
    body: r.body as string,
    status: r.status as OutboundStatus,
    scheduledAt: r.scheduled_at ? new Date(r.scheduled_at as string) : null,
    metadata: (typeof r.metadata === 'object' && r.metadata !== null ? r.metadata : {}) as Record<string, unknown>,
  };
}

export const postgresSmsSendStore: SmsSendStore = {
  async isTenantMessagingEnabled(tx, tenantId) {
    const { rows } = await tx.query(
      `SELECT (feature_flags ->> 'sms_messaging_enabled') = 'true' AS enabled
         FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    return rows[0]?.enabled === true;
  },

  async isTenantSender(tx, tenantId, from) {
    const { rows } = await tx.query(
      `SELECT 1 FROM phone_numbers WHERE tenant_id = $1 AND phone_number = $2 LIMIT 1`,
      [tenantId, from],
    );
    return rows.length > 0;
  },

  async latestConsentAction(tx, tenantId, phone) {
    const { rows } = await tx.query(
      `SELECT action FROM sms_consent_log
        WHERE tenant_id = $1 AND phone_number = $2 AND action IN ('opt_in', 'opt_out')
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, phone],
    );
    const action = rows[0]?.action;
    return action === 'opt_in' || action === 'opt_out' ? action : null;
  },

  async reserveOutbound(record, limit) {
    return withTenantClient(record.tenantId, async (client) => {
      if (limit) {
        const recent = await lockAndCountRecent(client, record.tenantId, record.to, limit.since, null);
        if (recent >= limit.max) return { reserved: false as const, recent };
      }
      await insertOutboundRow(client, record);
      return { reserved: true as const };
    });
  },

  async reserveDeferredSend(msg, limit, now) {
    return withTenantClient(msg.tenantId, async (client) => {
      if (limit) {
        const recent = await lockAndCountRecent(client, msg.tenantId, msg.to, limit.since, msg.id);
        if (recent >= limit.max) return { reserved: false as const, recent };
      }
      await client.query(`UPDATE sms_messages SET sent_at = $3 WHERE id = $1 AND tenant_id = $2`, [
        msg.id,
        msg.tenantId,
        now,
      ]);
      return { reserved: true as const };
    });
  },

  async insertOutbound(record) {
    await withTenantClient(record.tenantId, (client) => insertOutboundRow(client, record));
  },

  async updateOutbound(tenantId, id, patch) {
    await withTenantClient(tenantId, async (client) => {
      await client.query(
        `UPDATE sms_messages
            SET status = $3,
                twilio_sid = COALESCE($4, twilio_sid),
                error_message = COALESCE($5, error_message),
                scheduled_at = COALESCE($6, scheduled_at),
                sent_at = COALESCE($7, sent_at),
                metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($8::jsonb, '{}'::jsonb)
          WHERE id = $1 AND tenant_id = $2`,
        [
          id,
          tenantId,
          patch.status,
          patch.twilioSid ?? null,
          patch.errorMessage ?? null,
          patch.scheduledAt ?? null,
          patch.sentAt ?? null,
          patch.metadata ? JSON.stringify(patch.metadata) : null,
        ],
      );
    });
  },

  async claimDueDeferred(now, limit, stuckBefore) {
    // Scheduler path with no tenant yet, like claimDueScheduledMessages.
    // `releaseClaimedAt` marks rows this job moved to `sending`; only those
    // can be reclaimed, and only while no Twilio SID is recorded.
    return withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `WITH due AS (
           SELECT id, status = 'sending' AS reclaimed FROM sms_messages
            WHERE direction = 'outbound'
              AND ((status = 'deferred_quiet_hours' AND scheduled_at <= $1)
                OR (status = 'sending' AND twilio_sid IS NULL
                    AND (metadata ->> 'releaseClaimedAt')::timestamptz <= $3))
            ORDER BY scheduled_at ASC NULLS FIRST
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         UPDATE sms_messages m
            SET status = 'sending',
                metadata = COALESCE(m.metadata, '{}'::jsonb) || jsonb_build_object('releaseClaimedAt', $4::timestamptz)
           FROM due
          WHERE m.id = due.id
         RETURNING m.*, due.reclaimed`,
        [now, limit, stuckBefore, now],
      );
      return rows.map((r) => ({ ...rowToRecord(r), reclaimed: r.reclaimed === true }));
    });
  },
};

type SqlClient = { query: TenantTx['query'] };

/**
 * Serializes check-and-reserve per tenant + recipient for the rest of the
 * transaction, then counts sends in the window. Deferred, suppressed and
 * failed rows were never sent, so they don't count.
 */
async function lockAndCountRecent(
  client: SqlClient,
  tenantId: string,
  to: string,
  since: Date,
  excludeId: string | null,
): Promise<number> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sms-rate:${tenantId}:${to}`]);
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM sms_messages
      WHERE tenant_id = $1 AND to_number = $2 AND direction = 'outbound'
        AND status NOT IN ('failed', 'deferred_quiet_hours', 'suppressed')
        AND COALESCE(sent_at, created_at) >= $3
        AND ($4::varchar IS NULL OR id <> $4)`,
    [tenantId, to, since, excludeId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function insertOutboundRow(client: SqlClient, record: OutboundSmsRecord): Promise<void> {
  const { rows: numbers } = await client.query(
    `SELECT id FROM phone_numbers WHERE tenant_id = $1 AND phone_number = $2 LIMIT 1`,
    [record.tenantId, record.from],
  );
  // No FK on phone_number_id; fall back to the sender number so platform
  // senders still get a thread.
  const phoneNumberId = (numbers[0]?.id as string | undefined) ?? record.from;
  const { rows: conv } = await client.query(
    `INSERT INTO sms_conversations (id, tenant_id, phone_number_id, remote_number, status)
     VALUES ($1, $2, $3, $4, 'open')
     ON CONFLICT (tenant_id, phone_number_id, remote_number) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [randomUUID(), record.tenantId, phoneNumberId, record.to],
  );
  const conversationId = conv[0].id as string;
  await client.query(
    `INSERT INTO sms_messages
       (id, tenant_id, conversation_id, direction, from_number, to_number, body, status, scheduled_at, metadata)
     VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      record.id,
      record.tenantId,
      conversationId,
      record.from,
      record.to,
      record.body,
      record.status,
      record.scheduledAt,
      JSON.stringify(record.metadata),
    ],
  );
  const preview = record.body.length > 100 ? `${record.body.slice(0, 100)}...` : record.body;
  await client.query(
    `UPDATE sms_conversations SET last_message_at = NOW(), last_message_preview = $1, updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3`,
    [preview, conversationId, record.tenantId],
  );
}

export const defaultSmsSendDeps: SmsSendDeps = {
  store: postgresSmsSendStore,
  transport: twilioSmsTransport,
  quietHours: tenantSmsQuietHours,
  config: envSmsSendConfig,
};
