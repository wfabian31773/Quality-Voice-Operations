import { describe, expect, it, vi } from 'vitest';
import type { TenantTx } from '../../core/types';
import { loadAvailabilityData, loadBookingRuleRows, loadCatalog } from './loaders';
import { DEFAULT_BOOKING_RULES, resolveBookingRules } from './rules';
import { spokenSlot } from './spoken';
import {
  addDays,
  dateRange,
  dayOfWeek,
  diffDays,
  isRealIsoDate,
  localDateOf,
  localMinuteOf,
  offsetMinutes,
  parseClock,
  wallClockToUtc,
} from './time';

const NY = 'America/New_York';

describe('time helpers', () => {
  it('validates real calendar dates', () => {
    expect(isRealIsoDate('2026-11-01')).toBe(true);
    expect(isRealIsoDate('2028-02-29')).toBe(true);
    expect(isRealIsoDate('2026-02-29')).toBe(false);
    expect(isRealIsoDate('2026-13-01')).toBe(false);
    expect(isRealIsoDate('2026-1-1')).toBe(false);
    expect(isRealIsoDate('tomorrow')).toBe(false);
  });

  it('does calendar math without timezone drift', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(diffDays('2026-10-30', '2026-11-02')).toBe(3);
    expect(diffDays('2026-11-02', '2026-10-30')).toBe(-3);
    expect(dayOfWeek('2026-11-01')).toBe(0);
    expect(dayOfWeek('2026-10-24')).toBe(6);
    expect(dateRange('2026-10-30', '2026-11-01')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(dateRange('2026-11-01', '2026-10-30')).toEqual([]);
    expect(() => addDays('nope', 1)).toThrow(RangeError);
  });

  it('parses clock strings', () => {
    expect(parseClock('09:00')).toBe(540);
    expect(parseClock('9:30:00')).toBe(570);
    expect(parseClock('24:00')).toBe(1440);
    expect(parseClock('24:01')).toBeNull();
    expect(parseClock('10:75')).toBeNull();
    expect(parseClock('noon')).toBeNull();
  });

  it('converts wall-clock times across the Nov 1 2026 fall-back', () => {
    expect(new Date(wallClockToUtc('2026-10-31', 9 * 60, NY)).toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(new Date(wallClockToUtc('2026-11-02', 9 * 60, NY)).toISOString()).toBe('2026-11-02T14:00:00.000Z');
    // 1:00 is ambiguous: first occurrence (EDT). 3:00 is EST.
    expect(new Date(wallClockToUtc('2026-11-01', 60, NY)).toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(new Date(wallClockToUtc('2026-11-01', 180, NY)).toISOString()).toBe('2026-11-01T08:00:00.000Z');
    // Minutes past midnight roll into the next day.
    expect(new Date(wallClockToUtc('2026-10-23', 1440 + 30, NY)).toISOString()).toBe('2026-10-24T04:30:00.000Z');
    expect(offsetMinutes(Date.parse('2026-11-01T05:30:00Z'), NY)).toBe(-240);
    expect(offsetMinutes(Date.parse('2026-11-01T06:30:00Z'), NY)).toBe(-300);
  });

  it('reads local date and minute in the tenant timezone', () => {
    const ms = Date.parse('2026-10-24T03:30:00Z');
    expect(localDateOf(ms, NY)).toBe('2026-10-23');
    expect(localMinuteOf(ms, NY)).toBe(23 * 60 + 30);
    expect(localDateOf(ms, 'Asia/Kolkata')).toBe('2026-10-24');
  });
});

describe('spokenSlot', () => {
  const now = Date.parse('2026-10-19T12:00:00Z'); // Mon 8:00 AM EDT

  it('says today, tomorrow, a weekday, or a weekday with the date', () => {
    expect(spokenSlot(Date.parse('2026-10-19T18:00:00Z'), now, NY)).toBe('today at 2 PM');
    expect(spokenSlot(Date.parse('2026-10-20T14:00:00Z'), now, NY)).toBe('tomorrow at 10 AM');
    expect(spokenSlot(Date.parse('2026-10-20T19:30:00Z'), now, NY)).toBe('tomorrow at 3:30 PM');
    expect(spokenSlot(Date.parse('2026-10-22T19:30:00Z'), now, NY)).toBe('Thursday at 3:30 PM');
    expect(spokenSlot(Date.parse('2026-10-27T19:30:00Z'), now, NY)).toBe('Tuesday, October 27 at 3:30 PM');
  });

  it('is relative to now in the tenant timezone, not UTC', () => {
    // 11:30 PM EDT Monday is already Tuesday in UTC.
    expect(spokenSlot(Date.parse('2026-10-20T03:30:00Z'), now, NY)).toBe('today at 11:30 PM');
  });

  it('uses the tenant locale', () => {
    const es = spokenSlot(Date.parse('2026-10-20T14:00:00Z'), now, NY, 'es-US');
    expect(es.startsWith('mañana, ')).toBe(true);
    expect(spokenSlot(Date.parse('2026-10-22T19:30:00Z'), now, NY, 'es-US')).toMatch(/^jueves, /);
  });
});

describe('resolveBookingRules', () => {
  const row = (serviceId: string | null, extra: Partial<Parameters<typeof resolveBookingRules>[0][number]> = {}) => ({
    serviceId,
    minLeadHours: 0,
    maxLeadDays: 90,
    allowSameDay: true,
    maxDailyBookings: null,
    ...extra,
  });

  it('falls back to the column defaults', () => {
    expect(resolveBookingRules([], ['cut'])).toEqual(DEFAULT_BOOKING_RULES);
    expect(resolveBookingRules([], [])).toEqual(DEFAULT_BOOKING_RULES);
  });

  it('uses the tenant row, a service row over it, and the strictest across services', () => {
    const rows = [
      row(null, { minLeadHours: 1, maxLeadDays: 30, maxDailyBookings: 8 }),
      row('color', { minLeadHours: 24, maxLeadDays: 60, allowSameDay: false, maxDailyBookings: 0 }),
    ];
    expect(resolveBookingRules(rows, [])).toMatchObject({ minLeadMinutes: 60, maxLeadDays: 30, maxDailyBookings: 8 });
    expect(resolveBookingRules(rows, ['cut'])).toMatchObject({ minLeadMinutes: 60, maxLeadDays: 30, allowSameDay: true });
    expect(resolveBookingRules(rows, ['color'])).toEqual({
      minLeadMinutes: 24 * 60,
      maxLeadDays: 60,
      allowSameDay: false,
      sameDayCutoffMinute: null,
      maxDailyBookings: null, // 0 means "no cap", like the admin form
    });
    expect(resolveBookingRules(rows, ['cut', 'color'])).toEqual({
      minLeadMinutes: 24 * 60,
      maxLeadDays: 30,
      allowSameDay: false,
      sameDayCutoffMinute: null,
      maxDailyBookings: 8,
    });
  });

  it('clamps negative values', () => {
    expect(resolveBookingRules([row(null, { minLeadHours: -2, maxLeadDays: -1 })], ['cut'])).toMatchObject({
      minLeadMinutes: 0,
      maxLeadDays: 0,
    });
  });
});

function fakeTx(byTable: Record<string, Record<string, unknown>[]>) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    const table = Object.keys(byTable).find((t) => new RegExp(`FROM ${t}\\b`).test(sql));
    const rows = table ? byTable[table] : [];
    return { rows, rowCount: rows.length };
  });
  return { tx: { query } as TenantTx, query };
}

