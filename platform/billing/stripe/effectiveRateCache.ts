import { getTenantEffectiveRate, type TenantEffectiveRate } from './effectiveRate';

// Short-lived per-tenant cache so per-minute usage recording doesn't fan
// out one `stripe.subscriptions.retrieve` per call finalisation.
const RATE_CACHE_TTL_MS = (() => {
  const raw = parseInt(process.env.TENANT_RATE_CACHE_TTL_MS ?? '60000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

interface CachedRate {
  expiresAt: number;
  promise: Promise<TenantEffectiveRate>;
}

const rateCache = new Map<string, CachedRate>();

export async function getCachedTenantEffectiveRate(
  tenantId: string,
): Promise<TenantEffectiveRate> {
  const now = Date.now();
  const cached = rateCache.get(tenantId);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = getTenantEffectiveRate(tenantId).catch((err) => {
    // Don't cache a rejected promise.
    rateCache.delete(tenantId);
    throw err;
  });
  rateCache.set(tenantId, { expiresAt: now + RATE_CACHE_TTL_MS, promise });
  return promise;
}

export function clearTenantEffectiveRateCache(): void {
  rateCache.clear();
}
