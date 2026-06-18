import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  createPortalSessionMock: vi.fn(),
  createCheckoutSessionMock: vi.fn(),
  constructStripeEventMock: vi.fn(),
  handleStripeEventMock: vi.fn(),
  getTenantEffectiveRateMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  getRecommendationDigestStatusMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.queryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/billing/stripe/checkout', () => ({
  createCheckoutSession: a.createCheckoutSessionMock,
  createPortalSession: a.createPortalSessionMock,
}));
vi.mock('../../../platform/billing/stripe/webhook', () => ({
  constructStripeEvent: a.constructStripeEventMock,
  handleStripeEvent: a.handleStripeEventMock,
}));
vi.mock('../../../platform/billing/stripe/effectiveRate', () => ({
  getTenantEffectiveRate: a.getTenantEffectiveRateMock,
  getTenantUpgradePreview: vi.fn(),
  getTenantDowngradePreview: vi.fn(),
  isPlanTier: () => true,
  loadActiveCustomerDiscount: vi.fn().mockResolvedValue(null),
  loadActiveSubscriptionDiscounts: vi.fn().mockResolvedValue([]),
  nextUpgradeTier: () => 'pro',
  normalizeDiscount: () => null,
}));
vi.mock('../../../platform/billing/stripe/planChange', () => ({
  scheduleDowngrade: vi.fn(),
  loadTenantSubscription: vi.fn(),
  isStrictDowngrade: vi.fn(),
  classifyCheckoutDirection: vi.fn(),
}));
vi.mock('../../../platform/billing/budget/checkBudget', () => ({ checkBudget: a.checkBudgetMock }));
vi.mock('../../../platform/billing/PlanRecommendationDigestScheduler', () => ({ getTenantRecommendationDigestStatus: a.getRecommendationDigestStatusMock }));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));

import router from './billing';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.releaseMock.mockReset();
  a.createPortalSessionMock.mockReset().mockResolvedValue({ url: 'https://portal' });
  a.constructStripeEventMock.mockReset();
  a.handleStripeEventMock.mockReset().mockResolvedValue(undefined);
  a.getTenantEffectiveRateMock.mockReset().mockResolvedValue({ plan: 'starter', rateCents: 100 });
  a.checkBudgetMock.mockReset().mockResolvedValue({ allowed: true });
  a.getRecommendationDigestStatusMock.mockReset().mockResolvedValue({ enabled: false });
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
});

describe('GET /billing/subscription', () => {
  it('returns starter/none when no subscription row exists', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/billing/subscription')).body).toMatchObject({ subscription: null, plan: 'starter', status: 'none' });
  });
  it('returns the subscription (no stripe ids → no discount lookup)', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM subscriptions') ? { rows: [{ plan: 'pro', status: 'active', stripe_customer_id: null, stripe_subscription_id: null }] } : { rows: [] },
    );
    const res = await request(app()).get('/billing/subscription');
    expect(res.body.subscription).toMatchObject({ plan: 'pro', discount: null, discounts: [] });
  });
  it('500 on error', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/billing/subscription')).status).toBe(500);
  });
});

describe('GET /billing/usage', () => {
  it('aggregates usage by metric type', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM usage_metrics') ? { rows: [{ metric_type: 'ai_minutes', total: '120' }] } : { rows: [] },
    );
    expect((await request(app()).get('/billing/usage')).body.usage).toEqual({ ai_minutes: 120 });
  });
});

describe('POST /billing/acknowledge-downgrade-completion', () => {
  it('clears the completion flags', async () => {
    expect((await request(app()).post('/billing/acknowledge-downgrade-completion')).body).toEqual({ acknowledged: true });
  });
});

describe('POST /billing/portal', () => {
  it('rejects a viewer via rbac', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/billing/portal').send({})).status).toBe(403);
  });
  it('creates a portal session + audit', async () => {
    const res = await request(app()).post('/billing/portal').send({ returnUrl: 'https://x/return' });
    expect(res.body).toEqual({ url: 'https://portal' });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.portal_accessed' }));
  });
  it('500 on failure', async () => {
    a.createPortalSessionMock.mockRejectedValue(new Error('stripe down'));
    expect((await request(app()).post('/billing/portal').send({})).status).toBe(500);
  });
});

describe('simple read routes', () => {
  it('recommendation-status', async () => {
    a.getRecommendationDigestStatusMock.mockResolvedValue({ enabled: true });
    expect((await request(app()).get('/billing/recommendation-status')).body).toEqual({ status: { enabled: true } });
  });
  it('effective-rate', async () => {
    a.getTenantEffectiveRateMock.mockResolvedValue({ plan: 'pro', rateCents: 200 });
    expect((await request(app()).get('/billing/effective-rate')).body).toMatchObject({ plan: 'pro' });
  });
  it('effective-rate 500', async () => {
    a.getTenantEffectiveRateMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/billing/effective-rate')).status).toBe(500);
  });
  it('budget', async () => {
    a.checkBudgetMock.mockResolvedValue({ allowed: true, usage: 0.5 });
    expect((await request(app()).get('/billing/budget')).body).toMatchObject({ allowed: true });
  });
});

describe('GET /billing/invoices', () => {
  it('rejects a viewer via rbac', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).get('/billing/invoices')).status).toBe(403);
  });
  it('returns [] when there is no stripe customer', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('stripe_customer_id FROM subscriptions') ? { rows: [{ stripe_customer_id: null }] } : { rows: [] },
    );
    expect((await request(app()).get('/billing/invoices')).body).toEqual({ invoices: [] });
  });
});

describe('POST /billing/stripe-webhook', () => {
  it('400 when the signature header is missing', async () => {
    expect((await request(app()).post('/billing/stripe-webhook').send({})).status).toBe(400);
  });
  it('400 when signature verification fails', async () => {
    a.constructStripeEventMock.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await request(app()).post('/billing/stripe-webhook').set('stripe-signature', 't=1,v1=x').send({});
    expect(res.status).toBe(400);
  });
  it('processes a valid event', async () => {
    a.constructStripeEventMock.mockReturnValue({ type: 'invoice.paid' });
    const res = await request(app()).post('/billing/stripe-webhook').set('stripe-signature', 't=1,v1=x').send({});
    expect(res.body).toEqual({ received: true });
    expect(a.handleStripeEventMock).toHaveBeenCalled();
  });
  it('500 when the handler throws', async () => {
    a.constructStripeEventMock.mockReturnValue({ type: 'invoice.paid' });
    a.handleStripeEventMock.mockRejectedValue(new Error('handler boom'));
    const res = await request(app()).post('/billing/stripe-webhook').set('stripe-signature', 't=1,v1=x').send({});
    expect(res.status).toBe(500);
  });
});
