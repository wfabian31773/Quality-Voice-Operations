import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore, runAction, toAgentToolSchema, toHttpHandler, type ActionContext, type TenantTx } from '../index';
import { checkAvailabilityAction } from './checkAvailability';
import { priceText } from './listServices';

const TENANT = 'tenant-shop';
const MON_0800 = new Date('2026-10-19T12:00:00Z'); // Mon Oct 19 2026, 8:00 AM EDT

type Rows = Record<string, unknown>[];

function shopData(extra: Partial<Record<string, Rows>> = {}): Record<string, Rows> {
  return {
    scheduling_appointment_types: [
      { id: 'beard', name: 'Beard trim', duration_minutes: 15, buffer_minutes: 5, price_kind: 'fixed', price_cents: 2000, price_max_cents: null },
      { id: 'color', name: 'Color', duration_minutes: 90, buffer_minutes: 0, price_kind: 'hidden', price_cents: null, price_max_cents: null },
      { id: 'cut', name: "Men's cut", duration_minutes: 30, buffer_minutes: 0, price_kind: 'from', price_cents: 4500, price_max_cents: null },
    ],
    scheduling_providers: [
      { id: 'dana', name: 'Dana' },
      { id: 'marco', name: 'Marco' },
    ],
    scheduling_provider_services: [
      { provider_id: 'marco', appointment_type_id: 'cut' },
      { provider_id: 'marco', appointment_type_id: 'beard' },
      { provider_id: 'dana', appointment_type_id: 'cut' },
    ],
    scheduling_business_hours: [1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, open_time: '09:00:00', close_time: '17:00:00' })),
    scheduling_provider_schedules: [],
    scheduling_overrides: [],
    scheduling_booking_rules: [],
    bookings: [],
    ...extra,
  };
}

function setup(data: Record<string, Rows> = shopData()) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    const table = Object.keys(data).find((t) => new RegExp(`FROM ${t}\\b`).test(sql));
    const rows = table ? data[table] : [];
    return { rows, rowCount: rows.length };
  });
  const tx = { query } as TenantTx;
  const store = createMemoryStore();
  const tenants: string[] = [];
  const runtime = {
    store,
    withTenantTx: async <T>(tenantId: string, fn: (t: TenantTx) => Promise<T>) => {
      tenants.push(tenantId);
      return fn(tx);
    },
  };
  return { query, store, runtime, tenants };
}

function ctx(extra: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: TENANT,
    actor: { type: 'agent', id: 'agent-1' },
    now: MON_0800,
    tenantTimezone: 'America/New_York',
    callId: 'CA123',
    ...extra,
  };
}

async function run(name: string, input: unknown, env = setup(), extra: Partial<ActionContext> = {}) {
  const result = await runAction(name, ctx(extra), input, env.runtime);
  return { result, ...env };
}

function errorOf(result: Awaited<ReturnType<typeof runAction>>) {
  expect(result.ok).toBe(false);
  return result.ok ? null : result.error;
}

/** Table reads only; runAction's own SAVEPOINT statements are left out. */
function dataQueries(query: ReturnType<typeof setup>['query']) {
  return query.mock.calls.filter(([sql]) => !/^\s*(SAVEPOINT|RELEASE|ROLLBACK)\b/i.test(sql));
}

function readOnlyAndTenantScoped(query: ReturnType<typeof setup>['query']) {
  expect(dataQueries(query).length).toBeGreaterThan(0);
  for (const [sql, values] of dataQueries(query)) {
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(sql).toMatch(/WHERE tenant_id = \$1/);
    expect(values?.[0]).toBe(TENANT);
  }
}

