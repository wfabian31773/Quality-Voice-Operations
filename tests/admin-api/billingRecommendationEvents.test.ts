// Coverage for the BillingEstimator recommendation-banner instrumentation:
//   POST /billing/recommendation-event       (tenant route)
//   GET  /platform/billing-recommendations   (platform admin tile)
//   handleStripeEvent webhook path           (server-attributed completion)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  ),
  // Re-implement the real helper closely enough that the route under
  // test doesn't notice — the platform-admin handler just needs a
  // `client.query` it can call inside the callback.
  withPrivilegedClient: vi.fn(
    async (fn: (c: { query: typeof queryMock }) => Promise<unknown>) => {
      await queryMock('BEGIN');
      await queryMock('SET LOCAL row_security = off');
      try {
        const result = await fn({ query: queryMock });
        await queryMock('COMMIT');
        return result;
      } catch (err) {
        await queryMock('ROLLBACK');
        throw err;
      }
    },
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

const createCheckoutSessionMock = vi.fn();
vi.mock('../../platform/billing/stripe/checkout', () => ({
  createCheckoutSession: (...args: unknown[]) => createCheckoutSessionMock(...args),
  createPortalSession: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/webhook', () => ({
  constructStripeEvent: vi.fn(),
  handleStripeEvent: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/effectiveRate', () => ({
  getTenantEffectiveRate: vi.fn(),
  getTenantUpgradePreview: vi.fn(),
  isPlanTier: (v: unknown): v is string =>
    v === 'starter' || v === 'pro' || v === 'enterprise',
  nextUpgradeTier: vi.fn(),
}));

vi.mock('../../platform/billing/budget/checkBudget', () => ({
  checkBudget: vi.fn(),
}));

// platformAdmin pulls a handful of side-effecty modules at import time;
// stub the ones platformOnboarding.test.ts also stubs so the dynamic
// import below resolves cleanly without wiring real Slack / email / etc.
vi.mock('../../platform/messaging/SlackWebhookNotifier', () => ({
  postToOpsSlackWebhook: vi.fn(),
  getOpsSlackWebhookUrl: vi.fn(() => null),
}));
vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-rec',
      userId: 'user-rec',
      role: 'manager',
      isPlatformAdmin: true,
      email: 'admin@acme.test',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireMiniSystemWrite: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import billingRoutes from '../../server/admin-api/routes/billing';
import platformAdminRoutes from '../../server/admin-api/routes/platformAdmin';

function buildBillingApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(billingRoutes);
  return app;
}

function buildPlatformAdminApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(platformAdminRoutes);
  return app;
}

describe('POST /billing/recommendation-event', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('rejects an unknown eventType with 400 (matches the DB CHECK enum)', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'hover',
        currentTier: 'pro',
        recommendedTier: 'starter',
      });

    expect(res.status).toBe(400);
    const insertSql = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(insertSql).toBeUndefined();
  });

  it('rejects switch_completed via this endpoint (server-attributed only)', async () => {
    // switch_completed must come from the Stripe webhook so a tenant
    // cannot inflate the conversion count by hitting this endpoint.
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'switch_completed',
        currentTier: 'starter',
        recommendedTier: 'pro',
        monthlySavingsCents: 0,
      });

    expect(res.status).toBe(400);
    const insertSql = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(insertSql).toBeUndefined();
  });

  it.each(['currentTier', 'recommendedTier'])(
    'rejects an invalid %s with 400',
    async (field) => {
      const body: Record<string, string> = {
        eventType: 'click',
        currentTier: 'pro',
        recommendedTier: 'enterprise',
      };
      body[field] = 'not-a-tier';
      const res = await request(buildBillingApp())
        .post('/billing/recommendation-event')
        .send(body);
      expect(res.status).toBe(400);
    },
  );

  it('writes a click event with tenant id, both tiers, and projected savings', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'click',
        currentTier: 'enterprise',
        recommendedTier: 'pro',
        monthlySavingsCents: 30000,
        trailingWindowMonths: 6,
        metadata: { source: 'billing_estimator_recommendation' },
      });

    expect(res.status).toBe(204);
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[0]).toBe('tenant-rec');
    expect(params[1]).toBe('click');
    expect(params[2]).toBe('enterprise');
    expect(params[3]).toBe('pro');
    expect(params[4]).toBe(30000);
    expect(params[5]).toBe(6);
  });

  it('drops a non-whitelisted trailingWindowMonths value to NULL rather than 400ing', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'impression',
        currentTier: 'starter',
        recommendedTier: 'pro',
        monthlySavingsCents: 0,
        trailingWindowMonths: 7,
      });

    expect(res.status).toBe(204);
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[5]).toBeNull();
  });

  it('still returns 204 on a DB failure so analytics does not surface a tenant-facing error', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/INSERT INTO billing_recommendation_events/i.test(sql)) {
        throw new Error('boom');
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'click',
        currentTier: 'pro',
        recommendedTier: 'starter',
        monthlySavingsCents: 12000,
      });

    expect(res.status).toBe(204);
  });
});

