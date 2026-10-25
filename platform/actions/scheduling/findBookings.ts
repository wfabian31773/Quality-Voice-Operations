import { z } from 'zod';
import { BOOKING_FIND_V1, DATE_SLOT_FORMAT, nextMissingSlot, type SlotSpec, type ToolContract } from '../../callcore/contracts';
import { actionOk, defineAction, type ActionContext, type TenantTx } from '../core';
import { localDateOf, localMinuteOf } from './availability';
import { FIND_LIMIT, serviceNames, upcomingByPhone, type BookingRecord } from './bookingRows';
import { dateSlot, toTenantDate } from './dateSlot';
import { callerIdMatches, FIND_BOOKINGS, namesMatch, recordVerified } from './identity';
import { foundBookingLine, readbackLang, spokenWhen } from './readback';
import { countSlotAsk, SLOT_EXIT_MESSAGE, slotAskCount } from './slotAsks';
import { phone } from './writeSchemas';

const input = z.object({
  phone,
  /** The name on the booking, as the caller says it. */
  name: z.string().trim().min(1).max(80).optional(),
  /** Local date of the appointment (tenant timezone), YYYY-MM-DD; dateSlot's variants are accepted. */
  date: dateSlot.optional(),
  /** Local start time of the appointment (tenant timezone), 24-hour HH:MM. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour HH:MM time').optional(),
});
type FindInput = z.infer<typeof input>;

const NEEDS = ['name', 'name_date_time'] as const;

const output = z.object({
  verified: z.boolean(),
  bookings: z.array(
    z.object({
      bookingId: z.string(),
      customerName: z.string(),
      serviceNames: z.array(z.string()),
      staffId: z.string(),
      staffName: z.string(),
      start: z.string(),
      end: z.string(),
      spoken: z.string(),
    }),
  ),
  /** What the agent must ask for before anything can be found. */
  needs: z.enum(NEEDS).optional(),
  /** Unverified agent result: booking.find@1's askId to ask next. */
  askId: z.string().optional(),
  /** Unverified agent result: the one line to say (the ask, or the message offer at the exit). */
  callerSafeMessage: z.string().optional(),
  /** Second miss in the call: don't ask again, offer to take a message. */
  exit: z.literal('message_ticket').optional(),
});
type FindOutput = z.infer<typeof output>;

/** booking.find@1 for a caller the caller ID doesn't vouch for: name, date and time all required. */
const STEPPED_UP: Pick<ToolContract, 'slots'> = {
  slots: BOOKING_FIND_V1.slots.map((s) => (s.requiredWhen === 'callerIdMismatch' ? { ...s, required: true } : s)),
};

/** The slot a non-matching name (or date/time) counts against: the first-name check. */
const NAME_SLOT: SlotSpec = (() => {
  const slot = BOOKING_FIND_V1.slots.find((s) => s.name === 'name');
  if (!slot) throw new Error('booking.find@1 has no name slot');
  return slot;
})();

function hhmm(minuteOfDay: number): string {
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
}

function matches(ctx: ActionContext, booking: BookingRecord, args: Pick<FindInput, 'name' | 'date' | 'time'>): boolean {
  const startMs = booking.startTime.getTime();
  if (args.name && !namesMatch(args.name, booking.contactName)) return false;
  if (args.date && localDateOf(startMs, ctx.tenantTimezone) !== args.date) return false;
  if (args.time && hhmm(localMinuteOf(startMs, ctx.tenantTimezone)) !== args.time) return false;
  return true;
}

async function present(tx: TenantTx, ctx: ActionContext, bookings: BookingRecord[]): Promise<FindOutput['bookings']> {
  const lang = readbackLang(ctx.locale);
  const out: FindOutput['bookings'] = [];
  for (const booking of bookings) {
    const names = await serviceNames(tx, ctx.tenantId, booking.serviceIds, lang);
    const services = names.length > 0 ? names : [booking.title];
    const staffName = booking.providerName ?? (lang === 'es' ? 'el equipo' : 'the team');
    const when = spokenWhen({ startMs: booking.startTime.getTime(), nowMs: ctx.now.getTime(), timeZone: ctx.tenantTimezone, locale: ctx.locale });
    out.push({
      bookingId: booking.id,
      customerName: booking.contactName,
      serviceNames: services,
      staffId: booking.providerId ?? '',
      staffName,
      start: booking.startTime.toISOString(),
      end: booking.endTime.toISOString(),
      spoken: foundBookingLine({ serviceNames: services, staffName, when, customerName: booking.contactName }, lang),
    });
  }
  return out;
}

