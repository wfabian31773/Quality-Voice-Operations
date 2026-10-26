import { describe, expect, it } from 'vitest';
import { computeAvailability, searchPlan, spreadPick } from './engine';
import { DEFAULT_BOOKING_RULES } from './rules';
import type { AvailabilityInput, BusyBooking, ClockBlock, ServiceSpec, StaffMember } from './types';

const TZ = 'America/New_York';

// Oct 2026: Sat 17, Sun 18, Mon 19, Tue 20, Fri 23, Sat 24, Sat 31; Sun Nov 1
// is the US fall-back day (2:00 EDT → 1:00 EST).
const MON_0800 = new Date('2026-10-19T12:00:00Z');

const CUT: ServiceSpec = { id: 'cut', name: "Men's cut", durationMin: 30, bufferMin: 0 };
const BEARD: ServiceSpec = { id: 'beard', name: 'Beard trim', durationMin: 15, bufferMin: 5 };

function weekdays(days: number[], start: string, end: string): ClockBlock[] {
  return days.map((dayOfWeek) => ({ dayOfWeek, start, end }));
}

const MON_SAT_9_5 = weekdays([1, 2, 3, 4, 5, 6], '09:00', '17:00');

function staff(id: string, name: string, serviceIds: string[], weekly: ClockBlock[] = []): StaffMember {
  return { id, name, serviceIds, weekly };
}

const MARCO = staff('marco', 'Marco', ['cut', 'beard']);
const DANA = staff('dana', 'Dana', ['cut']);

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    timezone: TZ,
    now: MON_0800,
    businessHours: MON_SAT_9_5,
    staff: [MARCO, DANA],
    overrides: [],
    bookings: [],
    rules: { ...DEFAULT_BOOKING_RULES },
    services: [CUT],
    staffId: 'any',
    ...overrides,
  };
}

function booking(staffId: string, start: string, blockedUntil: string, extra: Partial<BusyBooking> = {}): BusyBooking {
  return { staffId, start: new Date(start), blockedUntil: new Date(blockedUntil), status: 'confirmed', ...extra };
}

/** Shop open only [from, to) on `date`, so a day has few enough slots to list them all. */
function shopOpen(date: string, from: string, to: string) {
  return { date, staffId: null, start: from, end: to, isAvailable: true };
}

const starts = (r: ReturnType<typeof computeAvailability>) => r.slots.map((s) => s.start);

describe('computeAvailability: DST (US fall back, Sun Nov 1 2026)', () => {
  const now = new Date('2026-10-30T16:00:00Z'); // Fri Oct 30, 12:00 EDT

  it('treats a 1:00–3:00 AM override on Nov 1 as three real hours', () => {
    const r = computeAvailability(input({
      now,
      date: '2026-11-01',
      overrides: [shopOpen('2026-11-01', '01:00', '03:00')],
      limit: 5,
    }));
    // 05:00Z (1:00 EDT) … 07:30Z (2:30 EST): eleven 15-minute starts, spread to five.
    expect(starts(r)).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T05:45:00.000Z',
      '2026-11-01T06:15:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T07:30:00.000Z',
    ]);
    expect(r.slots[4].end).toBe('2026-11-01T08:00:00.000Z');
    expect(r.slots.map((s) => s.spoken)).toEqual([
      'Sunday at 1 AM',
      'Sunday at 1:45 AM',
      'Sunday at 1:15 AM',
      'Sunday at 2 AM',
      'Sunday at 2:30 AM',
    ]);
  });

  it('fits a 180-minute service in the 1:00–3:00 AM window but not a 195-minute one', () => {
    const base = { now, date: '2026-11-01', overrides: [shopOpen('2026-11-01', '01:00', '03:00')] };
    const fits = computeAvailability(input({ ...base, services: [{ ...CUT, durationMin: 180 }] }));
    expect(starts(fits)).toEqual(['2026-11-01T05:00:00.000Z']);
    expect(fits.slots[0].end).toBe('2026-11-01T08:00:00.000Z');
    const tooLong = computeAvailability(input({ ...base, services: [{ ...CUT, durationMin: 195 }] }));
    expect(tooLong.slots).toEqual([]);
  });

  it('keeps 9:00–17:00 wall-clock hours on the EDT day before and the EST day after', () => {
    const sat = computeAvailability(input({ now, date: '2026-10-31', limit: 2 }));
    expect(starts(sat)).toEqual(['2026-10-31T13:00:00.000Z', '2026-10-31T20:30:00.000Z']);
    expect(sat.slots.map((s) => s.spoken)).toEqual(['tomorrow at 9 AM', 'tomorrow at 4:30 PM']);

    const mon = computeAvailability(input({ now, date: '2026-11-02', limit: 2 }));
    expect(starts(mon)).toEqual(['2026-11-02T14:00:00.000Z', '2026-11-02T21:30:00.000Z']);
    expect(mon.slots.map((s) => s.spoken)).toEqual(['Monday at 9 AM', 'Monday at 4:30 PM']);
  });

  it('is closed on the DST Sunday without an override and points to Monday', () => {
    const r = computeAvailability(input({ now, date: '2026-11-01' }));
    expect(r).toEqual({ slots: [], reasonIfNone: 'closed', nextOpenDate: '2026-11-02' });
  });
});

