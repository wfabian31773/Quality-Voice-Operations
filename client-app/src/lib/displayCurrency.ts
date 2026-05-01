import { useEffect, useState } from 'react';

// Display-currency helpers for the public marketing pages. Converts
// published USD prices into a visitor-picked currency for /pricing,
// /signup, and the ROI calculator. FX rates are indicative; final
// invoicing happens through Stripe in the tenant's billing currency.

export interface DisplayCurrency {
  code: string;
  name: string;
  symbol: string;
  fxFromUsd: number;
  rounding: number;
}

export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = [
  { code: 'USD', name: 'US Dollar', symbol: '$', fxFromUsd: 1, rounding: 1 },
  { code: 'EUR', name: 'Euro', symbol: '€', fxFromUsd: 0.92, rounding: 1 },
  { code: 'GBP', name: 'British Pound', symbol: '£', fxFromUsd: 0.79, rounding: 1 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', fxFromUsd: 1.36, rounding: 1 },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', fxFromUsd: 1.52, rounding: 1 },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', fxFromUsd: 1.65, rounding: 1 },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', fxFromUsd: 0.88, rounding: 1 },
  { code: 'SEK', name: 'Swedish Krona', symbol: 'kr', fxFromUsd: 10.4, rounding: 5 },
  { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr', fxFromUsd: 10.6, rounding: 5 },
  { code: 'DKK', name: 'Danish Krone', symbol: 'kr', fxFromUsd: 6.85, rounding: 5 },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', fxFromUsd: 150, rounding: 100 },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', fxFromUsd: 1.35, rounding: 1 },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', fxFromUsd: 7.81, rounding: 5 },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', fxFromUsd: 83, rounding: 50 },
  { code: 'MXN', name: 'Mexican Peso', symbol: 'Mex$', fxFromUsd: 17.5, rounding: 10 },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', fxFromUsd: 5.05, rounding: 1 },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R', fxFromUsd: 18.5, rounding: 5 },
  { code: 'AED', name: 'UAE Dirham', symbol: 'AED', fxFromUsd: 3.67, rounding: 1 },
];

export const DISPLAY_CURRENCY_BY_CODE: Record<string, DisplayCurrency> = Object.fromEntries(
  DISPLAY_CURRENCIES.map((c) => [c.code, c]),
);

export const DEFAULT_DISPLAY_CURRENCY = 'USD';

export const DISPLAY_CURRENCY_STORAGE_KEY = 'qvo:display_currency';

const CHANGE_EVENT = 'qvo:display-currency-change';

const REGION_TO_CURRENCY: Record<string, string> = {
  US: 'USD',
  GB: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR',
  IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR',
  FI: 'EUR', GR: 'EUR', LU: 'EUR', LT: 'EUR', LV: 'EUR',
  EE: 'EUR', SK: 'EUR', SI: 'EUR', CY: 'EUR', MT: 'EUR',
  CA: 'CAD', AU: 'AUD', NZ: 'NZD', CH: 'CHF',
  SE: 'SEK', NO: 'NOK', DK: 'DKK', JP: 'JPY',
  SG: 'SGD', HK: 'HKD', IN: 'INR', MX: 'MXN',
  BR: 'BRL', ZA: 'ZAR', AE: 'AED',
};

export function isSupportedDisplayCurrency(code: string | null | undefined): boolean {
  if (!code || typeof code !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(DISPLAY_CURRENCY_BY_CODE, code);
}

/**
 * Inspects `navigator.languages` (then `Intl.DateTimeFormat().resolvedOptions().locale`)
 * for a region tag like `en-GB` and maps it to a supported currency.
 * Falls back to `USD` when nothing is recognized.
 */
export function detectBrowserCurrency(): string {
  if (typeof window === 'undefined') return DEFAULT_DISPLAY_CURRENCY;
  try {
    const candidates: string[] = [];
    if (typeof navigator !== 'undefined') {
      if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
      if (navigator.language) candidates.push(navigator.language);
    }
    try {
      const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
      if (intlLocale) candidates.push(intlLocale);
    } catch {
      // Intl not available; fall through.
    }
    for (const tag of candidates) {
      if (!tag) continue;
      const region = tag.split(/[-_]/)[1]?.toUpperCase();
      if (region && REGION_TO_CURRENCY[region]) return REGION_TO_CURRENCY[region];
    }
  } catch {
    // Defensive — never let detection throw.
  }
  return DEFAULT_DISPLAY_CURRENCY;
}

export function getStoredDisplayCurrency(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(DISPLAY_CURRENCY_STORAGE_KEY);
    if (v && isSupportedDisplayCurrency(v)) return v;
  } catch {
    // localStorage may be unavailable (Safari private mode, etc).
  }
  return null;
}