describe('scheduling.list_services', () => {
  it('lists active services with spoken price text and who performs each', async () => {
    const { result, query, tenants, store } = await run('scheduling.list_services', {});
    expect(result).toEqual({
      ok: true,
      data: [
        { id: 'beard', name: 'Beard trim', durationMin: 15, priceText: '$20', staffIds: ['marco'] },
        { id: 'color', name: 'Color', durationMin: 90, priceText: null, staffIds: [] },
        { id: 'cut', name: "Men's cut", durationMin: 30, priceText: 'from $45', staffIds: ['marco', 'dana'] },
      ],
    });
    readOnlyAndTenantScoped(query);
    expect(tenants.every((t) => t === TENANT)).toBe(true);
    expect(store.audits.map((a) => [a.action, a.resultCode])).toEqual([['scheduling.list_services', 'ok']]);
  });

  it('filters by staff member, and treats any as no filter', async () => {
    const dana = await run('scheduling.list_services', { staffId: 'dana' });
    expect(dana.result.ok && dana.result.data).toEqual([
      { id: 'cut', name: "Men's cut", durationMin: 30, priceText: 'from $45', staffIds: ['marco', 'dana'] },
    ]);
    const any = await run('scheduling.list_services', { staffId: 'any' });
    expect(any.result.ok && (any.result.data as unknown[]).length).toBe(3);
  });

  it('returns NOT_FOUND for an unknown staff member', async () => {
    const { result } = await run('scheduling.list_services', { staffId: 'ghost' });
    expect(errorOf(result)).toMatchObject({ code: 'NOT_FOUND', field: 'staffId', callerSafeMessage: "I couldn't find that staff member." });
  });

  it('formats every price kind', () => {
    expect(priceText({ priceKind: 'fixed', priceCents: 4550, priceMaxCents: null })).toBe('$45.50');
    expect(priceText({ priceKind: 'range', priceCents: 4500, priceMaxCents: 6000 })).toBe('$45 to $60');
    expect(priceText({ priceKind: 'range', priceCents: 4500, priceMaxCents: null })).toBe('from $45');
    expect(priceText({ priceKind: 'hidden', priceCents: 4500, priceMaxCents: null })).toBeNull();
    expect(priceText({ priceKind: 'fixed', priceCents: null, priceMaxCents: null })).toBeNull();
  });
});

