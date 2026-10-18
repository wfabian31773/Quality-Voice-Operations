// booking.find@1 / reschedule@1 / cancel@1 enforced at the action (RT-06):
// a phone match is only a candidate; the first name on the booking confirms
// it before anything about an existing booking is said or changed. Includes
// scenario S16 (shared household phone). Runs on the in-memory action store
// and a fake of the booking tables (no database).
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BOOKING_FIND_V1 } from '../../callcore/contracts';
import { createMemoryStore, runAction, type ActionContext, type ActionResult, type MemoryActionStore, type TenantTx } from '../index';
import { FIND_BOOKINGS, namesMatch } from './identity';
import { cancelledReadback, rescheduledReadback } from './readback';
import { SLOT_EXIT_MESSAGE } from './slotAsks';

const TENANT = 'tenant-rt06';
const MON_0800 = new Date('2026-10-19T12:00:00Z'); // Mon Oct 19 2026, 8:00 AM EDT
const PHONE = '+15555550142';
const OTHER_PHONE = '+15555550199';
const BOOKING_ID = '7c1e4b2a-93d5-4f60-8a21-5b9e0d3c6f48';
const THU_1000 = new Date('2026-10-22T14:00:00Z'); // Thu 10:00 AM EDT
const WED_1400 = '2026-10-21T14:00:00-04:00';

/** Ref-shaped tokens (2–4 letters + 3+ digits, or a 5+ digit run). */
const REF_SHAPED = /\b[A-Za-z]{2,4}-?\d{3,}\b|\d{5,}/;

type Row = Record<string, unknown>;

const STATIC: Record<string, Row[]> = {
  scheduling_appointment_types: [
    { id: 'cut', name: "Men's cut", duration_minutes: 30, buffer_minutes: 0, price_kind: 'from', price_cents: 4500, price_max_cents: null },
  ],
  scheduling_providers: [{ id: 'marco', name: 'Marco' }],
  scheduling_provider_services: [{ provider_id: 'marco', appointment_type_id: 'cut' }],
  scheduling_business_hours: [1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, open_time: '09:00:00', close_time: '17:00:00' })),
  scheduling_provider_schedules: [],
  scheduling_overrides: [],
  scheduling_booking_rules: [],
};

function danaBooking(): Row {
  return {
    id: BOOKING_ID,
    tenant_id: TENANT,
    status: 'confirmed',
    start_time: THU_1000,
    end_time: new Date(THU_1000.getTime() + 30 * 60_000),
    blocked_until: new Date(THU_1000.getTime() + 30 * 60_000),
    hold_expires_at: null,
    provider_id: 'marco',
    appointment_type_id: 'cut',
    title: "Men's cut",
    contact_name: 'Dana Smith',
    contact_phone: PHONE,
    contact_email: '',
    cancellation_reason: '',
    idempotency_key: null,
    intake_data: null,
    created_at: new Date('2026-10-10T12:00:00Z'),
  };
}

