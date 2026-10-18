import {
  BOOKING_BOOK_V1,
  nextMissingSlot,
  type HeldFacts,
  type SlotSpec,
} from '../../callcore/contracts';
import {
  actionFail,
  actionOk,
  createProposal,
  defineAction,
  isActionFailure,
  type ActionContext,
  type ActionResult,
} from '../core';
import {
  bookingSource,
  COMMIT_GRACE_MS,
  HOLD_TTL_MS,
  insertHold,
  lockHoldByToken,
  releaseSessionHolds,
  serviceNames,
  sessionOf,
  setHoldOwner,
  writeBookingAudit,
} from './bookingRows';
import { catchOverlap, consumeToken, SCHEDULING_WRITE_ROLES, takeHold } from './commitShared';
import { expireStaleHolds } from './holds';
import {
  bookingPriceText,
  bookReadback,
  confirmedReadback,
  priceFallback,
  readbackLang,
  spokenWhen,
  toE164,
} from './readback';
import { clearSlotAsks, countSlotAsk, SLOT_EXIT_MESSAGE } from './slotAsks';
import { resolveSlot, slotConflict, slotScope } from './slots';
import {
  bookCommitOutput,
  bookPrepareInput,
  bookPrepareOutput,
  bookProposalPayload,
  confirmationTokenInput,
} from './writeSchemas';

export const BOOK_PREPARE = 'scheduling.book.prepare';
export const BOOK_COMMIT = 'scheduling.book.commit';

/** Server-held facts that fill a booking slot without an ask. */
function heldFactsOf(ctx: ActionContext): HeldFacts {
  const callerPhone = ctx.callerPhone ? toE164(ctx.callerPhone) : null;
  return callerPhone ? { callerPhone } : {};
}

/*
 * One ask per slot, then an exit (slotAsks.ts counts per tenant, session,
 * contract and slot, never from model arguments). A complete payload clears
 * the call's counts so a later booking in the call asks again.
 */

function refuseMissingSlot(ctx: ActionContext, slot: SlotSpec): ActionResult<never> {
  const lang = readbackLang(ctx.locale);
  const asks = countSlotAsk(ctx, BOOKING_BOOK_V1, slot);
  if (asks > BOOKING_BOOK_V1.ceilings.maxAsksPerSlot) {
    return actionFail('SLOT_MISSING', `Still missing ${slot.name} after one ask this call; offer to take a message`, {
      field: slot.name,
      askId: slot.askId,
      exit: 'message_ticket',
      retryable: false,
      callerSafeMessage: SLOT_EXIT_MESSAGE[lang],
    });
  }
  return actionFail('SLOT_MISSING', `Missing ${slot.name}: ask ${slot.askId}, then call prepare again`, {
    field: slot.name,
    askId: slot.askId,
    retryable: true,
    callerSafeMessage: slot.defaultAsk[lang],
  });
}

