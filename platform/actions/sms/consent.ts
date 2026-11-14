import { isSmsOptOut } from '../../campaigns/DncService';
import { withTenantClient } from '../../db';

/** Carrier-standard re-subscribe keywords (exact match, like `isSmsOptOut`). */
const SMS_OPT_IN_KEYWORDS = ['start', 'unstop'];

/** CTIA help keywords (exact match after trim + lower-case). */
const SMS_HELP_KEYWORDS = ['help', 'info'];

/**
 * Non-exact phrases that look like an opt-out but must NOT be treated as one.
 * Kept small and conservative so ordinary chat ("I had to stop at the shop")
 * is not flagged. Matched as a substring of the trimmed, lower-cased body.
 */
const LIKELY_OPT_OUT_PHRASES = [
  'stop texting',
  'please stop',
  'stop sending',
  'stop messaging',
  "don't text me",
  'dont text me',
];

export function isSmsOptIn(body: string): boolean {
  return SMS_OPT_IN_KEYWORDS.includes(body.trim().toLowerCase());
}

export function isSmsHelp(body: string): boolean {
  return SMS_HELP_KEYWORDS.includes(body.trim().toLowerCase());
}

/**
 * True when the body is not an exact STOP/START keyword but contains a
 * conservative likely-opt-out phrase (tools-spec §2.6 #3).
 */
export function isLikelySmsOptOut(body: string): boolean {
  if (isSmsOptOut(body) || isSmsOptIn(body) || isSmsHelp(body)) return false;
  const normalized = body.trim().toLowerCase().replace(/\s+/g, ' ');
  return LIKELY_OPT_OUT_PHRASES.some((phrase) => normalized.includes(phrase));
}

type SqlClient = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

/**
 * Lifts the DNC entry the inbound STOP path created (`source = 'sms'`).
 * Manual and voice DNC entries are left alone.
 *
 * When `client` is passed, the DELETE runs on that transaction (inbound
 * persist) instead of opening a new one.
 */
export async function liftSmsOptOutDnc(
  tenantId: string,
  phone: string,
  client?: SqlClient,
): Promise<boolean> {
  const run = async (c: SqlClient) => {
    const { rowCount } = await c.query(
      `DELETE FROM dnc_list WHERE tenant_id = $1 AND phone_number = $2 AND source = 'sms'`,
      [tenantId, phone],
    );
    return (rowCount ?? 0) > 0;
  };
  if (client) return run(client);
  return withTenantClient(tenantId, run);
}