describe('computeAvailability: closures and overrides', () => {
  it('reports a closed day with the next open date', () => {
    const r = computeAvailability(input({ date: '2026-10-18', now: new Date('2026-10-17T14:00:00Z') }));
    expect(r).toEqual({ slots: [], reasonIfNone: 'closed', nextOpenDate: '2026-10-19' });
  });

  it('closes the shop for a holiday override', () => {
    const r = computeAvailability(input({
      date: '2026-10-20',
      overrides: [{ date: '2026-10-20', staffId: null, start: null, end: null, isAvailable: false }],
    }));
    expect(r).toEqual({ slots: [], reasonIfNone: 'closed', nextOpenDate: '2026-10-21' });
  });

  it('a holiday closes staff with their own special hours too', () => {
    const r = computeAvailability(input({
      date: '2026-10-20',
      overrides: [
        { date: '2026-10-20', staffId: null, start: null, end: null, isAvailable: false },
        { date: '2026-10-20', staffId: 'marco', start: '10:00', end: '12:00', isAvailable: true },
      ],
    }));
    expect(r.reasonIfNone).toBe('closed');
  });

  it('staff off but shop open: named staff gets staff_off and his next day, any staff still books', () => {
    const marcoTueSat = staff('marco', 'Marco', ['cut', 'beard'], weekdays([2, 3, 4, 5, 6], '09:00', '17:00'));
    const named = computeAvailability(input({ staff: [marcoTueSat, DANA], staffId: 'marco', date: '2026-10-19' }));
    expect(named).toEqual({ slots: [], reasonIfNone: 'staff_off', nextOpenDate: '2026-10-20' });

    const any = computeAvailability(input({ staff: [marcoTueSat, DANA], date: '2026-10-19', limit: 1 }));
    expect(any.slots).toEqual([
      expect.objectContaining({ start: '2026-10-19T13:00:00.000Z', staffId: 'dana', staffName: 'Dana', spoken: 'today at 9 AM' }),
    ]);
  });

  it('time off (staff full-day override) is staff_off while the shop is open', () => {
    const r = computeAvailability(input({
      staffId: 'dana',
      date: '2026-10-20',
      overrides: [{ date: '2026-10-20', staffId: 'dana', start: null, end: null, isAvailable: false }],
    }));
    expect(r).toEqual({ slots: [], reasonIfNone: 'staff_off', nextOpenDate: '2026-10-21' });
  });

  it('an overnight 11:30 PM–12:30 AM override offers slots on both sides of midnight', () => {
    const late = { date: '2026-10-23', staffId: 'marco', start: '23:30', end: '00:30', isAvailable: true };
    const fri = computeAvailability(input({ staffId: 'marco', date: '2026-10-23', overrides: [late], limit: 5 }));
    // Special hours replace Marco's Friday; 00:00 belongs to Saturday.
    expect(starts(fri)).toEqual(['2026-10-24T03:30:00.000Z', '2026-10-24T03:45:00.000Z']);
    expect(fri.slots.map((s) => s.spoken)).toEqual(['Friday at 11:30 PM', 'Friday at 11:45 PM']);

    const sat = computeAvailability(input({ staffId: 'marco', date: '2026-10-24', overrides: [late], limit: 1 }));
    expect(sat.slots[0]).toMatchObject({
      start: '2026-10-24T04:00:00.000Z',
      end: '2026-10-24T04:30:00.000Z',
      spoken: 'Saturday at 12 AM',
    });
  });

  it('shop special hours replace the weekly hours for that date', () => {
    const r = computeAvailability(input({ date: '2026-10-20', overrides: [shopOpen('2026-10-20', '10:00', '11:00')], limit: 5 }));
    expect(starts(r)).toEqual(['2026-10-20T14:00:00.000Z', '2026-10-20T14:15:00.000Z', '2026-10-20T14:30:00.000Z']);
  });

  it('an all-day open override opens a normally closed day', () => {
    const r = computeAvailability(input({
      now: new Date('2026-10-17T14:00:00Z'),
      date: '2026-10-18',
      overrides: [{ date: '2026-10-18', staffId: null, start: null, end: null, isAvailable: true }],
      limit: 2,
    }));
    expect(starts(r)).toEqual(['2026-10-18T04:00:00.000Z', '2026-10-19T03:30:00.000Z']);
  });

  it('subtracts shop and staff partial closures (lunch, appointment)', () => {
    const r = computeAvailability(input({
      staffId: 'marco',
      date: '2026-10-20',
      overrides: [
        shopOpen('2026-10-20', '10:00', '12:00'),
        { date: '2026-10-20', staffId: null, start: '10:30', end: '11:00', isAvailable: false },
        { date: '2026-10-20', staffId: 'marco', start: '11:00', end: '11:30', isAvailable: false },
      ],
      limit: 5,
    }));
    expect(starts(r)).toEqual(['2026-10-20T14:00:00.000Z', '2026-10-20T15:30:00.000Z']);
  });

  it('intersects staff weekly hours with business hours', () => {
    const early = staff('marco', 'Marco', ['cut'], weekdays([2], '07:00', '10:00'));
    const r = computeAvailability(input({ staff: [early], date: '2026-10-20', limit: 5 }));
    expect(starts(r)).toEqual([
      '2026-10-20T13:00:00.000Z',
      '2026-10-20T13:15:00.000Z',
      '2026-10-20T13:30:00.000Z',
    ]);
  });

  it('with no business hours configured, staff weekly schedules decide', () => {
    const marco = staff('marco', 'Marco', ['cut'], weekdays([2], '10:00', '11:00'));
    const r = computeAvailability(input({ businessHours: [], staff: [marco], date: '2026-10-20', limit: 5 }));
    expect(starts(r)).toHaveLength(3);
    const closed = computeAvailability(input({ businessHours: [], staff: [marco], date: '2026-10-21' }));
    expect(closed.reasonIfNone).toBe('closed');
    const dana = staff('dana', 'Dana', ['beard'], weekdays([3], '10:00', '11:00'));
    const off = computeAvailability(input({ businessHours: [], staff: [marco, dana], date: '2026-10-21' }));
    expect(off.reasonIfNone).toBe('staff_off');
  });

  it('ignores malformed clock values instead of inventing hours', () => {
    const r = computeAvailability(input({
      date: '2026-10-20',
      businessHours: [{ dayOfWeek: 2, start: 'nine', end: '17:00' }],
    }));
    expect(r.reasonIfNone).toBe('closed');
  });
});

