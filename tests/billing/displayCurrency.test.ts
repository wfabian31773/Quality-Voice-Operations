// @vitest-environment happy-dom
/**
 * Unit coverage for `client-app/src/lib/displayCurrency` — the helper
 * that powers the public marketing pages' currency picker. The picker
 * lets a visitor see published USD prices in their local currency
 * before signup, then ships the selection to `/auth/signup` so the
 * tenant lands in-app rendering the same currency without a USD
 * flash. The contract worth pinning is:
 *
 *  - `convertUsd` rounds to the per-currency step so the converted
 *    figure reads like a quoted price (e.g. ¥60,000, not ¥59,850).
 *  - `convertUsdRate` skips rounding so per-minute / per-message
 *    rates keep their precision.
 *  - `formatPublicPrice` uses Intl.NumberFormat with the chosen
 *    currency, falling back gracefully when Intl rejects the code.
 *  - `detectBrowserCurrency` maps `navigator.languages` regions to
 *    the curated allowlist and falls back to USD for unknown locales.
 *  - `toBillingCurrencyCode` lowercases supported codes (matching
 *    `tenants.billing_currency`) and falls back to `usd` otherwise.
 *  - `useDisplayCurrency` persists to localStorage and broadcasts a
 *    custom event so cross-component pickers stay in sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  DEFAULT_DISPLAY_CURRENCY,
  DISPLAY_CURRENCY_STORAGE_KEY,
  convertUsd,
  convertUsdRate,
  detectBrowserCurrency,
  formatPublicPrice,
  isApproximateCurrency,
  isSupportedDisplayCurrency,
  resolveInitialDisplayCurrency,
  toBillingCurrencyCode,
  useDisplayCurrency,
} from '../../client-app/src/lib/displayCurrency';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isSupportedDisplayCurrency', () => {
  it('accepts every code on the curated allowlist', () => {
    for (const code of ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR']) {
      expect(isSupportedDisplayCurrency(code)).toBe(true);
    }
  });

  it('rejects unknown / malformed inputs', () => {
    expect(isSupportedDisplayCurrency(null)).toBe(false);
    expect(isSupportedDisplayCurrency(undefined)).toBe(false);
    expect(isSupportedDisplayCurrency('')).toBe(false);
    expect(isSupportedDisplayCurrency('XYZ')).toBe(false);
    // Case-sensitive: the picker stores upper-case codes.
    expect(isSupportedDisplayCurrency('eur')).toBe(false);
  });
});

describe('convertUsd', () => {
  it('returns the original USD amount unchanged', () => {
    expect(convertUsd(399, 'USD')).toBe(399);
  });

  it('rounds to the currency-preferred step', () => {
    // EUR rounds to 1 → 399 * 0.92 = 367.08 → 367
    expect(convertUsd(399, 'EUR')).toBe(367);
    // JPY rounds to 100 → 399 * 150 = 59,850 → 59,800 (nearest 100).
    // The point is the figure is a clean step, not the raw FX result.
    const jpy = convertUsd(399, 'JPY');
    expect(jpy % 100).toBe(0);
    // Sanity check the magnitude.
    expect(jpy).toBeGreaterThanOrEqual(59_000);
    expect(jpy).toBeLessThanOrEqual(60_000);
  });

  it('falls back to USD for unknown currencies', () => {
    expect(convertUsd(99, 'XYZ')).toBe(99);
  });

  it('returns 0 for non-finite input', () => {
    expect(convertUsd(Number.NaN, 'EUR')).toBe(0);
    expect(convertUsd(Number.POSITIVE_INFINITY, 'EUR')).toBe(0);
  });
});

describe('convertUsdRate', () => {
  it('keeps full precision for rate-style amounts', () => {
    // Per-minute rates round to 0 under convertUsd for many currencies;
    // convertUsdRate must preserve precision.
    expect(convertUsd(0.075, 'EUR')).toBe(0);
    expect(convertUsdRate(0.075, 'EUR')).toBeCloseTo(0.075 * 0.92, 6);
  });
});

describe('formatPublicPrice', () => {
  it('renders Intl-formatted currency for the picked code', () => {
    const out = formatPublicPrice(99, 'EUR', { fractionDigits: 0 });
    // Locale-specific symbol placement varies, but EUR + a number
    // close to 91 must appear together.
    expect(out).toMatch(/€/);
    expect(out).toMatch(/91/);
  });

  it('uses precise mode for per-minute rates', () => {
    const out = formatPublicPrice(0.075, 'EUR', { fractionDigits: 3, precise: true });
    expect(out).toMatch(/€/);
    expect(out).toMatch(/0\.069/);
  });

  it('does not throw on unknown currency codes', () => {
    expect(() => formatPublicPrice(99, 'NOT-A-CODE', { fractionDigits: 0 })).not.toThrow();
  });
});

describe('detectBrowserCurrency', () => {
  function withNavigatorLanguages(languages: string[], run: () => void) {
    const original = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(navigator),
      'languages',
    );
    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      get: () => languages,
    });
    try {
      run();
    } finally {
      if (original) {
        Object.defineProperty(navigator, 'languages', original);
      } else {
        delete (navigator as unknown as { languages?: readonly string[] }).languages;
      }
    }
  }

  it('maps a UK locale to GBP', () => {
    withNavigatorLanguages(['en-GB', 'en-US'], () => {
      expect(detectBrowserCurrency()).toBe('GBP');
    });
  });

  it('maps a German locale to EUR', () => {
    withNavigatorLanguages(['de-DE'], () => {
      expect(detectBrowserCurrency()).toBe('EUR');
    });
  });

  it('falls back to USD for unknown locales', () => {
    withNavigatorLanguages(['xx-XX'], () => {
      expect(detectBrowserCurrency()).toBe('USD');
    });
  });
});

describe('toBillingCurrencyCode', () => {
  it('lowercases supported codes to match the tenants column', () => {
    expect(toBillingCurrencyCode('EUR')).toBe('eur');
    expect(toBillingCurrencyCode('USD')).toBe('usd');
  });

  it('falls back to usd for unsupported codes', () => {
    expect(toBillingCurrencyCode('XYZ')).toBe('usd');
  });
});

describe('isApproximateCurrency', () => {
  it('treats USD as the canonical currency (not approximate)', () => {
    expect(isApproximateCurrency('USD')).toBe(false);
  });

  it('treats every other supported currency as approximate', () => {
    expect(isApproximateCurrency('EUR')).toBe(true);
    expect(isApproximateCurrency('JPY')).toBe(true);
  });

  it('returns false for unsupported codes (no FX, no disclaimer)', () => {
    expect(isApproximateCurrency('XYZ')).toBe(false);
  });
});

describe('resolveInitialDisplayCurrency', () => {
  it('prefers a stored selection over locale detection', () => {
    window.localStorage.setItem(DISPLAY_CURRENCY_STORAGE_KEY, 'GBP');
    expect(resolveInitialDisplayCurrency()).toBe('GBP');
  });

  it('returns the default when storage is empty and locale unknown', () => {
    window.localStorage.clear();
    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      get: () => ['xx-XX'],
    });
    expect(resolveInitialDisplayCurrency()).toBe(DEFAULT_DISPLAY_CURRENCY);
  });
});

describe('useDisplayCurrency', () => {
  it('persists the selection and broadcasts a change event', () => {
    const { result } = renderHook(() => useDisplayCurrency());
    expect(typeof result.current[0]).toBe('string');

    act(() => {
      result.current[1]('EUR');
    });

    expect(result.current[0]).toBe('EUR');
    expect(window.localStorage.getItem(DISPLAY_CURRENCY_STORAGE_KEY)).toBe('EUR');
  });

  it('ignores attempts to set an unsupported code', () => {
    const { result } = renderHook(() => useDisplayCurrency());
    act(() => {
      result.current[1]('GBP');
    });
    const before = result.current[0];
    act(() => {
      result.current[1]('NOT-A-CODE');
    });
    expect(result.current[0]).toBe(before);
  });

  it('keeps two hook instances in sync via the change event', () => {
    const a = renderHook(() => useDisplayCurrency());
    const b = renderHook(() => useDisplayCurrency());
    act(() => {
      a.result.current[1]('GBP');
    });
    expect(b.result.current[0]).toBe('GBP');
  });
});
