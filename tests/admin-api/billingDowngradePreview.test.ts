/**
 * Coverage for `GET /billing/downgrade-preview` (Task #1257).
 *
 * Pins down: plan/interval validation, free-tier short-circuit, the
 * "must be a strict downgrade" guard, the delegation to
 * `getTenantDowngradePreview`, and the DB-failure path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const {
  queryMock,
  releaseMock,
  connectMock,
  getTenantDowngradePreviewMock,
} = vi.hoisted(() => {
  const q = vi.fn();
  const r = vi.fn();
  return {
    queryMock: q,
    releaseMock: r,
    connectMock: vi.fn(async () => ({ query: q, release: r })),
    getTenantDowngradePreviewMock: vi.fn(),
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

vi.mock('../../platform/billing/stripe/effectiveRate', () => ({
  getTenantEffectiveRate: vi.fn(),
  getTenantUpgradePreview: vi.fn(),
  getTenantDowngradePreview: getTenantDowngradePreviewMock,
  isPlanTier: (s: unknown): s is 'starter' | 'pro' | 'enterprise' =>
    s === 'starter' || s === 'pro' || s === 'enterprise',
  nextUpgradeTier: vi.fn(),
}));

vi.mock('../../platform/billing/budget/checkBudget', () => ({
  checkBudget: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    subscriptions: { retrieve: vi.fn() },
    subscriptionSchedules: {
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
    },
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

function stubLoadSubscription(
  row: { stripe_subscription_id: string | null; plan: string | null } | null,
): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT\s+stripe_subscription_id[\s\S]+FROM\s+subscriptions/i.test(sql)) {
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('GET /billing/downgrade-preview', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    getTenantDowngradePreviewMock.mockReset();
  });

  it('rejects an unknown plan with 400 without consulting Stripe', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'enterprise' });

    const res = await request(buildApp())
      .get('/billing/downgrade-preview')
      .query({ plan: 'platinum', interval: 'monthly' });

    expect(res.status).toBe(400);
    expect(getTenantDowngradePreviewMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown interval with 400', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'enterprise' });

    const res = await request(buildApp())
      .get('/billing/downgrade-preview')
      .query({ plan: 'pro', interval: 'biweekly' });

    expect(res.status).toBe(400);
    expect(getTenantDowngradePreviewMock).not.toHaveBeenCalled();
  });

  it('returns { downgrade: null } for a free-tier tenant (no Stripe subscription)', async () => {
    stubLoadSubscription(null);

    const res = await request(buildApp())
      .get('/billing/downgrade-preview')
      .query({ plan: 'starter', interval: 'monthly' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ downgrade: null });
    expect(getTenantDowngradePreviewMock).not.toHaveBeenCalled();
  });

  it('returns { downgrade: null } when the requested plan is not a strict downgrade (upgrade or same tier)', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'pro' });

    const upgrade = await request(buildApp())
      .get('/billing/downgrade-preview')
      .query({ plan: 'enterprise', interval: 'monthly' });
    expect(upgrade.status).toBe(200);
    expect(upgrade.body).toEqual({ downgrade: null });

    const sameTier = await request(buildApp())
      .get('/billing/downgrade-preview')
      .query({ plan: 'pro', interval: 'annual' });
    expect(sameTier.status).toBe(200);
    expect(sameTier.body).toEqual({ downgrade: null });

    expect(getTenantDowngradePreviewMock).not.toHaveBeenCalled();
  });

  it('forwards the tenant id, target plan, and interval to getTenantDowngradePreview and returns its quote', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'enterprise' });
    getTenantDowngradePreviewMock.mockResolvedValueOnce({
      plan: 'pro',
      interval: 'monthly',
      nextInvoiceTotalCents: 39_900,
      nextInvoiceAt: '2026-06-01T00:00:00.000Z',
      basePriceCents: 39_900,
      currency: 'usd',
      source: 'stripe',
      basePriceSource: 'stripe',
      basePriceId: 'price_pro_monthly_published',
      discount: null,
    });

    const res = await request(buildApp())
      .get('/billing/downgrade-preview')
      .query({ plan: 'pro', interval: 'monthly' });

    expect(res.status).toBe(200);
    expect(getTenantDowngradePreviewMock).toHaveBeenCalledWith('tenant-1', 'pro', 'monthly');
    expect(res.body.downgrade).toMatchObject({
      plan: 'pro',
      interval: 'monthly',
      nextInvoiceTotalCents: 39_900,
      nextInvoiceAt: '2026-06-01T00:00:00.000Z',
      basePriceCents: 39_900,
    });
  });

  it('passes interval=annual through so monthly→annual downgrade quotes work end-to-end', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'enterprise' });
    getTenantDowngradePreviewMock.mockResolvedValueOnce({
      plan: 'pro',
      interval: 'annual',
      nextInvoiceTotalCents: 383_040,
      nextInvoiceAt: '2026-06-15T00:00:00.000Z',
      basePriceCents: 31_920,
      currency: 'usd',
      source: 'stripe',
      basePriceSource: 'stripe',
      basePriceId: 'price_pro_annual_published',
      discount: null,
    });

    const res = await request(buildApp())
      .get('/billing/downgrade-preview')
      .query({ plan: 'pro', interval: 'annual' });

    expect(res.status).toBe(200);
    expect(getTenantDowngradePreviewMock).toHaveBeenCalledWith('tenant-1', 'pro', 'annual');
    expect(res.body.downgrade.interval).toBe('annual');
    expect(res.body.downgrade.nextInvoiceTotalCents).toBe(383_040);
  });

  it('surfaces an active customer-level discount on the response so the UI can render the same Sales-coupon breadcrumb the upgrade card shows', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'enterprise' });
    getTenantDowngradePreviewMock.mockResolvedValueOnce({
      plan: 'pro',
      interval: 'monthly',
      nextInvoiceTotalCents: 29_925,
      nextInvoiceAt: '2026-06-01T00:00:00.000Z',
      basePriceCents: 29_925,
      currency: 'usd',
      source: 'stripe',
      basePriceSource: 'stripe',
      basePriceId: 'price_pro_monthly_published',
      discount: {
        couponId: 'coupon_pro_25',
        name: 'Sales 25% off',
        percentOff: 25,
        amountOffCents: null,
        currency: null,
        promotionCode: 'PROMO25',
      },
    });

    const res = await request(buildApp())
      .get('/billing/downgrade-preview')
      .query({ plan: 'pro', interval: 'monthly' });

    expect(res.status).toBe(200);
    expect(res.body.downgrade.discount).toMatchObject({
      couponId: 'coupon_pro_25',
      percentOff: 25,
      promotionCode: 'PROMO25',
    });
    // Discounted base flows through verbatim — no double-application
    // by the route.
    expect(res.body.downgrade.basePriceCents).toBe(29_925);
  });

  it('returns 500 with no Stripe call when the current-plan lookup throws (so we never quote a downgrade we cannot validate)', async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT[\s\S]+FROM subscriptions/i.test(sql)) {
        throw new Error('simulated DB outage');
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp())
      .get('/billing/downgrade-preview')
      .query({ plan: 'pro', interval: 'monthly' });

    expect(res.status).toBe(500);
    expect(getTenantDowngradePreviewMock).not.toHaveBeenCalled();
  });
});
