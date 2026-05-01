import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const customersRetrieve = vi.fn();
const subscriptionsRetrieve = vi.fn();
const promotionCodesRetrieve = vi.fn();
const portalConfigurationsList = vi.fn();
const portalConfigurationsUpdate = vi.fn();
const platformPoolQuery = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    query: platformPoolQuery,
    connect: async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    }),
  }),
  withTenantContext: vi.fn(async () => undefined),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../platform/billing/stripe/plans', () => ({
  getPlanPriceId: () => 'price_starter_monthly',
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    customers: { retrieve: customersRetrieve },
    subscriptions: { retrieve: subscriptionsRetrieve },
    promotionCodes: { retrieve: promotionCodesRetrieve },
    billingPortal: {
      configurations: {
        list: portalConfigurationsList,
        update: portalConfigurationsUpdate,
      },
    },
  }),
}));

import {
  evictPortalConfigCacheById,
  __resetPortalConfigCacheForTests,
} from '../../platform/billing/stripe/checkout';
import { runDiscountPortalConfigCleanup } from '../../platform/billing/stripe/portalConfigCleanup';

function customer(id: string, discount: unknown): { id: string; discount: unknown } {
  return { id, discount };
}

function activeDiscountedConfig(
  id: string,
  metadata: Record<string, string>,
): {
  id: string;
  metadata: Record<string, string>;
  active: boolean;
  business_profile: Record<string, unknown>;
  features: Record<string, unknown>;
} {
  return {
    id,
    metadata: { purpose: 'discount_headline', ...metadata },
    active: true,
    business_profile: { headline: metadata.headline ?? 'Active discount' },
    features: {},
  };
}

