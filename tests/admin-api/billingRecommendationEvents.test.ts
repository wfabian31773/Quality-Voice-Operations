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

  it('aggregates trailing-30-day per-tier counts and savings into the tile payload', async () => {
    // Match each SELECT by SQL shape so a future refactor that swaps the
    // queries around doesn't quietly break ordering assumptions.
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/GROUP BY recommended_tier\b/i.test(s)) {
        return {
          rows: [
            {
              recommended_tier: 'starter',
              impressions: '60',
              clicks: '15',
              completed_switches: '12',
              monthly_savings_cents: '420000',
            },
            {
              recommended_tier: 'pro',
              impressions: '50',
              clicks: '3',
              completed_switches: '2',
              monthly_savings_cents: '50000',
            },
            {
              recommended_tier: 'enterprise',
              impressions: '10',
              clicks: '0',
              completed_switches: '0',
              monthly_savings_cents: '0',
            },
          ],
        };
      }
      if (/GROUP BY current_tier, recommended_tier/i.test(s)) {
        return {
          rows: [
            {
              current_tier: 'pro',
              recommended_tier: 'starter',
              completed_switches: '12',
              monthly_savings_cents: '420000',
            },
            {
              current_tier: 'enterprise',
              recommended_tier: 'pro',
              completed_switches: '2',
              monthly_savings_cents: '50000',
            },
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
      // Totals are derived from the per-tier breakdown so the math always
      // ties out: 60+50+10 = 120 impressions, 15+3+0 = 18 clicks,
      // 12+2+0 = 14 completed switches, $4,700/mo saved.
      impressions: 120,
      clicks: 18,
      completedSwitches: 14,
      totalMonthlySavingsCents: 470000,
      tenantsClicked: 11,
      tenantsSwitched: 3,
      // CTR = 18 / 120 = 0.15; completion = 14 / 18 ≈ 0.777...
      clickThroughRate: 0.15,
      completionRate: 14 / 18,
      byRecommendedTier: [
        {
          recommendedTier: 'starter',
          impressions: 60,
          clicks: 15,
          completedSwitches: 12,
          monthlySavingsCents: 420000,
        },
        {
          recommendedTier: 'pro',
          impressions: 50,
          clicks: 3,
          completedSwitches: 2,
          monthlySavingsCents: 50000,
        },
        {
          recommendedTier: 'enterprise',
          impressions: 10,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
      ],
      switchPairs: [
        {
          currentTier: 'pro',
          recommendedTier: 'starter',
          completedSwitches: 12,
          monthlySavingsCents: 420000,
        },
        {
          currentTier: 'enterprise',
          recommendedTier: 'pro',
          completedSwitches: 2,
          monthlySavingsCents: 50000,
        },
      ],
    });
  });

  it('returns zeros (and an all-zero per-tier breakdown) when no events have been recorded yet', async () => {
    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      windowDays: 30,
      impressions: 0,
      clicks: 0,
      completedSwitches: 0,
      totalMonthlySavingsCents: 0,
      tenantsClicked: 0,
      tenantsSwitched: 0,
      clickThroughRate: 0,
      completionRate: 0,
      // Even with no events the three known tiers must show up so the UI
      // renders a stable table — only the values change.
      byRecommendedTier: [
        {
          recommendedTier: 'starter',
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
        {
          recommendedTier: 'pro',
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
        {
          recommendedTier: 'enterprise',
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
      ],
      switchPairs: [],
    });
  });

  it('drops rows with non-whitelisted recommended_tier values from the per-tier breakdown', async () => {
    // The DB schema doesn't constrain recommended_tier to the known plan
    // names; if a stray value sneaks in (e.g. a renamed plan, a test
    // fixture) we should silently ignore it rather than surface it on the
    // tile.
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/GROUP BY recommended_tier\b/i.test(s)) {
        return {
          rows: [
            {
              recommended_tier: 'starter',
              impressions: '4',
              clicks: '1',
              completed_switches: '1',
              monthly_savings_cents: '1000',
            },
            {
              recommended_tier: 'legacy-mystery-plan',
              impressions: '99',
              clicks: '99',
              completed_switches: '99',
              monthly_savings_cents: '999999',
            },
          ],
        };
      }
      if (/GROUP BY current_tier, recommended_tier/i.test(s)) {
        return {
          rows: [
            {
              current_tier: 'pro',
              recommended_tier: 'legacy-mystery-plan',
              completed_switches: '99',
              monthly_savings_cents: '999999',
            },
            {
              current_tier: 'pro',
              recommended_tier: 'starter',
              completed_switches: '1',
              monthly_savings_cents: '1000',
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations',
    );

    expect(res.status).toBe(200);
    // Totals are derived from the whitelisted breakdown — the mystery row
    // should not contribute to either the per-tier table or the totals.
    expect(res.body.impressions).toBe(4);
    expect(res.body.clicks).toBe(1);
    expect(res.body.completedSwitches).toBe(1);
    expect(res.body.totalMonthlySavingsCents).toBe(1000);
    expect(
      (res.body.byRecommendedTier as Array<{ recommendedTier: string }>).map(
        (r) => r.recommendedTier,
      ),
    ).toEqual(['starter', 'pro', 'enterprise']);
    expect(res.body.switchPairs).toEqual([
      {
        currentTier: 'pro',
        recommendedTier: 'starter',
        completedSwitches: 1,
        monthlySavingsCents: 1000,
      },
    ]);
  });

  it('queries the trailing-30-day window via NOW() - INTERVAL so we never have to backfill timestamps in the test', async () => {
    await request(buildPlatformAdminApp()).get('/platform/billing-recommendations');
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    const recSqls = sqls.filter((s) =>
      /billing_recommendation_events/i.test(s),
    );
    expect(recSqls.length).toBeGreaterThan(0);
    for (const sql of recSqls) {
      expect(sql).toMatch(/NOW\(\)\s*-\s*INTERVAL\s*'30 days'/i);
    }
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