/**
 * The refusal. It is the same whether the number has no bookings, the name
 * is wrong, or the date/time are: an unverified caller learns nothing, not
 * even how many bookings the number has. (No NOT_FOUND either: absence must
 * look exactly like a refusal.)
 */
function refused(ctx: ActionContext, needs: (typeof NEEDS)[number], slot: SlotSpec, exit: boolean): FindOutput {
  const lang = readbackLang(ctx.locale);
  if (exit) {
    return { verified: false, bookings: [], needs, askId: slot.askId, callerSafeMessage: SLOT_EXIT_MESSAGE[lang], exit: 'message_ticket' };
  }
  return { verified: false, bookings: [], needs, askId: slot.askId, callerSafeMessage: slot.defaultAsk[lang] };
}

/** One ask per slot: counts the miss server-side and exits on the second one in the call. */
function miss(ctx: ActionContext, needs: (typeof NEEDS)[number], slot: SlotSpec): FindOutput {
  const asks = countSlotAsk(ctx, BOOKING_FIND_V1, slot);
  return refused(ctx, needs, slot, asks > BOOKING_FIND_V1.ceilings.maxAsksPerSlot);
}

/** After the exit, find matches nothing more in this call (no name guessing on a shared phone). */
function exited(ctx: ActionContext): boolean {
  return BOOKING_FIND_V1.slots.some((s) => slotAskCount(ctx, BOOKING_FIND_V1, s.name) > BOOKING_FIND_V1.ceilings.maxAsksPerSlot);
}

export const findBookingsAction = defineAction({
  name: FIND_BOOKINGS,
  tool: 'scheduling',
  kind: 'read',
  input,
  output,
  permissions: { agent: true, mcpScope: 'qvo:read' },
  agentDescription:
    'Find the caller\'s upcoming appointments before any reschedule or cancel. Send the phone the caller '
    + 'gives (or their caller ID number) and the name on the booking. Caller ID is checked on the server, and a '
    + 'phone match alone lists nothing: the first name on the booking must match too. Until it does, verified is '
    + 'false: ask the one question in callerSafeMessage (askId), then call again. If needs is "name_date_time", '
    + `also ask the date (send it as ${DATE_SLOT_FORMAT}) and time (HH:MM) of the appointment and never suggest a date or time yourself. `
    + 'If exit is set, do not ask again: offer to take a message. Only a verified result lists bookings: read '
    + 'their spoken text, and if there is more than one, ask which. Never say whether an unverified number has '
    + 'appointments, and never read a booking id aloud.',
  async run(ctx, rawArgs, tx) {
    // An accepted date variant becomes the tenant's YYYY-MM-DD (dateSlot.ts).
    const args = { ...rawArgs, date: rawArgs.date === undefined ? undefined : toTenantDate(rawArgs.date, ctx.tenantTimezone) };
    // Date and time filter in SQL; the name matcher (authoritative, and the
    // JS date/time check alongside it) runs over every scanned row before the
    // result is capped at FIND_LIMIT.
    const lookup = async () => {
      const upcoming = await upcomingByPhone(tx, ctx.tenantId, args.phone, ctx.now, {
        timeZone: ctx.tenantTimezone,
        date: args.date,
        time: args.time,
      });
      return upcoming.filter((b) => matches(ctx, b, args)).slice(0, FIND_LIMIT);
    };

    // Staff, UI and MCP callers are trusted: a plain lookup by phone, with
    // optional name/date/time filters.
    if (ctx.actor.type !== 'agent') {
      return actionOk({ verified: true, bookings: await present(tx, ctx, await lookup()) });
    }

    // The agent (spec §0.2.6, booking.find@1). A caller-ID match is only a
    // candidate; the first name on the booking confirms it. Caller ID comes
    // from call_sessions, never from input. Everything up to a confirmed
    // match is decided before any booking is read.
    const callerMatch = await callerIdMatches(tx, ctx, args.phone);
    const needs = callerMatch ? 'name' : 'name_date_time';
    if (exited(ctx)) return actionOk(refused(ctx, needs, NAME_SLOT, true));
    const missing = nextMissingSlot(callerMatch ? BOOKING_FIND_V1 : STEPPED_UP, args);
    if (missing) return actionOk(miss(ctx, needs, missing));

    const found = await lookup();
    // A wrong name (or, without a caller-ID match, a wrong date/time) is a miss of the name check.
    if (found.length === 0) return actionOk(miss(ctx, needs, NAME_SLOT));
    await recordVerified(tx, ctx, found);
    return actionOk({ verified: true, bookings: await present(tx, ctx, found) });
  },
});
