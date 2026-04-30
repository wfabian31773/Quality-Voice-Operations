import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '../../platform/core/types';

const customersRetrieve = vi.fn();
const portalSessionsCreate = vi.fn();
const portalConfigurationsList = vi.fn();
const portalConfigurationsCreate = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string) => {
        const trimmed = sql.trimStart();
        if (
          trimmed.startsWith('BEGIN')
          || trimmed.startsWith('COMMIT')
          || trimmed.startsWith('ROLLBACK')
        ) {
          return { rows: [] };
        }
        return { rows: [{ stripe_customer_id: 'cus_portal_123' }] };
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

vi.mock('../../platform/billing/stripe/plans', () => ({
  getPlanPriceId: () => 'price_starter_monthly',
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    customers: { retrieve: customersRetrieve },
    billingPortal: {
      sessions: { create: portalSessionsCreate },
      configurations: {
        list: portalConfigurationsList,
        create: portalConfigurationsCreate,
      },
    },
  }),
}));

import {
  buildPortalDiscountHeadline,
  createPortalSession,
  __resetPortalConfigCacheForTests,
} from '../../platform/billing/stripe/checkout';

const TENANT: TenantId = 'tenant-portal-discount';

const DEFAULT_PORTAL_CONFIG = {
  id: 'bpc_default_xyz',
  is_default: true,
  business_profile: {
    headline: 'Manage your subscription',
    privacy_policy_url: 'https://example.test/privacy',
    terms_of_service_url: 'https://example.test/terms',
  },
  features: {
    customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: {
      enabled: true,
      mode: 'at_period_end',
      proration_behavior: 'none',
    },
    subscription_update: {
      enabled: true,
      // Stripe responses include these as `null` when unset; the create
      // params type rejects null, so the cloning helper must strip them.
      billing_cycle_anchor: null,
      default_allowed_updates: ['price'],
      products: null,
      proration_behavior: 'create_prorations',
    },
  },
};