describe('scheduling.list_staff', () => {
  // No weekly schedule: they follow the shop's hours (Mon–Sat, 9 to 5).
  const MON_SAT = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const SHOP_WEEK = { workingDays: MON_SAT, hours: Object.fromEntries(MON_SAT.map((d) => [d, '09:00-17:00'])) };

  it('lists active staff with the services they perform and their usual week', async () => {
    const { result, query } = await run('scheduling.list_staff', {});
    expect(result).toEqual({
      ok: true,
      data: [
        { id: 'dana', displayName: 'Dana', serviceIds: ['cut'], ...SHOP_WEEK },
        { id: 'marco', displayName: 'Marco', serviceIds: ['beard', 'cut'], ...SHOP_WEEK },
      ],
    });
    readOnlyAndTenantScoped(query);
    expect(dataQueries(query).some(([sql]) => /FROM scheduling_provider_schedules\b/.test(sql))).toBe(true);
  });

  it('filters by service', async () => {
    const { result } = await run('scheduling.list_staff', { serviceId: 'beard' });
    expect(result.ok && result.data).toEqual([{ id: 'marco', displayName: 'Marco', serviceIds: ['beard', 'cut'], ...SHOP_WEEK }]);
  });

  it('returns a non-contiguous week (Tue, Thu, Fri, Sat) from the weekly schedule, inside shop hours', async () => {
    // Oct 18 Sharp Line call: the agent said "Tuesday through Saturday" for Dee.
    const data = shopData({
      scheduling_providers: [{ id: 'dana', name: 'Dana' }, { id: 'dee', name: 'Dee' }],
      scheduling_provider_services: [
        { provider_id: 'dana', appointment_type_id: 'cut' },
        { provider_id: 'dee', appointment_type_id: 'cut' },
      ],
      scheduling_provider_schedules: [
        ...[2, 4, 5].map((d) => ({ provider_id: 'dee', day_of_week: d, start_time: '10:00:00', end_time: '18:00:00' })),
        { provider_id: 'dee', day_of_week: 6, start_time: '09:00:00', end_time: '12:00:00' },
        { provider_id: 'dee', day_of_week: 6, start_time: '13:00:00', end_time: '16:00:00' },
        // A Sunday block: the shop is closed Sundays, so it is not a working day.
        { provider_id: 'dee', day_of_week: 0, start_time: '10:00:00', end_time: '14:00:00' },
      ],
    });
    const env = setup(data);
    const { result } = await run('scheduling.list_staff', { serviceId: 'cut' }, env);
    const dee = result.ok ? (result.data as { id: string }[]).find((m) => m.id === 'dee') : undefined;
    expect(dee).toEqual({
      id: 'dee',
      displayName: 'Dee',
      serviceIds: ['cut'],
      workingDays: ['tue', 'thu', 'fri', 'sat'],
      // Clipped to the shop's 5 PM close; a split Saturday keeps both blocks.
      hours: { tue: '10:00-17:00', thu: '10:00-17:00', fri: '10:00-17:00', sat: '09:00-12:00, 13:00-16:00' },
    });
    // check_availability reads the same rows: no Wednesday for Dee, Thursday open.
    const wed = await run('scheduling.check_availability', { serviceIds: ['cut'], staffId: 'dee', date: '2026-10-21' }, env);
    const thu = await run('scheduling.check_availability', { serviceIds: ['cut'], staffId: 'dee', date: '2026-10-22' }, env);
    expect(wed.result.ok && (wed.result.data as { slots: unknown[] }).slots).toEqual([]);
    expect(thu.result.ok && (thu.result.data as { slots: unknown[] }).slots.length).toBeGreaterThan(0);
  });

  it("reports the tenant's own weekdays and wall-clock hours, not UTC ones", async () => {
    // Los Angeles: Saturday 6–10 PM is Sunday 01:00–05:00 UTC; Friday 10 PM–2 AM runs past midnight.
    const data = shopData({
      scheduling_providers: [{ id: 'dee', name: 'Dee' }],
      scheduling_provider_services: [{ provider_id: 'dee', appointment_type_id: 'cut' }],
      scheduling_business_hours: [
        { day_of_week: 5, open_time: '20:00:00', close_time: '03:00:00' },
        { day_of_week: 6, open_time: '17:00:00', close_time: '23:00:00' },
      ],
      scheduling_provider_schedules: [
        { provider_id: 'dee', day_of_week: 5, start_time: '22:00:00', end_time: '02:00:00' },
        { provider_id: 'dee', day_of_week: 6, start_time: '18:00:00', end_time: '22:00:00' },
      ],
    });
    // Fri Oct 23, 8 PM in Los Angeles = Sat 03:00 UTC.
    const { result } = await run('scheduling.list_staff', {}, setup(data), {
      tenantTimezone: 'America/Los_Angeles',
      now: new Date('2026-10-24T03:00:00Z'),
    });
    expect(result.ok && result.data).toEqual([
      { id: 'dee', displayName: 'Dee', serviceIds: ['cut'], workingDays: ['fri', 'sat'], hours: { fri: '22:00-02:00', sat: '18:00-22:00' } },
    ]);
  });

  it('a member with a schedule but no shop hours configured works their own schedule', async () => {
    const data = shopData({
      scheduling_business_hours: [],
      scheduling_provider_schedules: [{ provider_id: 'marco', day_of_week: 3, start_time: '12:00', end_time: '20:00' }],
    });
    const { result } = await run('scheduling.list_staff', {}, setup(data));
    expect(result.ok && result.data).toEqual([
      // No schedule and no shop hours: no usual week to report.
      { id: 'dana', displayName: 'Dana', serviceIds: ['cut'], workingDays: [], hours: {} },
      { id: 'marco', displayName: 'Marco', serviceIds: ['beard', 'cut'], workingDays: ['wed'], hours: { wed: '12:00-20:00' } },
    ]);
  });

  it('returns NOT_FOUND for an unknown service', async () => {
    const { result } = await run('scheduling.list_staff', { serviceId: 'perm' });
    expect(errorOf(result)).toMatchObject({ code: 'NOT_FOUND', field: 'serviceId' });
  });
});

