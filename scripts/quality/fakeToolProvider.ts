// The real floor's "said more than their own name" rule (pure, no imports), so
// the sim's floor decision can't drift from production's.
import { saidMoreThanTheirOwnName } from '../../platform/actions/tickets/floorHeuristics';
// The real service-ref resolver (pure), so a service name resolves in the sim exactly as in production.
import { resolveServiceRef } from '../../platform/actions/scheduling/serviceMatch';
import { isReleasedHold, type Service, type TenantState } from './seed';
import type {
  AgentToolSchema,
  BookingRow,
  ToolCallContext,
  ToolName,
  ToolProvider,
  ToolResult,
} from './types';

const GENERIC_SAFE: Record<string, string> = {
  VALIDATION_FAILED: 'Some details are missing or invalid.',
  NOT_FOUND: "I couldn't find that.",
  FORBIDDEN: "I don't have permission to do that.",
  TOOL_NOT_ENABLED: "That isn't available for this business.",
  CONFLICT: 'That time or record is no longer available.',
  OUTSIDE_POLICY: "That isn't allowed by the shop's policy.",
  CONFIRMATION_INVALID: 'That confirmation is no longer valid. I can start over.',
  IDEMPOTENCY_KEY_REUSED: 'This request does not match the original. I can start over.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
};

function fail(
  code: string,
  message: string,
  extra?: { field?: string; alternatives?: unknown[]; callerSafeMessage?: string; askId?: string; exit?: 'message_ticket' },
): ToolResult {
  return {
    ok: false,
    error: {
      code,
      message,
      callerSafeMessage: GENERIC_SAFE[code] ?? message,
      retryable: code === 'INTERNAL',
      ...extra,
    },
  };
}

// The real scheduling actions' caller-safe texts (platform/actions/scheduling/readback.ts).
const UNKNOWN_BOOKING = "I couldn't find that appointment.";
const SLOT_UNAVAILABLE = "That time isn't available. I can offer the closest open times.";
const UNKNOWN_SERVICE = "I couldn't find that service.";
const AMBIGUOUS_SERVICE = 'We have more than one service by that name. Which one did you mean?';
const PAST_APPOINTMENT ="That appointment has already started or passed, so I can't change it. I can take a message for the shop.";

/**
 * booking.find@1's asks (platform/callcore/contracts/bookingFind.ts) and the
 * exit line (platform/actions/scheduling/slotAsks.ts SLOT_EXIT_MESSAGE).
 */
type FindSlot = 'name' | 'date' | 'time';
const FIND_ASKS: Record<FindSlot, { askId: string; ask: string }> = {
  name: { askId: 'ask.bookingName', ask: 'What name is the appointment under?' },
  date: { askId: 'ask.bookingDate', ask: 'What day is the appointment?' },
  time: { askId: 'ask.bookingTime', ask: 'What time is the appointment?' },
};
const SLOT_EXIT_MESSAGE = 'I can take a message so someone can call you back.';

/** tickets.message@1 (platform/callcore/contracts/ticketsMessage.ts) for the agent's messages and callbacks. */
const MESSAGE_KINDS = new Set(['message', 'callback']);
const MESSAGE_ASKS = {
  subject: { askId: 'ask.messageSubject', ask: 'What would you like me to pass along?' },
  callbackNumber: { askId: 'ask.callbackNumber', ask: 'What number should they call you back on?' },
};
/** What the agent says when the subject is still missing after one ask (platform/actions/tickets/actions.ts). */
const MESSAGE_EXIT = "I'll let the team know you called.";

/** One ask per slot per call (contract ceilings.maxAsksPerSlot). */
const MAX_ASKS_PER_SLOT = 1;

/** The system-only hangup floor (platform/actions/tickets/floor.ts). */
export const FILE_FLOOR = 'tickets.file_floor';
export const FLOOR_SUBJECT = 'Caller hung up before finishing';

function cancellationPolicyText(hours: number): string {
  return `The shop's policy needs at least ${hours} ${hours === 1 ? "hour's" : "hours'"} notice to change or cancel an appointment. I can take a message for the shop.`;
}

