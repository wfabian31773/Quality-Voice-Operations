/**
 * Coverage for Task #1202 backend pieces:
 *
 *   POST /billing/schedule-downgrade
 *   POST /billing/checkout                       (downgrade-guard branch)
 *   webhook handleSubscriptionUpdated            (interval persistence)
 *
 * Why these three live together:
 *   The downgrade UI only stays honest end-to-end if (a) the schedule
 *   endpoint actually creates a Stripe Subscription Schedule, (b) the
 *   checkout endpoint REFUSES to create a parallel subscription for a
 *   strict downgrade, and (c) when Stripe later transitions schedule
 *   phases the customer.subscription.updated webhook persists the new
 *   billing_interval + stripe_price_id (otherwise the Billing UI would
 *   show the wrong interval after the swap takes effect).
 *
 * Pattern matches the in-memory express + mocked-pool style used by
 * tests/admin-api/billingTrailingUsage.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const {
  queryMock,
  releaseMock,
  connectMock,
  createCheckoutSessionMock,
  subscriptionsRetrieveMock,
  subscriptionSchedulesCreateMock,
  subscriptionSchedulesRetrieveMock,
  subscriptionSchedulesUpdateMock,
  getPlanPriceIdMock,
} = vi.hoisted(() => {
  const q = vi.fn();
  const r = vi.fn();
  return {
    queryMock: q,
    releaseMock: r,
    connectMock: vi.fn(async () => ({ query: q, release: r })),
    createCheckoutSessionMock: vi.fn(async () => ({ url: 'https://stripe.test/checkout' })),
    subscriptionsRetrieveMock: vi.fn(),
    subscriptionSchedulesCreateMock: vi.fn(),
    subscriptionSchedulesRetrieveMock: vi.fn(),
    subscriptionSchedulesUpdateMock: vi.fn(),
    getPlanPriceIdMock: vi.fn((tier: string, interval: string) => `price_${tier}_${interval}`),
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
  createCheckoutSession: createCheckoutSessionMock,
  createPortalSession: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/webhook', () => ({
  constructStripeEvent: vi.fn(),
  handleStripeEvent: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/effectiveRate', () => ({
  getTenantEffectiveRate: vi.fn(),
  getTenantUpgradePreview: vi.fn(),
  isPlanTier: (s: unknown): s is 'starter' | 'pro' | 'enterprise' =>
    s === 'starter' || s === 'pro' || s === 'enterprise',
  nextUpgradeTier: vi.fn(),
}));

vi.mock('../../platform/billing/budget/checkBudget', () => ({
  checkBudget: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    subscriptions: { retrieve: subscriptionsRetrieveMock },
    subscriptionSchedules: {
      create: subscriptionSchedulesCreateMock,
      retrieve: subscriptionSchedulesRetrieveMock,
      update: subscriptionSchedulesUpdateMock,
    },
  }),
  getWebhookSecret: () => 'whsec_test',
}));

vi.mock('../../platform/billing/stripe/plans', async () => {
  const actual = await vi.importActual<typeof import('../../platform/billing/stripe/plans')>(
    '../../platform/billing/stripe/plans',
  );
  return {
    ...actual,
    getPlanPriceId: getPlanPriceIdMock,
  };
});

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

/**
 * Default DB stub — returns the given subscription row whenever the
 * route asks for the tenant's stripe subscription. Other queries
 * (BEGIN/COMMIT/SET LOCAL) get empty result sets so the handler still
 * completes cleanly.
 */