/** A fake of the tables the booking actions read and write, enough for find, prepare and commit. */
function fakeShop() {
  const store: MemoryActionStore = createMemoryStore();
  const bookings: Row[] = [danaBooking()];
  const callSessions: Row[] = [];
  const writes: string[] = [];
  const out = (rows: Row[], rowCount = rows.length) => ({ rows, rowCount });
  const withProvider = (b: Row) => ({ ...b, provider_name: STATIC.scheduling_providers.find((p) => p.id === b.provider_id)?.name ?? null });
  const byId = (tenantId: unknown, id: unknown) => bookings.find((b) => b.tenant_id === tenantId && b.id === id);

  const query = vi.fn(async (raw: string, values: unknown[] = []) => {
    const sql = raw.trim();
    if (/^(SAVEPOINT|RELEASE|ROLLBACK)\b/i.test(sql)) return out([]);
    if (/^(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes.push(sql.split(/\s+/).slice(0, 3).join(' '));
    if (/FROM call_sessions\b/.test(sql)) {
      return out(callSessions.filter((r) => r.tenant_id === values[0] && (r.id === values[1] || r.call_sid === values[1])));
    }
    if (/FROM action_proposals\b/.test(sql)) {
      const [tenantId, action, callId, nowIso, bookingId, idKey] = values as string[];
      const hit = [...store.proposals.values()].some((p) => {
        const verified = (p.payload as { bookings?: Array<{ id: string; idKey: string }> }).bookings ?? [];
        return p.tenantId === tenantId && p.action === action && p.callId === callId && p.expiresAt.getTime() > Date.parse(nowIso)
          && verified.some((b) => b.id === bookingId && b.idKey === idKey);
      });
      return out(hit ? [{ ok: 1 }] : []);
    }
    if (/^INSERT INTO bookings\b/.test(sql)) {
      const v = values as string[];
      const id = `hold-${bookings.length}`;
      bookings.push({
        id, tenant_id: v[0], title: v[1], start_time: new Date(v[2]), end_time: new Date(v[3]), blocked_until: new Date(v[4]),
        status: 'held', hold_expires_at: new Date(v[5]), provider_id: v[6], appointment_type_id: v[7], contact_name: v[8],
        contact_phone: v[9], contact_email: v[10], cancellation_reason: '', idempotency_key: null, intake_data: JSON.parse(v[15]),
        created_at: MON_0800,
      });
      return out([{ id }]);
    }
    if (/^INSERT INTO scheduling_audit_log\b/.test(sql)) return out([]);
    if (/^UPDATE bookings SET idempotency_key/.test(sql)) {
      const b = byId(values[0], values[1]);
      if (b) b.idempotency_key = values[2];
      return out([], b ? 1 : 0);
    }
    if (/^UPDATE bookings\b/.test(sql) && /AND id = \$2 AND status IN \('held', 'cancelled'\)/.test(sql)) {
      const b = byId(values[0], values[1]);
      if (!b || !['held', 'cancelled'].includes(String(b.status))) return out([], 0);
      Object.assign(b, { status: values[2], hold_expires_at: null, cancellation_reason: '' });
      return out([], 1);
    }
    if (/^UPDATE bookings\b/.test(sql) && /AND id = \$2 AND status = \$3/.test(sql)) {
      const b = byId(values[0], values[1]);
      if (!b || b.status !== values[2]) return out([], 0);
      Object.assign(b, { status: values[3], cancellation_reason: values[4] ?? b.cancellation_reason });
      return out([], 1);
    }
    // Releasing or expiring holds: none are left over in these calls.
    if (/^UPDATE bookings\b/.test(sql)) return out([]);
    if (/FROM bookings b\b/.test(sql)) {
      const rows = bookings.filter((b) => b.tenant_id === values[0]);
      if (/b\.id = \$2/.test(sql)) return out(rows.filter((b) => b.id === values[1]).map(withProvider));
      if (/b\.idempotency_key = \$2/.test(sql)) return out(rows.filter((b) => b.idempotency_key === values[1]).map(withProvider));
      if (/b\.contact_phone/.test(sql)) {
        const variants = values[2] as string[];
        return out(rows
          .filter((b) => b.status === 'confirmed' && (b.start_time as Date) > new Date(String(values[1])))
          .filter((b) => variants.includes(String(b.contact_phone).replace(/\D/g, '')))
          .map(withProvider));
      }
    }
    if (/FROM bookings n\b/.test(sql)) return out([]);
    if (/FROM bookings\b/.test(sql)) {
      const statuses = values[2] as string[];
      return out(bookings.filter((b) => b.tenant_id === values[0] && statuses.includes(String(b.status))));
    }
    const table = Object.keys(STATIC).find((t) => new RegExp(`FROM ${t}\\b`).test(sql));
    return out(table ? STATIC[table] : []);
  });

  const tx = { query } as TenantTx;
  const runtime = { store, withTenantTx: async <T>(_tenantId: string, fn: (t: TenantTx) => Promise<T>) => fn(tx) };

  /** A call whose trusted caller ID (call_sessions.caller_number) is `callerNumber`. */
  function call(callerNumber: string | null, extra: Partial<ActionContext> = {}): ActionContext {
    const id = `CA-${randomUUID()}`;
    callSessions.push({ id, tenant_id: TENANT, caller_number: callerNumber, caller_lookup_hash: null });
    return { tenantId: TENANT, actor: { type: 'agent', id: 'agent-1' }, now: MON_0800, tenantTimezone: 'America/New_York', callId: id, ...extra };
  }

  // Each tool call carries its own key, like a per-invocation adapter.
  const act = (name: string, ctx: ActionContext, input: unknown) => runAction(name, { ...ctx, idempotencyKey: randomUUID() }, input, runtime);
  const lookups = () => query.mock.calls.filter(([sql]) => /b\.contact_phone/.test(sql)).length;
  const verifications = () => [...store.proposals.values()].filter((p) => p.action === FIND_BOOKINGS);

  return { store, bookings, writes, call, act, lookups, verifications };
}

type Found = { verified: boolean; bookings: Array<{ bookingId: string; spoken: string }>; askId?: string; exit?: string; callerSafeMessage?: string };

function data<T>(result: ActionResult): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data as T;
}

function errorOf(result: ActionResult) {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.data)}`);
  return result.error;
}

const FIRST_ASK = {
  verified: false,
  bookings: [],
  needs: 'name',
  askId: 'ask.bookingName',
  callerSafeMessage: 'What name is the appointment under?',
};
const EXIT = { ...FIRST_ASK, callerSafeMessage: SLOT_EXIT_MESSAGE.en, exit: 'message_ticket' };

describe('S16: shared household phone, wrong first name', () => {
  it('a caller-ID match on Dana Smith\'s booking with "Maria" reads nothing aloud, records nothing, changes nothing, then exits', async () => {
    const shop = fakeShop();
    const before = structuredClone(shop.bookings);
    const c = shop.call(PHONE);

    const maria = await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Maria' });
    expect(maria).toEqual({ ok: true, data: FIRST_ASK });
    // No booking detail and no count anywhere in what the agent sees.
    const seen = JSON.stringify(maria);
    for (const leak of ['Dana', 'Smith', "Men's cut", 'Marco', BOOKING_ID, 'Thursday', '10 AM', '2026-10-22', 'matchCount']) {
      expect(seen).not.toContain(leak);
    }
    expect(seen).not.toMatch(/\d/);
    // Absence looks exactly like a refusal: a number with no bookings at all says the same.
    expect(await shop.act('scheduling.find_bookings', shop.call(OTHER_PHONE), { phone: OTHER_PHONE, name: 'Maria' })).toEqual(maria);
    // Nothing was verified.
    expect(shop.verifications()).toEqual([]);

    // Reschedule and cancel refuse the booking exactly like an unknown id.
    const unknown = errorOf(await shop.act('scheduling.cancel.prepare', c, { bookingId: 'nope' }));
    expect(unknown).toMatchObject({ code: 'NOT_FOUND', field: 'bookingId' });
    expect(errorOf(await shop.act('scheduling.reschedule.prepare', c, { bookingId: BOOKING_ID, newStart: WED_1400 }))).toEqual(unknown);
    expect(errorOf(await shop.act('scheduling.cancel.prepare', c, { bookingId: BOOKING_ID }))).toEqual(unknown);
    expect(shop.bookings).toEqual(before);
    expect(shop.writes).toEqual([]);

    // Second wrong name on the same call: the exit, and no more name matching on this call.
    const ana = await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Ana' });
    expect(ana).toEqual({ ok: true, data: EXIT });
    const lookupsAtExit = shop.lookups();
    expect(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Dana' })).toEqual({ ok: true, data: EXIT });
    expect(shop.lookups()).toBe(lookupsAtExit);
    expect(shop.verifications()).toEqual([]);
    expect(errorOf(await shop.act('scheduling.cancel.prepare', c, { bookingId: BOOKING_ID }))).toEqual(unknown);
    expect(shop.bookings).toEqual(before);
  });

  it('happy path: "Dana" confirms Dana Smith\'s booking; the spoken line has no ref; reschedule and cancel prepare work', async () => {
    const shop = fakeShop();
    const c = shop.call(PHONE);
    const found = data<Found>(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Dana' }));
    expect(found).toEqual({
      verified: true,
      bookings: [{
        bookingId: BOOKING_ID,
        customerName: 'Dana Smith',
        serviceNames: ["Men's cut"],
        staffId: 'marco',
        staffName: 'Marco',
        start: '2026-10-22T14:00:00.000Z',
        end: '2026-10-22T14:30:00.000Z',
        spoken: "Men's cut with Marco, Thursday at 10 AM, for Dana Smith.",
      }],
    });
    expect(found.bookings[0].spoken).not.toMatch(REF_SHAPED);
    expect(found.bookings[0].spoken).not.toContain(BOOKING_ID);
    expect(shop.verifications()).toHaveLength(1);

    const moved = data<{ readback: string; confirmationToken: string }>(
      await shop.act('scheduling.reschedule.prepare', c, { bookingId: BOOKING_ID, newStart: WED_1400 }),
    );
    expect(moved.readback).toBe("Moving Dana Smith's Men's cut from Thursday at 10 AM with Marco to Wednesday at 2 PM with Marco.");
    const cancel = data<{ readback: string }>(await shop.act('scheduling.cancel.prepare', c, { bookingId: BOOKING_ID }));
    expect(cancel.readback).toBe("Cancelling Dana Smith's Men's cut with Marco, Thursday at 10 AM.");
  });
});

describe('scheduling.find_bookings enforces booking.find@1 for the agent', () => {
  it('a missing name is the first ask; the right name on the retry still verifies', async () => {
    const shop = fakeShop();
    const c = shop.call(PHONE);
    expect(data(await shop.act('scheduling.find_bookings', c, { phone: PHONE }))).toEqual(FIRST_ASK);
    const found = data<Found>(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'dána' }));
    expect(found.verified).toBe(true);
    expect(found.bookings.map((b) => b.bookingId)).toEqual([BOOKING_ID]);
  });

  it('a missing name then a wrong name is the exit (one ask, then a message)', async () => {
    const shop = fakeShop();
    const c = shop.call(PHONE);
    expect(data(await shop.act('scheduling.find_bookings', c, { phone: PHONE }))).toEqual(FIRST_ASK);
    expect(data(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Maria' }))).toEqual(EXIT);
  });

  it('counts per call: another call on the same phone starts at the first ask', async () => {
    const shop = fakeShop();
    const c = shop.call(PHONE);
    await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Maria' });
    expect(data(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Ana' }))).toEqual(EXIT);
    const next = shop.call(PHONE);
    expect(data(await shop.act('scheduling.find_bookings', next, { phone: PHONE, name: 'Maria' }))).toEqual(FIRST_ASK);
    expect(data<Found>(await shop.act('scheduling.find_bookings', next, { phone: PHONE, name: 'Dana' })).verified).toBe(true);
  });

  it('the counter is server-side: nothing in the model arguments resets it', async () => {
    const shop = fakeShop();
    const c = shop.call(PHONE);
    await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Maria' });
    // Extra keys are stripped by the input schema; the count stays where the server put it.
    const smuggled = { phone: PHONE, name: 'Ana', asks: 0, attempt: 1, exit: null };
    expect(data(await shop.act('scheduling.find_bookings', c, smuggled))).toEqual(EXIT);
  });

  it('a caller ID that doesn\'t match asks name, date and time in contract order, then verifies all three', async () => {
    const shop = fakeShop();
    const c = shop.call(OTHER_PHONE);
    const ask = async (input: Record<string, unknown>) => data<Found & { needs?: string }>(await shop.act('scheduling.find_bookings', c, { phone: PHONE, ...input }));
    expect(await ask({})).toMatchObject({ verified: false, bookings: [], needs: 'name_date_time', askId: 'ask.bookingName' });
    expect(await ask({ name: 'Dana' })).toMatchObject({ askId: 'ask.bookingDate', callerSafeMessage: 'What day is the appointment?' });
    expect(await ask({ name: 'Dana', date: '2026-10-22' })).toMatchObject({ askId: 'ask.bookingTime', callerSafeMessage: 'What time is the appointment?' });
    const found = await ask({ name: 'Dana', date: '2026-10-22', time: '10:00' });
    expect(found.verified).toBe(true);
    expect(found.bookings.map((b) => b.bookingId)).toEqual([BOOKING_ID]);
  });

  it('a caller ID that doesn\'t match: a wrong date with the right name is a miss of the name check, and reveals nothing', async () => {
    const shop = fakeShop();
    const c = shop.call(null);
    const wrong = data(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Dana', date: '2026-10-23', time: '10:00' }));
    expect(wrong).toEqual({ ...FIRST_ASK, needs: 'name_date_time' });
    expect(data(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Dana', date: '2026-10-22', time: '10:30' })))
      .toEqual({ ...EXIT, needs: 'name_date_time' });
  });

  it('speaks the Spanish ask and exit when the call locale is Spanish', async () => {
    const shop = fakeShop();
    const c = shop.call(PHONE, { locale: 'es-MX' });
    expect(data<Found>(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'María' })).callerSafeMessage)
      .toBe(BOOKING_FIND_V1.slots[1].defaultAsk.es);
    expect(data<Found>(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Ana' })).callerSafeMessage).toBe(SLOT_EXIT_MESSAGE.es);
  });

  it('staff, UI and MCP still get the plain lookup, with no ask and no counting', async () => {
    const shop = fakeShop();
    const staff: ActionContext = { tenantId: TENANT, actor: { type: 'user', id: 'u1', role: 'staff' }, now: MON_0800, tenantTimezone: 'America/New_York', callId: 'CA-staff' };
    for (let i = 0; i < 3; i += 1) {
      const found = data<Found>(await shop.act('scheduling.find_bookings', staff, { phone: PHONE, name: 'Maria' }));
      expect(found).toEqual({ verified: true, bookings: [] });
    }
    expect(data<Found>(await shop.act('scheduling.find_bookings', staff, { phone: PHONE })).bookings.map((b) => b.bookingId)).toEqual([BOOKING_ID]);
  });
});

describe('first-name rule (namesMatch)', () => {
  it.each([
    ['Dana', 'Dana Smith', true],
    ['dána', 'Dana Smith', true],
    ['DANA', 'Dana Smith', true],
    ['Maria', 'Dana Smith', false],
    ['Smith', 'Dana Smith', false],
    // Both sides with several names: the full names must still match.
    ['Dana Jones', 'Dana Smith', false],
    ['Dana Smith', 'dana smith', true],
  ])('%j vs %j → %s', (given, onBooking, expected) => {
    expect(namesMatch(given, onBooking)).toBe(expected);
  });
});

describe('reschedule / cancel need a verified find in the same call, at prepare and at commit', () => {
  async function verified() {
    const shop = fakeShop();
    const c = shop.call(PHONE);
    expect(data<Found>(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Dana' })).verified).toBe(true);
    const unknown = errorOf(await shop.act('scheduling.cancel.prepare', c, { bookingId: 'nope' }));
    return { shop, c, unknown };
  }

  it('a verification from another call does not count at prepare', async () => {
    const { shop, unknown } = await verified();
    const other = shop.call(PHONE);
    expect(errorOf(await shop.act('scheduling.cancel.prepare', other, { bookingId: BOOKING_ID }))).toEqual(unknown);
    expect(errorOf(await shop.act('scheduling.reschedule.prepare', other, { bookingId: BOOKING_ID, newStart: WED_1400 }))).toEqual(unknown);
  });

  it('commit refuses like an unknown id once the verification is gone', async () => {
    const { shop, c, unknown } = await verified();
    const cancel = data<{ confirmationToken: string }>(await shop.act('scheduling.cancel.prepare', c, { bookingId: BOOKING_ID }));
    const move = data<{ confirmationToken: string }>(await shop.act('scheduling.reschedule.prepare', c, { bookingId: BOOKING_ID, newStart: WED_1400 }));
    for (const p of shop.verifications()) shop.store.proposals.delete(p.id);
    const before = structuredClone(shop.bookings.find((b) => b.id === BOOKING_ID));
    expect(errorOf(await shop.act('scheduling.cancel.commit', c, { confirmationToken: cancel.confirmationToken }))).toEqual(unknown);
    expect(errorOf(await shop.act('scheduling.reschedule.commit', c, { confirmationToken: move.confirmationToken }))).toEqual(unknown);
    expect(shop.bookings.find((b) => b.id === BOOKING_ID)).toEqual(before);
  });

  it('commit goes through while the verification holds', async () => {
    const { shop, c } = await verified();
    const p = data<{ confirmationToken: string }>(await shop.act('scheduling.cancel.prepare', c, { bookingId: BOOKING_ID }));
    expect(data(await shop.act('scheduling.cancel.commit', c, { confirmationToken: p.confirmationToken }))).toMatchObject({ status: 'cancelled' });
    expect(shop.bookings.find((b) => b.id === BOOKING_ID)).toMatchObject({ status: 'cancelled' });
  });
});

describe('refs are texted, never spoken', () => {
  it('no spoken / readback / ask line from find, reschedule or cancel carries an id or a ref-shaped token', async () => {
    const spoken: string[] = [];
    for (const locale of ['en-US', 'es-MX']) {
      const shop = fakeShop();
      const c = shop.call(PHONE, { locale });
      const ask = data<Found>(await shop.act('scheduling.find_bookings', c, { phone: PHONE }));
      const found = data<Found>(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Dana' }));
      spoken.push(ask.callerSafeMessage ?? '', ...found.bookings.map((b) => b.spoken));

      const move = data<{ readback: string; confirmationToken: string }>(
        await shop.act('scheduling.reschedule.prepare', c, { bookingId: BOOKING_ID, newStart: WED_1400 }),
      );
      const moved = data<{ readback: string }>(await shop.act('scheduling.reschedule.commit', c, { confirmationToken: move.confirmationToken }));
      spoken.push(move.readback, moved.readback);

      // The moved booking's replacement row is the one to cancel now; verify it like a caller would.
      const again = data<Found>(await shop.act('scheduling.find_bookings', c, { phone: PHONE, name: 'Dana' }));
      const cancel = data<{ readback: string; confirmationToken: string }>(
        await shop.act('scheduling.cancel.prepare', c, { bookingId: again.bookings[0].bookingId }),
      );
      const cancelled = data<{ readback: string }>(await shop.act('scheduling.cancel.commit', c, { confirmationToken: cancel.confirmationToken }));
      spoken.push(cancel.readback, cancelled.readback);
      for (const token of [move.confirmationToken, cancel.confirmationToken]) {
        for (const line of spoken) expect(line).not.toContain(token);
      }
    }
    for (const slot of BOOKING_FIND_V1.slots) spoken.push(slot.defaultAsk.en, slot.defaultAsk.es);
    spoken.push(SLOT_EXIT_MESSAGE.en, SLOT_EXIT_MESSAGE.es);
    const facts = { serviceNames: ["Men's cut"], customerName: 'Dana Smith', when: 'Thursday at 10 AM', staffName: 'Marco', toWhen: 'Wednesday at 2 PM', toStaff: 'Marco' };
    spoken.push(rescheduledReadback(facts, 'en'), cancelledReadback(facts, 'es'));

    expect(spoken.length).toBeGreaterThan(20);
    for (const line of spoken) {
      expect(line).toBeTruthy();
      expect(line).not.toMatch(REF_SHAPED);
      expect(line).not.toContain(BOOKING_ID);
      expect(line).not.toMatch(/hold-\d/);
    }
  });

  it('the ref pattern does catch refs', () => {
    for (const ref of ['BK4821', 'QVO-12345', 'ref 123456', 'AB123']) expect(ref).toMatch(REF_SHAPED);
  });
});
