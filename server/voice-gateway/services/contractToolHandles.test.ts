/**
 * RT-14 prereq item 2: the model never receives an internal database id from
 * a contract tool. Booking, staff and service ids go out as call-scoped
 * handles and come back in as the real ids; hold, ticket and replaced-booking
 * ids are dropped; the confirmation token stays.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compose } from '../../../platform/agent-runtime/composer';
import { BARBERSHOP_TEMPLATE_V1 } from '../../../platform/agent-templates/barbershop';
import { actionFail, actionOk, createMemoryStore, runAction, type ActionContext } from '../../../platform/actions';
import { ContractToolBridge, type ContractActionRunner } from './contractToolBridge';
import { CallHandles, containsUuid } from './contractToolHandles';

const BINDING = compose(BARBERSHOP_TEMPLATE_V1, undefined, { businessName: 'Sharp Line Barbers' }, { language: 'en' }).contractTools;

/** The external tool name the model calls for an action. */
function toolFor(action: string): string {
  const name = Object.keys(BINDING.actions).find((tool) => BINDING.actions[tool] === action);
  if (!name) throw new Error(`no tool for ${action}`);
  return name;
}

function bridge(runner: ContractActionRunner) {
  return new ContractToolBridge({
    tenantId: 't-shop',
    callId: `cs-${randomUUID()}`,
    agentId: 'ag-shop',
    binding: BINDING,
    timeZone: 'America/New_York',
    language: 'en',
    callerNumber: '+15555550142',
    runAction: runner,
    smsEnabled: () => false,
    checkRateLimit: () => true,
  });
}

/** Keys the model must never see. */
const INTERNAL_KEYS = ['holdId', 'replacedHoldIds', 'ticketId', 'previousBookingId', 'ticketNumber'];

/** No uuid (other than the confirmation tokens it needs) and no internal-id key in what the model got. */
function expectNoInternalIds(json: string, realIds: readonly string[]): void {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const tokens: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        expect(INTERNAL_KEYS).not.toContain(k);
        if (k === 'confirmationToken' && typeof v === 'string') tokens.push(v);
        else walk(v);
      }
    }
  };
  walk(parsed);
  const withoutTokens = tokens.reduce((text, token) => text.split(token).join(''), json);
  expect(containsUuid(withoutTokens)).toBe(false);
  for (const id of realIds) expect(json).not.toContain(id);
}