export function setStoredDisplayCurrency(code: string): void {
  if (typeof window === 'undefined') return;
  if (!isSupportedDisplayCurrency(code)) return;
  try {
    window.localStorage.setItem(DISPLAY_CURRENCY_STORAGE_KEY, code);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: code }));
  } catch {
    // Swallow — picker still works in-memory via React state.
  }
}

export function resolveInitialDisplayCurrency(): string {
  const stored = getStoredDisplayCurrency();
  if (stored) return stored;
  return detectBrowserCurrency();
}

/**
 * React hook that returns the current public-display currency code and
 * a setter. Subscribes to the `qvo:display-currency-change` event and
 * to cross-tab `storage` events so flipping the picker on one page
 * updates every other mounted picker/price on the same site.
 */
export function useDisplayCurrency(): [string, (code: string) => void] {
  const [code, setCode] = useState<string>(() => resolveInitialDisplayCurrency());

  useEffect(() => {
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<string>).detail;
      if (next && isSupportedDisplayCurrency(next)) setCode(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DISPLAY_CURRENCY_STORAGE_KEY) return;
      if (e.newValue && isSupportedDisplayCurrency(e.newValue)) {
        setCode(e.newValue);
      }
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const set = (next: string) => {
    if (!isSupportedDisplayCurrency(next)) return;
    setStoredDisplayCurrency(next);
    setCode(next);
  };

  return [code, set];
}

function roundToNearest(value: number, step: number): number {
  if (!Number.isFinite(value)) return 0;
  if (step <= 0) return Math.round(value);
  return Math.round(value / step) * step;
}

/**
 * Convert a USD amount to the picked currency, rounded to the
 * currency's preferred step so the figure reads like a published
 * price ($399 → ¥60,000, not ¥59,850).
 */
export function convertUsd(amountUsd: number, currencyCode: string): number {
  const c = DISPLAY_CURRENCY_BY_CODE[currencyCode] ?? DISPLAY_CURRENCY_BY_CODE[DEFAULT_DISPLAY_CURRENCY];
  if (!Number.isFinite(amountUsd)) return 0;
  return roundToNearest(amountUsd * c.fxFromUsd, c.rounding);
}

/**
 * Rate-precision conversion: same FX, no rounding to whole units.
 * Used for per-minute / per-message prices where the precision
 * matters (e.g. $0.075/min → €0.069/min).
 */
export function convertUsdRate(amountUsd: number, currencyCode: string): number {
  const c = DISPLAY_CURRENCY_BY_CODE[currencyCode] ?? DISPLAY_CURRENCY_BY_CODE[DEFAULT_DISPLAY_CURRENCY];
  if (!Number.isFinite(amountUsd)) return 0;
  return amountUsd * c.fxFromUsd;
}

export interface FormatPublicPriceOptions {
  fractionDigits?: number;
  precise?: boolean;
  locale?: string;
}

export function formatPublicPrice(
  amountUsd: number,
  currencyCode: string,
  options: FormatPublicPriceOptions = {},
): string {
  const c = DISPLAY_CURRENCY_BY_CODE[currencyCode] ?? DISPLAY_CURRENCY_BY_CODE[DEFAULT_DISPLAY_CURRENCY];
  const value = options.precise
    ? convertUsdRate(amountUsd, c.code)
    : convertUsd(amountUsd, c.code);
  const fraction = options.fractionDigits ?? 0;
  try {
    return new Intl.NumberFormat(options.locale ?? 'en-US', {
      style: 'currency',
      currency: c.code,
      minimumFractionDigits: fraction,
      maximumFractionDigits: fraction,
    }).format(value);
  } catch {
    return `${c.symbol}${value.toFixed(fraction)}`;
  }
}

/**
 * Whether the given currency renders converted (approximate) figures
 * vs the canonical USD source. Used to gate the "≈" prefix /
 * "approximate conversion" disclaimer next to converted prices.
 */
export function isApproximateCurrency(code: string): boolean {
  return code !== DEFAULT_DISPLAY_CURRENCY && isSupportedDisplayCurrency(code);
}

/** Lowercase ISO-4217 form, matching the `tenants.billing_currency` column. */
export function toBillingCurrencyCode(displayCode: string): string {
  if (!isSupportedDisplayCurrency(displayCode)) return DEFAULT_DISPLAY_CURRENCY.toLowerCase();
  return displayCode.toLowerCase();
}