describe('computeAvailability: booking rules', () => {
  it('same-day booking off: today is outside_lead_time, tomorrow is next', () => {
    const r = computeAvailability(input({ date: '2026-10-19', rules: { ...DEFAULT_BOOKING_RULES, allowSameDay: false } }));
    expect(r).toEqual({ slots: [], reasonIfNone: 'outside_lead_time', nextOpenDate: '2026-10-20' });
  });

  it('same-day cutoff: closed after the cutoff, open before it', () => {
    const rules = { ...DEFAULT_BOOKING_RULES, sameDayCutoffMinute: 12 * 60 };
    const after = computeAvailability(input({ now: new Date('2026-10-19T17:00:00Z'), date: '2026-10-19', rules }));
    expect(after).toEqual({ slots: [], reasonIfNone: 'outside_lead_time', nextOpenDate: '2026-10-20' });
    const before = computeAvailability(input({ now: new Date('2026-10-19T15:00:00Z'), date: '2026-10-19', rules, limit: 1 }));
    expect(starts(before)).toEqual(['2026-10-19T15:00:00.000Z']);
    expect(before.slots[0].spoken).toBe('today at 11 AM');
  });

  it('"earliest anything" after closing time rolls to tomorrow', () => {
    const r = computeAvailability(input({ now: new Date('2026-10-19T22:00:00Z'), limit: 1 }));
    expect(r.slots[0]).toMatchObject({ start: '2026-10-20T13:00:00.000Z', spoken: 'tomorrow at 9 AM' });
  });

  it('min lead time hides slots that start too soon', () => {
    const r = computeAvailability(input({
      now: new Date('2026-10-19T14:05:00Z'), // 10:05
      date: '2026-10-19',
      rules: { ...DEFAULT_BOOKING_RULES, minLeadMinutes: 120 },
      limit: 1,
    }));
    expect(starts(r)).toEqual(['2026-10-19T16:15:00.000Z']); // 12:15
  });

  it('max lead days: a date past the limit is outside_lead_time with no next date', () => {
    const rules = { ...DEFAULT_BOOKING_RULES, maxLeadDays: 7 };
    expect(computeAvailability(input({ date: '2026-10-27', rules }))).toEqual({ slots: [], reasonIfNone: 'outside_lead_time' });
    expect(computeAvailability(input({ date: '2026-10-26', rules, limit: 1 })).slots).toHaveLength(1);
  });

  it('max daily bookings caps a staff member per day', () => {
    const rules = { ...DEFAULT_BOOKING_RULES, maxDailyBookings: 1 };
    const bookings = [booking('marco', '2026-10-20T13:00:00Z', '2026-10-20T13:30:00Z')];
    const named = computeAvailability(input({ staffId: 'marco', date: '2026-10-20', rules, bookings }));
    expect(named).toEqual({ slots: [], reasonIfNone: 'fully_booked', nextOpenDate: '2026-10-21' });
    const any = computeAvailability(input({ date: '2026-10-20', rules, bookings, limit: 1 }));
    expect(any.slots[0].staffId).toBe('dana');
  });
});