/** A fake scheduling + tickets backend that returns the real actions' output shapes with uuid ids. */
function fakeBackend() {
  const ids = {
    booking: randomUUID(),
    moved: randomUUID(),
    staff: randomUUID(),
    service: randomUUID(),
    hold: randomUUID(),
    oldHold: randomUUID(),
    ticket: randomUUID(),
  };
  const calls: Array<{ name: string; ctx: ActionContext; input: Record<string, unknown> }> = [];
  const slot = { staffId: ids.staff, staffName: 'Marco', start: '2026-10-23T19:30:00.000Z', end: '2026-10-23T20:00:00.000Z' };
  const runner: ContractActionRunner = async (name, ctx, rawInput) => {
    const input = rawInput as Record<string, unknown>;
    calls.push({ name, ctx, input });
    switch (name) {
      case 'scheduling.list_services':
        return actionOk([{ id: ids.service, name: 'Cut', durationMin: 30, priceText: 'thirty dollars', staffIds: [ids.staff] }]);
      case 'scheduling.list_staff':
        return actionOk([{ id: ids.staff, displayName: 'Marco', serviceIds: [ids.service] }]);
      case 'scheduling.check_availability':
        if (input.staffId !== 'any' && input.staffId !== ids.staff) return actionFail('NOT_FOUND', `Unknown staff member: ${String(input.staffId)}`, { field: 'staffId' });
        return actionOk({ slots: [{ ...slot, spoken: 'Friday at 3:30 PM' }], services: [{ id: ids.service, name: 'Cut' }], staffId: input.staffId });
      case 'scheduling.book.prepare':
      case 'scheduling.reschedule.prepare':
        return actionOk({ confirmationToken: randomUUID(), holdId: ids.hold, expiresAt: '2026-10-20T14:05:00.000Z', readback: 'A cut with Marco, Friday at 3:30 PM. Shall I?', priceText: 'thirty dollars', ...slot, replacedHoldIds: [ids.oldHold] });
      case 'scheduling.book.commit':
        return actionOk({ bookingId: ids.booking, status: 'confirmed', readback: 'Confirmed: cut with Marco, Friday at 3:30 PM.', confirmationChannel: 'none', ...slot }, { readback: 'Confirmed: cut with Marco, Friday at 3:30 PM.' });
      case 'scheduling.reschedule.commit':
        return actionOk({ bookingId: ids.moved, previousBookingId: ids.booking, status: 'confirmed', readback: 'Moved to Friday at 3:30 PM.', ...slot }, { readback: 'Moved to Friday at 3:30 PM.' });
      case 'scheduling.find_bookings':
        return actionOk({ verified: true, bookings: [{ bookingId: ids.booking, customerName: 'Luis', serviceNames: ['Cut'], ...slot, spoken: 'a cut with Marco on Friday at 3:30 PM' }] });
      case 'scheduling.cancel.prepare':
        if (input.bookingId !== ids.booking) return actionFail('NOT_FOUND', 'Booking not found', { field: 'bookingId' });
        return actionOk({ confirmationToken: randomUUID(), expiresAt: '2026-10-20T14:05:00.000Z', readback: 'Cancel the cut on Friday at 3:30 PM?' });
      case 'scheduling.cancel.commit':
        return actionOk({ bookingId: ids.booking, status: 'cancelled', readback: 'Cancelled: Friday at 3:30 PM.' }, { readback: 'Cancelled: Friday at 3:30 PM.' });
      case 'tickets.open.prepare':
        return actionOk({ confirmationToken: randomUUID(), expiresAt: '2026-10-20T14:05:00.000Z', readback: "I'll pass this along.", payloadHash: 'a'.repeat(64) });
      case 'tickets.open.commit':
        return actionOk({ ticketId: ids.ticket, ticketNumber: 1042, dueAt: null, deduped: false });
      default:
        return actionFail('NOT_FOUND', `no fake for ${name}`);
    }
  };
  return { ids, calls, runner, all: Object.values(ids) };
}

describe('CallHandles', () => {
  it('swaps ids for stable handles by kind and back again', () => {
    const h = new CallHandles();
    const booking = randomUUID();
    const out = h.toModel({ data: { bookingId: booking, again: booking, staffId: 'any' } }, 'scheduling.find_bookings') as { data: Record<string, string> };
    expect(out.data).toEqual({ bookingId: 'booking-1', again: 'booking-1', staffId: 'any' });
    expect(h.fromModel({ bookingId: 'booking-1', nested: { list: ['booking-1', 'booking-2'] } })).toEqual({ bookingId: booking, nested: { list: [booking, 'booking-2'] } });
  });

  it('keeps the confirmation token and payload hash verbatim', () => {
    const token = randomUUID();
    const out = new CallHandles().toModel({ data: { confirmationToken: token, payloadHash: 'f'.repeat(64) } }, 'tickets.open.prepare');
    expect(out).toEqual({ data: { confirmationToken: token, payloadHash: 'f'.repeat(64) } });
  });

  it('drops ticketNumber unless the contract lets it be said back, then keeps it as is', () => {
    const value = { ok: true, data: { ticketId: randomUUID(), ticketNumber: 1042 } };
    expect(new CallHandles().toModel(value, 'tickets.open.commit')).toEqual({ ok: true, data: {} });
    expect(new CallHandles().toModel(value, 'tickets.open.commit', new Set(['ticketNumber']))).toEqual({ ok: true, data: { ticketNumber: 1042 } });
  });

  it("list_staff: the id becomes a handle, the member's working days and hours (and spoken hours) reach the model as is", () => {
    const week = {
      workingDays: ['tue', 'thu', 'fri', 'sat'],
      hours: { tue: '10:00-18:00', thu: '10:00-18:00', fri: '10:00-18:00', sat: '09:00-12:00, 13:00-16:00' },
      spokenHours: { tue: '10 AM to 6 PM', thu: '10 AM to 6 PM', fri: '10 AM to 6 PM', sat: '9 AM to noon and 1 PM to 4 PM' },
    };
    const value = { ok: true, data: [{ id: randomUUID(), displayName: 'Dee', serviceIds: [randomUUID()], ...week }] };
    expect(new CallHandles().toModel(value, 'scheduling.list_staff')).toEqual({
      ok: true,
      data: [{ id: 'staff-1', displayName: 'Dee', serviceIds: ['service-1'], ...week }],
    });
  });

  it('turns a uuid anywhere else, even inside a message, into a ref handle', () => {
    const id = randomUUID();
    const out = new CallHandles().toModel({ error: { message: `Unknown thing ${id}`, other: id } }, 'x') as { error: Record<string, string> };
    expect(out.error).toEqual({ message: 'Unknown thing ref-1', other: 'ref-1' });
  });
});