describe('scheduling.check_availability', () => {
  it('returns spread-out spoken slots for any staff member', async () => {
    const { result, query, store } = await run('scheduling.check_availability', { serviceIds: ['cut'], staffId: 'any', date: '2026-10-20' });
    expect(result).toEqual({
      ok: true,
      data: {
        slots: [
          { start: '2026-10-20T13:00:00.000Z', end: '2026-10-20T13:30:00.000Z', staffId: 'dana', staffName: 'Dana', spoken: 'tomorrow at 9 AM' },
          { start: '2026-10-20T16:45:00.000Z', end: '2026-10-20T17:15:00.000Z', staffId: 'dana', staffName: 'Dana', spoken: 'tomorrow at 12:45 PM' },
          { start: '2026-10-20T20:30:00.000Z', end: '2026-10-20T21:00:00.000Z', staffId: 'dana', staffName: 'Dana', spoken: 'tomorrow at 4:30 PM' },
        ],
      },
    });
    readOnlyAndTenantScoped(query);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({ action: 'scheduling.check_availability', resultCode: 'ok', callId: 'CA123' });
  });

  it('books multi-service with the one staff member who does both, honoring bookings and holds', async () => {
    const env = setup(shopData({
      bookings: [
        { provider_id: 'marco', start_time: new Date('2026-10-20T13:00:00Z'), blocked_until: new Date('2026-10-20T13:30:00Z'), status: 'held', hold_expires_at: new Date('2026-10-19T12:04:00Z') },
      ],
    }));
    const { result } = await run('scheduling.check_availability', { serviceIds: ['cut', 'beard'], date: '2026-10-20', limit: 1 }, env);
    expect(result.ok && result.data).toEqual({
      slots: [{ start: '2026-10-20T13:30:00.000Z', end: '2026-10-20T14:15:00.000Z', staffId: 'marco', staffName: 'Marco', spoken: 'tomorrow at 9:30 AM' }],
    });
  });

  it.each([
    ['a full ISO datetime with a zone', '2026-10-20T14:00:00Z'],
    ['a datetime late enough to be the next UTC day', '2026-10-21T02:00:00Z'],
    ['a datetime without a zone', '2026-10-20T10:00:00'],
    ['YYYY/MM/DD', '2026/10/20'],
    ['a weekday next to the date', 'Tuesday 2026-10-20'],
  ])('accepts %s as the tenant\'s date: the same slots as 2026-10-20', async (_label, date) => {
    const plain = await run('scheduling.check_availability', { serviceIds: ['cut'], staffId: 'any', date: '2026-10-20' });
    const variant = await run('scheduling.check_availability', { serviceIds: ['cut'], staffId: 'any', date });
    expect(variant.result.ok).toBe(true);
    expect(variant.result).toEqual(plain.result);
  });

  it('a window given in variants is checked on the tenant\'s dates', async () => {
    const { result } = await run('scheduling.check_availability', { serviceIds: ['cut'], window: { from: '2026/10/20', to: '2026-10-21T15:00:00-04:00' } });
    expect(result.ok).toBe(true);
    // A zoned end that lands before the start in the tenant timezone is refused after normalizing.
    const backwards = await run('scheduling.check_availability', { serviceIds: ['cut'], window: { from: '2026-10-21', to: '2026-10-21T02:00:00Z' } });
    expect(errorOf(backwards.result)).toMatchObject({ code: 'VALIDATION_FAILED', field: 'window.to', message: 'window.to is before window.from' });
  });

  it('reports a closed day with the next open date', async () => {
    const { result } = await run('scheduling.check_availability', { serviceIds: ['cut'], staffId: 'marco', date: '2026-10-25' });
    expect(result.ok && result.data).toEqual({ slots: [], reasonIfNone: 'closed', nextOpenDate: '2026-10-26' });
  });

  it('applies booking rules from the database (same-day off)', async () => {
    const env = setup(shopData({
      scheduling_booking_rules: [
        { appointment_type_id: 'cut', min_lead_time_hours: 0, max_lead_time_days: 30, allow_same_day: false, max_daily_bookings: null },
      ],
    }));
    const { result } = await run('scheduling.check_availability', { serviceIds: ['cut'], date: '2026-10-19' }, env);
    expect(result.ok && result.data).toEqual({ slots: [], reasonIfNone: 'outside_lead_time', nextOpenDate: '2026-10-20' });
  });

  it('finds the first available day without a date, limited by partOfDay', async () => {
    const { result } = await run('scheduling.check_availability', { serviceIds: ['beard'], partOfDay: 'afternoon', limit: 1 }, setup(), {
      now: new Date('2026-10-19T22:00:00Z'),
    });
    expect(result.ok && result.data).toEqual({
      slots: [{ start: '2026-10-20T16:00:00.000Z', end: '2026-10-20T16:15:00.000Z', staffId: 'marco', staffName: 'Marco', spoken: 'tomorrow at 12 PM' }],
    });
  });

  it.each([
    ['an impossible date', { serviceIds: ['cut'], date: '2026-02-30' }, 'date'],
    ['a relative word', { serviceIds: ['cut'], date: 'tomorrow' }, 'date'],
    // RT-HOLD-LINE part 2: a full ISO datetime is now accepted (see below); ambiguous forms are not.
    ['a month/day date', { serviceIds: ['cut'], date: '10/20' }, 'date'],
    ['a day/month/year date', { serviceIds: ['cut'], date: '20/10/2026' }, 'date'],
    ['a weekday alone', { serviceIds: ['cut'], date: 'Tuesday' }, 'date'],
    ['a reversed window', { serviceIds: ['cut'], window: { from: '2026-10-22', to: '2026-10-20' } }, 'window.to'],
    ['a window over 14 days', { serviceIds: ['cut'], window: { from: '2026-10-20', to: '2026-11-03' } }, 'window.to'],
    ['date and window together', { serviceIds: ['cut'], date: '2026-10-20', window: { from: '2026-10-20', to: '2026-10-21' } }, 'window'],
    ['no services', { serviceIds: [] }, 'serviceIds'],
    ['four services', { serviceIds: ['a', 'b', 'c', 'd'] }, 'serviceIds'],
    ['a repeated service', { serviceIds: ['cut', 'cut'] }, 'serviceIds'],
    ['limit over 5', { serviceIds: ['cut'], limit: 6 }, 'limit'],
    ['an unknown part of day', { serviceIds: ['cut'], partOfDay: 'night' }, 'partOfDay'],
  ])('rejects %s with VALIDATION_FAILED', async (_label, input, field) => {
    const { result, query } = await run('scheduling.check_availability', input);
    expect(errorOf(result)).toMatchObject({ code: 'VALIDATION_FAILED', field });
    // Zod rejects before any table is read.
    expect(dataQueries(query)).toEqual([]);
  });

  it('accepts a 14-day window', async () => {
    const { result } = await run('scheduling.check_availability', { serviceIds: ['cut'], window: { from: '2026-10-20', to: '2026-11-02' }, limit: 1 });
    expect(result.ok).toBe(true);
  });

  it('rejects a date that has already passed in the tenant timezone', async () => {
    const { result, query } = await run('scheduling.check_availability', { serviceIds: ['cut'], date: '2026-10-18' });
    expect(errorOf(result)).toMatchObject({ code: 'VALIDATION_FAILED', field: 'date', callerSafeMessage: 'That date has already passed.' });
    expect(dataQueries(query)).toEqual([]);
    const window = await run('scheduling.check_availability', { serviceIds: ['cut'], window: { from: '2026-10-18', to: '2026-10-20' } });
    expect(errorOf(window.result)).toMatchObject({ code: 'VALIDATION_FAILED', field: 'window.from' });
  });

  it('returns NOT_FOUND for an unknown service', async () => {
    const { result } = await run('scheduling.check_availability', { serviceIds: ['cut', 'perm'] });
    expect(errorOf(result)).toMatchObject({ code: 'NOT_FOUND', field: 'serviceIds', callerSafeMessage: "I couldn't find that service." });
  });

  it('returns NOT_FOUND for an unknown staff member', async () => {
    const { result } = await run('scheduling.check_availability', { serviceIds: ['cut'], staffId: 'ghost' });
    expect(errorOf(result)).toMatchObject({ code: 'NOT_FOUND', field: 'staffId' });
  });

  it('rejects a named staff member who does not perform every service', async () => {
    const { result } = await run('scheduling.check_availability', { serviceIds: ['cut', 'beard'], staffId: 'dana' });
    expect(errorOf(result)).toMatchObject({
      code: 'VALIDATION_FAILED',
      field: 'staffId',
      callerSafeMessage: "Dana doesn't do all of those services.",
    });
    const single = await run('scheduling.check_availability', { serviceIds: ['beard'], staffId: 'dana' });
    expect(errorOf(single.result)?.callerSafeMessage).toBe("Dana doesn't do that service.");
  });

  it('rejects services nobody performs together', async () => {
    const { result } = await run('scheduling.check_availability', { serviceIds: ['color'] });
    expect(errorOf(result)).toMatchObject({ code: 'VALIDATION_FAILED', field: 'serviceIds' });
    const combo = await run('scheduling.check_availability', { serviceIds: ['beard', 'color'] });
    expect(errorOf(combo.result)?.callerSafeMessage).toBe('No one here does all of those services in one visit.');
  });

  it('needs the qvo:read scope for MCP callers', async () => {
    const denied = await run('scheduling.check_availability', { serviceIds: ['cut'] }, setup(), { actor: { type: 'mcp', id: 'bot' } });
    expect(errorOf(denied.result)?.code).toBe('FORBIDDEN');
    const allowed = await run('scheduling.check_availability', { serviceIds: ['cut'] }, setup(), {
      actor: { type: 'mcp', id: 'bot', scopes: ['qvo:read'] },
    });
    expect(allowed.result.ok).toBe(true);
  });

  it('maps a database failure to INTERNAL with a caller-safe message', async () => {
    const env = setup();
    const answer = env.query.getMockImplementation()!;
    env.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (/FROM scheduling_providers\b/.test(sql)) throw new Error('connection reset');
      return answer(sql, values);
    });
    const { result } = await run('scheduling.check_availability', { serviceIds: ['cut'] }, env);
    expect(errorOf(result)).toMatchObject({ code: 'INTERNAL', callerSafeMessage: 'Something went wrong on our side. Please try again.' });
  });

  it('serves 400 / 404 / 200 through the HTTP adapter', async () => {
    const env = setup();
    const handler = toHttpHandler(checkAvailabilityAction, env.runtime);
    const base = { tenantId: TENANT, actor: { type: 'user' as const, id: 'u1', role: 'owner' }, tenantTimezone: 'America/New_York', now: MON_0800 };
    expect((await handler({ ...base, body: { serviceIds: ['cut'], date: '2026-13-01' } })).status).toBe(400);
    expect((await handler({ ...base, body: { serviceIds: ['perm'] } })).status).toBe(404);
    expect((await handler({ ...base, body: { serviceIds: ['cut'], date: '2026-10-20' } })).status).toBe(200);
  });

  it('generates a stable agent tool schema', () => {
    expect(toAgentToolSchema(checkAvailabilityAction)).toMatchSnapshot();
  });
});