describe('computeAvailability: bookings, buffers and holds', () => {
  const day = '2026-10-20';
  const hours = [shopOpen(day, '10:00', '11:30')];

  it('respects an existing booking buffer (blocked_until)', () => {
    const r = computeAvailability(input({
      staffId: 'marco',
      date: day,
      overrides: hours,
      bookings: [booking('marco', '2026-10-20T14:00:00Z', '2026-10-20T14:45:00Z')],
      limit: 5,
    }));
    // 10:00–10:30 + 15 min buffer: next start 10:45.
    expect(starts(r)).toEqual(['2026-10-20T14:45:00.000Z', '2026-10-20T15:00:00.000Z']);
  });

  it("keeps the requested service's buffer clear of the next booking", () => {
    const r = computeAvailability(input({
      staffId: 'marco',
      date: day,
      overrides: [shopOpen(day, '10:00', '11:00')],
      services: [{ ...CUT, bufferMin: 10 }],
      bookings: [booking('marco', '2026-10-20T15:00:00Z', '2026-10-20T15:30:00Z')],
      limit: 5,
    }));
    // 10:30 would block until 11:10 and overlap the 11:00 booking.
    expect(starts(r)).toEqual(['2026-10-20T14:00:00.000Z', '2026-10-20T14:15:00.000Z']);
  });

  it('a live hold blocks the slot; an expired hold does not', () => {
    const hold = (expires: string) => booking('marco', '2026-10-20T14:00:00Z', '2026-10-20T14:30:00Z', {
      status: 'held',
      holdExpiresAt: new Date(expires),
    });
    const base = { staffId: 'marco', date: day, overrides: [shopOpen(day, '10:00', '10:30')] };
    const live = computeAvailability(input({ ...base, bookings: [hold('2026-10-19T12:05:00Z')] }));
    expect(live).toMatchObject({ slots: [], reasonIfNone: 'fully_booked' });
    const expired = computeAvailability(input({ ...base, bookings: [hold('2026-10-19T11:59:00Z')] }));
    expect(starts(expired)).toEqual(['2026-10-20T14:00:00.000Z']);
    const noExpiry = computeAvailability(input({ ...base, bookings: [{ ...hold('2026-10-19T11:59:00Z'), holdExpiresAt: null }] }));
    expect(noExpiry.slots).toHaveLength(1);
  });

  it('cancelled and completed bookings never block', () => {
    const r = computeAvailability(input({
      staffId: 'marco',
      date: day,
      overrides: [shopOpen(day, '10:00', '10:30')],
      bookings: [
        booking('marco', '2026-10-20T14:00:00Z', '2026-10-20T14:30:00Z', { status: 'cancelled' }),
        booking('marco', '2026-10-20T14:00:00Z', '2026-10-20T14:30:00Z', { status: 'completed' }),
      ],
    }));
    expect(r.slots).toHaveLength(1);
  });

  it('fully booked day reports fully_booked and the next open date', () => {
    const r = computeAvailability(input({
      date: day,
      overrides: [shopOpen(day, '10:00', '10:30')],
      bookings: [
        booking('marco', '2026-10-20T14:00:00Z', '2026-10-20T14:30:00Z'),
        booking('dana', '2026-10-20T14:00:00Z', '2026-10-20T14:30:00Z', { status: 'checked_in' }),
      ],
    }));
    expect(r).toEqual({ slots: [], reasonIfNone: 'fully_booked', nextOpenDate: '2026-10-21' });
  });

  it('each slot says when its staff member is free again: blockedUntil = end + the largest buffer', () => {
    const base = { staffId: 'marco', date: day, overrides: hours, limit: 1 };
    const beard = computeAvailability(input({ ...base, services: [BEARD] })).slots[0];
    expect(beard).toMatchObject({ end: '2026-10-20T14:15:00.000Z', blockedUntil: '2026-10-20T14:20:00.000Z' });
    const cut = computeAvailability(input({ ...base, services: [CUT] })).slots[0];
    expect(cut).toMatchObject({ end: '2026-10-20T14:30:00.000Z', blockedUntil: '2026-10-20T14:30:00.000Z' });
    const both = computeAvailability(input({ ...base, services: [{ ...CUT, bufferMin: 10 }, BEARD] })).slots[0];
    expect(both).toMatchObject({ end: '2026-10-20T14:45:00.000Z', blockedUntil: '2026-10-20T14:55:00.000Z' });
  });

  it("back-to-back with the same barber: once the first is booked, the second can start at its blockedUntil, not at its end", () => {
    const base = { staffId: 'marco', date: day, overrides: [shopOpen(day, '10:00', '12:00')] };
    const first = computeAvailability(input({ ...base, services: [{ ...CUT, bufferMin: 15 }], limit: 1 })).slots[0];
    expect(first).toMatchObject({ start: '2026-10-20T14:00:00.000Z', end: '2026-10-20T14:30:00.000Z', blockedUntil: '2026-10-20T14:45:00.000Z' });

    // The first booking blocks Marco until its blockedUntil (bookings.blocked_until).
    const second = { ...base, services: [CUT], bookings: [booking('marco', first.start, first.blockedUntil)] };
    expect(computeAvailability(input({ ...second, at: Date.parse(first.end) })).slots).toEqual([]);
    expect(starts(computeAvailability(input({ ...second, at: Date.parse(first.blockedUntil) })))).toEqual([first.blockedUntil]);
    expect(starts(computeAvailability(input({ ...second, limit: 5 })))[0]).toBe(first.blockedUntil);
  });
});

