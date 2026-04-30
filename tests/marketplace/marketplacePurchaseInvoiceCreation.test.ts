/**
 * Coverage for the marketplace one-off Checkout session shape (Task #1351).
 *
 * `MarketplacePurchaseService.createMarketplacePurchase` produces a
 * Stripe Checkout session for marketplace add-on purchases. For
 * one-off purchases (`mode: 'payment'`) Stripe does NOT generate an
 * invoice by default — only a Charge + receipt email — so the
 * coupon-aware "Discount applied" badge wired up by Task #1311 against
 * `invoice.finalized` would never fire on a one-off marketplace
 * purchase. The fix is to set `invoice_creation: { enabled: true }` on
 * the session so Stripe materializes an invoice we can stamp.
 *
 * These tests pin:
 *   1. One-off marketplace sessions request invoice creation, and the
 *      invoice carries the same purchase-tracing metadata as the
 *      session (so Finance can reconcile receipt → purchase row).
 *   2. Subscription marketplace sessions do NOT set `invoice_creation`
 *      (Stripe's subscription mode auto-creates invoices; setting it
 *      here would be redundant and risks future Stripe API changes).
 *   3. Both modes set `allow_promotion_codes: true` so buyers can
 *      redeem a coupon at the marketplace checkout (which is what
 *      makes the badge actually fire on real-world purchases).
 *   4. The session metadata stays intact so existing webhook handlers
 *      (`handleCheckoutCompleted` → `completePurchase`) keep working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRow = Record<string, unknown>;
type QueryHandler = (sql: string, values?: unknown[]) => Promise<{ rows: QueryRow[] }>;

let queryHandler: QueryHandler;
const sessionsCreate = vi.fn();
const customersRetrieve = vi.fn();

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
    query: vi.fn(async () => ({ rows: [] })),
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
    checkout: { sessions: { create: sessionsCreate } },
    customers: { retrieve: customersRetrieve },
  }),
}));

import { createMarketplacePurchase } from '../../platform/marketplace/MarketplacePurchaseService';

const TENANT = 'tenant_marketplace_buyer' as unknown as Parameters<typeof createMarketplacePurchase>[0]['tenantId'];

interface TemplateScenario {
  priceModel: 'one_time' | 'monthly_subscription' | 'usage_based' | 'free';
  priceCents: number;
  stripePriceId?: string | null;
}

function setupTemplateScenario(scenario: TemplateScenario) {
  queryHandler = async (sql: string) => {
    const trimmed = sql.trimStart();
    if (trimmed.startsWith('SELECT id, display_name, price_model')) {
      return {
        rows: [{
          id: 'tpl_widget',
          display_name: 'Dispatch Add-on',
          price_model: scenario.priceModel,
          price_cents: scenario.priceCents,
          stripe_price_id: scenario.stripePriceId ?? null,
        }],
      };
    }
    if (trimmed.startsWith('SELECT id FROM marketplace_purchases')) {
      // No prior completed purchase
      return { rows: [] };
    }
    if (trimmed.startsWith('INSERT INTO marketplace_purchases')) {
      return { rows: [{ id: 'mkt_purchase_xyz' }] };
    }
    if (trimmed.startsWith('SELECT stripe_customer_id FROM subscriptions')) {
      return { rows: [{ stripe_customer_id: 'cus_mkt_buyer' }] };
    }
    if (trimmed.startsWith('UPDATE marketplace_purchases SET stripe_checkout_session_id')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };
}

beforeEach(() => {
  sessionsCreate.mockReset();
  sessionsCreate.mockResolvedValue({
    id: 'cs_mkt_test_123',
    url: 'https://checkout.stripe.com/c/pay/cs_mkt_test_123',
  });
  customersRetrieve.mockReset();
  // Default: customer has no active discount, so the existing
  // `allow_promotion_codes` path is exercised.
  customersRetrieve.mockResolvedValue({
    id: 'cus_mkt_buyer',
    discount: null,
  });
  process.env.APP_URL = 'https://app.test';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createMarketplacePurchase — Stripe Checkout session shape', () => {
  it('enables invoice_creation on one-off purchases so the discount badge can fire', async () => {
    setupTemplateScenario({
      priceModel: 'one_time',
      priceCents: 4900,
      stripePriceId: 'price_oneoff_widget',
    });

    const result = await createMarketplacePurchase({
      tenantId: TENANT,
      userId: 'user_buyer',
      templateId: 'tpl_widget',
      successUrl: 'https://app.test/marketplace?ok=1',
      cancelUrl: 'https://app.test/marketplace?cancel=1',
    });

    expect(result.success).toBe(true);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const params = sessionsCreate.mock.calls[0][0];

    expect(params.mode).toBe('payment');
    // The whole reason for this task: invoice_creation must be enabled
    // on one-off marketplace sessions or no invoice.finalized event
    // ever fires for them.
    expect(params.invoice_creation).toEqual({
      enabled: true,
      invoice_data: {
        metadata: {
          tenantId: TENANT,
          templateId: 'tpl_widget',
          purchaseId: 'mkt_purchase_xyz',
          type: 'marketplace_purchase',
        },
      },
    });
    // Coupons need to be applicable at the marketplace checkout, else
    // there's nothing for the badge stamper to find later.
    expect(params.allow_promotion_codes).toBe(true);
    // Existing session metadata keeps the contract that
    // `handleCheckoutCompleted` reads to look up the purchase row.
    expect(params.metadata).toMatchObject({
      tenantId: TENANT,
      templateId: 'tpl_widget',
      purchaseId: 'mkt_purchase_xyz',
      type: 'marketplace_purchase',
    });
  });

  it('omits invoice_creation on subscription-mode purchases (Stripe auto-creates invoices)', async () => {
    setupTemplateScenario({
      priceModel: 'monthly_subscription',
      priceCents: 999,
      stripePriceId: 'price_sub_widget',
    });

    await createMarketplacePurchase({
      tenantId: TENANT,
      userId: 'user_buyer',
      templateId: 'tpl_widget',
      successUrl: 'https://app.test/marketplace?ok=1',
      cancelUrl: 'https://app.test/marketplace?cancel=1',
    });

    const params = sessionsCreate.mock.calls[0][0];
    expect(params.mode).toBe('subscription');
    // Subscription-mode sessions must NOT set invoice_creation —
    // Stripe rejects it (and would in any case auto-create the
    // recurring invoices we want to stamp).
    expect(params.invoice_creation).toBeUndefined();
    // Promo codes still allowed so the coupon-aware badge works on
    // the renewal invoices too.
    expect(params.allow_promotion_codes).toBe(true);
  });

  it('omits invoice_creation on usage-based marketplace subscriptions', async () => {
    setupTemplateScenario({
      priceModel: 'usage_based',
      priceCents: 5,
    });

    await createMarketplacePurchase({
      tenantId: TENANT,
      userId: 'user_buyer',
      templateId: 'tpl_widget',
      successUrl: 'https://app.test/marketplace?ok=1',
      cancelUrl: 'https://app.test/marketplace?cancel=1',
    });

    const params = sessionsCreate.mock.calls[0][0];
    expect(params.mode).toBe('subscription');
    expect(params.invoice_creation).toBeUndefined();
    expect(params.allow_promotion_codes).toBe(true);
  });
});

/**
 * Coverage for the customer-discount forwarding wiring (Task #1372).
 *
 * Subscription Checkout already forwards the buyer's customer-level
 * Stripe discount via `loadActiveCustomerDiscount` (see
 * `tests/billing/checkoutSessionDiscount.test.ts`). Marketplace one-off
 * Checkout sessions had to be brought to parity so a tenant who already
 * has a coupon on file doesn't have to re-type it at the marketplace
 * checkout (and risk forgetting). These tests pin the same matrix:
 *
 *   1. When a customer has a `promotion_code` discount, the session
 *      forwards it as `discounts: [{ promotion_code }]` AND drops
 *      `allow_promotion_codes` (Stripe rejects the combination).
 *   2. When a customer has only a coupon-without-promotion-code
 *      discount, the session forwards `discounts: [{ coupon }]`.
 *   3. When the customer has no discount on file, the session keeps
 *      the existing `allow_promotion_codes: true` behaviour and
 *      OMITS the `discounts` key entirely (Stripe rejects empty
 *      `discounts: []`).
 *   4. A failing `customers.retrieve` lookup must NOT block checkout —
 *      the buyer should still be able to complete their purchase, just
 *      without the auto-attached coupon line.
 *   5. Subscription-mode marketplace sessions get the same forwarding
 *      treatment so a tenant on `PROMO25` who upgrades into a paid
 *      subscription add-on lands on a checkout that already shows the
 *      coupon.
 */