describe('contract tool bridge: no internal ids reach the model', () => {
  it('book: list_services → check_availability → prepare → commit', async () => {
    const be = fakeBackend();
    const b = bridge(be.runner);
    const services = await b.runTool(toolFor('scheduling.list_services'), {});
    expectNoInternalIds(services, be.all);
    const service = (JSON.parse(services).data[0] as { id: string }).id;
    expect(service).toBe('service-1');

    const open = await b.runTool(toolFor('scheduling.check_availability'), { serviceIds: [service], staffId: 'any' });
    expectNoInternalIds(open, be.all);
    const staff = JSON.parse(open).data.slots[0].staffId as string;
    expect(staff).toBe('staff-1');
    // The handles go back to the real ids.
    expect(be.calls.at(-1)!.input).toEqual({ serviceIds: [be.ids.service], staffId: 'any' });

    const prep = await b.runTool(toolFor('scheduling.book.prepare'), { serviceIds: [service], staffId: staff, start: '2026-10-23T19:30:00.000Z', customer: { name: 'Luis' } });
    expectNoInternalIds(prep, be.all);
    expect(be.calls.at(-1)!.input).toMatchObject({ serviceIds: [be.ids.service], staffId: be.ids.staff });
    const token = JSON.parse(prep).data.confirmationToken as string;

    const done = await b.runTool(toolFor('scheduling.book.commit'), { confirmationToken: token });
    expectNoInternalIds(done, be.all);
    expect(JSON.parse(done).data).toMatchObject({ bookingId: 'booking-1', staffName: 'Marco', readback: 'Confirmed: cut with Marco, Friday at 3:30 PM.' });
    expect(be.calls.at(-1)!.input).toEqual({ confirmationToken: token });
  });

  it('find_bookings → reschedule with the handle reaches the action with the real id', async () => {
    const be = fakeBackend();
    const b = bridge(be.runner);
    const found = await b.runTool(toolFor('scheduling.find_bookings'), { phone: '+15555550142', name: 'Luis' });
    expectNoInternalIds(found, be.all);
    const handle = JSON.parse(found).data.bookings[0].bookingId as string;
    expect(handle).toBe('booking-1');

    const prep = await b.runTool(toolFor('scheduling.reschedule.prepare'), { bookingId: handle, newStart: '2026-10-23T19:30:00.000Z' });
    expectNoInternalIds(prep, be.all);
    expect(be.calls.at(-1)!.input).toEqual({ bookingId: be.ids.booking, newStart: '2026-10-23T19:30:00.000Z' });

    const done = await b.runTool(toolFor('scheduling.reschedule.commit'), { confirmationToken: JSON.parse(prep).data.confirmationToken });
    expectNoInternalIds(done, be.all);
    expect(JSON.parse(done).data).toEqual({ bookingId: 'booking-2', staffId: 'staff-1', readback: 'Moved to Friday at 3:30 PM.' });
  });

  it('find_bookings → cancel with the handle reaches the action with the real id', async () => {
    const be = fakeBackend();
    const b = bridge(be.runner);
    const found = await b.runTool(toolFor('scheduling.find_bookings'), { phone: '+15555550142', name: 'Luis' });
    const handle = JSON.parse(found).data.bookings[0].bookingId as string;

    const prep = await b.runTool(toolFor('scheduling.cancel.prepare'), { bookingId: handle });
    expectNoInternalIds(prep, be.all);
    expect(be.calls.at(-1)).toMatchObject({ name: 'scheduling.cancel.prepare', input: { bookingId: be.ids.booking } });
    expect(JSON.parse(prep).ok).toBe(true);

    const done = await b.runTool(toolFor('scheduling.cancel.commit'), { confirmationToken: JSON.parse(prep).data.confirmationToken });
    expectNoInternalIds(done, be.all);
    expect(JSON.parse(done).data).toEqual({ bookingId: 'booking-1', readback: 'Cancelled: Friday at 3:30 PM.' });
  });

  it('an error message naming an internal id reaches the model with the handle, not the id', async () => {
    const be = fakeBackend();
    const b = bridge(async (name, ctx, input) =>
      name === 'scheduling.check_availability' ? actionFail('NOT_FOUND', `Unknown staff member: ${be.ids.staff}`) : be.runner(name, ctx, input));
    const out = await b.runTool(toolFor('scheduling.check_availability'), { serviceIds: ['svc'], staffId: 'staff-7' });
    expectNoInternalIds(out, be.all);
  });

  it('tickets: prepare keeps its token and hash; commit shows no ticket id or number (tickets.message@1 never says it back)', async () => {
    const be = fakeBackend();
    const b = bridge(be.runner);
    const prep = await b.runTool(toolFor('tickets.open.prepare'), { kind: 'message', subject: 'Call me back' });
    expectNoInternalIds(prep, be.all);
    expect(JSON.parse(prep).data.payloadHash).toBe('a'.repeat(64));
    const done = await b.runTool(toolFor('tickets.open.commit'), { confirmationToken: JSON.parse(prep).data.confirmationToken, payloadHash: 'a'.repeat(64) });
    expectNoInternalIds(done, be.all);
    expect(JSON.parse(done)).toEqual({ ok: true, data: {} });
  });

  describe('Codex 4307380016: an ok commit returns only its sayBack fields plus what a later call needs', () => {
    /** A commit that returns every field the real actions can, plus effects and a speakable-looking ticket number. */
    const LOUD = (be: ReturnType<typeof fakeBackend>): ContractActionRunner => async (name, ctx, input) => {
      const real = await be.runner(name, ctx, input);
      if (!name.endsWith('.commit') || !real.ok) return real;
      return {
        ...real,
        data: { ...(real.data as Record<string, unknown>), previousBookingId: be.ids.booking, ticketId: be.ids.ticket, ticketNumber: 1042, status: 'confirmed', internalNote: 'x' },
        effects: [{ type: 'sms', bookingId: be.ids.booking }],
      } as never;
    };

    it.each([
      ['scheduling.book.commit', ['bookingId', 'readback', 'staffId', 'staffName']],
      ['scheduling.reschedule.commit', ['bookingId', 'readback', 'staffId']],
      ['scheduling.cancel.commit', ['bookingId', 'readback']],
      // tickets.message@1 says back only the prepare's readback: no ticket id or number, nothing else.
      ['tickets.open.commit', []],
    ])('%s: the model gets data keys %j and no effects', async (action, keys) => {
      const be = fakeBackend();
      const b = bridge(LOUD(be));
      const out = JSON.parse(await b.runTool(toolFor(action), { confirmationToken: randomUUID() }));
      expect(out.ok).toBe(true);
      expect(Object.keys(out.data).sort()).toEqual(keys);
      expect(out.effects).toBeUndefined();
      // bookingId is the call-scoped handle a later move or cancel takes back in.
      if (keys.includes('bookingId')) expect(out.data.bookingId).toMatch(/^booking-\d+$/);
      expectNoInternalIds(JSON.stringify(out), be.all);
    });
  });

  it('an unknown handle reaches the real action unchanged and gets its normal not-found', async () => {
    const store = createMemoryStore();
    const seen: unknown[] = [];
    const b = bridge((name, ctx, input) => {
      seen.push(input);
      return runAction(name, ctx, input, { store, withTenantTx: store.withTenantTx.bind(store) });
    });
    const out = JSON.parse(await b.runTool(toolFor('scheduling.cancel.prepare'), { bookingId: 'booking-9' }));
    expect(seen).toEqual([{ bookingId: 'booking-9' }]);
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('NOT_FOUND');
  });
});