describe('computeAvailability: services and staff', () => {
  const day = '2026-10-20';

  it('multi-service sums durations back-to-back with one staff member who does both', () => {
    const r = computeAvailability(input({
      date: day,
      services: [CUT, BEARD],
      overrides: [shopOpen(day, '10:00', '11:00')],
      limit: 5,
    }));
    expect(r.slots).toEqual([
      expect.objectContaining({ start: '2026-10-20T14:00:00.000Z', end: '2026-10-20T14:45:00.000Z', staffId: 'marco' }),
      expect.objectContaining({ start: '2026-10-20T14:15:00.000Z', end: '2026-10-20T15:00:00.000Z', staffId: 'marco' }),
    ]);
  });

  it('multi-service blocks with the largest buffer', () => {
    const r = computeAvailability(input({
      staffId: 'marco',
      date: day,
      services: [CUT, BEARD],
      overrides: [shopOpen(day, '10:00', '11:30')],
      bookings: [booking('marco', '2026-10-20T15:15:00Z', '2026-10-20T15:30:00Z')],
      limit: 5,
    }));
    // 10:15–11:00 blocks until 11:05 (fits before 11:15); 10:30–11:15 + 5 min overlaps it.
    expect(starts(r)).toEqual(['2026-10-20T14:00:00.000Z', '2026-10-20T14:15:00.000Z']);
  });

  it('nobody performs every requested service → staff_off without a next date', () => {
    expect(computeAvailability(input({ staffId: 'dana', services: [CUT, BEARD], date: day }))).toEqual({
      slots: [],
      reasonIfNone: 'staff_off',
    });
  });

  it('"any" gives each time to the least busy staff member; a named request keeps that staff member', () => {
    // Marco has a 3 PM booking that day, so Dana is less busy at 10 AM.
    const bookings = [booking('marco', '2026-10-20T19:00:00Z', '2026-10-20T19:30:00Z')];
    const base = { date: day, overrides: [shopOpen(day, '10:00', '10:30')], bookings };
    const any = computeAvailability(input(base));
    expect(any.slots.map((s) => s.staffId)).toEqual(['dana']);
    const anyNoLoad = computeAvailability(input({ ...base, bookings: [] }));
    expect(anyNoLoad.slots.map((s) => s.staffId)).toEqual(['marco']); // list order on a tie
    const named = computeAvailability(input({ ...base, staffId: 'marco' }));
    expect(named.slots.map((s) => [s.staffId, s.staffName])).toEqual([['marco', 'Marco']]);
  });

  it('"any" with one staff member busy offers the other', () => {
    const r = computeAvailability(input({
      date: day,
      overrides: [shopOpen(day, '10:00', '10:30')],
      bookings: [booking('marco', '2026-10-20T14:00:00Z', '2026-10-20T14:30:00Z')],
    }));
    expect(r.slots.map((s) => s.staffId)).toEqual(['dana']);
  });
});

