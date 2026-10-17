// Pieces shared by the book / reschedule / cancel actions: consuming a
// confirmation token, turning a hold into a booking (or re-taking a hold that
// ran out), catching overlap violations, and the cancellation-window policy.

import {
  actionFail,
  consumeProposal,
  isActionFailure,
  isConfirmationToken,
  type ActionContext,
  type ActionError,
  type ActionResult,
  type ProposalRecord,
  type TenantTx,
} from '../core';
import { getActionStore } from '../core/runtime';
import {
  cancellationWindowHours,
  confirmHold,
  HOLD_EXPIRED_REASON,
  HOLD_SUPERSEDED_REASON,
  hasNewerSessionPrepare,
  type BookingRecord,
} from './bookingRows';
import { bookingOverlapKind, expireStaleHolds } from './holds';
import { verifiedInCall } from './identity';
import {
  callerMessage,
  cancellationPolicyText,
  pastAppointmentText,
  readbackLang,
} from './readback';
import { resolveSlot, slotConflict, slotScope } from './slots';
import type { BookingOverlapKind } from './types';

/** Roles of requireMiniSystemWrite on the admin scheduling routes. */
export const SCHEDULING_WRITE_ROLES = ['tenant_owner', 'operations_manager'];

function errorOf(failure: ActionResult<never>): ActionError {
  if (failure.ok) throw new Error('expected an action failure');
  return failure.error;
}

/**
 * Consume a proposal from its token alone. Commit inputs carry only the
 * token (spec §1.4), so the stored payload hash is read back first; the core
 * consume still checks tenant, action, call, expiry and single use.
 */
export async function consumeToken(
  tx: TenantTx,
  ctx: ActionContext,
  token: string,
  action: string,
): Promise<ProposalRecord | ActionResult<never>> {
  if (!isConfirmationToken(token)) return actionFail('CONFIRMATION_INVALID', 'Unknown or expired confirmation token');
  const existing = await getActionStore().inspectProposal(tx, ctx, token);
  if (!existing) return actionFail('CONFIRMATION_INVALID', 'Unknown or expired confirmation token');
  return consumeProposal(tx, ctx, {
    confirmationToken: token,
    action,
    payloadHash: existing.payloadHash,
    callId: ctx.callId,
  });
}

/** Runs one write under a savepoint; an exclusion violation (23P01) comes back as a value. */
export async function catchOverlap<T>(
  tx: TenantTx,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; overlap: BookingOverlapKind }> {
  await tx.query('SAVEPOINT scheduling_write');
  try {
    const value = await fn();
    await tx.query('RELEASE SAVEPOINT scheduling_write');
    return { ok: true, value };
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT scheduling_write');
    const overlap = bookingOverlapKind(err);
    if (overlap) return { ok: false, overlap };
    throw err;
  }
}

/**
 * Turn the proposal's hold into a booking, inside the commit transaction
 * (the hold row is already locked FOR UPDATE):
 * - live hold → confirmed (or pending);
 * - hold that ran out (still 'held', or swept to 'cancelled'/hold_expired) →
 *   re-take the same slot if the engine still offers it, atomically under the
 *   exclusion constraint; otherwise CONFLICT (hold lost) with alternatives;
 * - hold released by a newer prepare in the call, or any lapsed hold with a
 *   newer prepare in the same session → CONFIRMATION_INVALID.
 */
