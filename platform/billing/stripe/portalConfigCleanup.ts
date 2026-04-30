/**
 * Periodic sweep that deactivates Stripe billing-portal configurations
 * we minted for the discount-headline badge once no active customer is
 * still using the coupon they were created for.
 *
 * Background: `resolveDiscountedPortalConfigId` (in `./checkout.ts`)
 * lazily creates a `billing_portal.configuration` every time a tenant
 * opens the customer portal under a *new* coupon — Stripe needs a
 * configuration object to override the page headline, and the headline
 * carries the per-tenant discount badge ("Active discount: 25% off —
 * PROMO25"). We tag every such configuration with
 * `metadata.purpose === 'discount_headline'` and stamp the originating
 * `couponId` / `promotionCodeId` so this sweep can match them back.
 *
 * Stripe portal configurations cannot be deleted via the public API —
 * they can only be deactivated (`active: false`). Once inactive they
 * disappear from the dashboard's default portal-configurations list,
 * which is the visual clutter we're cleaning up. Deactivation also
 * frees the configuration slot for our in-memory cache so a future
 * portal-open under the same coupon recreates a fresh active one.
 *
 * Match rules (in priority order):
 *   1. `metadata.couponId` is in the set of currently-active coupons on
 *      one of our tenant Stripe customers — KEEP.
 *   2. `metadata.promotionCodeId` is in the active set — KEEP.
 *   3. `metadata.headline` exactly matches a headline that
 *      `buildPortalDiscountHeadline` would produce for any currently
 *      active discount — KEEP. (Fallback for older configurations
 *      created before the coupon/promo metadata was stamped.)
 *   4. Otherwise — DEACTIVATE.
 *
 * The "active customer discount" set is built by walking the
 * `subscriptions` table for distinct `stripe_customer_id` values and
 * loading each customer's discount via the same path the portal /
 * checkout surfaces use (`loadActiveCustomerDiscount`), so the cleanup
 * judgement uses the same definition of "currently active" as the
 * surface that mints the configurations in the first place.
 */

import type Stripe from 'stripe';
import { getStripeClient } from './client';
import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import {
  loadActiveCustomerDiscount,
  type UpgradeDiscount,
} from './effectiveRate';
import {
  buildPortalDiscountHeadline,
  evictPortalConfigCacheById,
} from './checkout';

const logger = createLogger('PORTAL_CONFIG_CLEANUP');

/** Metadata.purpose value stamped by `resolveDiscountedPortalConfigId`. */
const DISCOUNT_HEADLINE_PURPOSE = 'discount_headline';

/** Stripe `configurations.list` page size cap is 100. */
const PORTAL_CONFIG_LIST_PAGE_SIZE = 100;

/**
 * Subscription statuses that count as "still being billed". A customer
 * in one of these states is actively consuming a discount that the
 * portal headline configuration was minted for, so we must keep that
 * configuration alive.
 *
 * Excluded statuses (`paused`, `cancelled`) are tenants whose Stripe
 * customer record may still carry a `discount` object (Stripe leaves
 * the discount attached after cancellation) but the tenant is no
 * longer being invoiced — the discount is dead weight from the
 * portal-headline cleanup's perspective. Counting them as "active"
 * would let stale coupons keep their portal configurations forever,
 * defeating the cleanup. See `migrations/008_billing.sql` for the full
 * `subscription_status` enum.
 */
const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const;

/**
 * Hard ceiling on how many active Stripe customers we will dereference
 * per cycle to build the "currently in use" set. We expect platform
 * tenant counts in the hundreds, well below this bound; the limit is
 * defensive in case a runaway INSERT into `subscriptions` ever queues
 * up tens of thousands of rows. When tripped we log a warning and
 * proceed with a partial active-set — the worst case is leaving a
 * still-in-use configuration deactivated, which the next portal open
 * for that coupon will silently re-create.
 */
const MAX_CUSTOMERS_PER_CYCLE = 5_000;

/**
 * Bounded concurrency for the per-customer discount lookups so we
 * don't burst Stripe's API rate limit when the active set is large.
 * `loadActiveCustomerDiscount` already swallows individual failures.
 */
const DISCOUNT_LOOKUP_CONCURRENCY = 4;

