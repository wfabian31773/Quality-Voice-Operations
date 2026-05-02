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
 *      one of our tenant Stripe customers — KEEP. Stacked configs
 *      (those stamped with `metadata.additionalDiscountCount > 0`)
 *      additionally require the stamped count to match a currently-
 *      observed stack size for that coupon, otherwise the "+ N more"
 *      headline is now factually wrong and the config is treated as
 *      stale.
 *   2. `metadata.promotionCodeId` is in the active set — KEEP. Same
 *      stacked-count refinement as rule #1 applies.
 *   3. `metadata.headline` exactly matches a headline that
 *      `buildPortalDiscountHeadline` would produce for any currently
 *      active discount — KEEP. (Fallback for older configurations
 *      created before the coupon/promo metadata was stamped. The
 *      headline string already encodes the stack size as the
 *      "+ N more" tail, so this rule is naturally stack-aware.)
 *   4. Otherwise — DEACTIVATE.
 *
 * The "active customer discount" set is built by walking the
 * `subscriptions` table for distinct `stripe_customer_id` /
 * `stripe_subscription_id` pairs and loading each tenant's discount via
 * the same paths the portal / checkout surfaces use:
 *
 *   - `loadActiveCustomerDiscount` for the legacy customer-level
 *     `customer.discount` shape.
 *   - `loadActiveSubscriptionDiscounts` for the modern multi-coupon
 *     `subscription.discounts[]` shape (including the brand-new stacked
 *     "+ N more" headline configs minted by `createPortalSession`).
 *
 * Without dereferencing the subscription-level path the sweep only sees
 * customer-level coupons, so any portal config that was minted from a
 * `subscription.discounts[]` entry — the modern shape, including every
 * stacked-discount headline — would flip to `active: false` on the next
 * pass even though the coupon is still in force, churning Stripe
 * configurations needlessly and polluting the cleanup log with bogus
 * "deactivated" entries. Loading both paths means the cleanup judgement
 * uses the same definition of "currently active" as the surface that
 * mints the configurations in the first place.
 */

