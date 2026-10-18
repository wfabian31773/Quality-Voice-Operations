import { describe, expect, it } from 'vitest';
import { METRICS_TIME_ZONE, dayBounds, dayOf } from './nyDay';

describe('New York day boundaries', () => {
  it('is America/New_York, explicitly', () => {
    expect(METRICS_TIME_ZONE).toBe('America/New_York');
  });

  it('an EDT day is 04:00Z to 04:00Z', () => {
    const { start, end } = dayBounds('2026-10-17');
    expect(start.toISOString()).toBe('2026-10-17T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-18T04:00:00.000Z');
  });

  it('an EST day is 05:00Z to 05:00Z', () => {
    const { start, end } = dayBounds('2026-12-01');
    expect(start.toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-12-02T05:00:00.000Z');
  });

  it('the spring-forward day is 23 hours and the fall-back day 25', () => {
    const spring = dayBounds('2026-03-08');
    expect(spring.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(spring.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    const fall = dayBounds('2026-11-01');
    expect(fall.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(fall.end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('crosses month and year ends', () => {
    expect(dayBounds('2026-12-31').end.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });

  it('dayOf names the New York date of an instant', () => {
    expect(dayOf(new Date('2026-10-18T03:59:59.999Z'))).toBe('2026-10-17');
    expect(dayOf(new Date('2026-10-18T04:00:00.000Z'))).toBe('2026-10-18');
    expect(dayOf(new Date('2026-11-02T04:30:00.000Z'))).toBe('2026-11-01');
  });

  it('rejects anything but a real YYYY-MM-DD', () => {
    expect(() => dayBounds('2026-02-30')).toThrow(/day/);
    expect(() => dayBounds('2026-1-5')).toThrow(/day/);
  });
});
