import {
  actionFail,
  actionOk,
  createProposal,
  defineAction,
  isActionFailure,
  type ActionContext,
  type TenantTx,
} from '../core';
import {
  CANCELLABLE_STATUSES,
  loadBooking,
  moveStatus,
  serviceNames,
  writeBookingAudit,
  type BookingRecord,
} from './bookingRows';
import { consumeToken, policyBlock, SCHEDULING_WRITE_ROLES } from './commitShared';
import {
  callerMessage,
  cancelledReadback,
  cancelReadback,
  readbackLang,
  spokenWhen,
} from './readback';
import {
  cancelCommitOutput,
  cancelPrepareInput,
  cancelPrepareOutput,
  cancelProposalPayload,
  confirmationTokenInput,
} from './writeSchemas';

export const CANCEL_PREPARE = 'scheduling.cancel.prepare';
export const CANCEL_COMMIT = 'scheduling.cancel.commit';

function isCancellable(status: string): boolean {
  return (CANCELLABLE_STATUSES as readonly string[]).includes(status);
}

async function readbackFacts(tx: TenantTx, ctx: ActionContext, booking: BookingRecord, locale: string | undefined) {
  const names = await serviceNames(tx, ctx.tenantId, booking.serviceIds);
  return {
    serviceNames: names.length > 0 ? names : [booking.title],
    customerName: booking.contactName,
    staffName: booking.providerName ?? (readbackLang(locale) === 'es' ? 'el equipo' : 'the team'),
    when: spokenWhen({ startMs: booking.startTime.getTime(), nowMs: ctx.now.getTime(), timeZone: ctx.tenantTimezone, locale }),
  };
}

// Agent use waits for PR-14 (verified find_bookings), like reschedule.
export const cancelPrepareAction = defineAction({
  name: CANCEL_PREPARE,
  tool: 'scheduling',
  kind: 'prepare',
  input: cancelPrepareInput,
  output: cancelPrepareOutput,
  permissions: { roles: SCHEDULING_WRITE_ROLES, agent: false, mcpScope: 'qvo:admin' },
  agentDescription:
    'Prepare to cancel an existing appointment and get the readback. Nothing changes until '
    + 'scheduling.cancel.commit. Inside the shop\'s cancellation window this returns OUTSIDE_POLICY with the policy to state.',
  async run(ctx, input, tx) {
    const lang = readbackLang(ctx.locale);
    const booking = await loadBooking(tx, ctx.tenantId, input.bookingId);
    if (!booking || booking.status === 'held') {
      return actionFail('NOT_FOUND', 'Booking not found', { field: 'bookingId', callerSafeMessage: callerMessage('unknownBooking', lang) });
    }
    if (!isCancellable(booking.status)) {
      return actionFail('VALIDATION_FAILED', `Cannot cancel a ${booking.status} booking`, {
        field: 'bookingId',
        callerSafeMessage: callerMessage('notChangeable', lang),
      });
    }
    const blocked = await policyBlock(tx, ctx, booking);
    if (blocked) return blocked;

    const readback = cancelReadback(await readbackFacts(tx, ctx, booking, ctx.locale), lang);
    const proposal = await createProposal(tx, ctx, {
      action: CANCEL_PREPARE,
      payload: { bookingId: booking.id, start: booking.startTime.toISOString(), reason: input.reason ?? null, locale: ctx.locale ?? null },
      readback,
      callId: ctx.callId,
    });
    return actionOk(
      { confirmationToken: proposal.confirmationToken, expiresAt: proposal.expiresAt.toISOString(), readback },
      { readback },
    );
  },
});

export const cancelCommitAction = defineAction({
  name: CANCEL_COMMIT,
  tool: 'scheduling',
  kind: 'commit',
  input: confirmationTokenInput,
  output: cancelCommitOutput,
  permissions: { roles: SCHEDULING_WRITE_ROLES, agent: false, mcpScope: 'qvo:admin' },
  agentDescription:
    'Cancel the appointment after the caller explicitly said yes to the readback. Only say it was cancelled once this returns ok.',
  async run(ctx, input, tx) {
    const lang = readbackLang(ctx.locale);
    const consumed = await consumeToken(tx, ctx, input.confirmationToken, CANCEL_PREPARE);
    if (isActionFailure(consumed)) return consumed;
    const payload = cancelProposalPayload.safeParse(consumed.payload);
    if (!payload.success) return actionFail('CONFIRMATION_INVALID', 'Stored proposal payload is not a cancellation');

    const booking = await loadBooking(tx, ctx.tenantId, payload.data.bookingId, { forUpdate: true });
    if (!booking || !isCancellable(booking.status) || booking.startTime.toISOString() !== payload.data.start) {
      return actionFail('CONFLICT', 'The booking changed since the prepare', { callerSafeMessage: callerMessage('bookingChanged', lang) });
    }
    const blocked = await policyBlock(tx, ctx, booking);
    if (blocked) return blocked;

    if (!(await moveStatus(tx, ctx.tenantId, booking.id, booking.status, 'cancelled', payload.data.reason ?? ''))) {
      throw new Error(`Booking ${booking.id} changed while locked`);
    }
    await writeBookingAudit(tx, ctx, {
      bookingId: booking.id,
      action: 'cancel',
      previousStatus: booking.status,
      newStatus: 'cancelled',
      details: { via: CANCEL_COMMIT, cancellation_reason: payload.data.reason },
    });

    const locale = payload.data.locale ?? ctx.locale;
    const readback = cancelledReadback(await readbackFacts(tx, ctx, booking, locale), readbackLang(locale));
    const data = { bookingId: booking.id, status: 'cancelled' as const, readback };
    return actionOk(data, {
      readback,
      effects: [{ type: 'booking.cancelled', payload: { ...data, proposalId: input.confirmationToken, callId: ctx.callId ?? null } }],
    });
  },
});
