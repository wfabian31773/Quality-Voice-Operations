import { withPrivilegedClient } from '../../db';
import { createLogger } from '../../core/logger';
import { getTwilioCredentials } from '../../integrations/twilio/sender';

const logger = createLogger('SMS_STATUS_CALLBACK');

/**
 * `error_message` of a row whose send attempt may have reached Twilio but has
 * no SID on record. It is never resent; a later StatusCallback (matched by
 * `?mid=`) can still attach the SID and move it forward.
 */
export const SMS_SEND_OUTCOME_UNKNOWN = 'SEND_OUTCOME_UNKNOWN';

type Query = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null } | undefined>;

export type PrivilegedRunner = <T>(fn: (client: { query: Query }) => Promise<T>) => Promise<T>;

/**
 * Progress rank of a Twilio message status. A callback only moves a row
 * forward, so a late `queued` or `sent` never overwrites `delivered`.
 * Our own pre-send `sending` ranks with Twilio's in-flight states.
 */
const STATUS_RANK: Record<string, number> = {
  accepted: 1,
  scheduled: 1,
  queued: 1,
  sending: 1,
  sent: 2,
  delivered: 3,
  undelivered: 3,
  failed: 3,
  canceled: 3,
  read: 4,
};

export interface SmsStatusCallback {
  messageSid: string;
  messageStatus: string;
  errorCode?: number | null;
  errorMessage?: string;
  /** `sms_messages.id` from the StatusCallback URL (`?mid=`), set by the chokepoint. */
  mid?: string | null;
  to?: string;
  from?: string;
  accountSid?: string;
}

/** The Twilio account the tenant sends from (its SMS connector, else the platform account). */
export type TenantAccountSidLookup = (tenantId: string) => Promise<string | null>;

const defaultAccountSidLookup: TenantAccountSidLookup = async (tenantId) =>
  (await getTwilioCredentials(tenantId))?.accountSid ?? null;

const MID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function samePhone(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const strip = (v: string) => v.trim().replace(/[\s\-().]/g, '');
  return strip(a) !== '' && strip(a) === strip(b);
}

/**
 * Attaches the callback's SID to the row named by `mid` when that row has no
 * SID yet (Twilio accepted the send but the SID write failed). Tenant-safe:
 * the row's To/From must match the callback and the callback's AccountSid
 * must be the account the row's tenant sends from. Returns true when attached.
 */
async function attachSidByMessageId(
  cb: SmsStatusCallback,
  runPrivileged: PrivilegedRunner,
  accountSidFor: TenantAccountSidLookup,
): Promise<boolean> {
  if (!cb.mid || !MID_PATTERN.test(cb.mid)) return false;
  const found = await runPrivileged((client) =>
    client.query(
      `SELECT id, tenant_id, to_number, from_number FROM sms_messages
        WHERE id = $1 AND direction = 'outbound' AND twilio_sid IS NULL
          AND (status = 'sending' OR (status = 'failed' AND error_message = $2))
        LIMIT 1`,
      [cb.mid, SMS_SEND_OUTCOME_UNKNOWN],
    ),
  );
  const row = found?.rows[0];
  if (!row) return false;
  const tenantId = row.tenant_id as string;
  if (!samePhone(row.to_number, cb.to) || !samePhone(row.from_number, cb.from)) {
    logger.warn('SMS status callback mid does not match the message To/From; SID not attached', {
      tenantId,
      messageId: cb.mid,
    });
    return false;
  }
  const expectedAccount = await accountSidFor(tenantId);
  if (!expectedAccount || !cb.accountSid || expectedAccount !== cb.accountSid) {
    logger.warn('SMS status callback account does not match the message tenant; SID not attached', {
      tenantId,
      messageId: cb.mid,
    });
    return false;
  }
  const attached = await runPrivileged((client) =>
    client.query(
      `UPDATE sms_messages
          SET twilio_sid = $3,
              status = 'queued',
              error_message = CASE WHEN error_message = $4 THEN NULL ELSE error_message END
        WHERE id = $1 AND tenant_id = $2 AND direction = 'outbound' AND twilio_sid IS NULL
          AND (status = 'sending' OR (status = 'failed' AND error_message = $4))
          AND NOT EXISTS (SELECT 1 FROM sms_messages other WHERE other.twilio_sid = $3)`,
      [cb.mid, tenantId, cb.messageSid, SMS_SEND_OUTCOME_UNKNOWN],
    ),
  );
  const ok = (attached?.rowCount ?? 0) > 0;
  if (ok) logger.info('Attached Twilio SID from status callback', { tenantId, messageId: cb.mid });
  return ok;
}

/**
 * Applies a Twilio StatusCallback to the `sms_messages` row the chokepoint
 * stored (matched by `twilio_sid`; a row with no SID yet is first matched by
 * `mid`, see attachSidByMessageId). Returns the number of rows updated: 0 for
 * unknown SIDs, unknown statuses, or a callback that would move a row backwards.
 */
export async function applySmsStatusCallback(
  cb: SmsStatusCallback,
  runPrivileged: PrivilegedRunner = withPrivilegedClient as unknown as PrivilegedRunner,
  accountSidFor: TenantAccountSidLookup = defaultAccountSidLookup,
): Promise<number> {
  const status = cb.messageStatus.trim().toLowerCase();
  const rank = STATUS_RANK[status];
  if (!cb.messageSid || rank === undefined) return 0;
  if (cb.mid) await attachSidByMessageId(cb, runPrivileged, accountSidFor);
  const errorCode = typeof cb.errorCode === 'number' && Number.isFinite(cb.errorCode) ? cb.errorCode : null;
  const errorMessage = (cb.errorMessage ?? '').slice(0, 500);
  const isFailure = status === 'failed' || status === 'undelivered';

  const rankCase = Object.entries(STATUS_RANK)
    .map(([name, value]) => `WHEN '${name}' THEN ${value}`)
    .join(' ');

  // The webhook carries a MessageSid, not a tenant; privileged like /twilio/sms-status.
  const result = await runPrivileged((client) =>
    client.query(
      `UPDATE sms_messages
          SET status = $2::text,
              sent_at = CASE WHEN $2::text IN ('sent', 'delivered', 'read') THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
              delivered_at = CASE WHEN $2::text IN ('delivered', 'read') THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
              error_message = CASE
                WHEN $4::boolean AND $5::text <> '' THEN $5::text
                WHEN $4::boolean AND $3::int IS NOT NULL THEN 'Twilio error ' || $3::text
                ELSE error_message
              END,
              metadata = CASE
                WHEN $3::int IS NOT NULL THEN COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('twilioErrorCode', $3::int)
                ELSE metadata
              END
        WHERE twilio_sid = $1
          AND direction = 'outbound'
          AND (CASE status ${rankCase} ELSE 0 END) < $6`,
      [cb.messageSid, status, errorCode, isFailure, errorMessage, rank],
    ),
  );
  return result?.rowCount ?? 0;
}
