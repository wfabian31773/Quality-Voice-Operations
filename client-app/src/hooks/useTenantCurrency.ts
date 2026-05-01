import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isSupportedDisplayCurrency } from '../lib/displayCurrency';

interface TenantMeResponse {
  tenant?: {
    id: string;
    billing_currency?: string | null;
  };
}

const DEFAULT_CURRENCY = 'USD';
const SIGNUP_BILLING_CURRENCY_KEY = 'qvo:signup_billing_currency';

function normalizeCurrency(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return DEFAULT_CURRENCY;
  const trimmed = value.trim().toUpperCase();
  if (trimmed.length !== 3) return DEFAULT_CURRENCY;
  return trimmed;
}

// Consume a one-shot session flag set by the public signup form
// immediately before it routed into the app, so the first
// post-signup render uses the currency the user just picked
// (no USD flash while /tenants/me is in flight). The flag is
// scoped to the active browser session and cleared on first
// read so it never leaks into subsequent logins.
function consumeSignupBillingCurrency(): TenantMeResponse | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.sessionStorage.getItem(SIGNUP_BILLING_CURRENCY_KEY);
    if (!raw) return undefined;
    window.sessionStorage.removeItem(SIGNUP_BILLING_CURRENCY_KEY);
    const upper = raw.trim().toUpperCase();
    if (!isSupportedDisplayCurrency(upper)) return undefined;
    return { tenant: { id: '', billing_currency: upper } };
  } catch {
    return undefined;
  }
}

/**
 * Returns the current tenant's billing currency code (e.g. "USD",
 * "EUR", "GBP") for use with formatCents/formatCurrency. Falls back
 * to "USD" until the tenant has loaded or if the request fails.
 *
 * Pass an explicit override (e.g. a `currency` field returned with
 * an analytics payload) to display a different tenant in its own
 * billing currency.
 */
export function useTenantCurrency(override?: string | null): string {
  const { user } = useAuth();

  const { data } = useQuery({
    queryKey: ['tenant-billing-currency', user?.tenantId ?? null],
    queryFn: () => api.get<TenantMeResponse>('/tenants/me'),
    enabled: !!user?.tenantId,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    initialData: consumeSignupBillingCurrency,
    initialDataUpdatedAt: 0,
  });

  if (override) return normalizeCurrency(override);
  return normalizeCurrency(data?.tenant?.billing_currency);
}