describe('computeAvailability: partOfDay, limit and search', () => {
  it('filters by part of day (morning < 12:00 ≤ afternoon < 17:00 ≤ evening)', () => {
    const afternoon = computeAvailability(input({ date: '2026-10-20', partOfDay: 'afternoon', limit: 2 }));
    expect(starts(afternoon)).toEqual(['2026-10-20T16:00:00.000Z', '2026-10-20T20:30:00.000Z']);
    const morning = computeAvailability(input({ date: '2026-10-20', partOfDay: 'morning', limit: 2 }));
    // Part of day goes by the start time: 11:45 is still morning.
    expect(starts(morning)).toEqual(['2026-10-20T13:00:00.000Z', '2026-10-20T15:45:00.000Z']);
    const late = computeAvailability(input({ date: '2026-10-20', overrides: [shopOpen('2026-10-20', '16:00', '19:00')], partOfDay: 'evening', limit: 1 }));
    expect(starts(late)).toEqual(['2026-10-20T21:00:00.000Z']);
  });

  it('no evening hours → closed for that part of day, with the next date that has one', () => {
    const r = computeAvailability(input({
      date: '2026-10-20',
      partOfDay: 'evening',
      overrides: [shopOpen('2026-10-22', '17:00', '19:00')],
    }));
    expect(r).toEqual({ slots: [], reasonIfNone: 'closed', nextOpenDate: '2026-10-22' });
  });

  it('a window too short for the service is fully_booked', () => {
    const r = computeAvailability(input({ date: '2026-10-20', overrides: [shopOpen('2026-10-20', '10:00', '10:15')] }));
    expect(r.reasonIfNone).toBe('fully_booked');
  });

  it('defaults to 3 spread-out slots and caps limit at 5', () => {
    const three = computeAvailability(input({ date: '2026-10-20' }));
    expect(starts(three)).toEqual(['2026-10-20T13:00:00.000Z', '2026-10-20T16:45:00.000Z', '2026-10-20T20:30:00.000Z']);
    expect(computeAvailability(input({ date: '2026-10-20', limit: 9 })).slots).toHaveLength(5);
    expect(computeAvailability(input({ date: '2026-10-20', limit: 0 })).slots).toHaveLength(1);
  });

  it('a date window returns the first open day in it', () => {
    const r = computeAvailability(input({
      now: new Date('2026-10-17T14:00:00Z'),
      window: { from: '2026-10-18', to: '2026-10-20' },
      limit: 1,
    }));
    expect(r.slots[0]).toMatchObject({ start: '2026-10-19T13:00:00.000Z', spoken: 'Monday at 9 AM' });
  });

  it('a window with nothing open looks past it for nextOpenDate', () => {
    const r = computeAvailability(input({
      now: new Date('2026-10-17T14:00:00Z'),
      window: { from: '2026-10-18', to: '2026-10-18' },
    }));
    expect(r).toEqual({ slots: [], reasonIfNone: 'closed', nextOpenDate: '2026-10-19' });
  });

  it('first-available search with nothing in range reports the best reason only', () => {
    const r = computeAvailability(input({ businessHours: [], rules: { ...DEFAULT_BOOKING_RULES, maxLeadDays: 3 } }));
    expect(r).toEqual({ slots: [], reasonIfNone: 'closed' });
  });

  it('uses a custom slot grid', () => {
    const r = computeAvailability(input({ date: '2026-10-20', overrides: [shopOpen('2026-10-20', '10:10', '11:10')], slotMinutes: 30, limit: 5 }));
    expect(starts(r)).toEqual(['2026-10-20T14:30:00.000Z']);
  });
});

