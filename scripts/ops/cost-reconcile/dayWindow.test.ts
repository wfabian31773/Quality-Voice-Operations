import { describe, expect, it } from 'vitest';

import { dayWindow, isInWindow, utcDatesCovering } from './dayWindow';

describe('dayWindow (America/New_York)', () => {
  it('is local midnight to local midnight on an EDT day', () => {
    const w = dayWindow('2026-10-15');
    expect([w.startUtc, w.endUtc]).toEqual(['2026-10-15T04:00:00.000Z', '2026-10-16T04:00:00.000Z']);
  });

  it('is UTC-5 in winter', () => {
    const w = dayWindow('2026-12-01');
    expect([w.startUtc, w.endUtc]).toEqual(['2026-12-01T05:00:00.000Z', '2026-12-02T05:00:00.000Z']);
  });

  it('is 23 hours on spring-forward day and 25 on fall-back day', () => {
    const spring = dayWindow('2026-03-08');
    expect([spring.startUtc, spring.endUtc]).toEqual(['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z']);
    const fall = dayWindow('2026-11-01');
    expect([fall.startUtc, fall.endUtc]).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']);
  });

  it('is half-open', () => {
    const w = dayWindow('2026-10-15');
    expect(isInWindow('2026-10-15T04:00:00.000Z', w)).toBe(true);
    expect(isInWindow('2026-10-16T03:59:59.999Z', w)).toBe(true);
    expect(isInWindow('2026-10-16T04:00:00.000Z', w)).toBe(false);
    expect(isInWindow('not a date', w)).toBe(false);
  });

  it('lists the UTC dates the local day touches', () => {
    expect(utcDatesCovering(dayWindow('2026-10-15'))).toEqual(['2026-10-15', '2026-10-16']);
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => dayWindow('2026-1-5')).toThrow();
    expect(() => dayWindow('2026-02-30')).toThrow();
  });
});
