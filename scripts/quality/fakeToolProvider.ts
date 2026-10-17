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
  INTERNAL: 'Something went wrong on our side. Please try again.',
};

function fail(code: string, message: string, extra?: { field?: string; alternatives?: unknown[] }): ToolResult {
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
  'scheduling.book.prepare',
  'scheduling.book.commit',
  'tickets.open.prepare',
  'tickets.open.commit',
  'calls.transfer_to_human.prepare',
  'calls.transfer_to_human.commit',
  'business.get_info',
]);

/** cancellation_reason the real scheduling.book.prepare writes on a hold a newer prepare in the call replaced. */
export const HOLD_SUPERSEDED_REASON = 'hold_superseded';

export class FakeToolProvider implements ToolProvider {
  /** Successful commit results by token: a retry with the same token replays it (core idempotency). */
  private readonly commits = new Map<string, ToolResult>();

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
        return this.commit('booking', asRecord(input));
      case 'tickets.open.prepare':
        return this.ticketPrepare(asRecord(input));
      case 'tickets.open.commit':
        return this.commit('ticket', asRecord(input));
      case 'calls.transfer_to_human.prepare':
        return this.transferPrepare(asRecord(input));
      case 'calls.transfer_to_human.commit':
        return this.commit('transfer', asRecord(input));
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
      if (hold.kind !== 'booking' || hold.callId !== callId) continue;
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

  /** A retry with an already-committed token replays the stored result (runAction idempotency). */
  private commit(kind: 'booking' | 'ticket' | 'transfer', input: Record<string, unknown>): ToolResult {
    const token = asString(input.confirmationToken);
    if (!token) return fail('VALIDATION_FAILED', 'confirmationToken is required', { field: 'confirmationToken' });
    const replay = this.commits.get(`${kind}\0${token}`);
    if (replay) return structuredClone(replay);
    const result = this.commitOnce(kind, token);
    if (result.ok) this.commits.set(`${kind}\0${token}`, structuredClone(result));
    return result;
  }

  private commitOnce(kind: 'booking' | 'ticket' | 'transfer', token: string): ToolResult {
    const hold = this.state.holds[token];
    if (!hold || hold.kind !== kind) return fail('CONFIRMATION_INVALID', 'confirmation token is invalid or expired');
    delete this.state.holds[token];
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
