import { z } from 'zod';
import { actionOk, defineAction, type ActionContext, type TenantTx } from '../core';
import { isRealIsoDate, localDateOf, localMinuteOf } from './availability';
import { serviceNames, upcomingByPhone, type BookingRecord } from './bookingRows';
import { callerIdMatches, FIND_BOOKINGS, namesMatch, recordVerified } from './identity';
import { foundBookingLine, readbackLang, spokenWhen } from './readback';
import { phone } from './writeSchemas';

const input = z.object({
  phone,
  /** The name on the booking, as the caller says it. */
  name: z.string().trim().min(1).max(80).optional(),
  /** Local date of the appointment (tenant timezone), YYYY-MM-DD. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
    .refine(isRealIsoDate, 'Not a real calendar date')
    .optional(),
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
  /** Upcoming bookings on the number; only when it is the caller's own (caller ID) and no name was given. */
  matchCount: z.number().int().nonnegative().optional(),
});
type FindOutput = z.infer<typeof output>;

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
    const names = await serviceNames(tx, ctx.tenantId, booking.serviceIds);
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
 * is wrong, or the date/time are: an unverified caller learns nothing.
 * (No NOT_FOUND either: absence must look exactly like a refusal.)
 */
function refused(needs: (typeof NEEDS)[number], matchCount?: number): FindOutput {
  return { verified: false, bookings: [], needs, ...(matchCount === undefined ? {} : { matchCount }) };
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
    + 'gives (or their caller ID number) and the name on the booking. Caller ID is checked on the server. '
    + 'If needs is "name", ask whose name the appointment is under. If needs is "name_date_time", ask for the '
    + 'name, date (YYYY-MM-DD) and time (HH:MM) of the appointment and never suggest a date or time yourself; '
    + 'if the caller doesn\'t know them, offer to take a message. Only a verified result lists bookings: read '
    + 'their spoken text, and if there is more than one, ask which. Never say whether an unverified number has appointments.',
  async run(ctx, args, tx) {
    const upcoming = await upcomingByPhone(tx, ctx.tenantId, args.phone, ctx.now);

    // Staff, UI and MCP callers are trusted: a plain lookup by phone, with
    // optional name/date/time filters.
    if (ctx.actor.type !== 'agent') {
      return actionOk({ verified: true, bookings: await present(tx, ctx, upcoming.filter((b) => matches(ctx, b, args))) });
    }

    // The agent (spec §0.2.6). Caller ID comes from call_sessions, never from input.
    if (await callerIdMatches(tx, ctx, args.phone)) {
      if (!args.name) return actionOk(refused('name', upcoming.length));
      const found = upcoming.filter((b) => matches(ctx, b, args));
      if (found.length === 0) return actionOk(refused('name'));
      await recordVerified(tx, ctx, found.map((b) => b.id));
      return actionOk({ verified: true, bookings: await present(tx, ctx, found) });
    }

    // Blocked or different caller ID: name, date and time must all match.
    if (!args.name || !args.date || !args.time) return actionOk(refused('name_date_time'));
    const found = upcoming.filter((b) => matches(ctx, b, args));
    if (found.length === 0) return actionOk(refused('name_date_time'));
    await recordVerified(tx, ctx, found.map((b) => b.id));
    return actionOk({ verified: true, bookings: await present(tx, ctx, found) });
  },
});
