import { withPrivilegedClient } from '../../db';

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
}

/**
 * Applies a Twilio StatusCallback to the `sms_messages` row the chokepoint
 * stored (matched by `twilio_sid`). Returns the number of rows updated: 0 for
 * unknown SIDs, unknown statuses, or a callback that would move a row backwards.
 */
export async function applySmsStatusCallback(
  cb: SmsStatusCallback,
  runPrivileged: PrivilegedRunner = withPrivilegedClient as unknown as PrivilegedRunner,
): Promise<number> {
  const status = cb.messageStatus.trim().toLowerCase();
  const rank = STATUS_RANK[status];
  if (!cb.messageSid || rank === undefined) return 0;
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