export interface PortalConfigCleanupResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Total Stripe portal configurations walked this cycle. */
  examinedConfigurations: number;
  /** Subset of those carrying `metadata.purpose === 'discount_headline'`. */
  candidateConfigurations: number;
  /** Active customer count we considered when building the in-use set. */
  customersConsidered: number;
  /** Distinct currently-active discount headlines we resolved. */
  activeHeadlinesCount: number;
  /** Distinct currently-active coupon ids we resolved. */
  activeCouponsCount: number;
  /** Configuration ids we deactivated this cycle. */
  deactivatedConfigurationIds: string[];
  /** Configuration ids we kept (still in use) this cycle. */
  keptConfigurationIds: string[];
  /** Per-configuration deactivation failures. */
  errors: Array<{ configurationId: string; error: string }>;
  /** Whether the customer iteration hit `MAX_CUSTOMERS_PER_CYCLE`. */
  truncatedActiveSet: boolean;
}

interface ActiveDiscountSet {
  headlines: Set<string>;
  couponIds: Set<string>;
  promotionCodeIds: Set<string>;
  customersConsidered: number;
  truncated: boolean;
}

async function buildActiveDiscountSet(stripe: Stripe): Promise<ActiveDiscountSet> {
  const pool = getPlatformPool();
  // Filter to subscription statuses that mean the tenant is still
  // being billed — those are the only customers whose Stripe-side
  // discount counts as "in use" by the portal headline. Cancelled and
  // paused subscriptions can leave a customer.discount intact on the
  // Stripe side (Stripe doesn't auto-clear the discount on cancel) but
  // the tenant is no longer paying, so any portal configuration minted
  // for that coupon is unambiguously stale. Without this filter,
  // long-churned customers would keep their stale coupons in the
  // active set forever and the cleanup would never deactivate
  // anything.
  // `subscriptions.status` is a Postgres enum (`subscription_status`,
  // see migrations/008_billing.sql). Postgres will not implicitly
  // compare an enum to a text[]; we must cast the bound text[] back to
  // the enum array type so `= ANY(...)` resolves to the enum equality
  // operator. Without this cast, the query fails at plan time with
  // "operator does not exist: subscription_status = text".
  const { rows } = await pool.query<{ stripe_customer_id: string | null }>(
    `SELECT DISTINCT stripe_customer_id
       FROM subscriptions
      WHERE stripe_customer_id IS NOT NULL
        AND status = ANY($1::subscription_status[])
      LIMIT $2`,
    [
      [...ACTIVE_SUBSCRIPTION_STATUSES],
      MAX_CUSTOMERS_PER_CYCLE + 1,
    ],
  );

  const customerIds = rows
    .map((r) => r.stripe_customer_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const truncated = customerIds.length > MAX_CUSTOMERS_PER_CYCLE;
  const consideredCustomerIds = truncated
    ? customerIds.slice(0, MAX_CUSTOMERS_PER_CYCLE)
    : customerIds;

  if (truncated) {
    logger.warn(
      'Active customer set capped for discount-headline cleanup; remaining customers skipped this cycle',
      {
        cap: MAX_CUSTOMERS_PER_CYCLE,
        observed: customerIds.length,
      },
    );
  }

  const headlines = new Set<string>();
  const couponIds = new Set<string>();
  const promotionCodeIds = new Set<string>();

  // Walk the customer list with bounded concurrency so we don't burst
  // Stripe's rate limit on accounts with thousands of paying tenants.
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= consideredCustomerIds.length) return;
      const customerId = consideredCustomerIds[idx];
      let discount: UpgradeDiscount | null = null;
      try {
        discount = await loadActiveCustomerDiscount(stripe, customerId, {
          tenantId: 'portal-config-cleanup',
          surface: 'portal_config_cleanup',
        });
      } catch {
        // `loadActiveCustomerDiscount` already swallows internally, but
        // belt-and-braces so a single rogue customer never aborts the
        // whole cycle.
        discount = null;
      }
      if (!discount) continue;

      const headline = buildPortalDiscountHeadline(discount);
      if (headline) headlines.add(headline);
      if (discount.couponId) couponIds.add(discount.couponId);
      if (discount.promotionCodeId) promotionCodeIds.add(discount.promotionCodeId);
    }
  }

  const workerCount = Math.min(
    DISCOUNT_LOOKUP_CONCURRENCY,
    Math.max(1, consideredCustomerIds.length),
  );
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  return {
    headlines,
    couponIds,
    promotionCodeIds,
    customersConsidered: consideredCustomerIds.length,
    truncated,
  };
}