describe('loaders', () => {
  it('loadCatalog filters by tenant and maps active staff ↔ service links', async () => {
    const { tx, query } = fakeTx({
      scheduling_appointment_types: [
        { id: 'cut', name: 'Cut', duration_minutes: 30, buffer_minutes: 5, price_kind: 'from', price_cents: 4500, price_max_cents: null },
        { id: 'odd', name: 'Odd', duration_minutes: null, buffer_minutes: 'x', price_kind: null, price_cents: null, price_max_cents: null },
      ],
      scheduling_providers: [{ id: 'marco', name: 'Marco' }],
      scheduling_provider_services: [
        { provider_id: 'marco', appointment_type_id: 'cut' },
        { provider_id: 'inactive', appointment_type_id: 'cut' },
        { provider_id: 'marco', appointment_type_id: 'inactive-service' },
      ],
    });
    const catalog = await loadCatalog(tx, 't1');
    expect(catalog.services).toEqual([
      { id: 'cut', name: 'Cut', durationMin: 30, bufferMin: 5, priceKind: 'from', priceCents: 4500, priceMaxCents: null },
      { id: 'odd', name: 'Odd', durationMin: 0, bufferMin: 0, priceKind: 'hidden', priceCents: null, priceMaxCents: null },
    ]);
    expect(catalog.staff).toEqual([{ id: 'marco', name: 'Marco' }]);
    expect([...catalog.staffByService.get('cut')!]).toEqual(['marco']);
    expect([...catalog.staffByService.get('odd')!]).toEqual([]);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).toMatch(/WHERE tenant_id = \$1/);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
      expect(values?.[0]).toBe('t1');
    }
    expect(query.mock.calls[0][0]).toMatch(/is_active = true/);
    expect(query.mock.calls[1][0]).toMatch(/is_active = true/);
  });

  it('loadBookingRuleRows maps nulls to column defaults', async () => {
    const { tx, query } = fakeTx({
      scheduling_booking_rules: [
        { appointment_type_id: null, min_lead_time_hours: null, max_lead_time_days: null, allow_same_day: null, max_daily_bookings: null },
        { appointment_type_id: 'cut', min_lead_time_hours: 2, max_lead_time_days: 14, allow_same_day: false, max_daily_bookings: 6 },
      ],
    });
    expect(await loadBookingRuleRows(tx, 't1', ['cut'])).toEqual([
      { serviceId: null, minLeadHours: 0, maxLeadDays: 90, allowSameDay: true, maxDailyBookings: null },
      { serviceId: 'cut', minLeadHours: 2, maxLeadDays: 14, allowSameDay: false, maxDailyBookings: 6 },
    ]);
    expect(query.mock.calls[0][1]).toEqual(['t1', ['cut']]);
  });

  it('loadAvailabilityData reads hours, schedules, overrides and blocking bookings for the range', async () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const { tx, query } = fakeTx({
      scheduling_business_hours: [{ day_of_week: 1, open_time: '09:00:00', close_time: '17:00:00' }],
      scheduling_provider_schedules: [
        { provider_id: 'marco', day_of_week: 2, start_time: '10:00:00', end_time: '18:00:00' },
        { provider_id: 'marco', day_of_week: 3, start_time: '10:00:00', end_time: '18:00:00' },
      ],
      scheduling_overrides: [
        { provider_id: null, override_date: '2026-10-20', start_time: null, end_time: null, is_available: false },
        { provider_id: 'marco', override_date: '2026-10-21', start_time: '23:30:00', end_time: '00:30:00', is_available: true },
      ],
      bookings: [
        { provider_id: 'marco', start_time: new Date('2026-10-20T14:00:00Z'), blocked_until: '2026-10-20T14:45:00Z', status: 'held', hold_expires_at: '2026-10-19T12:05:00Z' },
        { provider_id: 'marco', start_time: '2026-10-21T14:00:00Z', blocked_until: new Date('2026-10-21T14:30:00Z'), status: 'confirmed', hold_expires_at: null },
      ],
    });
    const data = await loadAvailabilityData(tx, 't1', {
      staffIds: ['marco', 'dana'],
      bookingStaffIds: ['marco'],
      fromDate: '2026-10-18',
      toDate: '2026-10-22',
      timezone: NY,
      now,
    });
    expect(data.businessHours).toEqual([{ dayOfWeek: 1, start: '09:00:00', end: '17:00:00' }]);
    expect(data.weeklyByStaff.get('marco')).toHaveLength(2);
    expect(data.weeklyByStaff.has('dana')).toBe(false);
    expect(data.overrides).toEqual([
      { date: '2026-10-20', staffId: null, start: null, end: null, isAvailable: false },
      { date: '2026-10-21', staffId: 'marco', start: '23:30:00', end: '00:30:00', isAvailable: true },
    ]);
    expect(data.bookings).toEqual([
      {
        staffId: 'marco',
        start: new Date('2026-10-20T14:00:00Z'),
        blockedUntil: new Date('2026-10-20T14:45:00Z'),
        status: 'held',
        holdExpiresAt: new Date('2026-10-19T12:05:00Z'),
      },
      {
        staffId: 'marco',
        start: new Date('2026-10-21T14:00:00Z'),
        blockedUntil: new Date('2026-10-21T14:30:00Z'),
        status: 'confirmed',
        holdExpiresAt: null,
      },
    ]);

    const [bookingSql, bookingValues] = query.mock.calls[3];
    expect(bookingSql).toMatch(/hold_expires_at > \$4/);
    expect(bookingSql).toMatch(/COALESCE\(blocked_until, end_time\)/);
    expect(bookingValues).toEqual([
      't1',
      ['marco'],
      ['confirmed', 'held', 'checked_in', 'pending'],
      now,
      new Date('2026-10-18T04:00:00Z'),
      new Date('2026-10-23T04:00:00Z'),
    ]);
    expect(query.mock.calls[2][1]).toEqual(['t1', '2026-10-18', '2026-10-22', ['marco', 'dana']]);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).toMatch(/WHERE tenant_id = \$1/);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
      expect(values?.[0]).toBe('t1');
    }
  });
});
