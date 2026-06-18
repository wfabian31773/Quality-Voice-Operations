import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));

vi.mock('../db', () => ({ getPlatformPool: () => ({ query: a.poolQueryMock }) }));
vi.mock('../core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import {
  evaluateSmsQuietHours, nextSmsWindowStart, getEffectiveSmsQuietHoursWindow,
  evaluateSmsQuietHoursForTenant, nextSmsWindowStartForTenant, formatSmsQuietHoursWindow,
  clearSmsQuietHoursCache, SMS_QUIET_HOURS_WINDOW_START, SMS_QUIET_HOURS_WINDOW_END,
} from './SmsQuietHours';

// New York number (212) → America/New_York. In June it's EDT (UTC-4).
const NY = '+12125550123';
const INSIDE = new Date('2026-06-15T18:00:00Z'); // 14:00 local — inside 08:00–21:00
const OUTSIDE = new Date('2026-06-15T06:00:00Z'); // 02:00 local — quiet hours

beforeEach(() => {
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  clearSmsQuietHoursCache();
});

describe('evaluateSmsQuietHours', () => {
  it('allows a send inside the federal window', () => {
    expect(evaluateSmsQuietHours(NY, INSIDE).allowed).toBe(true);
  });
  it('blocks a send during quiet hours', () => {
    expect(evaluateSmsQuietHours(NY, OUTSIDE).allowed).toBe(false);
  });
  it('honours a narrowed window override', () => {
    // 14:00 local is outside a 08:00–13:00 window → blocked.
    expect(evaluateSmsQuietHours(NY, INSIDE, { start: '08:00', end: '13:00' }).allowed).toBe(false);
  });
});

describe('nextSmsWindowStart', () => {
  it('returns now unchanged when already inside the window', () => {
    expect(nextSmsWindowStart(NY, INSIDE).getTime()).toBe(INSIDE.getTime());
  });
  it('returns a future instant when outside the window', () => {
    const next = nextSmsWindowStart(NY, OUTSIDE);
    expect(next.getTime()).toBeGreaterThan(OUTSIDE.getTime());
  });
});

describe('getEffectiveSmsQuietHoursWindow', () => {
  it('returns the federal default when there is no tenant row', async () => {
    const w = await getEffectiveSmsQuietHoursWindow('t1');
    expect(w).toMatchObject({ start: SMS_QUIET_HOURS_WINDOW_START, end: SMS_QUIET_HOURS_WINDOW_END, isTenantOverride: false });
  });
  it('keeps a tenant window that is tighter than the federal floor', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ sms_quiet_hours_start: '09:00:00', sms_quiet_hours_end: '20:00:00' }] });
    const w = await getEffectiveSmsQuietHoursWindow('t2');
    expect(w).toMatchObject({ start: '09:00', end: '20:00', isTenantOverride: true });
  });
  it('clamps a looser tenant window back to the federal bounds', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ sms_quiet_hours_start: '06:00:00', sms_quiet_hours_end: '23:00:00' }] });
    const w = await getEffectiveSmsQuietHoursWindow('t3');
    expect(w).toMatchObject({ start: SMS_QUIET_HOURS_WINDOW_START, end: SMS_QUIET_HOURS_WINDOW_END, isTenantOverride: false });
  });
  it('caches the result within the TTL', async () => {
    await getEffectiveSmsQuietHoursWindow('t4');
    await getEffectiveSmsQuietHoursWindow('t4');
    expect(a.poolQueryMock).toHaveBeenCalledTimes(1);
  });
  it('falls back to the federal default on a query error', async () => {
    a.poolQueryMock.mockRejectedValue(new Error('db down'));
    const w = await getEffectiveSmsQuietHoursWindow('t5');
    expect(w.isTenantOverride).toBe(false);
  });
});

describe('tenant-aware variants', () => {
  it('evaluateSmsQuietHoursForTenant uses the effective window', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ sms_quiet_hours_start: '08:00:00', sms_quiet_hours_end: '13:00:00' }] });
    expect((await evaluateSmsQuietHoursForTenant('t6', NY, INSIDE)).allowed).toBe(false);
  });
  it('nextSmsWindowStartForTenant returns a Date', async () => {
    expect(await nextSmsWindowStartForTenant('t7', NY, INSIDE)).toBeInstanceOf(Date);
  });
});

describe('formatSmsQuietHoursWindow', () => {
  it('renders the window for display', () => {
    expect(formatSmsQuietHoursWindow({ start: '08:00', end: '21:00', isTenantOverride: false })).toBe('08:00–21:00 local');
  });
});
