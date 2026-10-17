import type { TenantTx } from '../core/types';
import {
  BOOKING_OVERLAP_CONSTRAINTS,
  EXCLUSION_VIOLATION_SQLSTATE,
  HOLD_EXPIRED_REASON,
  type BookingOverlapKind,
  type ExpireStaleHoldsOptions,
  type ExpireStaleHoldsResult,
} from './types';

/**
 * Cancel this provider's held bookings whose hold has expired, so they stop
 * occupying the slot under the 122 exclusion constraints.
 *
 * Call it inside the action's tenant transaction, before inserting a new
 * hold or confirmed booking for the same provider (and resource, if any).
 * Rows are never deleted: they move to 'cancelled' with
 * cancellation_reason = 'hold_expired'.
 */
export async function expireStaleHolds(
  tx: TenantTx,
  tenantId: string,
  providerId: string | null,
  options: ExpireStaleHoldsOptions = {},
): Promise<ExpireStaleHoldsResult> {
  const resourceId = options.resourceId ?? null;
  if (!providerId && !resourceId) return { expiredBookingIds: [] };

  const { rows } = await tx.query(
    `UPDATE bookings
        SET status = 'cancelled',
            cancellation_reason = $4,
            updated_at = NOW()
      WHERE tenant_id = $1
        AND status = 'held'
        AND hold_expires_at <= COALESCE($5::timestamptz, NOW())
        AND (provider_id = $2 OR resource_id = $3)
      RETURNING id`,
    [tenantId, providerId, resourceId, HOLD_EXPIRED_REASON, options.now ?? null],
  );
  return { expiredBookingIds: rows.map((row) => String(row.id)) };
}

/**
 * Which overlap constraint a database error violated, or null if it is not
 * a booking overlap. Actions turn a non-null result into CONFLICT.
 */
export function bookingOverlapKind(err: unknown): BookingOverlapKind | null {
  if (!err || typeof err !== 'object') return null;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  if (code !== EXCLUSION_VIOLATION_SQLSTATE) return null;
  if (constraint === BOOKING_OVERLAP_CONSTRAINTS.provider) return 'provider';
  if (constraint === BOOKING_OVERLAP_CONSTRAINTS.resource) return 'resource';
  return null;
}