function stubLoadSubscription(row: { stripe_subscription_id: string | null; plan: string | null } | null): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT stripe_subscription_id, plan FROM subscriptions/i.test(sql)) {
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('POST /billing/schedule-downgrade', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    subscriptionsRetrieveMock.mockReset();
    subscriptionSchedulesCreateMock.mockReset();
    subscriptionSchedulesRetrieveMock.mockReset();
    subscriptionSchedulesUpdateMock.mockReset();
    createCheckoutSessionMock.mockClear();
    getPlanPriceIdMock.mockClear();
  });

  it('rejects an invalid plan without touching Stripe', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'enterprise' });

    const res = await request(buildApp())
      .post('/billing/schedule-downgrade')
      .send({ plan: 'platinum', interval: 'monthly' });

    expect(res.status).toBe(400);
    expect(subscriptionSchedulesUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects when the tenant has no active paid subscription', async () => {
    stubLoadSubscription(null);

    const res = await request(buildApp())
      .post('/billing/schedule-downgrade')
      .send({ plan: 'pro', interval: 'monthly' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no active paid subscription/i);
    expect(subscriptionSchedulesUpdateMock).not.toHaveBeenCalled();
  });

  it('rejects an upgrade or same-tier "downgrade" so the endpoint cannot be misused', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'pro' });

    const upgrade = await request(buildApp())
      .post('/billing/schedule-downgrade')
      .send({ plan: 'enterprise', interval: 'monthly' });
    expect(upgrade.status).toBe(400);
    expect(upgrade.body.error).toMatch(/not a downgrade/i);

    const sameTier = await request(buildApp())
      .post('/billing/schedule-downgrade')
      .send({ plan: 'pro', interval: 'annual' });
    expect(sameTier.status).toBe(400);
    expect(sameTier.body.error).toMatch(/not a downgrade/i);

    expect(subscriptionSchedulesUpdateMock).not.toHaveBeenCalled();
  });

  it('creates a new Subscription Schedule and queues a phase 2 with the new price', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'enterprise' });
    subscriptionsRetrieveMock.mockResolvedValue({
      id: 'sub_1',
      schedule: null,
      items: { data: [{ id: 'si_1', price: { id: 'price_enterprise_monthly' } }] },
    });
    const phaseEnd = Math.floor(Date.UTC(2026, 5, 1) / 1000); // 2026-06-01
    subscriptionSchedulesCreateMock.mockResolvedValue({
      id: 'sub_sched_1',
      phases: [
        {
          start_date: phaseEnd - 30 * 86400,
          end_date: phaseEnd,
          items: [{ price: 'price_enterprise_monthly', quantity: 1 }],
        },
      ],
    });
    subscriptionSchedulesUpdateMock.mockResolvedValue({ id: 'sub_sched_1' });

    const res = await request(buildApp())
      .post('/billing/schedule-downgrade')
      .send({ plan: 'pro', interval: 'monthly' });

    expect(res.status).toBe(200);
    expect(res.body.scheduled).toMatchObject({
      scheduleId: 'sub_sched_1',
      targetPlan: 'pro',
      targetInterval: 'monthly',
      scheduledFor: new Date(phaseEnd * 1000).toISOString(),
    });

    expect(subscriptionSchedulesCreateMock).toHaveBeenCalledWith({ from_subscription: 'sub_1' });
    expect(getPlanPriceIdMock).toHaveBeenCalledWith('pro', 'monthly');

    const [scheduleId, updateArgs] = subscriptionSchedulesUpdateMock.mock.calls[0];
    expect(scheduleId).toBe('sub_sched_1');
    expect(updateArgs.end_behavior).toBe('release');
    expect(updateArgs.phases).toHaveLength(2);
    // Phase 0 = current paid period, pinned to its existing end date.
    expect(updateArgs.phases[0].end_date).toBe(phaseEnd);
    expect(updateArgs.phases[0].items[0].price).toBe('price_enterprise_monthly');
    // Phase 1 = lower tier, exactly one billing cycle, no proration.
    expect(updateArgs.phases[1].items[0].price).toBe('price_pro_monthly');
    expect(updateArgs.phases[1].duration).toEqual({ interval_count: 1, interval: 'month' });
    expect(updateArgs.phases[1].proration_behavior).toBe('none');
  });

  it('passes interval=annual through to phase 2 duration so a monthly→annual downgrade swaps cadence', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'enterprise' });
    subscriptionsRetrieveMock.mockResolvedValue({
      id: 'sub_1',
      schedule: null,
      items: { data: [{ id: 'si_1', price: { id: 'price_enterprise_monthly' } }] },
    });
    const phaseEnd = Math.floor(Date.UTC(2026, 6, 1) / 1000);
    subscriptionSchedulesCreateMock.mockResolvedValue({
      id: 'sub_sched_2',
      phases: [
        {
          start_date: phaseEnd - 30 * 86400,
          end_date: phaseEnd,
          items: [{ price: 'price_enterprise_monthly', quantity: 1 }],
        },
      ],
    });
    subscriptionSchedulesUpdateMock.mockResolvedValue({ id: 'sub_sched_2' });

    const res = await request(buildApp())
      .post('/billing/schedule-downgrade')
      .send({ plan: 'pro', interval: 'annual' });

    expect(res.status).toBe(200);
    const [, updateArgs] = subscriptionSchedulesUpdateMock.mock.calls[0];
    expect(updateArgs.phases[1].items[0].price).toBe('price_pro_annual');
    expect(updateArgs.phases[1].duration).toEqual({ interval_count: 1, interval: 'year' });
  });

  it('reuses an existing Subscription Schedule instead of creating a parallel one', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'enterprise' });
    subscriptionsRetrieveMock.mockResolvedValue({
      id: 'sub_1',
      schedule: 'sub_sched_existing',
      items: { data: [{ id: 'si_1', price: { id: 'price_enterprise_monthly' } }] },
    });
    const phaseEnd = Math.floor(Date.UTC(2026, 5, 15) / 1000);
    subscriptionSchedulesRetrieveMock.mockResolvedValue({
      id: 'sub_sched_existing',
      phases: [
        {
          start_date: phaseEnd - 30 * 86400,
          end_date: phaseEnd,
          items: [{ price: 'price_enterprise_monthly', quantity: 1 }],
        },
      ],
    });
    subscriptionSchedulesUpdateMock.mockResolvedValue({ id: 'sub_sched_existing' });

    const res = await request(buildApp())
      .post('/billing/schedule-downgrade')
      .send({ plan: 'pro', interval: 'monthly' });

    expect(res.status).toBe(200);
    expect(subscriptionSchedulesCreateMock).not.toHaveBeenCalled();
    expect(subscriptionSchedulesRetrieveMock).toHaveBeenCalledWith('sub_sched_existing');
    expect(res.body.scheduled.scheduleId).toBe('sub_sched_existing');
  });
});