describe('createMarketplacePurchase — forwards existing customer discount', () => {
  it('prefers promotion_code over coupon when both are available and drops allow_promotion_codes', async () => {
    setupTemplateScenario({
      priceModel: 'one_time',
      priceCents: 4900,
      stripePriceId: 'price_oneoff_widget',
    });
    customersRetrieve.mockResolvedValue({
      id: 'cus_mkt_buyer',
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

    await createMarketplacePurchase({
      tenantId: TENANT,
      userId: 'user_buyer',
      templateId: 'tpl_widget',
      successUrl: 'https://app.test/marketplace?ok=1',
      cancelUrl: 'https://app.test/marketplace?cancel=1',
    });

    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const params = sessionsCreate.mock.calls[0][0];
    expect(params.discounts).toEqual([{ promotion_code: 'promo_xyz' }]);
    // Stripe rejects sessions that combine `discounts` with
    // `allow_promotion_codes`, so the field MUST be omitted entirely.
    expect('allow_promotion_codes' in params).toBe(false);
    // Invoice creation still fires for one-off sessions so the
    // discount badge stamper can pick the coupon up off the
    // resulting invoice.
    expect(params.invoice_creation).toMatchObject({ enabled: true });
  });

  it('falls back to coupon when no promotion code exists', async () => {
    setupTemplateScenario({
      priceModel: 'one_time',
      priceCents: 4900,
      stripePriceId: 'price_oneoff_widget',
    });
    customersRetrieve.mockResolvedValue({
      id: 'cus_mkt_buyer',
      discount: {
        coupon: {
          id: 'coupon_promo25',
          name: 'Spring Promo',
          percent_off: 25,
          valid: true,
        },
        promotion_code: null,
      },
    });

    await createMarketplacePurchase({
      tenantId: TENANT,
      userId: 'user_buyer',
      templateId: 'tpl_widget',
      successUrl: 'https://app.test/marketplace?ok=1',
      cancelUrl: 'https://app.test/marketplace?cancel=1',
    });

    const params = sessionsCreate.mock.calls[0][0];
    expect(params.discounts).toEqual([{ coupon: 'coupon_promo25' }]);
    expect('allow_promotion_codes' in params).toBe(false);
  });

  it('omits the `discounts` key entirely when no customer discount applies and keeps allow_promotion_codes', async () => {
    setupTemplateScenario({
      priceModel: 'one_time',
      priceCents: 4900,
      stripePriceId: 'price_oneoff_widget',
    });
    customersRetrieve.mockResolvedValue({
      id: 'cus_mkt_buyer',
      discount: null,
    });

    await createMarketplacePurchase({
      tenantId: TENANT,
      userId: 'user_buyer',
      templateId: 'tpl_widget',
      successUrl: 'https://app.test/marketplace?ok=1',
      cancelUrl: 'https://app.test/marketplace?cancel=1',
    });

    const params = sessionsCreate.mock.calls[0][0];
    // Stripe rejects an empty `discounts: []` array, so the key must
    // be missing entirely when no discount applies.
    expect('discounts' in params).toBe(false);
    // Without a forwarded discount, buyers can still type a promo
    // code by hand at the marketplace checkout.
    expect(params.allow_promotion_codes).toBe(true);
  });

  it('drops the discount when the coupon is no longer valid and keeps the manual promo box', async () => {
    setupTemplateScenario({
      priceModel: 'one_time',
      priceCents: 4900,
      stripePriceId: 'price_oneoff_widget',
    });
    customersRetrieve.mockResolvedValue({
      id: 'cus_mkt_buyer',
      discount: {
        coupon: { id: 'coupon_dead', percent_off: 50, valid: false },
      },
    });

    await createMarketplacePurchase({
      tenantId: TENANT,
      userId: 'user_buyer',
      templateId: 'tpl_widget',
      successUrl: 'https://app.test/marketplace?ok=1',
      cancelUrl: 'https://app.test/marketplace?cancel=1',
    });

    const params = sessionsCreate.mock.calls[0][0];
    expect('discounts' in params).toBe(false);
    expect(params.allow_promotion_codes).toBe(true);
  });

  it('does not block checkout when the discount lookup throws', async () => {
    setupTemplateScenario({
      priceModel: 'one_time',
      priceCents: 4900,
      stripePriceId: 'price_oneoff_widget',
    });
    customersRetrieve.mockRejectedValue(new Error('stripe is down'));

    const result = await createMarketplacePurchase({
      tenantId: TENANT,
      userId: 'user_buyer',
      templateId: 'tpl_widget',
      successUrl: 'https://app.test/marketplace?ok=1',
      cancelUrl: 'https://app.test/marketplace?cancel=1',
    });

    expect(result.success).toBe(true);
    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_mkt_test_123');
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const params = sessionsCreate.mock.calls[0][0];
    expect('discounts' in params).toBe(false);
    expect(params.allow_promotion_codes).toBe(true);
  });

  it('forwards customer discount on subscription-mode marketplace purchases too', async () => {
    setupTemplateScenario({
      priceModel: 'monthly_subscription',
      priceCents: 999,
      stripePriceId: 'price_sub_widget',
    });
    customersRetrieve.mockResolvedValue({
      id: 'cus_mkt_buyer',
      discount: {
        coupon: { id: 'coupon_promo25', percent_off: 25, valid: true },
        promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
      },
    });

    await createMarketplacePurchase({
      tenantId: TENANT,
      userId: 'user_buyer',
      templateId: 'tpl_widget',
      successUrl: 'https://app.test/marketplace?ok=1',
      cancelUrl: 'https://app.test/marketplace?cancel=1',
    });

    const params = sessionsCreate.mock.calls[0][0];
    expect(params.mode).toBe('subscription');
    expect(params.discounts).toEqual([{ promotion_code: 'promo_xyz' }]);
    // Subscription-mode sessions also can't combine `discounts` with
    // `allow_promotion_codes`.
    expect('allow_promotion_codes' in params).toBe(false);
    // Stripe still auto-creates invoices in subscription mode, so we
    // continue to omit `invoice_creation` here.
    expect(params.invoice_creation).toBeUndefined();
  });
});
