/**
 * Curated list of ISO 4217 currency codes that tenants may select as
 * their billing currency. The list is intentionally limited to common
 * fiat currencies that Stripe supports for both charges and payouts in
 * the major regions QVO targets, so an owner who flips this dropdown
 * never lands on a currency we cannot actually invoice in.
 *
 * Codes are stored lowercase in the database (matching `usd`,
 * `eur`, ...) to stay consistent with Stripe's API. The UI renders the
 * uppercase form to match how the rest of the app displays currency
 * codes (e.g. `USD`, `EUR`).
 */
export interface SupportedCurrency {
  /** Lowercase ISO 4217 code, e.g. `usd`. Matches the DB column shape. */
  code: string;
  /** Human-readable currency name. */
  name: string;
  /** Currency symbol shown alongside the code in the picker. */
  symbol: string;
}

export const SUPPORTED_BILLING_CURRENCIES: readonly SupportedCurrency[] = [
  { code: 'usd', name: 'US Dollar', symbol: '$' },
  { code: 'eur', name: 'Euro', symbol: '€' },
  { code: 'gbp', name: 'British Pound', symbol: '£' },
  { code: 'cad', name: 'Canadian Dollar', symbol: 'CA$' },
  { code: 'aud', name: 'Australian Dollar', symbol: 'A$' },
  { code: 'nzd', name: 'New Zealand Dollar', symbol: 'NZ$' },
  { code: 'chf', name: 'Swiss Franc', symbol: 'CHF' },
  { code: 'sek', name: 'Swedish Krona', symbol: 'kr' },
  { code: 'nok', name: 'Norwegian Krone', symbol: 'kr' },
  { code: 'dkk', name: 'Danish Krone', symbol: 'kr' },
  { code: 'jpy', name: 'Japanese Yen', symbol: '¥' },
  { code: 'sgd', name: 'Singapore Dollar', symbol: 'S$' },
  { code: 'hkd', name: 'Hong Kong Dollar', symbol: 'HK$' },
  { code: 'inr', name: 'Indian Rupee', symbol: '₹' },
  { code: 'mxn', name: 'Mexican Peso', symbol: 'Mex$' },
  { code: 'brl', name: 'Brazilian Real', symbol: 'R$' },
  { code: 'zar', name: 'South African Rand', symbol: 'R' },
  { code: 'aed', name: 'UAE Dirham', symbol: 'AED' },
];

const SUPPORTED_CODE_SET = new Set(
  SUPPORTED_BILLING_CURRENCIES.map((c) => c.code),
);

/**
 * Returns true when `code` matches one of the curated supported
 * currency codes. The check is case-insensitive and tolerant of
 * surrounding whitespace.
 */
export function isSupportedBillingCurrency(
  code: string | null | undefined,
): boolean {
  if (!code || typeof code !== 'string') return false;
  return SUPPORTED_CODE_SET.has(code.trim().toLowerCase());
}
