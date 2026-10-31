// Oct 31 2026 test calls: check_availability said a Nov 5 slot as "jueves, 14:30"
// and the agent converted its UTC start with the wrong offset. What a read says
// must match what the readback says, on both sides of the Nov 1 DST change.
import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore, runAction, type ActionContext, type TenantTx } from '../index';
import { localIsoOf } from './availability/time';
import { spokenWhen } from './readback';
import { bookPrepareInput } from './writeSchemas';

const NY = 'America/New_York';
const NOW = new Date('2026-10-31T11:00:00Z'); // Sat Oct 31 2026, 7:00 AM EDT

type Rows = Record<string, unknown>[];
type SlotOut = { start: string; localTime: string; spoken: string };

const DATA: Record<string, Rows> = {
  scheduling_appointment_types: [
    { id: 'cut', name: 'Haircut', duration_minutes: 30, buffer_minutes: 0, price_kind: 'from', price_cents: 3000, price_max_cents: null },
  ],
  scheduling_providers: [{ id: 'marcus', name: 'Marcus' }],
  scheduling_provider_services: [{ provider_id: 'marcus', appointment_type_id: 'cut' }],
  scheduling_business_hours: [
    { day_of_week: 0, open_time: '00:00:00', close_time: '17:00:00' },
    ...[1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, open_time: '09:00:00', close_time: '17:00:00' })),
  ],
  scheduling_provider_schedules: [],
  scheduling_overrides: [],
  scheduling_booking_rules: [],
  bookings: [],
};

async function check(startTime: string, locale: string | undefined): Promise<SlotOut> {
  const query = vi.fn(async (sql: string) => {
    const table = Object.keys(DATA).find((t) => new RegExp(`FROM ${t}\\b`).test(sql));
    const rows = table ? DATA[table] : [];
    return { rows, rowCount: rows.length };
  });
  const tx = { query } as TenantTx;
  const runtime = { store: createMemoryStore(), withTenantTx: async <T>(_t: string, fn: (t: TenantTx) => Promise<T>) => fn(tx) };
  const ctx: ActionContext = {
    tenantId: 'tenant-sharp-line',
    actor: { type: 'agent', id: 'agent-1' },
    now: NOW,
    tenantTimezone: NY,
    callId: 'CA-dst',
    locale,
  };
  const result = await runAction('scheduling.check_availability', ctx, { serviceIds: ['cut'], startTime, limit: 1 }, runtime);
  if (!result.ok) throw new Error(result.error.message);
  return (result.data as { slots: SlotOut[] }).slots[0];
}

/** ICU versions write es-US as "p. m." or "p.m."; only the spacing differs. */
function icuSpacing(spoken: string): string {
  return spoken.replace(/([ap])\.m\./, '$1. m.');
}

const SLOTS = [
  { start: '2026-10-31T13:00:00.000Z', en: 'today at 9 AM', es: 'hoy, 9 a. m.', localTime: '2026-10-31T09:00:00-04:00' },
  { start: '2026-11-01T05:30:00.000Z', en: 'tomorrow at 1:30 AM', es: 'mañana, 1:30 a. m.', localTime: '2026-11-01T01:30:00-04:00' },
  { start: '2026-11-01T08:00:00.000Z', en: 'tomorrow at 3 AM', es: 'mañana, 3 a. m.', localTime: '2026-11-01T03:00:00-05:00' },
  { start: '2026-11-01T14:00:00.000Z', en: 'tomorrow at 9 AM', es: 'mañana, 9 a. m.', localTime: '2026-11-01T09:00:00-05:00' },
  { start: '2026-11-05T19:30:00.000Z', en: 'Thursday at 2:30 PM', es: 'jueves, 2:30 p. m.', localTime: '2026-11-05T14:30:00-05:00' },
];

describe.each(SLOTS)('slot $start, seen from Oct 31 (EDT)', ({ start, en, es, localTime }) => {
  it.each([
    ['en-US', en],
    [undefined, en],
    ['es', es],
    ['es-US', es],
  ])('locale %s says it as the readback does', async (locale, spoken) => {
    const slot = await check(start, locale);
    expect(slot).toMatchObject({ start, localTime });
    expect(icuSpacing(slot.spoken)).toBe(spoken);
    expect(spokenWhen({ startMs: Date.parse(start), nowMs: NOW.getTime(), timeZone: NY, locale })).toBe(slot.spoken);
  });

  it('accepts localTime and start as copied timestamps, for the same instant', async () => {
    expect((await check(localTime, 'es')).start).toBe(start);
    expect((await check(start, 'es')).start).toBe(start);
    const parsed = bookPrepareInput.parse({ serviceIds: ['cut'], staffId: 'marcus', start: localTime });
    expect(Date.parse(String(parsed.start))).toBe(Date.parse(start));
  });
});

describe('localIsoOf', () => {
  it('tells the repeated 1:30 AM on the fall-back day apart by its offset', () => {
    const first = Date.parse('2026-11-01T05:30:00Z');
    const second = Date.parse('2026-11-01T06:30:00Z');
    expect(localIsoOf(first, NY)).toBe('2026-11-01T01:30:00-04:00');
    expect(localIsoOf(second, NY)).toBe('2026-11-01T01:30:00-05:00');
    expect(Date.parse(localIsoOf(second, NY))).toBe(second);
  });

  it('writes offsets east of UTC and on the half hour', () => {
    const ms = Date.parse('2026-11-05T19:30:00Z');
    expect(localIsoOf(ms, 'UTC')).toBe('2026-11-05T19:30:00+00:00');
    expect(localIsoOf(ms, 'Asia/Kolkata')).toBe('2026-11-06T01:00:00+05:30');
  });
});
