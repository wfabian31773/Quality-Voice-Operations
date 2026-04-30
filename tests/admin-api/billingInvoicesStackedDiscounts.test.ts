/**
 * Coverage for `GET /billing/invoices` (Task #1313).
 *
 * Pins down that an invoice carrying multiple stacked discounts (e.g. a
 * customer-level coupon plus a one-off invoice-level coupon) surfaces
 * EVERY usable discount on the response — not just the first one — so
 * the tenant portal can render a chip per discount.
 *
 * The legacy `discount` field is also asserted so an in-flight rollout
 * with an older client build still sees one chip.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const {
  queryMock,
  releaseMock,
  connectMock,
  invoicesListMock,
} = vi.hoisted(() => {
  const q = vi.fn();
  const r = vi.fn();
  return {
    queryMock: q,
    releaseMock: r,
    connectMock: vi.fn(async () => ({ query: q, release: r })),
    invoicesListMock: vi.fn(),
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

vi.mock('../../platform/billing/stripe/effectiveRate', async () => {
  const actual = await vi.importActual<
    typeof import('../../platform/billing/stripe/effectiveRate')
  >('../../platform/billing/stripe/effectiveRate');
  return {
    ...actual,
    getTenantEffectiveRate: vi.fn(),
    getTenantUpgradePreview: vi.fn(),
    getTenantDowngradePreview: vi.fn(),
    nextUpgradeTier: vi.fn(),
  };
});

vi.mock('../../platform/billing/budget/checkBudget', () => ({
  checkBudget: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    invoices: { list: invoicesListMock },
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

function stubLoadCustomer(customerId: string | null): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT\s+stripe_customer_id[\s\S]+FROM\s+subscriptions/i.test(sql)) {
      return customerId
        ? { rows: [{ stripe_customer_id: customerId }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('GET /billing/invoices — stacked discounts', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    invoicesListMock.mockReset();
  });

  it('returns every usable discount on the invoice in `discounts`, plus the first one in `discount` for backward-compat', async () => {
    stubLoadCustomer('cus_test_123');
    invoicesListMock.mockResolvedValueOnce({
      data: [
        {
          id: 'in_test_1',
          number: 'INV-001',
          status: 'paid',
          amount_paid: 12_345,
          amount_due: 0,
          total: 12_345,
          currency: 'usd',
          created: 1_700_000_000,
          invoice_pdf: 'https://stripe.test/inv.pdf',
          description: 'Pro monthly',
          lines: { data: [] },
          discounts: [
            {
              coupon: {
                id: 'coupon_customer_promo',
                name: 'Customer 25% Off',
                percent_off: 25,
                amount_off: null,
                currency: null,
                valid: true,
              },
              promotion_code: { id: 'promo_cust', code: 'WELCOME25' },
              end: null,
            },
            {
              coupon: {
                id: 'coupon_invoice_oneoff',
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
        },
      ],
    });

    const res = await request(buildApp()).get('/billing/invoices');

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    const inv = res.body.invoices[0];

    // BOTH discounts must surface — not just the first.
    expect(inv.discounts).toHaveLength(2);
    expect(inv.discounts[0]).toMatchObject({
      couponId: 'coupon_customer_promo',
      percentOff: 25,
      promotionCode: 'WELCOME25',
    });
    expect(inv.discounts[1]).toMatchObject({
      couponId: 'coupon_invoice_oneoff',
      amountOffCents: 500,
      currency: 'usd',
    });

    // Backward-compat: the legacy `discount` field still carries the
    // first usable discount so an older client build keeps rendering.
    expect(inv.discount).toMatchObject({
      couponId: 'coupon_customer_promo',
      percentOff: 25,
    });
  });

  it('skips invalidated coupons and still surfaces the rest', async () => {
    stubLoadCustomer('cus_test_456');
    invoicesListMock.mockResolvedValueOnce({
      data: [
        {
          id: 'in_test_2',
          number: 'INV-002',
          status: 'paid',
          amount_paid: 9_900,
          total: 9_900,
          currency: 'usd',
          created: 1_700_000_100,
          invoice_pdf: null,
          description: null,
          lines: { data: [] },
          discounts: [
            {
              // Stripe has invalidated this one — must be filtered out.
              coupon: {
                id: 'coupon_dead',
                name: 'Expired',
                percent_off: 10,
                valid: false,
              },
              promotion_code: null,
              end: null,
            },
            {
              coupon: {
                id: 'coupon_live',
                name: 'Live Promo',
                percent_off: 15,
                valid: true,
              },
              promotion_code: null,
              end: null,
            },
          ],
        },
      ],
    });

    const res = await request(buildApp()).get('/billing/invoices');
    expect(res.status).toBe(200);

    const inv = res.body.invoices[0];
    expect(inv.discounts).toHaveLength(1);
    expect(inv.discounts[0]).toMatchObject({
      couponId: 'coupon_live',
      percentOff: 15,
    });
    expect(inv.discount).toMatchObject({ couponId: 'coupon_live' });
  });

  it('returns an empty `discounts` array (and null `discount`) for an invoice with no coupons', async () => {
    stubLoadCustomer('cus_test_789');
    invoicesListMock.mockResolvedValueOnce({
      data: [
        {
          id: 'in_test_3',
          number: 'INV-003',
          status: 'paid',
          amount_paid: 5_000,
          total: 5_000,
          currency: 'usd',
          created: 1_700_000_200,
          invoice_pdf: null,
          description: null,
          lines: { data: [] },
          discounts: [],
        },
      ],
    });

    const res = await request(buildApp()).get('/billing/invoices');
    expect(res.status).toBe(200);

    const inv = res.body.invoices[0];
    expect(inv.discounts).toEqual([]);
    expect(inv.discount).toBeNull();
  });

  it('falls back to a placeholder discount when `discounts` is missing but `total_discount_amounts` indicates a coupon was applied (legacy invoice shape)', async () => {
    stubLoadCustomer('cus_test_legacy');
    invoicesListMock.mockResolvedValueOnce({
      data: [
        {
          id: 'in_test_legacy',
          number: 'INV-LEGACY',
          status: 'paid',
          amount_paid: 7_700,
          total: 7_700,
          currency: 'usd',
          created: 1_700_000_300,
          invoice_pdf: null,
          description: null,
          lines: { data: [] },
          // No expanded `discounts` array (older Stripe response shape),
          // but the totals confirm a coupon was applied.
          total_discount_amounts: [{ amount: 1_000, discount: 'di_x' }],
        },
      ],
    });

    const res = await request(buildApp()).get('/billing/invoices');
    expect(res.status).toBe(200);

    const inv = res.body.invoices[0];
    expect(inv.discounts).toHaveLength(1);
    expect(inv.discounts[0]).toMatchObject({
      couponId: null,
      percentOff: null,
      amountOffCents: null,
      currency: 'usd',
    });
    expect(inv.discount).toMatchObject({ couponId: null });
  });
});