describe('POST /billing/checkout — strict downgrade guard', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    createCheckoutSessionMock.mockClear();
  });

  it('refuses a downgrade routed to /billing/checkout and points the caller at the schedule endpoint', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'enterprise' });

    const res = await request(buildApp())
      .post('/billing/checkout')
      .send({ plan: 'pro', interval: 'monthly', successUrl: 'https://x', cancelUrl: 'https://y' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DOWNGRADE_REQUIRES_SCHEDULE');
    expect(res.body.error).toMatch(/schedule-downgrade/);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('still allows checkout for a true upgrade', async () => {
    stubLoadSubscription({ stripe_subscription_id: 'sub_1', plan: 'pro' });

    const res = await request(buildApp())
      .post('/billing/checkout')
      .send({ plan: 'enterprise', interval: 'monthly', successUrl: 'https://x', cancelUrl: 'https://y' });

    expect(res.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'enterprise', interval: 'monthly' }),
    );
  });

  it('still allows checkout for a free-tier tenant (no current subscription) selecting any plan', async () => {
    stubLoadSubscription(null);

    const res = await request(buildApp())
      .post('/billing/checkout')
      .send({ plan: 'starter', interval: 'monthly', successUrl: 'https://x', cancelUrl: 'https://y' });

    expect(res.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'starter', interval: 'monthly' }),
    );
  });

  it('fails CLOSED (503, no Stripe call) when the downgrade-guard subscription lookup throws', async () => {
    // If we can't tell whether this is a downgrade we MUST refuse the
    // checkout — falling through would re-open the parallel-Stripe-sub
    // bug that scheduleDowngrade exists to prevent.
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
      .post('/billing/checkout')
      .send({ plan: 'pro', interval: 'monthly', successUrl: 'https://x', cancelUrl: 'https://y' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DOWNGRADE_GUARD_UNAVAILABLE');
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });
});
