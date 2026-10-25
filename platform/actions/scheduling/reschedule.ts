import {
  actionFail,
  actionOk,
  createProposal,
  defineAction,
  isActionFailure,
} from '../core';
import {
  bookingSource,
  COMMIT_GRACE_MS,
  HOLD_TTL_MS,
  insertHold,
  loadBooking,
  lockHoldByToken,
  moveStatus,
  releaseSessionHolds,
  RESCHEDULABLE_STATUSES,
  serviceNames,
  sessionOf,
  setHoldOwner,
  writeBookingAudit,
} from './bookingRows';
import {
  agentBookingBlock,
  agentCommitBlock,
  agentIdentityChanged,
  agentIdKey,
  catchOverlap,
  consumeToken,
  policyBlock,
  SCHEDULING_WRITE_ROLES,
  takeHold,
} from './commitShared';
import { expireStaleHolds } from './holds';
import {
  callerMessage,
  readbackLang,
  rescheduledReadback,
  rescheduleReadback,
  spokenServiceName,
  spokenWhen,
} from './readback';
import { resolveSlot, slotConflict, slotScope } from './slots';
import {
  CLEAR_YES,
  confirmationTokenInput,
  rescheduleCommitOutput,
  reschedulePrepareInput,
  reschedulePrepareOutput,
  rescheduleProposalPayload,
} from './writeSchemas';

export const RESCHEDULE_PREPARE = 'scheduling.reschedule.prepare';
export const RESCHEDULE_COMMIT = 'scheduling.reschedule.commit';

function isReschedulable(status: string): boolean {
  return (RESCHEDULABLE_STATUSES as readonly string[]).includes(status);
}

