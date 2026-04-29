/**
 * Canonical money helpers shared by the parts of the workspace that
 * cannot directly import from `client-app/src/lib/formatCurrency.ts` or
 * `platform/core/formatCurrency.ts` — namely `mobile/`, `widget/`,
 * `server/`, and the rest of `shared/`.
 *
 * All monetary values stored in the platform are integer cents. These
 * helpers are the single point of conversion to a presentation string
 * (or to/from whole-dollar numbers) so that no caller accidentally
 * divides cents by 100 twice (or forgets to divide at all). The custom
 * ESLint rules `local/no-cents-divided-by-100` and
 * `local/no-dollars-times-100` whitelist this file so the underlying
 * `cents / 100` and `dollars * 100` math is allowed to live here.
 */

export type CurrencyUnit = 'cents' | 'dollars';

export interface FormatCurrencyOptions {
  unit?: CurrencyUnit;
  currency?: string;
  locale?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  compact?: boolean;
  fallback?: string;
  signDisplay?: 'auto' | 'always' | 'never' | 'exceptZero';
}

const DEFAULTS = {
  unit: 'cents' as CurrencyUnit,
  currency: 'USD',
  locale: 'en-US',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  compact: false,
  fallback: '\u2014',
  signDisplay: 'auto' as const,
};

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'bigint') return Number(value);
  return null;
}

export function formatCurrency(
  value: number | string | bigint | null | undefined,
  options: FormatCurrencyOptions = {},
): string {
  const opts = { ...DEFAULTS, ...options };
  const numeric = toNumber(value);
  if (numeric === null) return opts.fallback;

  const dollars = opts.unit === 'cents' ? numeric / 100 : numeric;

  const intlOpts: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: opts.currency,
    minimumFractionDigits: opts.minimumFractionDigits,
    maximumFractionDigits: opts.maximumFractionDigits,
    signDisplay: opts.signDisplay,
  };
  if (opts.compact) {
    intlOpts.notation = 'compact';
    intlOpts.compactDisplay = 'short';
  }

  try {
    return new Intl.NumberFormat(opts.locale, intlOpts).format(dollars);
  } catch {
    const sign = dollars < 0 ? '-' : '';
    const abs = Math.abs(dollars);
    return `${sign}$${abs.toFixed(opts.maximumFractionDigits)}`;
  }
}

export function formatCents(
  cents: number | string | bigint | null | undefined,
  options: Omit<FormatCurrencyOptions, 'unit'> = {},
): string {
  return formatCurrency(cents, { ...options, unit: 'cents' });
}

export function formatDollars(
  dollars: number | string | bigint | null | undefined,
  options: Omit<FormatCurrencyOptions, 'unit'> = {},
): string {
  return formatCurrency(dollars, { ...options, unit: 'dollars' });
}

/**
 * Canonical dollars→integer-cents converter. Pair with `formatCurrency`
 * for the inverse direction. Returns `0` for null/undefined/empty/non-finite
 * input — matching the defensive `parseFloat(value || '0')` idiom this
 * helper is replacing.
 */
export function dollarsToCents(
  value: number | string | bigint | null | undefined,
): number {
  if (value == null) return 0;
  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'bigint') {
    numeric = Number(value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return 0;
    numeric = parseFloat(trimmed);
  } else {
    return 0;
  }
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

/**
 * Canonical integer-cents→whole-dollar-integer converter. Use for cases
 * (e.g. pricing-page round numbers) that need a whole-dollar primitive
 * rather than a formatted string. For presentation, prefer
 * `formatCents` / `formatCurrency` instead so the locale/currency
 * formatting is consistent.
 */
export function centsToWholeDollars(
  value: number | string | bigint | null | undefined,
): number {
  const numeric = toNumber(value);
  if (numeric === null) return 0;
  return Math.round(numeric / 100);
}