export async function takeHold(
  tx: TenantTx,
  ctx: ActionContext,
  hold: BookingRecord,
  status: 'confirmed' | 'pending',
): Promise<{ retaken: boolean } | ActionResult<never>> {
  const lang = readbackLang(ctx.locale);
  if (hold.status === 'held' && hold.holdExpiresAt && hold.holdExpiresAt.getTime() > ctx.now.getTime()) {
    await confirmHold(tx, ctx.tenantId, hold.id, status);
    return { retaken: false };
  }
  if (hold.status === 'cancelled' && hold.cancellationReason === HOLD_SUPERSEDED_REASON) {
    return actionFail('CONFIRMATION_INVALID', 'This hold was released by a newer prepare in the same call', {
      callerSafeMessage: callerMessage('holdReplaced', lang),
    });
  }
  const lapsed = hold.status === 'held' || (hold.status === 'cancelled' && hold.cancellationReason === HOLD_EXPIRED_REASON);
  if (!lapsed) return actionFail('CONFIRMATION_INVALID', `Hold is ${hold.status}; nothing to confirm`);
  // A newer prepare in the same call means the caller corrected this one;
  // whatever the release/sweep ordering, the old hold is never re-taken.
  if (await hasNewerSessionPrepare(tx, ctx.tenantId, hold)) {
    return actionFail('CONFIRMATION_INVALID', 'This hold was replaced by a newer prepare in the same call', {
      callerSafeMessage: callerMessage('holdReplaced', lang),
    });
  }

  // Re-take: release the lapsed hold (if the sweeper hasn't yet), then the
  // slot must still be one the engine offers, and the status flip re-runs
  // the exclusion constraint against anyone who took it meanwhile.
  if (hold.status === 'held') await expireStaleHolds(tx, ctx.tenantId, hold.providerId, { now: ctx.now });
  const scope = await slotScope(tx, ctx, { serviceIds: hold.serviceIds, staffId: hold.providerId ?? 'any' });
  if (isActionFailure(scope)) {
    return actionFail('CONFLICT', `Hold lost and the slot can no longer be booked: ${errorOf(scope).message}`, {
      alternatives: [],
      callerSafeMessage: callerMessage('holdLost', lang),
    });
  }
  const check = await resolveSlot(tx, ctx, { serviceIds: hold.serviceIds, staffId: hold.providerId ?? 'any', start: hold.startTime }, scope);
  if (isActionFailure(check)) {
    const error = errorOf(check);
    if (error.code === 'CONFLICT') {
      return actionFail('CONFLICT', `Hold lost: ${error.message}`, {
        alternatives: error.alternatives ?? [],
        callerSafeMessage: callerMessage('holdLost', lang),
      });
    }
    return slotConflict(tx, ctx, scope, hold.startTime.getTime(), `Hold lost: ${error.message}`, 'holdLost');
  }
  const flipped = await catchOverlap(tx, () => confirmHold(tx, ctx.tenantId, hold.id, status));
  if (!flipped.ok) {
    return slotConflict(tx, ctx, scope, hold.startTime.getTime(), `Hold lost: slot taken (${flipped.overlap} overlap)`, 'holdLost');
  }
  return { retaken: true };
}

/**
 * Agent reschedule/cancel only touch a booking that scheduling.find_bookings
 * verified in this same call and tenant (spec §0.2.6). A guessed id, one
 * verified in another call, another tenant's, or any id without a callId gets
 * exactly the NOT_FOUND an unknown id gets (same message too), so the agent
 * can't probe which ids exist. It runs before the booking is even loaded.
 * Staff, UI and MCP callers are not gated here.
 */
export async function agentBookingBlock(
  tx: TenantTx,
  ctx: ActionContext,
  bookingId: string,
): Promise<ActionResult<never> | null> {
  if (ctx.actor.type !== 'agent') return null;
  if (await verifiedInCall(tx, ctx, bookingId)) return null;
  return actionFail('NOT_FOUND', 'Booking not found', {
    field: 'bookingId',
    callerSafeMessage: callerMessage('unknownBooking', readbackLang(ctx.locale)),
  });
}

/**
 * An agent commit needs its call: the core consume matches call_id, and a
 * missing callId would otherwise match a UI/MCP proposal (call_id NULL).
 */
export function agentCommitBlock(ctx: ActionContext): ActionResult<never> | null {
  if (ctx.actor.type !== 'agent' || ctx.callId) return null;
  return actionFail('CONFIRMATION_INVALID', 'Unknown or expired confirmation token');
}

/**
 * Reschedule/cancel policy (spec §1.6 #8): nothing that already started, and
 * nothing inside the tenant's cancellation_window_hours. OUTSIDE_POLICY's
 * callerSafeMessage is the policy text the agent states.
 */
export async function policyBlock(
  tx: TenantTx,
  ctx: ActionContext,
  booking: BookingRecord,
): Promise<ActionResult<never> | null> {
  const lang = readbackLang(ctx.locale);
  const leadMs = booking.startTime.getTime() - ctx.now.getTime();
  if (leadMs <= 0) {
    return actionFail('OUTSIDE_POLICY', 'The appointment has already started or passed', {
      callerSafeMessage: pastAppointmentText(lang),
    });
  }
  const hours = await cancellationWindowHours(tx, ctx.tenantId, booking.serviceIds);
  if (hours > 0 && leadMs < hours * 3_600_000) {
    return actionFail('OUTSIDE_POLICY', `Inside the ${hours}-hour cancellation window (scheduling_booking_rules.cancellation_window_hours)`, {
      callerSafeMessage: cancellationPolicyText(hours, lang),
    });
  }
  return null;
}
