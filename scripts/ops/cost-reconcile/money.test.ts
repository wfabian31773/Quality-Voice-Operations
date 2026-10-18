import { describe, expect, it } from 'vitest';

import { centsPerMinute, centsStringToMicros, microsToCents, parseScaledDecimal, percentOf, roundDiv, usdStringToMicros } from './money';

describe('money', () => {
  it('parses Twilio prices to absolute micro-USD exactly', () => {
    expect(usdStringToMicros('-0.01700')).toBe(17_000);
    expect(usdStringToMicros('-0.0085')).toBe(8_500);
    expect(usdStringToMicros('0')).toBe(0);
    expect(usdStringToMicros('1.5')).toBe(1_500_000);
  });

  it('parses NUMERIC(10,4) cents to micros', () => {
    expect(centsStringToMicros('2.5500')).toBe(25_500);
  });

  it('rounds past the kept digits half away from zero and rejects junk', () => {
    expect(parseScaledDecimal('0.0000005', 6)).toBe(1);
    expect(parseScaledDecimal('-0.0000005', 6)).toBe(-1);
    expect(parseScaledDecimal('0.0000004', 6)).toBe(0);
    expect(() => parseScaledDecimal('1e-3', 6)).toThrow();
    expect(() => parseScaledDecimal('', 6)).toThrow();
    expect(() => parseScaledDecimal('.', 6)).toThrow();
  });

  it('rounds micros to cents half-up', () => {
    expect(microsToCents(5_000)).toBe(1);
    expect(microsToCents(4_999)).toBe(0);
    expect(microsToCents(265_500)).toBe(27);
    expect(roundDiv(-15, 10)).toBe(-2);
  });

  it('computes cents per minute and percent in integers', () => {
    expect(centsPerMinute(742_845, 510)).toBe(8.74);
    expect(centsPerMinute(1, 0)).toBeNull();
    expect(percentOf(270_845, 399_500)).toBe(67.8);
    expect(percentOf(1, 0)).toBeNull();
  });
});
