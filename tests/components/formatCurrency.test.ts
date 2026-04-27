import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  formatCents,
  formatDollars,
} from '../../client-app/src/lib/formatCurrency';

const NBSP = '\u00a0';

function normalize(s: string): string {
  return s.replace(/\u00a0/g, ' ');
}

describe('formatCurrency', () => {
  it('formats integer cents as USD by default', () => {
    expect(normalize(formatCurrency(1234))).toBe('$12.34');
  });

  it('treats values as dollars when unit=dollars', () => {
    expect(normalize(formatCurrency(12.34, { unit: 'dollars' }))).toBe('$12.34');
  });

  it('does NOT divide dollar values by 100 (regression: BL-023 100x bug)', () => {
    // 12.34 dollars should render as $12.34, not $0.12
    expect(normalize(formatCurrency(12.34, { unit: 'dollars' }))).toBe('$12.34');
    // 1234 cents should render as $12.34, not $1234.00
    expect(normalize(formatCurrency(1234, { unit: 'cents' }))).toBe('$12.34');
  });

  it('returns the fallback for null and undefined', () => {
    expect(formatCurrency(null)).toBe('\u2014');
    expect(formatCurrency(undefined)).toBe('\u2014');
    expect(formatCurrency(null, { fallback: 'n/a' })).toBe('n/a');
  });

  it('returns the fallback for non-numeric strings', () => {
    expect(formatCurrency('not a number')).toBe('\u2014');
    expect(formatCurrency('')).toBe('\u2014');
  });

  it('parses numeric strings', () => {
    expect(normalize(formatCurrency('1234'))).toBe('$12.34');
  });

  it('handles bigint cents', () => {
    expect(normalize(formatCurrency(123456n))).toBe('$1,234.56');
  });

  it('handles negative values with sign', () => {
    expect(normalize(formatCurrency(-500))).toBe('-$5.00');
  });

  it('respects minimum/maximum fraction digits', () => {
    expect(
      normalize(formatCurrency(1234, { minimumFractionDigits: 0, maximumFractionDigits: 0 })),
    ).toBe('$12');
  });

  it('supports compact notation for large amounts', () => {
    const out = normalize(
      formatCurrency(1_234_500_00, {
        compact: true,
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }),
    );
    // Intl renders something like "$1.2M"
    expect(out).toMatch(/^\$1\.2M$/);
  });

  it('supports non-USD currencies', () => {
    const out = formatCurrency(1234, { currency: 'EUR', locale: 'en-US' });
    expect(out).toContain('12.34'); // €12.34
  });

  it('respects the locale', () => {
    const out = formatCurrency(123456, { locale: 'de-DE', currency: 'EUR' });
    // de-DE typically renders 1.234,56 €
    expect(out).toMatch(/1\.234,56/);
  });

  it('formatCents is a cents-only alias', () => {
    expect(normalize(formatCents(1000))).toBe('$10.00');
    expect(normalize(formatCents(0))).toBe('$0.00');
    expect(formatCents(null)).toBe('\u2014');
  });

  it('formatDollars is a dollars-only alias', () => {
    expect(normalize(formatDollars(10))).toBe('$10.00');
    expect(normalize(formatDollars(0))).toBe('$0.00');
    expect(formatDollars(null)).toBe('\u2014');
  });

  it('preserves NBSP separators where Intl emits them', () => {
    // Some locales separate currency symbol with NBSP. Sanity-check the raw string:
    const out = formatCurrency(123456, { locale: 'de-DE', currency: 'EUR' });
    expect(out.includes(NBSP) || out.includes(' ')).toBe(true);
  });
});