/** E.164 like the real phone schema (10 digits = US), or null. */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0') ? `+${digits}` : null;
  if (digits.length === 10 && !/^[01]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function nameTokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Mirrors namesMatch in platform/actions/scheduling/identity.ts: first name or full name, case/accent-insensitive. */
export function namesMatch(given: string, onBooking: string): boolean {
  const g = nameTokens(given);
  const b = nameTokens(onBooking);
  if (g.length === 0 || b.length === 0) return false;
  if (g.length === 1 || b.length === 1) return g[0] === b[0];
  return g.join(' ') === b.join(' ');
}

/**
 * The phone + name a booking was verified against (the real action stores a
 * sha256 of tenant, phone digits and normalized name; the fake keeps it plain).
 */
function identityOf(row: BookingRow): string {
  return `${toE164(row.customerPhone) ?? row.customerPhone}\0${nameTokens(row.customerName).join(' ')}`;
}

/** Agent reschedule/cancel proposals keep the identity verified at prepare (the real payload's idKey). */
function agentIdKey(row: BookingRow, ctx: ToolCallContext): { idKey?: string } {
  return ctx.actor.type === 'agent' ? { idKey: identityOf(row) } : {};
}

/** An agent commit refuses a booking whose phone or name changed since the prepare. */
function agentIdentityChanged(row: BookingRow, payload: Record<string, unknown>, ctx: ToolCallContext): boolean {
  return ctx.actor.type === 'agent' && payload.idKey !== identityOf(row);
}

function ok(data: unknown, readback?: string): ToolResult {
  return readback ? { ok: true, data, readback } : { ok: true, data };
}

function asRecord(input: Record<string, unknown>): Record<string, unknown> {
  return input;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** A catalog service; `bufferMin` (services.buffer_minutes) comes from the shop fixtures and defaults to 0. */
export type CatalogService = Service & { bufferMin?: number };

/**
 * How the availability engine sizes a booking of `serviceIds` at `start`
 * (platform/actions/scheduling/availability/engine.ts, slots.ts resolveSlot):
 * `endMs` = start + the durations (end_time, what is read back) and
 * `blockedUntilMs` = end + the largest buffer of the services
 * (bookings.blocked_until). Overlap is checked on [start, blockedUntil).
 */
export function bookingSpan(
  services: CatalogService[],
  serviceIds: string[],
  start: string,
): { startMs: number; endMs: number; blockedUntilMs: number } {
  const picked = serviceIds.map((id) => services.find((service) => service.id === id));
  const durationMin = picked.reduce((total, service) => total + (service?.durationMin ?? 0), 0);
  const bufferMin = picked.reduce((max, service) => Math.max(max, service?.bufferMin ?? 0), 0);
  const startMs = Date.parse(start);
  const endMs = startMs + durationMin * 60_000;
  return { startMs, endMs, blockedUntilMs: endMs + bufferMin * 60_000 };
}

function staffPerforms(state: TenantState, staffId: string, serviceIds: string[]): boolean {
  if (serviceIds.length === 0) return true;
  const staff = state.staff.find((member) => member.id === staffId);
  return Boolean(staff && serviceIds.every((id) => staff.serviceIds.includes(id)));
}

/**
 * Service refs → service ids, with the real resolver (serviceMatch.ts
 * resolveServiceRef): an id, or an exact name/alias of exactly one service.
 * Failures mirror serviceRefs.ts: candidates in `alternatives` as { serviceId, name }.
 */
function resolveServiceIds(
  state: TenantState,
  refs: string[],
  field: string,
  unknownCode: 'NOT_FOUND' | 'VALIDATION_FAILED',
): string[] | ToolResult {
  const ids: string[] = [];
  const choices = (services: Service[]) => services.map((service) => ({ serviceId: service.id, name: service.name }));
  for (const ref of refs) {
    const found = resolveServiceRef(state, ref);
    if (found.status === 'ambiguous') {
      return fail('VALIDATION_FAILED', `"${ref}" matches more than one service`, {
        field,
        alternatives: choices(found.candidates),
        callerSafeMessage: AMBIGUOUS_SERVICE,
      });
    }
    if (found.status === 'unknown') {
      return fail(unknownCode, `unknown service ${ref}`, { field, alternatives: choices(found.suggestions), callerSafeMessage: UNKNOWN_SERVICE });
    }
    ids.push(found.service.id);
  }
  if (new Set(ids).size !== ids.length) return fail('VALIDATION_FAILED', 'Each service may appear once', { field });
  return ids;
}

export function slotStartMatches(
  slotStart: string,
  requested: string,
  timeZone: string,
  onDate?: string,
): boolean {
  if (requested === slotStart) return true;
  if (/^\d{1,2}:\d{2}$/.test(requested)) {
    if (!onDate) return false;
    const [hour, minute] = requested.split(':');
    return (
      formatLocalHm(slotStart, timeZone) === `${hour.padStart(2, '0')}:${minute}` &&
      localDate(slotStart, timeZone) === onDate
    );
  }
  return false;
}

export function formatLocalHm(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour.padStart(2, '0')}:${minute}`;
}

export function localDate(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function spokenSlot(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function last4(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-4);
}

let tokenSeq = 0;

function nextToken(): string {
  tokenSeq += 1;
  return `tok_${tokenSeq}`;
}

export function resetFakeTokens(): void {
  tokenSeq = 0;
}

const HANDLED = new Set([
  'scheduling.list_services',
  'scheduling.list_staff',
  'scheduling.check_availability',
  'scheduling.find_bookings',
  'scheduling.book.prepare',
  'scheduling.book.commit',
  'scheduling.reschedule.prepare',
  'scheduling.reschedule.commit',
  'scheduling.cancel.prepare',
  'scheduling.cancel.commit',
  'tickets.open.prepare',
  'tickets.open.commit',
  'calls.transfer_to_human.prepare',
  'calls.transfer_to_human.commit',
  'business.get_info',
]);

/** cancellation_reason the real scheduling.book.prepare writes on a hold a newer prepare in the call replaced. */
export const HOLD_SUPERSEDED_REASON = 'hold_superseded';

/** Most bookings one find_bookings returns (platform/actions/scheduling/bookingRows.ts FIND_LIMIT). */
export const FIND_LIMIT = 20;

type CommitKind = 'booking' | 'reschedule' | 'cancel' | 'ticket' | 'transfer';

export class FakeToolProvider implements ToolProvider {
  /**
   * Successful commit results by token, with the call that committed: a retry
   * with the same token from the same call replays it (core idempotency).
   */
  private readonly commits = new Map<string, { callId: string; result: ToolResult }>();
  /**
   * Booking ids find_bookings verified, per call, with the phone + name they
   * were verified against (the real action records them per tenant + call).
   */
  private readonly verified = new Map<string, Map<string, string>>();
  /**
   * Contract misses per (call, contract, slot), counted here like slotAsks.ts
   * and never from agent input. The real counter treats a retry of the same
   * tool call as one miss; the fake has no idempotency key, so its asks are
   * not retryable (the sim's retry wrapper would otherwise re-count them).
   */
  private readonly asks = new Map<string, number>();

  constructor(
    private readonly state: TenantState,
    private readonly enabled: ToolName[],
  ) {}

  listTools(): AgentToolSchema[] {
    return [...HANDLED]
      .filter((name) => this.enabled.includes(name.split('.')[0] as ToolName))
      .map((name) => ({ name, description: name }));
  }

  async invoke(name: string, input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    // Not an agent tool (never listed): the runtime calls it at teardown.
    if (name === FILE_FLOOR) return this.fileFloor(asRecord(input), ctx);
    const tool = name.split('.')[0] as ToolName;
    if (!this.enabled.includes(tool)) return fail('TOOL_NOT_ENABLED', `${tool} is not enabled for this template`);
    if (!HANDLED.has(name)) return fail('NOT_FOUND', `unknown action ${name}`);
    switch (name) {
      case 'scheduling.list_services':
        return ok(this.state.services);
      case 'scheduling.list_staff':
        return this.listStaff(asRecord(input));
      case 'scheduling.check_availability':
        return this.checkAvailability(asRecord(input), ctx);
      case 'scheduling.book.prepare':
        return this.bookPrepare(asRecord(input), ctx);
      case 'scheduling.book.commit':
        return this.commit('booking', asRecord(input), ctx);
      case 'scheduling.find_bookings':
        return this.findBookings(asRecord(input), ctx);
      case 'scheduling.reschedule.prepare':
        return this.reschedulePrepare(asRecord(input), ctx);
      case 'scheduling.reschedule.commit':
        return this.commit('reschedule', asRecord(input), ctx);
      case 'scheduling.cancel.prepare':
        return this.cancelPrepare(asRecord(input), ctx);
      case 'scheduling.cancel.commit':
        return this.commit('cancel', asRecord(input), ctx);
      case 'tickets.open.prepare':
        return this.ticketPrepare(asRecord(input), ctx);
      case 'tickets.open.commit':
        return this.commit('ticket', asRecord(input), ctx);
      case 'calls.transfer_to_human.prepare':
        return this.transferPrepare(asRecord(input));
      case 'calls.transfer_to_human.commit':
        return this.commit('transfer', asRecord(input), ctx);
      case 'business.get_info':
        return ok({
          hours: this.state.hoursText,
          address: this.state.address,
          transferTarget: this.state.transferTarget,
        });
      default:
        return fail('NOT_FOUND', `unknown action ${name}`);
    }
  }

  /**
   * Like scheduling.list_staff: serviceId (an id, or an exact service name/alias) lists only who does it.
   * Each member carries their usual week (workingDays, hours) from the seed.
   */
  private listStaff(input: Record<string, unknown>): ToolResult {
    const ref = asString(input.serviceId);
    const resolved = ref ? resolveServiceIds(this.state, [ref], 'serviceId', 'NOT_FOUND') : [];
    if (!Array.isArray(resolved)) return resolved;
    const [serviceId] = resolved;
    return ok(
      this.state.staff
        .filter((member) => !serviceId || member.serviceIds.includes(serviceId))
        .map((member) => ({
          id: member.id,
          displayName: member.displayName,
          serviceIds: member.serviceIds,
          workingDays: [...member.workingDays],
          hours: { ...member.hours },
        })),
    );
  }

  private checkAvailability(input: Record<string, unknown>, ctx: ToolCallContext): ToolResult {
    const staffId = asString(input.staffId) ?? 'any';
    const serviceIds = resolveServiceIds(this.state, asStringArray(input.serviceIds), 'serviceIds', 'NOT_FOUND');
    if (!Array.isArray(serviceIds)) return serviceIds;
    const date = asString(input.date) ?? localDate(ctx.now.toISOString(), ctx.tenantTimezone);
    const today = localDate(ctx.now.toISOString(), ctx.tenantTimezone);
    const slots = this.state.slots
      .filter((slot) => {
        if (localDate(slot.start, ctx.tenantTimezone) !== date) return false;
        if (staffId !== 'any' && slot.staffId !== staffId) return false;
        if (!staffPerforms(this.state, slot.staffId, serviceIds)) return false;
        // Without services the fake can't size the request's buffer; the seeded slot end stands in.
        return this.isFree(slot.staffId, slot.start, serviceIds.length > 0 ? this.blockedUntilFor(serviceIds, slot.start) : Date.parse(slot.end));
      })
      .map((slot) => {
        const staff = this.state.staff.find((member) => member.id === slot.staffId);
        return {
          start: slot.start,
          end: slot.end,
          staffId: slot.staffId,
          staffName: staff?.displayName ?? slot.staffId,
          spoken: spokenSlot(slot.start, ctx.tenantTimezone),
        };
      });
    if (slots.length === 0) {
      const reason =
        date === today ? this.state.reasonIfNoneToday ?? 'fully_booked' : 'fully_booked';
      return ok({
        slots: [],
        nextOpenDate: this.state.nextOpenDate,
        reasonIfNone: reason,
      });
    }
    return ok({ slots });
  }

  /**
   * Like PR-13's scheduling.book.prepare: a new prepare in the same call
   * releases that call's earlier, still-held hold first (spec §1.6 #6), so
   * its token can no longer commit and exactly one booking can remain.
   */
  private releaseCallHolds(callId: string): void {
    for (const [token, hold] of Object.entries(this.state.holds)) {
      if ((hold.kind !== 'booking' && hold.kind !== 'reschedule') || hold.callId !== callId) continue;
      const booking = this.state.bookings.find((row) => row.id === hold.payload.bookingId);
      if (booking?.status !== 'held') continue;
      booking.status = 'cancelled';
      booking.cancellationReason = HOLD_SUPERSEDED_REASON;
      delete this.state.holds[token];
    }
  }

  private bookPrepare(input: Record<string, unknown>, ctx: ToolCallContext): ToolResult {
    const serviceRefs = asStringArray(input.serviceIds);
    const start = asString(input.start);
    const staffPref = asString(input.staffId) ?? 'any';
    const customer = (input.customer ?? {}) as Record<string, unknown>;
    const name = asString(customer.name);
    const phone = asString(customer.phone);
    if (!start || !name || !phone || serviceRefs.length === 0) {
      return fail('VALIDATION_FAILED', 'serviceIds, start, and customer name/phone are required', {
        field: !start ? 'start' : !name ? 'customer.name' : 'customer.phone',
      });
    }
    // Like the real book.prepare (slots.ts slotScope): an unknown service is VALIDATION_FAILED.
    const serviceIds = resolveServiceIds(this.state, serviceRefs, 'serviceIds', 'VALIDATION_FAILED');
    if (!Array.isArray(serviceIds)) return serviceIds;
    this.releaseCallHolds(ctx.callId);
    const onDate = localDate(ctx.now.toISOString(), ctx.tenantTimezone);
    const slot = this.state.slots.find((candidate) => {
      if (!slotStartMatches(candidate.start, start, ctx.tenantTimezone, onDate)) return false;
      if (staffPref !== 'any' && candidate.staffId !== staffPref) return false;
      return staffPerforms(this.state, candidate.staffId, serviceIds);
    });
    if (!slot) {
      return fail('CONFLICT', 'that time is not available', {
        alternatives: this.state.slots.slice(0, 3).map((candidate) => candidate.start),
      });
    }
    const staff = this.state.staff.find((member) => member.id === slot.staffId);
    if (!this.isFree(slot.staffId, slot.start, this.blockedUntilFor(serviceIds, slot.start))) {
      return fail('CONFLICT', 'that time is no longer available');
    }
    const services = this.state.services.filter((service) => serviceIds.includes(service.id));
    const serviceNames = services.map((service) => service.name).join(' and ') || 'appointment';
    const when = spokenSlot(slot.start, ctx.tenantTimezone);
    const readback = `a ${serviceNames} with ${staff?.displayName ?? slot.staffId}, ${when}, for ${name}, at ${phone}`;
    const token = nextToken();
    const booking: BookingRow = {
      id: `hold_${token}`,
      status: 'held',
      staffId: slot.staffId,
      staffName: staff?.displayName ?? slot.staffId,
      serviceIds,
      start: slot.start,
      startLocal: formatLocalHm(slot.start, ctx.tenantTimezone),
      customerName: name,
      customerPhone: phone,
      callId: ctx.callId,
    };
    this.state.bookings.push(booking);
    this.state.holds[token] = { kind: 'booking', payload: { bookingId: booking.id }, readback, callId: ctx.callId };
    return ok(
      {
        confirmationToken: token,
        holdId: booking.id,
        expiresAt: new Date(ctx.now.getTime() + 5 * 60 * 1000).toISOString(),
        readback,
        priceText: services[0]?.priceText ?? 'the shop will confirm the price',
      },
      readback,
    );
  }

  private serviceNamesOf(serviceIds: string[]): string[] {
    return serviceIds.map((id) => this.state.services.find((service) => service.id === id)?.name ?? id);
  }

  /** The end that is read back (end_time): durations only, no buffer. */
  private endOf(booking: BookingRow): string {
    return new Date(bookingSpan(this.state.services, booking.serviceIds, booking.start).endMs).toISOString();
  }

  /** Where a booking of `serviceIds` at `start` stops blocking its staff member (blocked_until). */
  private blockedUntilFor(serviceIds: string[], start: string): number {
    return bookingSpan(this.state.services, serviceIds, start).blockedUntilMs;
  }

  /** Counts one miss of a contract slot in this call; returns the call's count (1 = the first ask). */
  private countAsk(callId: string, contract: string, slot: string): number {
    const key = `${callId}\0${contract}\0${slot}`;
    const count = (this.asks.get(key) ?? 0) + 1;
    this.asks.set(key, count);
    return count;
  }

  private askCount(callId: string, contract: string, slot: string): number {
    return this.asks.get(`${callId}\0${contract}\0${slot}`) ?? 0;
  }

  /** The unverified result: the next ask, or the message offer once the slot was missed twice. */
  private findRefusal(needs: 'name' | 'name_date_time', slot: FindSlot, exit: boolean): ToolResult {
    const { askId, ask } = FIND_ASKS[slot];
    return exit
      ? ok({ verified: false, bookings: [], needs, askId, callerSafeMessage: SLOT_EXIT_MESSAGE, exit: 'message_ticket' })
      : ok({ verified: false, bookings: [], needs, askId, callerSafeMessage: ask });
  }

  private findMiss(callId: string, needs: 'name' | 'name_date_time', slot: FindSlot): ToolResult {
    return this.findRefusal(needs, slot, this.countAsk(callId, 'booking.find', slot) > MAX_ASKS_PER_SLOT);
  }

  /**
   * Like scheduling.find_bookings (spec §0.2.6, booking.find@1). The trusted
   * caller ID is `state.callerNumber` (call_sessions in the real action),
   * never input. A caller-ID match is only a candidate: the first name on the
   * booking confirms it. No match: name, date and time must all match. Until
   * then the result carries no booking and no count, only the next ask
   * (askId + callerSafeMessage); a missing or wrong name is one ask, and the
   * second miss in the call exits to a message (exit: 'message_ticket'),
   * after which nothing more is matched.
   */
  private findBookings(input: Record<string, unknown>, ctx: ToolCallContext): ToolResult {
    const phone = toE164(asString(input.phone) ?? '');
    if (!phone) return fail('VALIDATION_FAILED', 'Use a valid phone number, e.g. +15555550142', { field: 'phone' });
    const name = asString(input.name)?.trim() || undefined;
    const date = asString(input.date);
    const time = asString(input.time);
    const tz = ctx.tenantTimezone;
    const upcoming = this.state.bookings
      .filter((row) => row.status === 'confirmed' && Date.parse(row.start) > ctx.now.getTime() && toE164(row.customerPhone) === phone)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const isMatch = (row: BookingRow) =>
      (!name || namesMatch(name, row.customerName)) &&
      (!date || localDate(row.start, tz) === date) &&
      (!time || formatLocalHm(row.start, tz) === time);
    // Like the real action: filter every scanned row, then cap at FIND_LIMIT.
    const matching = () => upcoming.filter(isMatch).slice(0, FIND_LIMIT);
    const present = (rows: BookingRow[]) =>
      rows.map((row) => {
        const services = this.serviceNamesOf(row.serviceIds);
        const when = spokenSlot(row.start, tz);
        return {
          bookingId: row.id,
          customerName: row.customerName,
          serviceNames: services,
          staffId: row.staffId,
          staffName: row.staffName,
          start: new Date(row.start).toISOString(),
          end: this.endOf(row),
          spoken: `${services.join(' and ')} with ${row.staffName}, ${when}, for ${row.customerName}.`,
        };
      });
    const verify = (rows: BookingRow[]) => {
      const verified = this.verified.get(ctx.callId) ?? new Map<string, string>();
      for (const row of rows) verified.set(row.id, identityOf(row));
      this.verified.set(ctx.callId, verified);
      this.state.disclosed = [...(this.state.disclosed ?? []), ...rows.map((row) => row.id)];
      return ok({ verified: true, bookings: present(rows) });
    };

    if (ctx.actor.type !== 'agent') return ok({ verified: true, bookings: present(matching()) });
    const callerId = this.state.callerNumber ? toE164(this.state.callerNumber) : null;
    const callerMatch = callerId === phone;
    const needs = callerMatch ? 'name' : 'name_date_time';
    const exited = (Object.keys(FIND_ASKS) as FindSlot[]).some(
      (slot) => this.askCount(ctx.callId, 'booking.find', slot) > MAX_ASKS_PER_SLOT,
    );
    if (exited) return this.findRefusal(needs, 'name', true);
    const given: Record<FindSlot, string | undefined> = { name, date, time };
    const required: FindSlot[] = callerMatch ? ['name'] : ['name', 'date', 'time'];
    const missing = required.find((slot) => !given[slot]);
    if (missing) return this.findMiss(ctx.callId, needs, missing);
    const found = matching();
    // A wrong name (or, without a caller-ID match, a wrong date/time) is a miss of the name check.
    return found.length > 0 ? verify(found) : this.findMiss(ctx.callId, needs, 'name');
  }

  /**
   * The agent may only change a booking find_bookings verified in this call
   * that still has the phone and name it was verified against; anything else
   * gets the NOT_FOUND an unknown id gets. Then the PR-13 policy: nothing
   * already started, nothing inside the cancellation window.
   */
  private changeable(bookingId: string | undefined, ctx: ToolCallContext): BookingRow | ToolResult {
    const notFound = fail('NOT_FOUND', 'Booking not found', { field: 'bookingId', callerSafeMessage: UNKNOWN_BOOKING });
    if (!bookingId) return fail('VALIDATION_FAILED', 'bookingId is required', { field: 'bookingId' });
    const booking = this.state.bookings.find((row) => row.id === bookingId);
    if (ctx.actor.type === 'agent' && (!booking || this.verified.get(ctx.callId)?.get(bookingId) !== identityOf(booking))) {
      return notFound;
    }
    if (!booking || booking.status === 'held') return notFound;
    if (booking.status !== 'confirmed') {
      return fail('VALIDATION_FAILED', `Cannot change a ${booking.status} booking`, {
        field: 'bookingId',
        callerSafeMessage: "I can't change that appointment. I can take a message for the shop.",
      });
    }
    const leadMs = Date.parse(booking.start) - ctx.now.getTime();
    if (leadMs <= 0) {
      return fail('OUTSIDE_POLICY', 'The appointment has already started or passed', { callerSafeMessage: PAST_APPOINTMENT });
    }
    const hours = this.state.cancellationWindowHours ?? 24;
    if (hours > 0 && leadMs < hours * 3_600_000) {
      return fail('OUTSIDE_POLICY', `Inside the ${hours}-hour cancellation window`, { callerSafeMessage: cancellationPolicyText(hours) });
    }
    return booking;
  }

  /**
   * No held or confirmed booking of this staff member overlaps [start,
   * blockedUntil), buffers included on both sides like the engine:
   * start < otherBlockedUntil && otherStart < blockedUntil, or starts at the
   * same instant (a row whose services the fake can't size still blocks its
   * own start). check_availability, book.prepare and reschedule.prepare all
   * use it. The booking being rescheduled still occupies its own time until
   * the commit, like the real action.
   */
  private isFree(staffId: string, start: string, blockedUntilMs: number): boolean {
    const startMs = Date.parse(start);
    return !this.state.bookings.some((row) => {
      if (row.staffId !== staffId || (row.status !== 'held' && row.status !== 'confirmed')) return false;
      const rowStart = Date.parse(row.start);
      return rowStart === startMs || (startMs < this.blockedUntilFor(row.serviceIds, row.start) && rowStart < blockedUntilMs);
    });
  }

  private reschedulePrepare(input: Record<string, unknown>, ctx: ToolCallContext): ToolResult {
    const original = this.changeable(asString(input.bookingId), ctx);
    if ('ok' in original) return original;
    const newStart = asString(input.newStart);
    if (!newStart || Number.isNaN(Date.parse(newStart))) {
      return fail('VALIDATION_FAILED', 'newStart must be an ISO date-time with offset', { field: 'newStart' });
    }
    const staffPref = asString(input.staffId) ?? original.staffId;
    this.releaseCallHolds(ctx.callId);
    const tz = ctx.tenantTimezone;
    const fits = (slot: { staffId: string }) =>
      (staffPref === 'any' || slot.staffId === staffPref) && staffPerforms(this.state, slot.staffId, original.serviceIds);
    const free = (candidate: { staffId: string; start: string }) =>
      this.isFree(candidate.staffId, candidate.start, this.blockedUntilFor(original.serviceIds, candidate.start));
    const slot = this.state.slots.find((candidate) => fits(candidate) && Date.parse(candidate.start) === Date.parse(newStart));
    if (!slot || !free(slot)) {
      const day = localDate(newStart, tz);
      const alternatives = this.state.slots
        .filter((candidate) => fits(candidate) && localDate(candidate.start, tz) === day && free(candidate))
        .slice(0, 3)
        .map((candidate) => ({ start: candidate.start, staffId: candidate.staffId, spoken: spokenSlot(candidate.start, tz) }));
      return fail('CONFLICT', 'that time is not available', { alternatives, callerSafeMessage: SLOT_UNAVAILABLE });
    }
    const staff = this.state.staff.find((member) => member.id === slot.staffId);
    const services = this.serviceNamesOf(original.serviceIds).join(' and ');
    const readback =
      `Moving ${original.customerName}'s ${services} from ${spokenSlot(original.start, tz)} with ${original.staffName} ` +
      `to ${spokenSlot(slot.start, tz)} with ${staff?.displayName ?? slot.staffId}.`;
    const token = nextToken();
    const hold: BookingRow = {
      id: `hold_${token}`,
      status: 'held',
      staffId: slot.staffId,
      staffName: staff?.displayName ?? slot.staffId,
      serviceIds: [...original.serviceIds],
      start: slot.start,
      startLocal: formatLocalHm(slot.start, tz),
      customerName: original.customerName,
      customerPhone: original.customerPhone,
      callId: ctx.callId,
    };
    this.state.bookings.push(hold);
    this.state.holds[token] = {
      kind: 'reschedule',
      payload: { bookingId: hold.id, originalId: original.id, ...agentIdKey(original, ctx) },
      readback,
      callId: ctx.callId,
    };
    return ok(
      {
        confirmationToken: token,
        holdId: hold.id,
        expiresAt: new Date(ctx.now.getTime() + 5 * 60 * 1000).toISOString(),
        readback,
        staffId: hold.staffId,
        staffName: hold.staffName,
        start: slot.start,
        end: this.endOf(hold),
      },
      readback,
    );
  }

  private cancelPrepare(input: Record<string, unknown>, ctx: ToolCallContext): ToolResult {
    const booking = this.changeable(asString(input.bookingId), ctx);
    if ('ok' in booking) return booking;
    const services = this.serviceNamesOf(booking.serviceIds).join(' and ');
    const readback = `Cancelling ${booking.customerName}'s ${services} with ${booking.staffName}, ${spokenSlot(booking.start, ctx.tenantTimezone)}.`;
    const token = nextToken();
    this.state.holds[token] = {
      kind: 'cancel',
      payload: { bookingId: booking.id, reason: asString(input.reason) ?? '', ...agentIdKey(booking, ctx) },
      readback,
      callId: ctx.callId,
    };
    return ok({ confirmationToken: token, expiresAt: new Date(ctx.now.getTime() + 5 * 60 * 1000).toISOString(), readback }, readback);
  }

  /**
   * tickets.message@1 for the agent's messages and callbacks, like the real
   * tickets.open.prepare: a missing subject is asked once, then exits; the
   * callback number is held from caller ID, and without one it is asked once
   * and the message is then prepared anyway, filed with no number. A filled
   * slot's count is cleared; a declined callback number stays counted.
   */
  private messageContract(
    input: Record<string, unknown>,
    ctx: ToolCallContext,
  ): { subject: string; phone: string } | ToolResult {
    const subject = asString(input.subject)?.trim() ?? '';
    const given = asString(((input.customer ?? {}) as Record<string, unknown>).phone)?.trim() ?? '';
    const held = this.state.callerNumber ? toE164(this.state.callerNumber) : null;
    const key = (slot: string) => `${ctx.callId}\0tickets.message\0${slot}`;
    if (!subject) {
      const exit = this.countAsk(ctx.callId, 'tickets.message', 'subject') > MAX_ASKS_PER_SLOT;
      return fail('SLOT_MISSING', exit ? 'Still missing subject after one ask this call; do not ask again' : 'Missing subject', {
        field: 'subject',
        askId: MESSAGE_ASKS.subject.askId,
        callerSafeMessage: exit ? MESSAGE_EXIT : MESSAGE_ASKS.subject.ask,
        ...(exit ? { exit: 'message_ticket' as const } : {}),
      });
    }
    this.asks.delete(key('subject'));
    const phone = given || held || '';
    if (phone) {
      this.asks.delete(key('callbackNumber'));
    } else if (this.countAsk(ctx.callId, 'tickets.message', 'callbackNumber') <= MAX_ASKS_PER_SLOT) {
      return fail('SLOT_MISSING', 'Missing callbackNumber', {
        field: 'callbackNumber',
        askId: MESSAGE_ASKS.callbackNumber.askId,
        callerSafeMessage: MESSAGE_ASKS.callbackNumber.ask,
      });
    }
    return { subject, phone };
  }

  private ticketPrepare(input: Record<string, unknown>, ctx: ToolCallContext): ToolResult {
    const kind = asString(input.kind) ?? 'message';
    const customer = (input.customer ?? {}) as Record<string, unknown>;
    let subject = asString(input.subject) ?? 'Message';
    let phone = asString(customer.phone) ?? '';
    if (ctx.actor.type === 'agent' && MESSAGE_KINDS.has(kind)) {
      const filled = this.messageContract(input, ctx);
      if ('ok' in filled) return filled;
      ({ subject, phone } = filled);
    }
    const name = asString(customer.name) ?? 'the caller';
    const readback = `I'll pass this to ${this.state.transferTarget}: you'd like a ${kind} about ${subject}, for ${name}, ${phone ? `at ${phone}` : 'with no callback number'}`;
    const token = nextToken();
    const ticket = {
      id: `tkt_${token}`,
      status: 'held' as const,
      kind,
      subject,
      callId: ctx.callId,
      phone,
    };
    this.state.tickets.push(ticket);
    this.state.holds[token] = { kind: 'ticket', payload: { ticketId: ticket.id }, readback };
    return ok({ confirmationToken: token, ticketId: ticket.id, readback }, readback);
  }

  /**
   * tickets.file_floor (platform/actions/tickets/floor.ts), system actor only:
   * never_heard → nothing_substantive → already_filed → filed. Files one
   * message ticket with the caller-ID number (call_sessions), or none.
   */
  private fileFloor(input: Record<string, unknown>, ctx: ToolCallContext): ToolResult {
    if (ctx.actor.type !== 'system') return fail('FORBIDDEN', 'Only the runtime can file the floor ticket');
    const callId = asString(input.callId);
    if (!callId || callId !== ctx.callId) {
      return fail('VALIDATION_FAILED', 'callId does not match the call in context', { field: 'callId' });
    }
    const lines = asStringArray(input.callerLines).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return ok({ filed: false, reason: 'never_heard' });
    if (!saidMoreThanTheirOwnName(lines, asString(input.callerName))) return ok({ filed: false, reason: 'nothing_substantive' });
    if (this.hasCallArtifact(callId)) return ok({ filed: false, reason: 'already_filed' });
    const ticket = {
      id: `tkt_floor_${callId}`,
      status: 'open' as const,
      kind: 'message',
      subject: FLOOR_SUBJECT,
      callId,
      phone: (this.state.callerNumber && toE164(this.state.callerNumber)) || '',
      floor: true,
    };
    this.state.tickets.push(ticket);
    return ok({ filed: true, reason: 'filed', ticketId: ticket.id });
  }

  /** Like TicketsRepo.hasCallArtifact: a ticket filed on the call, or a booking it made that isn't a hold. */
  private hasCallArtifact(callId: string): boolean {
    return (
      this.state.tickets.some((row) => row.callId === callId && row.status === 'open') ||
      this.state.bookings.some(
        (row) => row.callId === callId && row.status !== 'held' && !isReleasedHold(row),
      )
    );
  }

  private transferPrepare(input: Record<string, unknown>): ToolResult {
    const target = asString(input.target) ?? this.state.transferTarget;
    const readback = `I'll connect you to ${target} now`;
    const token = nextToken();
    this.state.transfers.push({ to: target, status: 'held' });
    this.state.holds[token] = { kind: 'transfer', payload: { to: target }, readback };
    return ok({ confirmationToken: token, target, readback }, readback);
  }

  /**
   * A retry with an already-committed token replays the stored result
   * (runAction idempotency). runAction hashes the callId into the request, so
   * the same token from another call is IDEMPOTENCY_KEY_REUSED, not a replay.
   */
  private commit(kind: CommitKind, input: Record<string, unknown>, ctx: ToolCallContext): ToolResult {
    const token = asString(input.confirmationToken);
    if (!token) return fail('VALIDATION_FAILED', 'confirmationToken is required', { field: 'confirmationToken' });
    const replay = this.commits.get(`${kind}\0${token}`);
    if (replay) {
      if (replay.callId !== ctx.callId) {
        return fail('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different payload');
      }
      return structuredClone(replay.result);
    }
    const result = this.commitOnce(kind, token, ctx);
    if (result.ok) this.commits.set(`${kind}\0${token}`, { callId: ctx.callId, result: structuredClone(result) });
    return result;
  }

  private commitOnce(kind: CommitKind, token: string, ctx: ToolCallContext): ToolResult {
    const hold = this.state.holds[token];
    if (!hold || hold.kind !== kind) return fail('CONFIRMATION_INVALID', 'confirmation token is invalid or expired');
    // Tokens are bound to the call that prepared them (core consumeProposal).
    if (hold.callId !== undefined && hold.callId !== ctx.callId) {
      return fail('CONFIRMATION_INVALID', 'Confirmation token belongs to a different call');
    }
    delete this.state.holds[token];
    if (kind === 'reschedule') {
      const moved = this.state.bookings.find((row) => row.id === hold.payload.bookingId);
      const original = this.state.bookings.find((row) => row.id === hold.payload.originalId);
      if (!moved || moved.status !== 'held') return fail('CONFIRMATION_INVALID', 'hold was lost');
      if (!original || original.status !== 'confirmed' || agentIdentityChanged(original, hold.payload, ctx)) {
        return fail('CONFLICT', 'The original booking changed since the prepare');
      }
      moved.status = 'confirmed';
      original.status = 'rescheduled';
      const readback = `Done: ${moved.customerName}'s ${this.serviceNamesOf(moved.serviceIds).join(' and ')} is now ${spokenSlot(moved.start, ctx.tenantTimezone)} with ${moved.staffName}.`;
      return ok({ bookingId: moved.id, previousBookingId: original.id, status: 'confirmed', readback });
    }
    if (kind === 'cancel') {
      const booking = this.state.bookings.find((row) => row.id === hold.payload.bookingId);
      if (!booking || booking.status !== 'confirmed' || agentIdentityChanged(booking, hold.payload, ctx)) {
        return fail('CONFLICT', 'The booking changed since the prepare');
      }
      booking.status = 'cancelled';
      booking.cancellationReason = String(hold.payload.reason ?? '');
      return ok({ bookingId: booking.id, status: 'cancelled', readback: hold.readback.replace(/^Cancelling /, 'Cancelled: ') });
    }
    if (kind === 'booking') {
      const booking = this.state.bookings.find((row) => row.id === hold.payload.bookingId);
      if (!booking) return fail('CONFIRMATION_INVALID', 'hold was lost');
      booking.status = 'confirmed';
      return ok({
        bookingId: booking.id,
        status: 'confirmed',
        readback: hold.readback,
        confirmationChannel: 'sms',
      });
    }
    if (kind === 'ticket') {
      const ticket = this.state.tickets.find((row) => row.id === hold.payload.ticketId);
      if (!ticket) return fail('CONFIRMATION_INVALID', 'hold was lost');
      ticket.status = 'open';
      return ok({ ticketId: ticket.id, ticketNumber: ticket.id, status: 'open' });
    }
    const transfer = this.state.transfers.find((row) => row.to === hold.payload.to && row.status === 'held');
    if (!transfer) return fail('CONFIRMATION_INVALID', 'hold was lost');
    transfer.status = 'committed';
    return ok({ transferred: true, who: transfer.to });
  }
}