beforeEach(() => {
  customersRetrieve.mockReset();
  portalSessionsCreate.mockReset();
  portalConfigurationsList.mockReset();
  portalConfigurationsCreate.mockReset();
  __resetPortalConfigCacheForTests();
  portalSessionsCreate.mockResolvedValue({
    id: 'bps_test_123',
    url: 'https://billing.stripe.com/p/session/bps_test_123',
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildPortalDiscountHeadline', () => {
  it('formats a percent-off discount with the promo code tail', () => {
    expect(
      buildPortalDiscountHeadline({
        couponId: 'coupon_promo25',
        name: 'Spring Promo',
        percentOff: 25,
        amountOffCents: null,
        currency: null,
        promotionCode: 'PROMO25',
        promotionCodeId: 'promo_xyz',
      }),
    ).toBe('Active discount: 25% off — PROMO25');
  });

  it('falls back to the coupon name when no promo code exists', () => {
    expect(
      buildPortalDiscountHeadline({
        couponId: 'coupon_named',
        name: 'Loyalty Coupon',
        percentOff: 10,
        amountOffCents: null,
        currency: null,
        promotionCode: null,
        promotionCodeId: null,
      }),
    ).toBe('Active discount: 10% off — Loyalty Coupon');
  });

  it('formats an amount-off discount with the coupon currency', () => {
    expect(
      buildPortalDiscountHeadline({
        couponId: 'coupon_50off',
        name: null,
        percentOff: null,
        amountOffCents: 5000,
        currency: 'usd',
        promotionCode: 'SUMMER',
        promotionCodeId: 'promo_summer',
      }),
    ).toBe('Active discount: USD 50.00 off — SUMMER');
  });

  it('drops the promo-code tail before truncating mid-word', () => {
    const longCode = 'SUPER_LONG_CUSTOM_PROMOTIONAL_CODE_1234567890';
    const headline = buildPortalDiscountHeadline({
      couponId: 'coupon_long',
      name: null,
      percentOff: 25,
      amountOffCents: null,
      currency: null,
      promotionCode: longCode,
      promotionCodeId: 'promo_long',
    });
    expect(headline).toBe('Active discount: 25% off');
    expect((headline ?? '').length).toBeLessThanOrEqual(60);
  });

  it('returns null for a discount with neither percent nor amount off', () => {
    expect(
      buildPortalDiscountHeadline({
        couponId: 'coupon_meta_only',
        name: 'Metadata Only',
        percentOff: null,
        amountOffCents: null,
        currency: null,
        promotionCode: null,
        promotionCodeId: null,
      }),
    ).toBeNull();
  });

  it('returns null when no discount is provided', () => {
    expect(buildPortalDiscountHeadline(null)).toBeNull();
    expect(buildPortalDiscountHeadline(undefined)).toBeNull();
  });
});

describe('createPortalSession discount headline', () => {
  it('attaches a custom configuration with the discount headline when a coupon is active', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_portal_123',
      discount: {
        coupon: {
          id: 'coupon_promo25',
          name: 'Spring Promo',
          percent_off: 25,
          valid: true,
        },
        promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
      },
    });
    portalConfigurationsList.mockResolvedValue({ data: [DEFAULT_PORTAL_CONFIG] });
    portalConfigurationsCreate.mockResolvedValue({ id: 'bpc_with_headline' });

    await createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });

    expect(portalConfigurationsList).toHaveBeenCalledWith({
      is_default: true,
      limit: 1,
    });
    expect(portalConfigurationsCreate).toHaveBeenCalledTimes(1);
    const createArgs = portalConfigurationsCreate.mock.calls[0][0];
    expect(createArgs.business_profile.headline).toBe(
      'Active discount: 25% off — PROMO25',
    );
    expect(createArgs.business_profile.privacy_policy_url).toBe(
      'https://example.test/privacy',
    );
    expect(createArgs.business_profile.terms_of_service_url).toBe(
      'https://example.test/terms',
    );
    expect(createArgs.features.invoice_history).toEqual({ enabled: true });
    expect(createArgs.features.subscription_update.enabled).toBe(true);
    // The cloning helper must strip the nullable response-only slots so
    // the create call doesn't fail validation.
    expect(
      'billing_cycle_anchor' in createArgs.features.subscription_update,
    ).toBe(false);
    expect('products' in createArgs.features.subscription_update).toBe(false);
    expect(createArgs.metadata).toEqual({
      purpose: 'discount_headline',
      headline: 'Active discount: 25% off — PROMO25',
      defaultConfigId: DEFAULT_PORTAL_CONFIG.id,
      // Provenance fields used by the periodic cleanup sweep
      // (PortalConfigCleanupScheduler) to match the configuration
      // back to the discount it was minted for.
      couponId: 'coupon_promo25',
      promotionCodeId: 'promo_xyz',
    });

    expect(portalSessionsCreate).toHaveBeenCalledWith({
      customer: 'cus_portal_123',
      return_url: 'https://example.test/dashboard',
      configuration: 'bpc_with_headline',
    });
  });

  it('reuses the cached configuration for repeated portal opens with the same coupon', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_portal_123',
      discount: {
        coupon: {
          id: 'coupon_promo25',
          name: 'Spring Promo',
          percent_off: 25,
          valid: true,
        },
        promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
      },
    });
    portalConfigurationsList.mockResolvedValue({ data: [DEFAULT_PORTAL_CONFIG] });
    portalConfigurationsCreate.mockResolvedValue({ id: 'bpc_with_headline' });

    await createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });
    await createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });

    expect(portalConfigurationsCreate).toHaveBeenCalledTimes(1);
    expect(portalSessionsCreate).toHaveBeenCalledTimes(2);
    // Both sessions reference the same cached configuration.
    expect(portalSessionsCreate.mock.calls[0][0].configuration).toBe(
      'bpc_with_headline',
    );
    expect(portalSessionsCreate.mock.calls[1][0].configuration).toBe(
      'bpc_with_headline',
    );
  });

  it('coalesces concurrent first-opens for the same coupon into a single Stripe configuration create', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_portal_123',
      discount: {
        coupon: {
          id: 'coupon_promo25',
          name: 'Spring Promo',
          percent_off: 25,
          valid: true,
        },
        promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
      },
    });
    portalConfigurationsList.mockResolvedValue({
      data: [DEFAULT_PORTAL_CONFIG],
    });
    let resolveCreate: ((cfg: { id: string }) => void) | undefined;
    const createReached = new Promise<void>((reachedResolve) => {
      portalConfigurationsCreate.mockImplementation(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveCreate = resolve;
            reachedResolve();
          }),
      );
    });

    const first = createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });
    // Wait until the first call has actually entered the configuration
    // create call (so the in-flight slot is populated) before kicking
    // off the second call, then yield enough microtasks for the second
    // call to walk past customer retrieval / list / cache and hit the
    // in-flight check.
    await createReached;
    const second = createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    resolveCreate?.({ id: 'bpc_with_headline' });
    await Promise.all([first, second]);

    expect(portalConfigurationsCreate).toHaveBeenCalledTimes(1);
    expect(portalSessionsCreate).toHaveBeenCalledTimes(2);
    expect(portalSessionsCreate.mock.calls[0][0].configuration).toBe(
      'bpc_with_headline',
    );
    expect(portalSessionsCreate.mock.calls[1][0].configuration).toBe(
      'bpc_with_headline',
    );
  });

  it('invalidates the cache when the dashboard default portal configuration changes', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_portal_123',
      discount: {
        coupon: {
          id: 'coupon_promo25',
          name: 'Spring Promo',
          percent_off: 25,
          valid: true,
        },
        promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
      },
    });
    portalConfigurationsList
      .mockResolvedValueOnce({ data: [DEFAULT_PORTAL_CONFIG] })
      .mockResolvedValueOnce({
        data: [{ ...DEFAULT_PORTAL_CONFIG, id: 'bpc_default_swapped' }],
      });
    portalConfigurationsCreate
      .mockResolvedValueOnce({ id: 'bpc_with_headline_v1' })
      .mockResolvedValueOnce({ id: 'bpc_with_headline_v2' });

    await createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });
    await createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });

    expect(portalConfigurationsCreate).toHaveBeenCalledTimes(2);
    expect(portalSessionsCreate.mock.calls[0][0].configuration).toBe(
      'bpc_with_headline_v1',
    );
    expect(portalSessionsCreate.mock.calls[1][0].configuration).toBe(
      'bpc_with_headline_v2',
    );
  });

  it('opens the portal without a configuration when no discount is active', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_portal_123',
      discount: null,
    });

    await createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });

    expect(portalConfigurationsList).not.toHaveBeenCalled();
    expect(portalConfigurationsCreate).not.toHaveBeenCalled();
    const args = portalSessionsCreate.mock.calls[0][0];
    expect('configuration' in args).toBe(false);
    expect(args).toEqual({
      customer: 'cus_portal_123',
      return_url: 'https://example.test/dashboard',
    });
  });

  it('opens the portal without a configuration when the coupon has expired', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_portal_123',
      discount: {
        coupon: { id: 'coupon_dead', percent_off: 50, valid: false },
      },
    });

    await createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });

    expect(portalConfigurationsList).not.toHaveBeenCalled();
    const args = portalSessionsCreate.mock.calls[0][0];
    expect('configuration' in args).toBe(false);
  });

  it('falls back to a configuration-less session when no default config exists', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_portal_123',
      discount: {
        coupon: {
          id: 'coupon_promo25',
          name: 'Spring Promo',
          percent_off: 25,
          valid: true,
        },
        promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
      },
    });
    portalConfigurationsList.mockResolvedValue({ data: [] });

    const result = await createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });

    expect(portalConfigurationsCreate).not.toHaveBeenCalled();
    const args = portalSessionsCreate.mock.calls[0][0];
    expect('configuration' in args).toBe(false);
    expect(result.url).toBe('https://billing.stripe.com/p/session/bps_test_123');
  });

  it('falls back to a configuration-less session when the configuration lookup throws', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_portal_123',
      discount: {
        coupon: { id: 'coupon_promo25', percent_off: 25, valid: true },
        promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
      },
    });
    portalConfigurationsList.mockRejectedValue(new Error('stripe is down'));

    await createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });

    expect(portalConfigurationsCreate).not.toHaveBeenCalled();
    const args = portalSessionsCreate.mock.calls[0][0];
    expect('configuration' in args).toBe(false);
  });

  it('falls back to a configuration-less session when the configuration create throws', async () => {
    customersRetrieve.mockResolvedValue({
      id: 'cus_portal_123',
      discount: {
        coupon: { id: 'coupon_promo25', percent_off: 25, valid: true },
        promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
      },
    });
    portalConfigurationsList.mockResolvedValue({ data: [DEFAULT_PORTAL_CONFIG] });
    portalConfigurationsCreate.mockRejectedValue(new Error('config rejected'));

    await createPortalSession({
      tenantId: TENANT,
      returnUrl: 'https://example.test/dashboard',
    });

    const args = portalSessionsCreate.mock.calls[0][0];
    expect('configuration' in args).toBe(false);
  });
});
