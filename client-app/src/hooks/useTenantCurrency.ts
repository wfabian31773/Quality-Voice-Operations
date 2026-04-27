import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

interface TenantMeResponse {
  tenant?: {
    id: string;
    billing_currency?: string | null;
  };
}

const DEFAULT_CURRENCY = 'USD';

function normalizeCurrency(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return DEFAULT_CURRENCY;
  const trimmed = value.trim().toUpperCase();
  if (trimmed.length !== 3) return DEFAULT_CURRENCY;
  return trimmed;
}

/**
 * Returns the current tenant's billing currency code (e.g. "USD", "EUR", "GBP")
 * for use with formatCents/formatCurrency. Falls back to "USD" until the
 * tenant has loaded or if the request fails.
 *
 * Pass an explicit override (e.g. a `currency` field returned alongside an
 * analytics payload, like the per-tenant admin views) to display data from
 * a different tenant in its own billing currency.
 */
export function useTenantCurrency(override?: string | null): string {
  const { user } = useAuth();

  const { data } = useQuery({
    queryKey: ['tenant-billing-currency', user?.tenantId ?? null],
    queryFn: () => api.get<TenantMeResponse>('/tenants/me'),
    enabled: !!user?.tenantId,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });

  if (override) return normalizeCurrency(override);
  return normalizeCurrency(data?.tenant?.billing_currency);
}
