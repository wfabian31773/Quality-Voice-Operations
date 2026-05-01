import type Stripe from 'stripe';
import { createLogger } from '../../core/logger';

const logger = createLogger('STRIPE_PRICE_CACHE');

/**
 * Short-lived process-local TTL cache for `stripe.prices.retrieve(...)` calls
 * keyed by Stripe price id.
 *
 * Why this exists:
 *   The public Pricing page resolves up to three published Stripe prices per
 *   tenant on every load (the metered AI-overage line plus the monthly /
 *   annual licensed prices). For tenants on the same plan those price ids
 *   are identical and the underlying `unit_amount` rarely changes, but we
 *   were re-fetching them on every request. A short TTL cache cuts the
 *   external API fan-out dramatically and trims p95 latency on /pricing
 *   without sacrificing freshness — Stripe price mutations fire a
 *   `price.updated` webhook (handled in `./webhook.ts`) which calls
 *   `invalidateStripePrice(...)` to bust the cached entry immediately.
 *
 * The cache stores the in-flight Promise rather than the resolved value so
 * a burst of concurrent /pricing loads collapses into a single Stripe
 * round-trip (request coalescing). Rejected promises are evicted from the
 * cache so a transient Stripe failure doesn't get pinned for the TTL.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — see `STRIPE_PRICE_CACHE_TTL_MS`.

function resolveTtlMs(): number {
  const raw = process.env.STRIPE_PRICE_CACHE_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return parsed;
}

interface CachedPrice {
  expiresAt: number;
  promise: Promise<Stripe.Price>;
}

const priceCache = new Map<string, CachedPrice>();

/**
 * Retrieve a Stripe price, consulting the in-process TTL cache first.
 *
 * Never throws on its own — propagates whatever `stripe.prices.retrieve`
 * throws so existing callers can keep their try/catch fallbacks intact.
 * On rejection the entry is removed from the cache so the next call gets
 * a fresh attempt rather than a TTL-pinned failure.
 */
export async function getCachedStripePrice(
  stripe: Stripe,
  priceId: string,
): Promise<Stripe.Price> {
  const now = Date.now();
  const cached = priceCache.get(priceId);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = stripe.prices.retrieve(priceId).catch((err) => {
    // Don't pin a rejected promise for the TTL — the next caller should
    // retry against Stripe instead of inheriting a stale failure.
    const current = priceCache.get(priceId);
    if (current && current.promise === promise) {
      priceCache.delete(priceId);
    }
    throw err;
  });

  priceCache.set(priceId, { expiresAt: now + resolveTtlMs(), promise });
  return promise;
}

/**
 * Drop the cached entry for `priceId`. Called from the Stripe webhook
 * handler on `price.updated` / `price.deleted` / `price.created` so a
 * mutation in Stripe is reflected in our pricing surfaces by the next
 * request rather than waiting out the TTL. Safe to call when the entry
 * is not in the cache.
 */
export function invalidateStripePrice(priceId: string): void {
  if (priceCache.delete(priceId)) {
    logger.info('Invalidated cached Stripe price', { priceId });
  }
}

/**
 * Drop every cached entry. Intended for tests so cache state from one
 * case cannot leak into the next, and for operational scripts that need
 * to force a full refresh.
 */
export function clearStripePriceCache(): void {
  priceCache.clear();
}

/**
 * Test-only helper: report the current cache size so unit tests can
 * assert that a second call within the TTL did not insert a new entry.
 */
export function stripePriceCacheSizeForTesting(): number {
  return priceCache.size;
}