describe('GET /platform/billing-recommendations', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('aggregates trailing-30-day event_type counts into the tile payload', async () => {
    // Match each SELECT by SQL shape so a future refactor that merges
    // the two queries doesn't break ordering assumptions.
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/GROUP BY event_type/i.test(s)) {
        return {
          rows: [
            { event_type: 'impression', count: '120' },
            { event_type: 'click', count: '18' },
            { event_type: 'switch_completed', count: '4' },
          ],
        };
      }
      if (/COUNT\(DISTINCT tenant_id\)/i.test(s)) {
        return {
          rows: [{ tenants_clicked: '11', tenants_switched: '3' }],
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      windowDays: 30,
      impressions: 120,
      clicks: 18,
      completedSwitches: 4,
      tenantsClicked: 11,
      tenantsSwitched: 3,
      // CTR = 18 / 120 = 0.15; completion = 4 / 18 ≈ 0.222...
      clickThroughRate: 0.15,
      completionRate: 4 / 18,
    });
  });

  it('returns zeros (and zero ratios) when no events have been recorded yet', async () => {
    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      windowDays: 30,
      impressions: 0,
      clicks: 0,
      completedSwitches: 0,
      tenantsClicked: 0,
      tenantsSwitched: 0,
      clickThroughRate: 0,
      completionRate: 0,
    });
  });

  it('queries the trailing-30-day window via NOW() - INTERVAL so we never have to backfill timestamps in the test', async () => {
    await request(buildPlatformAdminApp()).get('/platform/billing-recommendations');
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    const recSql = sqls.find((s) => /billing_recommendation_events/i.test(s));
    expect(recSql).toBeDefined();
    expect(recSql).toMatch(/NOW\(\)\s*-\s*INTERVAL\s*'30 days'/i);
  });
});

describe('POST /billing/checkout — recommendation attribution validation', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    createCheckoutSessionMock.mockReset();
    createCheckoutSessionMock.mockResolvedValue({ url: 'https://stripe.test/checkout' });
  });

  it('forwards recommendation metadata when recommendedTier matches the purchased plan', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/checkout')
      .send({
        plan: 'pro',
        interval: 'monthly',
        recommendation: {
          currentTier: 'enterprise',
          recommendedTier: 'pro',
          monthlySavingsCents: 25000,
          trailingWindowMonths: 6,
        },
      });

    expect(res.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
    const args = createCheckoutSessionMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.recommendation).toEqual({
      currentTier: 'enterprise',
      recommendedTier: 'pro',
      monthlySavingsCents: 25000,
      trailingWindowMonths: 6,
    });
  });

  it('drops recommendation attribution when recommendedTier does not match the purchased plan', async () => {
    // A stale client could submit a recommendation snapshot for a tier
    // the tenant isn't actually buying. Stamping that into Stripe metadata
    // would credit the banner for the wrong upgrade — drop it instead.
    const res = await request(buildBillingApp())
      .post('/billing/checkout')
      .send({
        plan: 'enterprise',
        interval: 'monthly',
        recommendation: {
          currentTier: 'starter',
          recommendedTier: 'pro',
          monthlySavingsCents: 10000,
        },
      });

    expect(res.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
    const args = createCheckoutSessionMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.recommendation).toBeUndefined();
  });
});