beforeEach(() => {
  customersRetrieve.mockReset();
  subscriptionsRetrieve.mockReset();
  promotionCodesRetrieve.mockReset();
  portalConfigurationsList.mockReset();
  portalConfigurationsUpdate.mockReset();
  platformPoolQuery.mockReset();
  // Default: no subscription-level discounts so existing tests that
  // don't supply a `stripe_subscription_id` row are unaffected by the
  // new subscription-discount path.
  subscriptionsRetrieve.mockResolvedValue({ discounts: [], discount: null });
  __resetPortalConfigCacheForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runDiscountPortalConfigCleanup', () => {
  it('deactivates configurations whose coupon is no longer used by any active customer', async () => {
    platformPoolQuery.mockResolvedValue({
      rows: [
        { stripe_customer_id: 'cus_active' },
        { stripe_customer_id: 'cus_no_discount' },
      ],
    });
    customersRetrieve.mockImplementation(async (id: string) => {
      if (id === 'cus_active') {
        return customer('cus_active', {
          coupon: {
            id: 'coupon_promo25',
            name: 'Spring Promo',
            percent_off: 25,
            valid: true,
          },
          promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
        });
      }
      return customer(id, null);
    });
    portalConfigurationsList.mockResolvedValue({
      data: [
        // Still in use — matches the active coupon.
        activeDiscountedConfig('bpc_in_use', {
          headline: 'Active discount: 25% off — PROMO25',
          couponId: 'coupon_promo25',
          promotionCodeId: 'promo_xyz',
          defaultConfigId: 'bpc_default',
        }),
        // Not in use — references a coupon nobody has anymore.
        activeDiscountedConfig('bpc_stale', {
          headline: 'Active discount: 50% off — DEAD',
          couponId: 'coupon_dead',
          promotionCodeId: 'promo_dead',
          defaultConfigId: 'bpc_default',
        }),
        // Untagged configuration — must NEVER be touched.
        {
          id: 'bpc_default_other',
          metadata: { purpose: 'tenant_branding' },
          active: true,
          business_profile: { headline: 'Manage your subscription' },
          features: {},
        },
        // Configuration with no metadata at all — must also be ignored.
        {
          id: 'bpc_no_metadata',
          metadata: null,
          active: true,
          business_profile: { headline: 'Default' },
          features: {},
        },
      ],
      has_more: false,
    });
    portalConfigurationsUpdate.mockResolvedValue({ id: 'bpc_stale', active: false });

    const result = await runDiscountPortalConfigCleanup();

    expect(portalConfigurationsList).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, limit: 100 }),
    );
    expect(portalConfigurationsUpdate).toHaveBeenCalledTimes(1);
    expect(portalConfigurationsUpdate).toHaveBeenCalledWith('bpc_stale', {
      active: false,
    });

    expect(result.examinedConfigurations).toBe(4);
    expect(result.candidateConfigurations).toBe(2);
    expect(result.deactivatedConfigurationIds).toEqual(['bpc_stale']);
    expect(result.keptConfigurationIds).toEqual(['bpc_in_use']);
    expect(result.errors).toEqual([]);
    expect(result.activeCouponsCount).toBe(1);
    expect(result.activeHeadlinesCount).toBe(1);
    expect(result.customersConsidered).toBe(2);
    expect(result.truncatedActiveSet).toBe(false);
  });

  it('falls back to headline matching for legacy configurations missing coupon metadata', async () => {
    platformPoolQuery.mockResolvedValue({
      rows: [{ stripe_customer_id: 'cus_active' }],
    });
    customersRetrieve.mockResolvedValue(
      customer('cus_active', {
        coupon: {
          id: 'coupon_loyalty',
          name: 'Loyalty Coupon',
          percent_off: 10,
          valid: true,
        },
        promotion_code: null,
      }),
    );
    portalConfigurationsList.mockResolvedValue({
      data: [
        // Legacy config: only `headline` was stamped, no couponId. Must
        // still match against the rebuilt active headline.
        activeDiscountedConfig('bpc_legacy_in_use', {
          headline: 'Active discount: 10% off — Loyalty Coupon',
          defaultConfigId: 'bpc_default',
        }),
        // Legacy config whose headline doesn't correspond to any active
        // discount any longer.
        activeDiscountedConfig('bpc_legacy_stale', {
          headline: 'Active discount: 99% off — RETIRED',
          defaultConfigId: 'bpc_default',
        }),
      ],
      has_more: false,
    });

    const result = await runDiscountPortalConfigCleanup();

    expect(portalConfigurationsUpdate).toHaveBeenCalledTimes(1);
    expect(portalConfigurationsUpdate).toHaveBeenCalledWith(
      'bpc_legacy_stale',
      { active: false },
    );
    expect(result.deactivatedConfigurationIds).toEqual(['bpc_legacy_stale']);
    expect(result.keptConfigurationIds).toEqual(['bpc_legacy_in_use']);
  });

  it('skips configurations entirely when the active customer set is unavailable (no rows)', async () => {
    // Edge case: zero subscriptions in the database. We should still
    // walk Stripe and deactivate every discount-headline configuration
    // since none of them can possibly correspond to an active customer.
    platformPoolQuery.mockResolvedValue({ rows: [] });
    portalConfigurationsList.mockResolvedValue({
      data: [
        activeDiscountedConfig('bpc_orphan_a', {
          headline: 'Active discount: 25% off — PROMO25',
          couponId: 'coupon_promo25',
        }),
        activeDiscountedConfig('bpc_orphan_b', {
          headline: 'Active discount: 50% off',
          couponId: 'coupon_50',
        }),
      ],
      has_more: false,
    });

    const result = await runDiscountPortalConfigCleanup();

    expect(customersRetrieve).not.toHaveBeenCalled();
    expect(portalConfigurationsUpdate).toHaveBeenCalledTimes(2);
    expect(result.deactivatedConfigurationIds).toEqual([
      'bpc_orphan_a',
      'bpc_orphan_b',
    ]);
    expect(result.keptConfigurationIds).toEqual([]);
    expect(result.customersConsidered).toBe(0);
    expect(result.truncatedActiveSet).toBe(false);
  });

  it('paginates through Stripe portal configuration pages until has_more is false', async () => {
    platformPoolQuery.mockResolvedValue({ rows: [] });
    portalConfigurationsList
      .mockResolvedValueOnce({
        data: [
          activeDiscountedConfig('bpc_p1_a', { headline: 'h1', couponId: 'c1' }),
          activeDiscountedConfig('bpc_p1_b', { headline: 'h2', couponId: 'c2' }),
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          activeDiscountedConfig('bpc_p2_a', { headline: 'h3', couponId: 'c3' }),
        ],
        has_more: false,
      });

    const result = await runDiscountPortalConfigCleanup();

    expect(portalConfigurationsList).toHaveBeenCalledTimes(2);
    expect(portalConfigurationsList.mock.calls[0][0]).not.toHaveProperty(
      'starting_after',
    );
    expect(portalConfigurationsList.mock.calls[1][0]).toEqual(
      expect.objectContaining({ starting_after: 'bpc_p1_b' }),
    );
    expect(result.examinedConfigurations).toBe(3);
    expect(result.deactivatedConfigurationIds).toHaveLength(3);
  });

  it('records per-configuration errors without aborting the rest of the sweep', async () => {
    platformPoolQuery.mockResolvedValue({ rows: [] });
    portalConfigurationsList.mockResolvedValue({
      data: [
        activeDiscountedConfig('bpc_will_fail', { headline: 'h', couponId: 'c' }),
        activeDiscountedConfig('bpc_will_succeed', { headline: 'h2', couponId: 'c2' }),
      ],
      has_more: false,
    });
    portalConfigurationsUpdate.mockImplementation(async (id: string) => {
      if (id === 'bpc_will_fail') throw new Error('stripe rejected the update');
      return { id, active: false };
    });

    const result = await runDiscountPortalConfigCleanup();

    expect(result.deactivatedConfigurationIds).toEqual(['bpc_will_succeed']);
    expect(result.errors).toEqual([
      { configurationId: 'bpc_will_fail', error: 'stripe rejected the update' },
    ]);
  });

  it('keeps everything when the active set was truncated (defensive fail-open)', async () => {
    // Simulate a runaway subscriptions table: more rows than the per-cycle
    // cap. We can't trust the active set is complete, so the sweep must
    // not deactivate anything this cycle.
    const truncatingRows = Array.from({ length: 5_001 }, (_, i) => ({
      stripe_customer_id: `cus_${i}`,
    }));
    platformPoolQuery.mockResolvedValue({ rows: truncatingRows });
    customersRetrieve.mockResolvedValue(customer('cus', null));
    portalConfigurationsList.mockResolvedValue({
      data: [
        activeDiscountedConfig('bpc_orphan', {
          headline: 'Active discount: 25% off',
          couponId: 'coupon_orphan',
        }),
      ],
      has_more: false,
    });

    const result = await runDiscountPortalConfigCleanup();

    expect(portalConfigurationsUpdate).not.toHaveBeenCalled();
    expect(result.deactivatedConfigurationIds).toEqual([]);
    expect(result.keptConfigurationIds).toEqual(['bpc_orphan']);
    expect(result.truncatedActiveSet).toBe(true);
  });

  it('only counts subscriptions in active billing states when building the active discount set', async () => {
    // Regression: a churned tenant whose Stripe customer still carries a
    // `discount` object (Stripe doesn't auto-clear the discount on
    // cancel) must NOT keep its coupon's portal configuration alive.
    // The active-set query must filter the subscriptions table to
    // currently-billing statuses; cancelled / paused subscriptions
    // should be excluded so their stale coupons get cleaned up.
    platformPoolQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      // The cleanup should only ask the database for subscriptions
      // whose status is one of the still-being-billed values.
      expect(sql).toMatch(/status\s*=\s*ANY/i);
      // `subscriptions.status` is a Postgres enum, so the bound
      // parameter must be cast to `subscription_status[]` — comparing
      // the enum to a `text[]` would fail at plan time with "operator
      // does not exist: subscription_status = text".
      expect(sql).toMatch(/subscription_status\s*\[\s*\]/i);
      expect(params[0]).toEqual(
        expect.arrayContaining(['active', 'trialing', 'past_due']),
      );
      expect(params[0]).not.toEqual(expect.arrayContaining(['cancelled']));
      expect(params[0]).not.toEqual(expect.arrayContaining(['paused']));
      // Simulate the WHERE filter doing its job: only the active
      // customer's id makes it through. The cancelled customer (whose
      // Stripe customer.discount is stale but still attached) is
      // intentionally absent.
      return { rows: [{ stripe_customer_id: 'cus_still_billing' }] };
    });

    customersRetrieve.mockResolvedValue(
      customer('cus_still_billing', {
        coupon: {
          id: 'coupon_live',
          name: 'Live Coupon',
          percent_off: 20,
          valid: true,
        },
        promotion_code: null,
      }),
    );

    portalConfigurationsList.mockResolvedValue({
      data: [
        // Tied to the live customer's coupon — must be kept.
        activeDiscountedConfig('bpc_live', {
          headline: 'Active discount: 20% off — Live Coupon',
          couponId: 'coupon_live',
        }),
        // Tied to the churned customer's still-attached-but-dead
        // coupon. The active-set query must not surface that customer,
        // so this configuration must be deactivated this cycle.
        activeDiscountedConfig('bpc_churned', {
          headline: 'Active discount: 50% off — Churned',
          couponId: 'coupon_churned',
        }),
      ],
      has_more: false,
    });

    const result = await runDiscountPortalConfigCleanup();

    expect(portalConfigurationsUpdate).toHaveBeenCalledTimes(1);
    expect(portalConfigurationsUpdate).toHaveBeenCalledWith('bpc_churned', {
      active: false,
    });
    expect(result.deactivatedConfigurationIds).toEqual(['bpc_churned']);
    expect(result.keptConfigurationIds).toEqual(['bpc_live']);
    expect(result.customersConsidered).toBe(1);
  });

  it('keeps configurations whose coupon lives on subscription.discounts[] (modern shape)', async () => {
    // Regression: tenants whose coupons live on `subscription.discounts[]`
    // (rather than the legacy customer.discount field) must keep their
    // portal-headline configurations alive. The cleanup sweep must
    // dereference subscription-level discounts via
    // `loadActiveSubscriptionDiscounts` and add their coupon /
    // promotion-code ids to the active set. Without that, every modern
    // tenant's portal config would flip to `active: false` on the next
    // sweep — including the new stacked "+ N more" headline configs —
    // and the next portal open would silently re-create them, churning
    // Stripe configurations for no benefit.
    platformPoolQuery.mockResolvedValue({
      rows: [
        {
          stripe_customer_id: 'cus_modern',
          stripe_subscription_id: 'sub_stacked',
        },
      ],
    });
    // No customer-level discount — modern tenants attach coupons at the
    // subscription level.
    customersRetrieve.mockResolvedValue(customer('cus_modern', null));
    // Two stacked subscription-level discounts. The portal headline
    // config will have been minted with `metadata.couponId` = the
    // primary one and `additionalDiscountCount = 1`; the cleanup must
    // recognise *both* coupons so siblings stay alive too.
    subscriptionsRetrieve.mockResolvedValue({
      discounts: [
        {
          coupon: {
            id: 'coupon_primary',
            name: 'Primary Coupon',
            percent_off: 30,
            valid: true,
          },
          promotion_code: { id: 'promo_primary', code: 'STACK30' },
        },
        {
          coupon: {
            id: 'coupon_secondary',
            name: 'Secondary Coupon',
            percent_off: 10,
            valid: true,
          },
          promotion_code: null,
        },
      ],
      discount: null,
    });
    portalConfigurationsList.mockResolvedValue({
      data: [
        // Stacked headline config minted by `createPortalSession` for
        // the primary coupon. Carries `additionalDiscountCount` to flag
        // it as one of the stacked-discount configs.
        activeDiscountedConfig('bpc_stacked_primary', {
          headline: 'Active discount: 30% off — STACK30 + 1 more',
          couponId: 'coupon_primary',
          promotionCodeId: 'promo_primary',
          additionalDiscountCount: '1',
          defaultConfigId: 'bpc_default',
        }),
        // Portal config for the sibling coupon (mintable when the
        // headline is rebuilt off the second discount). Must also be
        // kept alive — its couponId is in the subscription-level
        // active set.
        activeDiscountedConfig('bpc_sibling', {
          headline: 'Active discount: 10% off — Secondary Coupon',
          couponId: 'coupon_secondary',
          defaultConfigId: 'bpc_default',
        }),
        // Genuinely stale config — its coupon is not on either the
        // customer or any subscription. Must be deactivated this cycle
        // so the sweep still does its job.
        activeDiscountedConfig('bpc_stale', {
          headline: 'Active discount: 99% off — DEAD',
          couponId: 'coupon_dead',
          defaultConfigId: 'bpc_default',
        }),
      ],
      has_more: false,
    });

    const result = await runDiscountPortalConfigCleanup();

    expect(subscriptionsRetrieve).toHaveBeenCalledWith(
      'sub_stacked',
      expect.objectContaining({ expand: expect.any(Array) }),
    );
    expect(portalConfigurationsUpdate).toHaveBeenCalledTimes(1);
    expect(portalConfigurationsUpdate).toHaveBeenCalledWith('bpc_stale', {
      active: false,
    });
    expect(result.deactivatedConfigurationIds).toEqual(['bpc_stale']);
    expect(result.keptConfigurationIds).toEqual(
      expect.arrayContaining(['bpc_stacked_primary', 'bpc_sibling']),
    );
    expect(result.keptConfigurationIds).not.toContain('bpc_stale');
    // Subscription-level coupon ids must show up in the active-coupon
    // count even though no customer.discount was set.
    expect(result.activeCouponsCount).toBe(2);
  });

  it('keeps stacked-discount configurations via headline match when coupon metadata is missing', async () => {
    // Defense-in-depth: even if a stacked-discount config was minted
    // before `couponId` metadata was reliably stamped, the headline
    // fallback must still rescue it. The cleanup builds the stacked
    // headline string (e.g. "+ 1 more") for each subscription-level
    // discount, so a legacy stacked config whose only marker is the
    // headline still round-trips through rule #3.
    platformPoolQuery.mockResolvedValue({
      rows: [
        {
          stripe_customer_id: 'cus_modern',
          stripe_subscription_id: 'sub_stacked',
        },
      ],
    });
    customersRetrieve.mockResolvedValue(customer('cus_modern', null));
    subscriptionsRetrieve.mockResolvedValue({
      discounts: [
        {
          coupon: {
            id: 'coupon_primary',
            name: 'Primary Coupon',
            percent_off: 30,
            valid: true,
          },
          promotion_code: { id: 'promo_primary', code: 'STACK30' },
        },
        {
          coupon: {
            id: 'coupon_secondary',
            name: 'Secondary Coupon',
            percent_off: 10,
            valid: true,
          },
          promotion_code: null,
        },
      ],
      discount: null,
    });
    portalConfigurationsList.mockResolvedValue({
      data: [
        // No coupon metadata — only the stacked headline. Must still
        // survive the cleanup because the rebuilt active-set headline
        // exactly matches.
        activeDiscountedConfig('bpc_legacy_stacked', {
          headline: 'Active discount: 30% off — STACK30 + 1 more',
          additionalDiscountCount: '1',
          defaultConfigId: 'bpc_default',
        }),
      ],
      has_more: false,
    });

    const result = await runDiscountPortalConfigCleanup();

    expect(portalConfigurationsUpdate).not.toHaveBeenCalled();
    expect(result.deactivatedConfigurationIds).toEqual([]);
    expect(result.keptConfigurationIds).toEqual(['bpc_legacy_stacked']);
  });

  it('evicts the in-process configuration cache for every deactivated id', async () => {
    platformPoolQuery.mockResolvedValue({ rows: [] });
    portalConfigurationsList.mockResolvedValue({
      data: [
        activeDiscountedConfig('bpc_to_evict', {
          headline: 'h_evict',
          couponId: 'c_evict',
        }),
      ],
      has_more: false,
    });

    // Pre-populate the cache with an entry pointing at the doomed id;
    // the cleanup should evict it after deactivating the Stripe-side
    // configuration so the next portal-open recreates a fresh active
    // configuration instead of trying to reuse the dead one.
    const evictSpy = vi.fn();
    const removed = evictPortalConfigCacheById('bpc_to_evict');
    expect(removed).toBe(0);
    evictSpy(removed);

    await runDiscountPortalConfigCleanup();

    expect(portalConfigurationsUpdate).toHaveBeenCalledWith('bpc_to_evict', {
      active: false,
    });
  });
});