export const bookPrepareAction = defineAction({
  name: BOOK_PREPARE,
  tool: 'scheduling',
  kind: 'prepare',
  input: bookPrepareInput,
  output: bookPrepareOutput,
  permissions: { roles: SCHEDULING_WRITE_ROLES, agent: true, mcpScope: 'qvo:admin' },
  agentDescription:
    'Hold an appointment for 5 minutes and get the readback. Use serviceIds, staffId (a staff id or \'any\') '
    + 'and a start time from check_availability, plus the customer\'s name and phone. Read the returned readback '
    + 'to the caller word for word and call scheduling.book.commit only after an explicit yes. If the caller '
    + 'changes anything, call prepare again (the earlier hold is released). On CONFLICT, offer the alternatives. '
    + 'On SLOT_MISSING, ask the caller the one question in callerSafeMessage; if exit is set, offer to take a message.',
  async run(ctx, input, tx) {
    // booking.book@1 owns its rule: the next missing slot, in ask order, is the next question.
    const held = heldFactsOf(ctx);
    const missing = nextMissingSlot(BOOKING_BOOK_V1, input, held);
    if (missing) return refuseMissingSlot(ctx, missing);
    clearSlotAsks(ctx, BOOKING_BOOK_V1);
    const { serviceIds, staffId } = input;
    const customerName = input.customer?.name ?? held.verifiedName;
    const customerPhone = input.customer?.phone ?? held.callerPhone;
    if (!serviceIds || !staffId || !input.start || !customerName || !customerPhone) {
      return actionFail('VALIDATION_FAILED', 'Booking details are incomplete');
    }

    const lang = readbackLang(ctx.locale);
    const session = sessionOf(ctx);
    // A correction in the same call releases the earlier hold first, so it
    // never blocks its own replacement and exactly one booking can remain.
    const replacedHoldIds = await releaseSessionHolds(tx, ctx.tenantId, session);

    const scope = await slotScope(tx, ctx, { serviceIds, staffId });
    if (isActionFailure(scope)) return scope;
    const resolved = await resolveSlot(tx, ctx, { serviceIds, staffId, start: new Date(input.start) }, scope);
    if (isActionFailure(resolved)) return resolved;

    const { staff, services } = resolved;
    await expireStaleHolds(tx, ctx.tenantId, staff.id, { now: ctx.now });
    const holdExpiresAt = new Date(ctx.now.getTime() + HOLD_TTL_MS);
    const inserted = await catchOverlap(tx, () =>
      insertHold(tx, {
        tenantId: ctx.tenantId,
        title: services.map((s) => s.name).join(' + '),
        start: new Date(resolved.startMs),
        end: new Date(resolved.endMs),
        blockedUntil: new Date(resolved.blockedUntilMs),
        holdExpiresAt,
        providerId: staff.id,
        appointmentTypeId: services[0].id,
        contactName: customerName,
        contactPhone: customerPhone,
        contactEmail: input.customer?.email ?? '',
        notes: input.notes ?? '',
        timezone: ctx.tenantTimezone,
        source: bookingSource(ctx),
        createdBy: ctx.actor.type === 'user' ? ctx.actor.id : null,
        meta: { serviceIds, session },
      }),
    );
    if (!inserted.ok) {
      return slotConflict(tx, ctx, scope, resolved.startMs, `Slot was just taken (${inserted.overlap} overlap)`, 'slotTaken');
    }
    const holdId = inserted.value;

    const price = bookingPriceText(services, lang);
    const readback = bookReadback(
      {
        serviceNames: services.map((s) => s.name),
        staffName: staff.name,
        when: spokenWhen({ startMs: resolved.startMs, nowMs: ctx.now.getTime(), timeZone: ctx.tenantTimezone, locale: ctx.locale }),
        customerName,
        phone: customerPhone,
      },
      price,
      lang,
    );
    const start = new Date(resolved.startMs).toISOString();
    const end = new Date(resolved.endMs).toISOString();
    const proposal = await createProposal(tx, ctx, {
      action: BOOK_PREPARE,
      payload: {
        holdId,
        serviceIds,
        staffId: staff.id,
        start,
        end,
        customerName,
        locale: ctx.locale ?? null,
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
        priceText: price ?? priceFallback(lang),
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

export const bookCommitAction = defineAction({
  name: BOOK_COMMIT,
  tool: 'scheduling',
  kind: 'commit',
  input: confirmationTokenInput,
  output: bookCommitOutput,
  permissions: { roles: SCHEDULING_WRITE_ROLES, agent: true, mcpScope: 'qvo:admin' },
  agentDescription:
    'Confirm a prepared appointment after the caller explicitly said yes to the readback. '
    + 'Only say it is booked once this returns ok. Retrying with the same token is safe. '
    + 'On CONFLICT the hold was lost: say so and offer the alternatives.',
  async run(ctx, input, tx) {
    const consumed = await consumeToken(tx, ctx, input.confirmationToken, BOOK_PREPARE);
    if (isActionFailure(consumed)) return consumed;
    const payload = bookProposalPayload.safeParse(consumed.payload);
    if (!payload.success) return actionFail('CONFIRMATION_INVALID', 'Stored proposal payload is not a booking hold');

    const hold = await lockHoldByToken(tx, ctx.tenantId, input.confirmationToken);
    if (!hold || hold.id !== payload.data.holdId) {
      return actionFail('CONFIRMATION_INVALID', 'The hold for this confirmation no longer exists');
    }
    const previousStatus = hold.status;
    const taken = await takeHold(tx, ctx, hold, 'confirmed');
    if (isActionFailure(taken)) return taken;

    await writeBookingAudit(tx, ctx, {
      bookingId: hold.id,
      action: 'created',
      previousStatus,
      newStatus: 'confirmed',
      details: { via: BOOK_COMMIT, retaken: taken.retaken, serviceIds: hold.serviceIds, provider_id: hold.providerId },
    });

    const lang = readbackLang(payload.data.locale ?? ctx.locale);
    const staffName = hold.providerName ?? '';
    const readback = confirmedReadback(
      {
        serviceNames: await serviceNames(tx, ctx.tenantId, hold.serviceIds),
        staffName,
        when: spokenWhen({ startMs: hold.startTime.getTime(), nowMs: ctx.now.getTime(), timeZone: ctx.tenantTimezone, locale: payload.data.locale ?? ctx.locale }),
        customerName: hold.contactName,
      },
      lang,
    );
    const data = {
      bookingId: hold.id,
      status: 'confirmed' as const,
      readback,
      confirmationChannel: 'none' as const,
      staffId: hold.providerId ?? '',
      staffName,
      start: hold.startTime.toISOString(),
      end: hold.endTime.toISOString(),
    };
    // No booking outbox exists yet; `effects` is informational and replayed
    // verbatim on a same-token retry, so adapters must not dispatch from it.
    return actionOk(data, {
      readback,
      effects: [{ type: 'booking.confirmed', payload: { ...data, proposalId: input.confirmationToken, callId: ctx.callId ?? null } }],
    });
  },
});
