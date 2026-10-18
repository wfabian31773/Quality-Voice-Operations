/**
 * RT-HOLD-LINE part 2: date slots accept unambiguous variants (Oct 18: one
 * check_availability failed on "Use a YYYY-MM-DD date" and cost the caller a
 * round trip), still refuse anything a person could read two ways, and the
 * tool descriptions name the format.
 */
import { describe, expect, it } from 'vitest';
import { BOOKING_FIND_V1, DATE_SLOT_FORMAT } from '../../callcore/contracts';
import { toAgentToolSchema } from '../core';
import { checkAvailabilityAction } from './checkAvailability';
import {
  DATE_FORMAT_MESSAGE,
  dateSlot,
  dateSlotIssue,
  NOT_A_REAL_DATE_MESSAGE,
  toTenantDate,
  WEEKDAY_MISMATCH_MESSAGE,
} from './dateSlot';
import { findBookingsAction } from './findBookings';

const NY = 'America/New_York';

describe('date slot: accepted forms → the tenant\'s YYYY-MM-DD', () => {
  it.each([
    ['2026-10-21', '2026-10-21'],
    // A full ISO datetime without a zone is the tenant's wall clock: its written date.
    ['2026-10-21T09:00', '2026-10-21'],
    ['2026-10-21T09:00:00', '2026-10-21'],
    ['2026-10-21 09:00:00.000', '2026-10-21'],
    // With a zone: its date in the tenant timezone.
    ['2026-10-21T09:00:00-04:00', '2026-10-21'],
    ['2026-10-21T13:00:00Z', '2026-10-21'],
    ['2026-10-22T01:30:00Z', '2026-10-21'], // 21:30 the evening before in New York
    ['2026-10-21T23:30:00-0700', '2026-10-22'], // 02:30 the next morning in New York
    ['2026-10-21T08:00:00+02', '2026-10-21'],
    ['2026/10/21', '2026-10-21'],
    ['2026/1/5', '2026-01-05'],
    ['Wednesday 2026-10-21', '2026-10-21'],
    ['Wednesday, 2026-10-21', '2026-10-21'],
    ['wed 2026-10-21', '2026-10-21'],
    ['Wed. 2026-10-21', '2026-10-21'],
    ['2026-10-21 (Wednesday)', '2026-10-21'],
    ['miércoles 2026-10-21', '2026-10-21'],
    ['2026-10-21 miercoles', '2026-10-21'],
    ['  2026-10-21  ', '2026-10-21'],
  ])('%s → %s', (raw, expected) => {
    expect(dateSlotIssue(raw)).toBeUndefined();
    expect(dateSlot.safeParse(raw).success).toBe(true);
    expect(toTenantDate(raw, NY)).toBe(expected);
  });

  it('the tenant timezone decides a zoned datetime\'s date', () => {
    expect(toTenantDate('2026-10-22T01:30:00Z', NY)).toBe('2026-10-21');
    expect(toTenantDate('2026-10-22T01:30:00Z', 'Europe/Madrid')).toBe('2026-10-22');
    expect(toTenantDate('2026-10-22T01:30:00Z', 'UTC')).toBe('2026-10-22');
  });
});

describe('date slot: ambiguous or wrong forms still fail with the same message', () => {
  it.each([
    ['10/21', DATE_FORMAT_MESSAGE],
    ['21/10/2026', DATE_FORMAT_MESSAGE],
    ['10/21/2026', DATE_FORMAT_MESSAGE],
    ['Wednesday', DATE_FORMAT_MESSAGE],
    ['next Wednesday', DATE_FORMAT_MESSAGE],
    ['tomorrow', DATE_FORMAT_MESSAGE],
    ['21-10-2026', DATE_FORMAT_MESSAGE],
    ['2026-10-21T25:00', DATE_FORMAT_MESSAGE],
    ['2026-10-21T09:00+25:00', DATE_FORMAT_MESSAGE],
    ['Someday 2026-10-21', DATE_FORMAT_MESSAGE],
    ['', DATE_FORMAT_MESSAGE],
    ['2026-02-30', NOT_A_REAL_DATE_MESSAGE],
    ['2026/02/30', NOT_A_REAL_DATE_MESSAGE],
    ['2026-02-30T10:00:00Z', NOT_A_REAL_DATE_MESSAGE],
    // A weekday that isn't that date's could mean either: refuse.
    ['Tuesday 2026-10-21', WEEKDAY_MISMATCH_MESSAGE],
    ['2026-10-21 (jueves)', WEEKDAY_MISMATCH_MESSAGE],
  ])('%s → refused', (raw, message) => {
    expect(dateSlotIssue(raw)).toBe(message);
    const parsed = dateSlot.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe(message);
    expect(() => toTenantDate(raw, NY)).toThrow(message);
  });
});

describe('date slot in the actions', () => {
  const base = { serviceIds: ['svc-1'], staffId: 'any' };

  it('check_availability accepts a variant for date and window, and still refuses an ambiguous one', () => {
    const input = checkAvailabilityAction.input;
    expect(input.safeParse({ ...base, date: '2026-10-21T09:00:00-04:00' }).success).toBe(true);
    expect(input.safeParse({ ...base, window: { from: '2026/10/21', to: 'Friday 2026-10-23' } }).success).toBe(true);
    const bad = input.safeParse({ ...base, date: '10/21' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]).toMatchObject({ path: ['date'], message: DATE_FORMAT_MESSAGE });
  });

  it('the window checks compare the dates the variants name', () => {
    const input = checkAvailabilityAction.input;
    const backwards = input.safeParse({ ...base, window: { from: '2026/10/23', to: '2026-10-21T09:00' } });
    expect(backwards.success).toBe(false);
    if (!backwards.success) expect(backwards.error.issues[0]?.message).toBe('window.to is before window.from');
    const long = input.safeParse({ ...base, window: { from: '2026-10-01', to: '2026/10/20' } });
    expect(long.success).toBe(false);
    if (!long.success) expect(long.error.issues[0]?.message).toBe('A window covers at most 14 days');
  });

  it('find_bookings accepts the same variants for its date', () => {
    const input = findBookingsAction.input;
    expect(input.safeParse({ phone: '+15550100142', name: 'Dana', date: '2026/10/21' }).success).toBe(true);
    expect(input.safeParse({ phone: '+15550100142', name: 'Dana', date: 'Wednesday' }).success).toBe(false);
  });
});

describe('date slot descriptions name the format', () => {
  it('the shared wording: YYYY-MM-DD in the tenant\'s timezone, today from get_current_tenant_time', () => {
    expect(DATE_SLOT_FORMAT).toMatch(/^YYYY-MM-DD\b/);
    expect(DATE_SLOT_FORMAT).toContain("tenant's timezone");
    expect(DATE_SLOT_FORMAT).toContain('get_current_tenant_time');
  });

  it('check_availability and find_bookings tool descriptions carry it', () => {
    expect(toAgentToolSchema(checkAvailabilityAction).description).toContain(DATE_SLOT_FORMAT);
    expect(toAgentToolSchema(findBookingsAction).description).toContain(DATE_SLOT_FORMAT);
  });

  it('booking.find@1 marks its date slot as a date', () => {
    expect(BOOKING_FIND_V1.slots.find((slot) => slot.name === 'date')?.format).toBe('date');
  });
});