describe('searchPlan and spreadPick', () => {
  const rules = { maxLeadDays: 90 };

  it('plans a single date with a next-open search and one day of loader slack', () => {
    const plan = searchPlan({ today: '2026-10-19', date: '2026-10-20', rules, maxSearchDays: 3 });
    expect(plan).toEqual({
      days: ['2026-10-20'],
      nextOpenDays: ['2026-10-21', '2026-10-22', '2026-10-23'],
      loadFrom: '2026-10-19',
      loadTo: '2026-10-24',
    });
  });

  it('plans first-available from today, bounded by max lead days', () => {
    const plan = searchPlan({ today: '2026-10-19', rules: { maxLeadDays: 2 } });
    expect(plan.days).toEqual(['2026-10-19', '2026-10-20', '2026-10-21']);
    expect(plan.nextOpenDays).toEqual([]);
    expect([plan.loadFrom, plan.loadTo]).toEqual(['2026-10-18', '2026-10-22']);
    expect(searchPlan({ today: '2026-10-19', rules }).days).toHaveLength(61);
  });

  it('spreads picks evenly and keeps the first', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    expect(spreadPick(items, 3)).toEqual([0, 5, 9]);
    expect(spreadPick(items, 1)).toEqual([0]);
    expect(spreadPick([1, 2], 5)).toEqual([1, 2]);
  });
});

describe('computeAvailability: exact start (at) and nearest slots (near), used by the write actions', () => {
  const TUE_1000 = Date.parse('2026-10-20T14:00:00Z');

  it('offers exactly the requested start, with the engine-assigned staff member for any', () => {
    const r = computeAvailability(input({ date: '2026-10-20', at: TUE_1000, limit: 1 }));
    expect(r.slots).toEqual([
      { start: '2026-10-20T14:00:00.000Z', end: '2026-10-20T14:30:00.000Z', blockedUntil: '2026-10-20T14:30:00.000Z', staffId: 'marco', staffName: 'Marco', spoken: 'tomorrow at 10 AM' },
    ]);
    // Marco busier that day → Dana gets it.
    const busy = computeAvailability(input({
      date: '2026-10-20',
      at: TUE_1000,
      bookings: [booking('marco', '2026-10-20T13:00:00Z', '2026-10-20T13:30:00Z')],
    }));
    expect(busy.slots.map((s) => s.staffId)).toEqual(['dana']);
  });

  it('gives the reason for a start it does not offer, and no nextOpenDate', () => {
    const taken = computeAvailability(input({
      date: '2026-10-20',
      staffId: 'marco',
      at: TUE_1000,
      bookings: [booking('marco', '2026-10-20T13:45:00Z', '2026-10-20T14:15:00Z')],
    }));
    expect(taken).toEqual({ slots: [], reasonIfNone: 'fully_booked' });
    const lead = computeAvailability(input({ date: '2026-10-19', at: Date.parse('2026-10-19T13:00:00Z'), rules: { ...DEFAULT_BOOKING_RULES, minLeadMinutes: 120 } }));
    expect(lead).toEqual({ slots: [], reasonIfNone: 'outside_lead_time' });
    const closed = computeAvailability(input({ date: '2026-10-25', at: Date.parse('2026-10-25T14:00:00Z') }));
    expect(closed).toEqual({ slots: [], reasonIfNone: 'closed' });
    // Off the 15-minute grid: never offered.
    expect(computeAvailability(input({ date: '2026-10-20', at: TUE_1000 + 7 * 60_000 })).slots).toEqual([]);
  });

  it('picks the slots closest to `near`, returned in time order', () => {
    const r = computeAvailability(input({ date: '2026-10-20', staffId: 'marco', near: TUE_1000, limit: 3 }));
    expect(starts(r)).toEqual(['2026-10-20T13:45:00.000Z', '2026-10-20T14:00:00.000Z', '2026-10-20T14:15:00.000Z']);
  });
});
