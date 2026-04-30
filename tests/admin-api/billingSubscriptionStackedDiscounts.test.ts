/**
 * Coverage for `GET /billing/subscription`: pins the merged
 * `discounts` array (customer + subscription-level, de-duped) and the
 * legacy `discount` field.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const {
  queryMock,
  releaseMock,
  connectMock,
  customersRetrieveMock,
  subscriptionsRetrieveMock,
} = vi.hoisted(() => {
  const q = vi.fn();
  const r = vi.fn();
  return {
    queryMock: q,
    releaseMock: r,
    connectMock: vi.fn(async () => ({ query: q, release: r })),
    customersRetrieveMock: vi.fn(),
    subscriptionsRetrieveMock: vi.fn(),
  };
});

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../platform/billing/stripe/checkout', () => ({
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/webhook', () => ({
  constructStripeEvent: vi.fn(),
  handleStripeEvent: vi.fn(),
}));

vi.mock('../../platform/billing/budget/checkBudget', () => ({
  checkBudget: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    customers: { retrieve: customersRetrieveMock },
    subscriptions: { retrieve: subscriptionsRetrieveMock },
  }),
  getWebhookSecret: () => 'whsec_test',
}));

const currentUser = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  role: 'manager',
  isPlatformAdmin: false,
  email: 'manager@acme.test',
};

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = { ...currentUser };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import billingRoutes from '../../server/admin-api/routes/billing';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(billingRoutes);
  return app;
}

interface SubscriptionRowOverrides {
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}

function stubSubscriptionRow(overrides: SubscriptionRowOverrides = {}): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM\s+subscriptions\s+WHERE\s+tenant_id/i.test(sql)) {
      return {
        rows: [
          {
            plan: 'pro',
            status: 'active',
            billing_interval: 'monthly',
            current_period_start: '2026-04-01T00:00:00Z',
            current_period_end: '2026-05-01T00:00:00Z',
            trial_end: null,
            cancelled_at: null,
            monthly_call_limit: 1000,
            monthly_sms_limit: 1000,
            monthly_ai_minute_limit: 500,
            overage_enabled: true,
            stripe_customer_id: overrides.stripe_customer_id ?? 'cus_test',
            stripe_subscription_id: overrides.stripe_subscription_id ?? 'sub_test',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-04-01T00:00:00Z',
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('GET /billing/subscription — stacked discounts', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    customersRetrieveMock.mockReset();
    subscriptionsRetrieveMock.mockReset();
  });

  it('merges customer + subscription-level coupons with the customer chip first', async () => {
    stubSubscriptionRow();
    customersRetrieveMock.mockResolvedValueOnce({
      id: 'cus_test',
      discount: {
        coupon: {
          id: 'coupon_customer_promo',
          name: 'Customer 10% Off',
          percent_off: 10,
          amount_off: null,
          currency: null,
          valid: true,
        },
        promotion_code: { id: 'promo_cust', code: 'WELCOME10' },
        end: null,
      },
    });
    subscriptionsRetrieveMock.mockResolvedValueOnce({
      id: 'sub_test',
      discounts: [
        {
          coupon: {
            id: 'coupon_sub_recurring',
            name: 'Sub 25% Off',
            percent_off: 25,
            amount_off: null,
            currency: null,
            valid: true,
          },
          promotion_code: { id: 'promo_sub', code: 'STACK25' },
          end: null,
        },
        {
          coupon: {
            id: 'coupon_sub_oneoff',
            name: 'Upgrade Bonus',
            percent_off: null,
            amount_off: 500,
            currency: 'usd',
            valid: true,
          },
          promotion_code: null,
          end: null,
        },
      ],
    });

    const res = await request(buildApp()).get('/billing/subscription');

    expect(res.status).toBe(200);
    const sub = res.body.subscription;

    expect(sub.discounts).toHaveLength(3);
    expect(sub.discounts[0]).toMatchObject({
      couponId: 'coupon_customer_promo',
      percentOff: 10,
      promotionCode: 'WELCOME10',
    });
    expect(sub.discounts[1]).toMatchObject({
      couponId: 'coupon_sub_recurring',
      percentOff: 25,
      promotionCode: 'STACK25',
    });
    expect(sub.discounts[2]).toMatchObject({
      couponId: 'coupon_sub_oneoff',
      amountOffCents: 500,
      currency: 'usd',
    });

    expect(sub.discount).toMatchObject({
      couponId: 'coupon_customer_promo',
      percentOff: 10,
      promotionCode: 'WELCOME10',
    });

    expect(sub.stripe_customer_id).toBeUndefined();
    expect(sub.stripe_subscription_id).toBeUndefined();

    // Only the modern `discounts.promotion_code` is expanded — expanding
    // the removed `discount.promotion_code` would throw on newer API
    // versions and silently drop every entry.
    expect(subscriptionsRetrieveMock).toHaveBeenCalledWith('sub_test', {
      expand: ['discounts.promotion_code'],
    });
  });

  it('de-duplicates a coupon attached to both the customer and the subscription', async () => {
    stubSubscriptionRow();
    customersRetrieveMock.mockResolvedValueOnce({
      id: 'cus_test',
      discount: {
        coupon: {
          id: 'coupon_shared',
          name: 'Shared 15% Off',
          percent_off: 15,
          valid: true,
        },
        promotion_code: { id: 'promo_shared', code: 'SHARED15' },
        end: null,
      },
    });
    subscriptionsRetrieveMock.mockResolvedValueOnce({
      id: 'sub_test',
      discounts: [
        {
          coupon: {
            id: 'coupon_shared',
            name: 'Shared 15% Off',
            percent_off: 15,
            valid: true,
          },
          promotion_code: { id: 'promo_shared', code: 'SHARED15' },
          end: null,
        },
        {
          coupon: {
            id: 'coupon_extra',
            name: 'Extra Promo',
            percent_off: 5,
            valid: true,
          },
          promotion_code: null,
          end: null,
        },
      ],
    });

    const res = await request(buildApp()).get('/billing/subscription');
    expect(res.status).toBe(200);

    const sub = res.body.subscription;
    expect(sub.discounts).toHaveLength(2);
    expect(sub.discounts[0]).toMatchObject({ couponId: 'coupon_shared' });
    expect(sub.discounts[1]).toMatchObject({ couponId: 'coupon_extra' });
  });

  it('mirrors the customer-level chip into `discounts` when the subscription has no stack', async () => {
    stubSubscriptionRow();
    customersRetrieveMock.mockResolvedValueOnce({
      id: 'cus_test',
      discount: {
        coupon: {
          id: 'coupon_customer_only',
          name: 'Loyalty 15% Off',
          percent_off: 15,
          valid: true,
        },
        promotion_code: { id: 'promo_loyalty', code: 'LOYAL15' },
        end: null,
      },
    });
    subscriptionsRetrieveMock.mockResolvedValueOnce({
      id: 'sub_test',
      discounts: [],
    });

    const res = await request(buildApp()).get('/billing/subscription');
    expect(res.status).toBe(200);

    const sub = res.body.subscription;
    expect(sub.discount).toMatchObject({ couponId: 'coupon_customer_only' });
    expect(sub.discounts).toHaveLength(1);
    expect(sub.discounts[0]).toMatchObject({ couponId: 'coupon_customer_only' });
  });

  it('skips invalidated subscription-level coupons and still surfaces the rest', async () => {
    stubSubscriptionRow();
    customersRetrieveMock.mockResolvedValueOnce({ id: 'cus_test', discount: null });
    subscriptionsRetrieveMock.mockResolvedValueOnce({
      id: 'sub_test',
      discounts: [
        {
          coupon: { id: 'coupon_dead', percent_off: 10, valid: false },
          promotion_code: null,
          end: null,
        },
        {
          coupon: { id: 'coupon_live', percent_off: 20, valid: true },
          promotion_code: null,
          end: null,
        },
      ],
    });

    const res = await request(buildApp()).get('/billing/subscription');
    expect(res.status).toBe(200);

    const sub = res.body.subscription;
    expect(sub.discounts).toHaveLength(1);
    expect(sub.discounts[0]).toMatchObject({ couponId: 'coupon_live' });
    expect(sub.discount).toBeNull();
  });

  it('returns null `discount` and empty `discounts` when neither side has a discount', async () => {
    stubSubscriptionRow();
    customersRetrieveMock.mockResolvedValueOnce({ id: 'cus_test', discount: null });
    subscriptionsRetrieveMock.mockResolvedValueOnce({ id: 'sub_test', discounts: [] });

    const res = await request(buildApp()).get('/billing/subscription');
    expect(res.status).toBe(200);

    const sub = res.body.subscription;
    expect(sub.discount).toBeNull();
    expect(sub.discounts).toEqual([]);
  });

  // Pins the multi-discount response shape consumed by the
  // post-checkout success-redirect banner.
  it('returns the post-checkout success-redirect chips: customer + stacked subscription discounts', async () => {
    stubSubscriptionRow();
    customersRetrieveMock.mockResolvedValueOnce({
      id: 'cus_test',
      discount: {
        coupon: {
          id: 'coupon_recurring',
          name: 'Recurring 10% Off',
          percent_off: 10,
          valid: true,
        },
        promotion_code: { id: 'promo_recurring', code: 'LOYAL10' },
        end: null,
      },
    });
    subscriptionsRetrieveMock.mockResolvedValueOnce({
      id: 'sub_test',
      discounts: [
        {
          coupon: {
            id: 'coupon_upgrade_promo',
            name: 'Annual Upgrade 20% Off',
            percent_off: 20,
            valid: true,
          },
          promotion_code: { id: 'promo_upgrade', code: 'UPGRADE20' },
          end: null,
        },
      ],
    });

    const res = await request(buildApp()).get('/billing/subscription');
    expect(res.status).toBe(200);

    const sub = res.body.subscription;
    expect(sub.discounts).toHaveLength(2);
    expect(sub.discounts[0]).toMatchObject({
      couponId: 'coupon_recurring',
      percentOff: 10,
      promotionCode: 'LOYAL10',
    });
    expect(sub.discounts[1]).toMatchObject({
      couponId: 'coupon_upgrade_promo',
      percentOff: 20,
      promotionCode: 'UPGRADE20',
    });
    expect(sub.discount).toMatchObject({
      couponId: 'coupon_recurring',
      promotionCode: 'LOYAL10',
    });
  });

  it('falls back to the legacy `subscription.discount` when `discounts` array is missing', async () => {
    stubSubscriptionRow();
    customersRetrieveMock.mockResolvedValueOnce({ id: 'cus_test', discount: null });
    subscriptionsRetrieveMock.mockResolvedValueOnce({
      id: 'sub_test',
      discount: {
        coupon: { id: 'coupon_legacy', percent_off: 30, valid: true },
        promotion_code: { id: 'promo_legacy', code: 'LEGACY30' },
        end: null,
      },
    });

    const res = await request(buildApp()).get('/billing/subscription');
    expect(res.status).toBe(200);

    const sub = res.body.subscription;
    expect(sub.discounts).toHaveLength(1);
    expect(sub.discounts[0]).toMatchObject({
      couponId: 'coupon_legacy',
      percentOff: 30,
      promotionCode: 'LEGACY30',
    });
  });
});
