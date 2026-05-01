/**
 * Unit coverage for the process-local Stripe price TTL cache in
 * `platform/billing/stripe/priceCache.ts`. The cache is consulted by
 * every `effectiveRate.ts` path that resolves a published Stripe price
 * (the `/pricing` page is the highest-volume caller), so the contract
 * we exercise here is:
 *
 *   1. A second call within the TTL satisfies from the cache and does
 *      NOT round-trip to Stripe (this is the latency win).
 *   2. Concurrent callers for the same price id collapse into a single
 *      Stripe round-trip (request coalescing).
 *   3. A rejected retrieval is NOT pinned for the TTL — the next caller
 *      gets a fresh attempt.
 *   4. `invalidateStripePrice(...)` (called from the `price.updated`
 *      webhook handler) drops the cached entry so the next call refreshes.
 *   5. After the TTL expires the cache refreshes from Stripe.
 *
 * The end-to-end "second `/pricing` load hits the cache, not Stripe"
 * assertion lives at the bottom of the file and exercises
 * `getTenantEffectiveRate` (the actual production caller).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pricesRetrieve = vi.fn();
const subscriptionsRetrieve = vi.fn();

type QueryHandler = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;
let queryHandler: QueryHandler = async () => ({ rows: [] });

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        const trimmed = sql.trimStart();
        if (
          trimmed.startsWith('BEGIN')
          || trimmed.startsWith('COMMIT')
          || trimmed.startsWith('ROLLBACK')
        ) {
          return { rows: [] };
        }
        return queryHandler(sql, values);
      }),
      release: vi.fn(),
    }),
  }),
  withTenantContext: vi.fn(async () => undefined),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    prices: { retrieve: pricesRetrieve },
    subscriptions: { retrieve: subscriptionsRetrieve },
  }),
}));

import {
  getCachedStripePrice,
  invalidateStripePrice,
  clearStripePriceCache,
  stripePriceCacheSizeForTesting,
} from '../../platform/billing/stripe/priceCache';
import { getStripeClient } from '../../platform/billing/stripe/client';
import { getTenantEffectiveRate } from '../../platform/billing/stripe/effectiveRate';
import { PLAN_CATALOG } from '../../shared/billing/planCatalog';

beforeEach(() => {
  pricesRetrieve.mockReset();
  subscriptionsRetrieve.mockReset();
  queryHandler = async () => ({ rows: [] });
  clearStripePriceCache();
  delete process.env.STRIPE_PRICE_CACHE_TTL_MS;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_ANNUAL;
  delete process.env.STRIPE_PRICE_PRO_AI_MINUTES;
  delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
  delete process.env.STRIPE_PRICE_STARTER_ANNUAL;
  delete process.env.STRIPE_PRICE_STARTER_AI_MINUTES;
});

afterEach(() => {
  vi.useRealTimers();
  clearStripePriceCache();
  delete process.env.STRIPE_PRICE_CACHE_TTL_MS;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_ANNUAL;
  delete process.env.STRIPE_PRICE_PRO_AI_MINUTES;
  delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
  delete process.env.STRIPE_PRICE_STARTER_ANNUAL;
  delete process.env.STRIPE_PRICE_STARTER_AI_MINUTES;
});

describe('getCachedStripePrice — TTL cache behaviour', () => {
  it('returns the same value for a second call within the TTL without re-calling Stripe', async () => {
    const stripePrice = {
      id: 'price_cached',
      unit_amount: 39_900,
      unit_amount_decimal: '39900',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month' },
      metadata: {},
    };
    pricesRetrieve.mockResolvedValueOnce(stripePrice);

    const stripe = getStripeClient();
    const first = await getCachedStripePrice(stripe, 'price_cached');
    const second = await getCachedStripePrice(stripe, 'price_cached');

    expect(first).toBe(stripePrice);
    expect(second).toBe(stripePrice);
    // The whole point of the cache: only one Stripe round-trip.
    expect(pricesRetrieve).toHaveBeenCalledTimes(1);
    expect(pricesRetrieve).toHaveBeenCalledWith('price_cached');
    expect(stripePriceCacheSizeForTesting()).toBe(1);
  });

  it('coalesces concurrent calls for the same price id into one Stripe round-trip', async () => {
    let resolveStripe: ((p: unknown) => void) | null = null;
    pricesRetrieve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStripe = resolve;
        }),
    );

    const stripe = getStripeClient();
    const callA = getCachedStripePrice(stripe, 'price_concurrent');
    const callB = getCachedStripePrice(stripe, 'price_concurrent');
    const callC = getCachedStripePrice(stripe, 'price_concurrent');

    expect(resolveStripe).not.toBeNull();
    const stripePrice = { id: 'price_concurrent', unit_amount: 100 };
    resolveStripe!(stripePrice);

    const [a, b, c] = await Promise.all([callA, callB, callC]);
    expect(a).toBe(stripePrice);
    expect(b).toBe(stripePrice);
    expect(c).toBe(stripePrice);
    // 3 callers, but only one round-trip — request coalescing kept the
    // burst from fanning out.
    expect(pricesRetrieve).toHaveBeenCalledTimes(1);
  });

  it('does not pin a rejected retrieval — the next caller retries against Stripe', async () => {
    pricesRetrieve.mockRejectedValueOnce(new Error('Stripe 503'));
    const stripePrice = { id: 'price_recover', unit_amount: 200 };
    pricesRetrieve.mockResolvedValueOnce(stripePrice);

    const stripe = getStripeClient();
    await expect(
      getCachedStripePrice(stripe, 'price_recover'),
    ).rejects.toThrow('Stripe 503');

    // The next caller should NOT receive a cached rejection.
    const recovered = await getCachedStripePrice(stripe, 'price_recover');
    expect(recovered).toBe(stripePrice);
    expect(pricesRetrieve).toHaveBeenCalledTimes(2);
  });

  it('invalidateStripePrice drops the cached entry so the next call refreshes from Stripe', async () => {
    const v1 = { id: 'price_evict', unit_amount: 100 };
    const v2 = { id: 'price_evict', unit_amount: 200 };
    pricesRetrieve.mockResolvedValueOnce(v1);
    pricesRetrieve.mockResolvedValueOnce(v2);

    const stripe = getStripeClient();
    expect(await getCachedStripePrice(stripe, 'price_evict')).toBe(v1);
    expect(pricesRetrieve).toHaveBeenCalledTimes(1);

    invalidateStripePrice('price_evict');
    expect(stripePriceCacheSizeForTesting()).toBe(0);

    expect(await getCachedStripePrice(stripe, 'price_evict')).toBe(v2);
    expect(pricesRetrieve).toHaveBeenCalledTimes(2);
  });

  it('refreshes from Stripe once the TTL expires', async () => {
    process.env.STRIPE_PRICE_CACHE_TTL_MS = '60000'; // 60s
    const v1 = { id: 'price_ttl', unit_amount: 100 };
    const v2 = { id: 'price_ttl', unit_amount: 150 };
    pricesRetrieve.mockResolvedValueOnce(v1);
    pricesRetrieve.mockResolvedValueOnce(v2);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T12:00:00Z'));

    const stripe = getStripeClient();
    expect(await getCachedStripePrice(stripe, 'price_ttl')).toBe(v1);

    // 30s in: still cached.
    vi.setSystemTime(new Date('2026-05-01T12:00:30Z'));
    expect(await getCachedStripePrice(stripe, 'price_ttl')).toBe(v1);
    expect(pricesRetrieve).toHaveBeenCalledTimes(1);

    // 70s in: TTL expired, refetch.
    vi.setSystemTime(new Date('2026-05-01T12:01:10Z'));
    expect(await getCachedStripePrice(stripe, 'price_ttl')).toBe(v2);
    expect(pricesRetrieve).toHaveBeenCalledTimes(2);
  });
});

describe('Stripe price cache — production wiring through /pricing', () => {
  it('a second /pricing-style getTenantEffectiveRate call hits the cache, not Stripe', async () => {
    // Subscription-less tenant on the Pro tier — the path that the public
    // /pricing page hits when no tenantId is present (defaults to Pro for
    // marketing). The function will look up the per-tier metered
    // AI-minutes price AND the published monthly/annual base prices via
    // `prices.retrieve`, all of which should be cached on the second call.
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_published';
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual_published';
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai_minutes_metered';

    queryHandler = async (sql) => {
      const trimmed = sql.trimStart();
      if (trimmed.startsWith('SELECT plan, stripe_subscription_id')) {
        return {
          rows: [
            {
              plan: 'pro',
              stripe_subscription_id: null,
              stripe_price_id: null,
              stripe_customer_id: null,
            },
          ],
        };
      }
      return { rows: [] };
    };

    pricesRetrieve.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_pro_ai_minutes_metered') {
        return {
          id: priceId,
          unit_amount: 9,
          unit_amount_decimal: '9',
          currency: 'usd',
          recurring: { usage_type: 'metered', interval: 'month' },
          metadata: { metric: 'ai_minutes' },
        };
      }
      if (priceId === 'price_pro_monthly_published') {
        return {
          id: priceId,
          unit_amount: 39_900,
          unit_amount_decimal: '39900',
          currency: 'usd',
          recurring: { usage_type: 'licensed', interval: 'month' },
          metadata: {},
        };
      }
      if (priceId === 'price_pro_annual_published') {
        return {
          id: priceId,
          unit_amount: 38_3040,
          unit_amount_decimal: '383040',
          currency: 'usd',
          recurring: { usage_type: 'licensed', interval: 'year' },
          metadata: {},
        };
      }
      throw new Error(`unexpected prices.retrieve(${priceId})`);
    });

    // First /pricing-style load — populates the cache.
    const first = await getTenantEffectiveRate('tenant-pricing-cache');
    const callsAfterFirst = pricesRetrieve.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(first.plan).toBe('pro');
    // The metered AI-minutes price came back at $0.09/min — confirms the
    // first load was real (not a no-op fallback) so the second-load hit
    // assertion below actually proves the cache works.
    expect(first.overageRatePerMinute).toBeCloseTo(0.09, 6);
    expect(first.basePriceCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);

    // Second /pricing-style load — should be served entirely from the
    // cache for every Stripe price id, with NO additional `prices.retrieve`
    // calls on the wire.
    const second = await getTenantEffectiveRate('tenant-pricing-cache');
    expect(pricesRetrieve.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toEqual(first);
  });

  it('after invalidateStripePrice fires, the next /pricing load refetches just that price', async () => {
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai_minutes_metered';

    queryHandler = async (sql) => {
      const trimmed = sql.trimStart();
      if (trimmed.startsWith('SELECT plan, stripe_subscription_id')) {
        return {
          rows: [
            {
              plan: 'pro',
              stripe_subscription_id: null,
              stripe_price_id: null,
              stripe_customer_id: null,
            },
          ],
        };
      }
      return { rows: [] };
    };

    let aiCallCount = 0;
    pricesRetrieve.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_pro_ai_minutes_metered') {
        aiCallCount += 1;
        return {
          id: priceId,
          unit_amount: aiCallCount === 1 ? 9 : 12,
          unit_amount_decimal: aiCallCount === 1 ? '9' : '12',
          currency: 'usd',
          recurring: { usage_type: 'metered', interval: 'month' },
          metadata: { metric: 'ai_minutes' },
        };
      }
      throw new Error(`unexpected prices.retrieve(${priceId})`);
    });

    const before = await getTenantEffectiveRate('tenant-invalidate');
    expect(before.overageRatePerMinute).toBeCloseTo(0.09, 6);
    expect(aiCallCount).toBe(1);

    // Cached — second call doesn't refetch.
    await getTenantEffectiveRate('tenant-invalidate');
    expect(aiCallCount).toBe(1);

    // Webhook-style invalidation — Stripe fires `price.updated` and we
    // bust the cache entry for that specific id.
    invalidateStripePrice('price_pro_ai_minutes_metered');

    const after = await getTenantEffectiveRate('tenant-invalidate');
    expect(aiCallCount).toBe(2);
    expect(after.overageRatePerMinute).toBeCloseTo(0.12, 6);
  });
});