import type Stripe from 'stripe';
import { getStripeClient } from './client';
import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import {
  loadActiveCustomerDiscount,
  loadActiveSubscriptionDiscounts,
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
  /**
   * For every currently-active coupon, the set of `additionalDiscountCount`
   * values observed across the subscriptions where that coupon is
   * attached. A subscription whose `subscription.discounts[]` length is
   * `N` contributes `N - 1` (clamped to 0) for every coupon in it; a
   * customer-level coupon contributes `0`.
   *
   * Used by the cleanup loop to deactivate stale "stacked" portal
   * configurations after a tenant detaches one of multiple coupons:
   * the underlying `couponId` is still active (so rule #1 alone would
   * keep the config alive), but its `metadata.additionalDiscountCount`
   * no longer matches any currently-observed stack size, so the
   * "+ N more" headline is now factually wrong.
   */
  couponIdToAdditionalCounts: Map<string, Set<number>>;
  promotionCodeIdToAdditionalCounts: Map<string, Set<number>>;
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
  //
  // We also pull `stripe_subscription_id` so the worker below can
  // dereference subscription-level discounts (`subscription.discounts[]`,
  // the modern multi-coupon shape including the stacked
  // "+ N more" headline configs). Without that the active-set sweep
  // only sees customer-level coupons and would mass-deactivate
  // still-in-use stacked-discount portal configs every cycle.
  const { rows } = await pool.query<{
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  }>(
    `SELECT DISTINCT stripe_customer_id, stripe_subscription_id
       FROM subscriptions
      WHERE stripe_customer_id IS NOT NULL
        AND status = ANY($1::subscription_status[])
      LIMIT $2`,
    [
      [...ACTIVE_SUBSCRIPTION_STATUSES],
      MAX_CUSTOMERS_PER_CYCLE + 1,
    ],
  );

  // Dedupe in code as well — the SQL DISTINCT is on the
  // (customer, subscription) pair, but a single customer with multiple
  // active subscription rows would otherwise hit
  // `loadActiveCustomerDiscount` twice. The Set guarantees one Stripe
  // call per unique id regardless of how the join shakes out.
  const customerIdSet = new Set<string>();
  const subscriptionIdSet = new Set<string>();
  for (const r of rows) {
    if (typeof r.stripe_customer_id === 'string' && r.stripe_customer_id.length > 0) {
      customerIdSet.add(r.stripe_customer_id);
    }
    if (
      typeof r.stripe_subscription_id === 'string'
      && r.stripe_subscription_id.length > 0
    ) {
      subscriptionIdSet.add(r.stripe_subscription_id);
    }
  }

  const customerIds = Array.from(customerIdSet);
  const subscriptionIds = Array.from(subscriptionIdSet);
  // Truncation is judged on the customer count (the historical
  // semantic for `MAX_CUSTOMERS_PER_CYCLE` and the field surfaced in
  // the cleanup result). Subscriptions are 1:1 with billing customers
  // in our schema, so the same cap effectively bounds them too.
  const truncated = customerIds.length > MAX_CUSTOMERS_PER_CYCLE;
  const consideredCustomerIds = truncated
    ? customerIds.slice(0, MAX_CUSTOMERS_PER_CYCLE)
    : customerIds;
  const consideredSubscriptionIds = truncated
    ? subscriptionIds.slice(0, MAX_CUSTOMERS_PER_CYCLE)
    : subscriptionIds;

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
  const couponIdToAdditionalCounts = new Map<string, Set<number>>();
  const promotionCodeIdToAdditionalCounts = new Map<string, Set<number>>();

  function rememberAdditionalCount(
    map: Map<string, Set<number>>,
    key: string,
    additionalCount: number,
  ): void {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(additionalCount);
  }

  function recordDiscount(
    discount: UpgradeDiscount,
    additionalCount: number,
  ): void {
    // Always record the singular headline so cleanups for
    // single-coupon configs keep matching, and also record the
    // stacked variant when this discount belongs to a tenant with
    // multiple active subscription-level discounts. Stacked configs
    // live or die by the `+ N more` form; recording it lets the
    // headline fallback rule (#3) keep them alive when they were
    // minted before `couponId` metadata was stamped.
    const singular = buildPortalDiscountHeadline(discount);
    if (singular) headlines.add(singular);
    if (additionalCount > 0) {
      const stacked = buildPortalDiscountHeadline(discount, { additionalCount });
      if (stacked) headlines.add(stacked);
    }
    if (discount.couponId) {
      couponIds.add(discount.couponId);
      // Track the stack size this coupon is currently observed at.
      // The cleanup matching loop uses this to detect stale stacked
      // configs whose `metadata.additionalDiscountCount` no longer
      // matches any current observation for the coupon.
      rememberAdditionalCount(
        couponIdToAdditionalCounts,
        discount.couponId,
        additionalCount,
      );
    }
    if (discount.promotionCodeId) {
      promotionCodeIds.add(discount.promotionCodeId);
      rememberAdditionalCount(
        promotionCodeIdToAdditionalCounts,
        discount.promotionCodeId,
        additionalCount,
      );
    }
  }

  // Walk the customer list with bounded concurrency so we don't burst
  // Stripe's rate limit on accounts with thousands of paying tenants.
  let customerCursor = 0;
  async function customerWorker(): Promise<void> {
    for (;;) {
      const idx = customerCursor++;
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
      recordDiscount(discount, 0);
    }
  }

  // Same pattern for the subscription-level discount path. Each
  // subscription can carry multiple coupons (`subscription.discounts[]`)
  // and `loadActiveSubscriptionDiscounts` returns all of them. We feed
  // every entry into the active set so a portal config minted from any
  // of them — whether the headline one or one of the "+ N more"
  // siblings — keeps matching by `couponId` / `promotionCodeId`. The
  // additionalCount we pass to the headline builder mirrors what
  // `createPortalSession` would have computed (`length - 1`) so the
  // stacked headline string round-trips through the headline-fallback
  // rule for legacy configs missing the new `additionalDiscountCount`
  // metadata.
  let subscriptionCursor = 0;
  async function subscriptionWorker(): Promise<void> {
    for (;;) {
      const idx = subscriptionCursor++;
      if (idx >= consideredSubscriptionIds.length) return;
      const subscriptionId = consideredSubscriptionIds[idx];
      let subDiscounts: UpgradeDiscount[] = [];
      try {
        subDiscounts = await loadActiveSubscriptionDiscounts(stripe, subscriptionId, {
          tenantId: 'portal-config-cleanup',
          surface: 'portal_config_cleanup',
        });
      } catch {
        // Belt-and-braces — `loadActiveSubscriptionDiscounts` already
        // returns `[]` on error, but a thrown error here would
        // otherwise abort the whole worker pool.
        subDiscounts = [];
      }
      const additionalCount = subDiscounts.length > 1 ? subDiscounts.length - 1 : 0;
      for (const discount of subDiscounts) {
        recordDiscount(discount, additionalCount);
      }
    }
  }

  const customerWorkerCount = Math.min(
    DISCOUNT_LOOKUP_CONCURRENCY,
    Math.max(1, consideredCustomerIds.length),
  );
  const subscriptionWorkerCount = Math.min(
    DISCOUNT_LOOKUP_CONCURRENCY,
    Math.max(1, consideredSubscriptionIds.length),
  );
  await Promise.all([
    ...Array.from({ length: customerWorkerCount }, () => customerWorker()),
    ...Array.from({ length: subscriptionWorkerCount }, () => subscriptionWorker()),
  ]);

  return {
    headlines,
    couponIds,
    promotionCodeIds,
    couponIdToAdditionalCounts,
    promotionCodeIdToAdditionalCounts,
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
      // Parse the stacked-discount stamp. Defensive against junk values
      // (Stripe metadata is always strings, and very old configs won't
      // have stamped this at all). Negative / non-finite / sub-1 values
      // collapse to 0 so the matching path treats the config as a
      // singular headline, which is the safe historical behaviour.
      const stampedAdditionalRaw = md.additionalDiscountCount;
      let stampedAdditionalCount = 0;
      if (typeof stampedAdditionalRaw === 'string' && stampedAdditionalRaw.length > 0) {
        const parsed = Number.parseInt(stampedAdditionalRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          stampedAdditionalCount = parsed;
        }
      }

      // Without a complete active set we can't safely judge configurations
      // whose customers we never dereferenced. Keep them this cycle so the
      // sweep degrades gracefully instead of mass-deactivating live coupons.
      if (activeSet.truncated) {
        keptConfigurationIds.push(cfg.id);
        continue;
      }

      // For stacked configs (those minted with `additionalDiscountCount > 0`),
      // a bare coupon-id / promotion-code-id match is no longer enough:
      // if the tenant has since detached one of the stacked coupons,
      // the underlying primary `couponId` is still attached but the
      // "+ N more" claim baked into the headline is now wrong. Require
      // the stamped count to match a currently-observed stack size for
      // that coupon (or promo) before keeping the config alive.
      // Singular configs (stamped 0 / unstamped) keep the original
      // membership-only semantics so the common case is unchanged.
      const couponMatchesById =
        couponId !== null
        && activeSet.couponIds.has(couponId)
        && (stampedAdditionalCount === 0
          || activeSet.couponIdToAdditionalCounts
            .get(couponId)
            ?.has(stampedAdditionalCount) === true);
      const promotionCodeMatchesById =
        promotionCodeId !== null
        && activeSet.promotionCodeIds.has(promotionCodeId)
        && (stampedAdditionalCount === 0
          || activeSet.promotionCodeIdToAdditionalCounts
            .get(promotionCodeId)
            ?.has(stampedAdditionalCount) === true);
      // Headline match is naturally stack-aware (the headline string
      // includes the "+ N more" tail), so it stays as a straight set
      // membership lookup regardless of `stampedAdditionalCount`.
      const headlineMatches = headline !== null && activeSet.headlines.has(headline);

      const stillUsed =
        couponMatchesById || promotionCodeMatchesById || headlineMatches;

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
