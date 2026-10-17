import { withTenantClient } from '../../db';

/** Carrier-standard re-subscribe keywords (exact match, like `isSmsOptOut`). */
const SMS_OPT_IN_KEYWORDS = ['start', 'unstop'];

export function isSmsOptIn(body: string): boolean {
  return SMS_OPT_IN_KEYWORDS.includes(body.trim().toLowerCase());
}

/**
 * Lifts the DNC entry the inbound STOP path created (`source = 'sms'`).
 * Manual and voice DNC entries are left alone.
 */
export async function liftSmsOptOutDnc(tenantId: string, phone: string): Promise<boolean> {
  return withTenantClient(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM dnc_list WHERE tenant_id = $1 AND phone_number = $2 AND source = 'sms'`,
      [tenantId, phone],
    );
    return (rowCount ?? 0) > 0;
  });
}