// The agent may only move a booking scheduling.find_bookings verified in the
// same call (agentBookingBlock, spec §0.2.6).
export const reschedulePrepareAction = defineAction({
  name: RESCHEDULE_PREPARE,
  tool: 'scheduling',
  kind: 'prepare',
  input: reschedulePrepareInput,
  output: reschedulePrepareOutput,
  permissions: { roles: SCHEDULING_WRITE_ROLES, agent: true, mcpScope: 'qvo:admin' },
  agentDescription:
    'Hold a new time for an existing appointment without changing it yet, and get the readback. '
    + 'Call scheduling.find_bookings first: bookingId must be one it returned verified in this call, '
    + 'and newStart a time from check_availability. Never offer a time to a caller find_bookings did not verify. '
    + 'Read the readback word for word and commit with scheduling.reschedule.commit only after an explicit yes. '
    + 'On OUTSIDE_POLICY (inside the cancellation window, or already passed) say the callerSafeMessage and offer '
    + 'to take a message for the owner. On CONFLICT, offer the alternatives.',
  async run(ctx, input, tx) {
    const lang = readbackLang(ctx.locale);
    const unverified = await agentBookingBlock(tx, ctx, input.bookingId);
    if (unverified) return unverified;
    const booking = await loadBooking(tx, ctx.tenantId, input.bookingId);
    if (!booking || booking.status === 'held') {
      return actionFail('NOT_FOUND', 'Booking not found', { field: 'bookingId', callerSafeMessage: callerMessage('unknownBooking', lang) });
    }
    if (!isReschedulable(booking.status) || booking.serviceIds.length === 0) {
      return actionFail('VALIDATION_FAILED', `Cannot reschedule a ${booking.status} booking${booking.serviceIds.length ? '' : ' without a service'}`, {
        field: 'bookingId',
        callerSafeMessage: callerMessage('notChangeable', lang),
      });
    }
    const blocked = await policyBlock(tx, ctx, booking);
    if (blocked) return blocked;

    const session = sessionOf(ctx);
    const replacedHoldIds = await releaseSessionHolds(tx, ctx.tenantId, session);
    const request = { serviceIds: booking.serviceIds, staffId: input.staffId ?? booking.providerId ?? 'any' };
    const scope = await slotScope(tx, ctx, request);
    if (isActionFailure(scope)) return scope;
    // The original stays confirmed until the commit, so it still occupies its
    // own time: a new start overlapping it (same staff) is not offered.
    const resolved = await resolveSlot(tx, ctx, { ...request, start: new Date(input.newStart) }, scope);
    if (isActionFailure(resolved)) return resolved;

    const { staff, services } = resolved;
    await expireStaleHolds(tx, ctx.tenantId, staff.id, { now: ctx.now });
    const holdExpiresAt = new Date(ctx.now.getTime() + HOLD_TTL_MS);
    const inserted = await catchOverlap(tx, () =>
      insertHold(tx, {
        tenantId: ctx.tenantId,
        title: booking.title || services.map((s) => s.name).join(' + '),
        start: new Date(resolved.startMs),
        end: new Date(resolved.endMs),
        blockedUntil: new Date(resolved.blockedUntilMs),
        holdExpiresAt,
        providerId: staff.id,
        appointmentTypeId: booking.appointmentTypeId ?? services[0].id,
        contactName: booking.contactName,
        contactPhone: booking.contactPhone,
        contactEmail: booking.contactEmail,
        notes: '',
        timezone: ctx.tenantTimezone,
        source: bookingSource(ctx),
        createdBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
        meta: { serviceIds: booking.serviceIds, session, rescheduleOf: booking.id },
      }),
    );
    if (!inserted.ok) {
      return slotConflict(tx, ctx, scope, resolved.startMs, `Slot was just taken (${inserted.overlap} overlap)`, 'slotTaken');
    }
    const holdId = inserted.value;

    const nowMs = ctx.now.getTime();
    const tz = ctx.tenantTimezone;
    const readback = rescheduleReadback(
      {
        serviceNames: services.map((s) => spokenServiceName(s, lang)),
        customerName: booking.contactName,
        fromWhen: spokenWhen({ startMs: booking.startTime.getTime(), nowMs, timeZone: tz, locale: ctx.locale }),
        fromStaff: booking.providerName ?? staff.name,
        toWhen: spokenWhen({ startMs: resolved.startMs, nowMs, timeZone: tz, locale: ctx.locale }),
        toStaff: staff.name,
      },
      lang,
    );
    const start = new Date(resolved.startMs).toISOString();
    const end = new Date(resolved.endMs).toISOString();
    const proposal = await createProposal(tx, ctx, {
      action: RESCHEDULE_PREPARE,
      payload: {
        holdId,
        bookingId: booking.id,
        fromStart: booking.startTime.toISOString(),
        serviceIds: booking.serviceIds,
        staffId: staff.id,
        start,
        end,
        customerName: booking.contactName,
        locale: ctx.locale ?? null,
        ...agentIdKey(ctx, booking),
      },
      readback,
      callId: ctx.callId,
      ttlMs: HOLD_TTL_MS + COMMIT_GRACE_MS,
    });
    await setHoldOwner(tx, ctx.tenantId, holdId, proposal.confirmationToken);

    return actionOk(
      {
        confirmationToken: proposal.confirmationToken,
        holdId,
        expiresAt: holdExpiresAt.toISOString(),
        readback,
        staffId: staff.id,
        staffName: staff.name,
        start,
        end,
        replacedHoldIds,
      },
      { readback },
    );
  },
});

