import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  DEFAULT_AGENT_LANGUAGE,
  normalizeAgentLanguage,
} from '../lib/agentLanguages';

interface TenantMeResponse {
  tenant?: {
    id: string;
    settings?: Record<string, unknown> | null;
  };
}

/**
 * Returns the current tenant's primary language code (e.g. "en", "es", "de")
 * sourced from `tenant.settings.primaryLanguage`. Falls back to the default
 * agent language until the tenant has loaded or if the request fails.
 */
export function useTenantPrimaryLanguage(): string {
  const { user } = useAuth();

  const { data } = useQuery({
    queryKey: ['tenant-primary-language', user?.tenantId ?? null],
    queryFn: () => api.get<TenantMeResponse>('/tenants/me'),
    enabled: !!user?.tenantId,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });

  const settings = (data?.tenant?.settings ?? {}) as Record<string, unknown>;
  const raw = settings.primaryLanguage;
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_AGENT_LANGUAGE;
  return normalizeAgentLanguage(raw);
}