/**
 * Run a single cleanup pass. Safe to invoke concurrently: every
 * Stripe operation is idempotent and the worst-case race is one redundant
 * `configurations.update({ active: false })` against an already-inactive
 * id, which Stripe accepts as a no-op.
 *
 * Never throws on individual configuration failures; per-config errors
 * are accumulated in the returned `errors` array so the caller (or the
 * scheduler snapshot) can surface them without aborting the rest of
 * the sweep.
 */
export async function runDiscountPortalConfigCleanup(): Promise<PortalConfigCleanupResult> {
  const startedAt = new Date();
  const stripe = getStripeClient();

  const activeSet = await buildActiveDiscountSet(stripe);

  let examinedConfigurations = 0;
  let candidateConfigurations = 0;
  const deactivatedConfigurationIds: string[] = [];
  const keptConfigurationIds: string[] = [];
  const errors: Array<{ configurationId: string; error: string }> = [];

  let startingAfter: string | undefined;
  // We only need to consider currently-active configurations: an
  // already-deactivated config is invisible in the dashboard's default
  // view, which is the surface the task is aimed at decluttering.
  for (;;) {
    const list = await stripe.billingPortal.configurations.list({
      limit: PORTAL_CONFIG_LIST_PAGE_SIZE,
      active: true,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const cfg of list.data) {
      examinedConfigurations += 1;
      const md = (cfg.metadata ?? {}) as Record<string, string | undefined>;
      if (md.purpose !== DISCOUNT_HEADLINE_PURPOSE) continue;
      candidateConfigurations += 1;

      const headline = typeof md.headline === 'string' ? md.headline : null;
      const couponId = typeof md.couponId === 'string' ? md.couponId : null;
      const promotionCodeId =
        typeof md.promotionCodeId === 'string' ? md.promotionCodeId : null;

      // Without a complete active set we can't safely judge configurations
      // whose customers we never dereferenced. Keep them this cycle so the
      // sweep degrades gracefully instead of mass-deactivating live coupons.
      if (activeSet.truncated) {
        keptConfigurationIds.push(cfg.id);
        continue;
      }

      const stillUsed =
        (couponId !== null && activeSet.couponIds.has(couponId)) ||
        (promotionCodeId !== null && activeSet.promotionCodeIds.has(promotionCodeId)) ||
        (headline !== null && activeSet.headlines.has(headline));

      if (stillUsed) {
        keptConfigurationIds.push(cfg.id);
        continue;
      }

      try {
        await stripe.billingPortal.configurations.update(cfg.id, {
          active: false,
        });
        deactivatedConfigurationIds.push(cfg.id);
        // Drop any in-process cache entry pointing to the now-dead
        // configuration so the next portal open recreates a fresh one
        // instead of trying to reuse a deactivated id.
        evictPortalConfigCacheById(cfg.id);
        logger.info('Deactivated unused discount portal configuration', {
          configurationId: cfg.id,
          headline,
          couponId,
          promotionCodeId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ configurationId: cfg.id, error: message });
        logger.warn('Failed to deactivate discount portal configuration', {
          configurationId: cfg.id,
          error: message,
        });
      }
    }

    if (!list.has_more || list.data.length === 0) break;
    const lastId = list.data[list.data.length - 1]?.id;
    if (!lastId || lastId === startingAfter) break;
    startingAfter = lastId;
  }

  const finishedAt = new Date();
  const result: PortalConfigCleanupResult = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    examinedConfigurations,
    candidateConfigurations,
    customersConsidered: activeSet.customersConsidered,
    activeHeadlinesCount: activeSet.headlines.size,
    activeCouponsCount: activeSet.couponIds.size,
    deactivatedConfigurationIds,
    keptConfigurationIds,
    errors,
    truncatedActiveSet: activeSet.truncated,
  };

  logger.info('Discount portal configuration cleanup cycle complete', {
    examinedConfigurations,
    candidateConfigurations,
    deactivated: deactivatedConfigurationIds.length,
    kept: keptConfigurationIds.length,
    errors: errors.length,
    customersConsidered: activeSet.customersConsidered,
    truncatedActiveSet: activeSet.truncated,
    durationMs: result.durationMs,
  });

  return result;
}

export const PORTAL_CONFIG_CLEANUP_INTERNALS = {
  DISCOUNT_HEADLINE_PURPOSE,
  PORTAL_CONFIG_LIST_PAGE_SIZE,
  MAX_CUSTOMERS_PER_CYCLE,
  DISCOUNT_LOOKUP_CONCURRENCY,
  ACTIVE_SUBSCRIPTION_STATUSES,
} as const;