export const rescheduleCommitAction = defineAction({
  name: RESCHEDULE_COMMIT,
  tool: 'scheduling',
  kind: 'commit',
  input: confirmationTokenInput,
  output: rescheduleCommitOutput,
  permissions: { roles: SCHEDULING_WRITE_ROLES, agent: true, mcpScope: 'qvo:admin' },
  agentDescription:
    'Move the appointment to the held time after the caller explicitly said yes to the readback. '
    + CLEAR_YES
    + 'Only say it was moved once this returns ok. Retrying with the same token is safe.',
  async run(ctx, input, tx) {
    const lang = readbackLang(ctx.locale);
    const noCall = agentCommitBlock(ctx);
    if (noCall) return noCall;
    const consumed = await consumeToken(tx, ctx, input.confirmationToken, RESCHEDULE_PREPARE);
    if (isActionFailure(consumed)) return consumed;
    const payload = rescheduleProposalPayload.safeParse(consumed.payload);
    if (!payload.success) return actionFail('CONFIRMATION_INVALID', 'Stored proposal payload is not a reschedule hold');

    // Lock the original first, then the hold, in one transaction: both rows
    // change together or not at all (like the admin reschedule transition).
    const original = await loadBooking(tx, ctx.tenantId, payload.data.bookingId, { forUpdate: true });
    // For an agent, the locked booking must still carry the contact verified at prepare.
    if (
      !original
      || !isReschedulable(original.status)
      || original.startTime.toISOString() !== payload.data.fromStart
      || agentIdentityChanged(ctx, original, payload.data.idKey)
    ) {
      return actionFail('CONFLICT', 'The original booking changed since the prepare', {
        callerSafeMessage: callerMessage('bookingChanged', lang),
      });
    }
    // The find's verification (first name confirmed) must still hold at the commit.
    const unverified = await agentBookingBlock(tx, ctx, original.id);
    if (unverified) return unverified;
    const blocked = await policyBlock(tx, ctx, original);
    if (blocked) return blocked;

    const hold = await lockHoldByToken(tx, ctx.tenantId, input.confirmationToken);
    if (!hold || hold.id !== payload.data.holdId || hold.rescheduleOf !== original.id) {
      return actionFail('CONFIRMATION_INVALID', 'The hold for this confirmation no longer exists');
    }
    // Same rule as bookingLifecycle: a pending request is not promoted to confirmed.
    const status = original.status === 'pending' ? 'pending' : 'confirmed';
    const holdStatus = hold.status;
    const taken = await takeHold(tx, ctx, hold, status);
    if (isActionFailure(taken)) return taken;
    if (!(await moveStatus(tx, ctx.tenantId, original.id, original.status, 'rescheduled'))) {
      throw new Error(`Booking ${original.id} changed while locked`);
    }

    await writeBookingAudit(tx, ctx, {
      bookingId: original.id,
      action: 'rescheduled',
      previousStatus: original.status,
      newStatus: 'rescheduled',
      details: { via: RESCHEDULE_COMMIT, new_booking_id: hold.id, new_start_time: hold.startTime.toISOString(), new_end_time: hold.endTime.toISOString() },
    });
    await writeBookingAudit(tx, ctx, {
      bookingId: hold.id,
      action: 'created',
      previousStatus: holdStatus,
      newStatus: status,
      details: { via: RESCHEDULE_COMMIT, rescheduled_from: original.id, retaken: taken.retaken },
    });

    const staffName = hold.providerName ?? '';
    const locale = payload.data.locale ?? ctx.locale;
    const readback = rescheduledReadback(
      {
        serviceNames: await serviceNames(tx, ctx.tenantId, hold.serviceIds, readbackLang(locale)),
        customerName: hold.contactName,
        toWhen: spokenWhen({ startMs: hold.startTime.getTime(), nowMs: ctx.now.getTime(), timeZone: ctx.tenantTimezone, locale }),
        toStaff: staffName,
      },
      readbackLang(locale),
    );
    const data = {
      bookingId: hold.id,
      previousBookingId: original.id,
      status,
      readback,
      staffId: hold.providerId ?? '',
      staffName,
      start: hold.startTime.toISOString(),
      end: hold.endTime.toISOString(),
    };
    return actionOk(data, {
      readback,
      effects: [{ type: 'booking.rescheduled', payload: { ...data, proposalId: input.confirmationToken, callId: ctx.callId ?? null } }],
    });
  },
});
