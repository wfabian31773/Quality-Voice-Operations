import type { TenantState } from './seed';
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
  extra?: { field?: string; alternatives?: unknown[]; callerSafeMessage?: string },
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
const PAST_APPOINTMENT = "That appointment has already started or passed, so I can't change it. I can take a message for the shop.";

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

function staffPerforms(state: TenantState, staffId: string, serviceIds: string[]): boolean {
  if (serviceIds.length === 0) return true;
  const staff = state.staff.find((member) => member.id === staffId);
  return Boolean(staff && serviceIds.every((id) => staff.serviceIds.includes(id)));
}

function unknownServiceIds(state: TenantState, serviceIds: string[]): string[] {
  return serviceIds.filter((id) => !state.services.some((service) => service.id === id));
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
    const tool = name.split('.')[0] as ToolName;
    if (!this.enabled.includes(tool)) return fail('TOOL_NOT_ENABLED', `${tool} is not enabled for this template`);
    if (!HANDLED.has(name)) return fail('NOT_FOUND', `unknown action ${name}`);
    switch (name) {
      case 'scheduling.list_services':
        return ok(this.state.services);
      case 'scheduling.list_staff':
        return ok(this.state.staff.map((member) => ({ id: member.id, displayName: member.displayName, serviceIds: member.serviceIds })));
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
        return this.ticketPrepare(asRecord(input));
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

  private checkAvailability(input: Record<string, unknown>, ctx: ToolCallContext): ToolResult {
    const staffId = asString(input.staffId) ?? 'any';
    const serviceIds = asStringArray(input.serviceIds);
    const unknown = unknownServiceIds(this.state, serviceIds);
    if (unknown.length > 0) return fail('NOT_FOUND', `unknown service ${unknown.join(', ')}`, { field: 'serviceIds' });
    const date = asString(input.date) ?? localDate(ctx.now.toISOString(), ctx.tenantTimezone);
    const today = localDate(ctx.now.toISOString(), ctx.tenantTimezone);
    const slots = this.state.slots
      .filter((slot) => {
        if (localDate(slot.start, ctx.tenantTimezone) !== date) return false;
        if (staffId !== 'any' && slot.staffId !== staffId) return false;
        if (!staffPerforms(this.state, slot.staffId, serviceIds)) return false;
        const held = this.state.bookings.some(
          (row) => row.staffId === slot.staffId && row.start === slot.start && (row.status === 'held' || row.status === 'confirmed'),
        );
        return !held;
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
    const serviceIds = asStringArray(input.serviceIds);
    const start = asString(input.start);
    const staffPref = asString(input.staffId) ?? 'any';
    const customer = (input.customer ?? {}) as Record<string, unknown>;
    const name = asString(customer.name);
    const phone = asString(customer.phone);
    if (!start || !name || !phone || serviceIds.length === 0) {
      return fail('VALIDATION_FAILED', 'serviceIds, start, and customer name/phone are required', {
        field: !start ? 'start' : !name ? 'customer.name' : 'customer.phone',
      });
    }
    const unknown = unknownServiceIds(this.state, serviceIds);
    if (unknown.length > 0) return fail('NOT_FOUND', `unknown service ${unknown.join(', ')}`, { field: 'serviceIds' });
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
    const taken = this.state.bookings.some(
      (row) => row.staffId === slot.staffId && row.start === slot.start && (row.status === 'held' || row.status === 'confirmed'),
    );
    if (taken) {
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

  private endFor(serviceIds: string[], start: string): string {
    const minutes = serviceIds.reduce(
      (total, id) => total + (this.state.services.find((service) => service.id === id)?.durationMin ?? 0),
      0,
    );
    return new Date(Date.parse(start) + minutes * 60_000).toISOString();
  }

  private endOf(booking: BookingRow): string {
    return this.endFor(booking.serviceIds, booking.start);
  }

  /**
   * Like scheduling.find_bookings (spec §0.2.6). The trusted caller ID is
   * `state.callerNumber` (call_sessions in the real action), never input.
   * Caller-ID match: the name on the booking is enough. No match: name, date
   * and time must all match. Anything else returns the same empty refusal,
   * whether or not the number has bookings.
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
      return ok({ verified: true, bookings: present(rows) });
    };

    if (ctx.actor.type !== 'agent') return ok({ verified: true, bookings: present(matching()) });
    const callerId = this.state.callerNumber ? toE164(this.state.callerNumber) : null;
    if (callerId === phone) {
      if (!name) return ok({ verified: false, bookings: [], needs: 'name', matchCount: upcoming.length });
      const found = matching();
      return found.length > 0 ? verify(found) : ok({ verified: false, bookings: [], needs: 'name' });
    }
    if (!name || !date || !time) return ok({ verified: false, bookings: [], needs: 'name_date_time' });
    const found = matching();
    return found.length > 0 ? verify(found) : ok({ verified: false, bookings: [], needs: 'name_date_time' });
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
   * No held or confirmed booking of this staff member overlaps [start, end):
   * start < otherEnd && otherStart < end. The booking being rescheduled still
   * occupies its own time until the commit, like the real action.
   */
  private isFree(staffId: string, start: string, end: string): boolean {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    return !this.state.bookings.some(
      (row) =>
        row.staffId === staffId &&
        (row.status === 'held' || row.status === 'confirmed') &&
        startMs < Date.parse(this.endOf(row)) &&
        Date.parse(row.start) < endMs,
    );
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
      this.isFree(candidate.staffId, candidate.start, this.endFor(original.serviceIds, candidate.start));
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

  private ticketPrepare(input: Record<string, unknown>): ToolResult {
    const kind = asString(input.kind) ?? 'message';
    const subject = asString(input.subject) ?? 'Message';
    const customer = (input.customer ?? {}) as Record<string, unknown>;
    const name = asString(customer.name) ?? 'the caller';
    const phone = asString(customer.phone) ?? '';
    const readback = `I'll pass this to ${this.state.transferTarget}: you'd like a ${kind} about ${subject}, for ${name}, at ${phone || 'the number on caller ID'}`;
    const token = nextToken();
    const ticket = {
      id: `tkt_${token}`,
      status: 'held' as const,
      kind,
      subject,
    };
    this.state.tickets.push(ticket);
    this.state.holds[token] = { kind: 'ticket', payload: { ticketId: ticket.id }, readback };
    return ok({ confirmationToken: token, ticketId: ticket.id, readback }, readback);
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
