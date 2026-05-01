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
    expect(params[9]).toBe('tier-switch');
  });

  it('persists pitch=annual-only when the client forwards the optimal-branch annual pitch attribution', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'click',
        currentTier: 'pro',
        recommendedTier: 'pro',
        monthlySavingsCents: 4400,
        trailingWindowMonths: 3,
        pitch: 'annual-only',
      });

    expect(res.status).toBe(204);
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[1]).toBe('click');
    expect(params[2]).toBe('pro');
    expect(params[3]).toBe('pro');
    expect(params[9]).toBe('annual-only');
  });

  it('falls back to the tier-switch bucket on an unknown pitch value (server allowlist)', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'impression',
        currentTier: 'starter',
        recommendedTier: 'pro',
        monthlySavingsCents: 0,
        pitch: 'something-novel',
      });

    expect(res.status).toBe(204);
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[9]).toBe('tier-switch');
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

  it('writes a discount_impression with sanitised coupon identity', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'discount_impression',
        currentTier: 'starter',
        recommendedTier: 'pro',
        couponId: '  cou_promo20  ',
        promotionCode: 'PROMO20',
      });

    expect(res.status).toBe(204);
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[1]).toBe('discount_impression');
    expect(params[2]).toBe('starter');
    expect(params[3]).toBe('pro');
    // coupon_id and promotion_code are the last two positional params and
    // must be trimmed (whitespace from sloppy clients shouldn't leak into
    // the rollup-by-coupon SQL key).
    expect(params[7]).toBe('cou_promo20');
    expect(params[8]).toBe('PROMO20');
  });

  it('writes a discount_click when only promotionCode is provided', async () => {
    // Either identity field is sufficient; the missing side becomes NULL.
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'discount_click',
        currentTier: 'starter',
        recommendedTier: 'pro',
        promotionCode: 'BLACKFRIDAY',
      });

    expect(res.status).toBe(204);
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[1]).toBe('discount_click');
    expect(params[7]).toBeNull();
    expect(params[8]).toBe('BLACKFRIDAY');
  });

  it('rejects a discount event with neither couponId nor promotionCode (400)', async () => {
    // Unattributable rows would just pad the rollup with NULL/NULL groups.
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'discount_impression',
        currentTier: 'starter',
        recommendedTier: 'pro',
      });

    expect(res.status).toBe(400);
    const insertCall = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(insertCall).toBeUndefined();
  });

  it('rejects discount_switch_completed via this endpoint (server-attributed only)', async () => {
    // The Stripe webhook is the only writer for completion events.
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'discount_switch_completed',
        currentTier: 'starter',
        recommendedTier: 'pro',
        couponId: 'cou_promo20',
      });

    expect(res.status).toBe(400);
  });

  it('drops oversize couponId / promotionCode values to NULL and 400s when both end up empty', async () => {
    // Sanitisers cap couponId at 255 chars and promotionCode at 64.
    const res = await request(buildBillingApp())
      .post('/billing/recommendation-event')
      .send({
        eventType: 'discount_impression',
        currentTier: 'starter',
        recommendedTier: 'pro',
        couponId: 'x'.repeat(300),
        promotionCode: 'y'.repeat(100),
      });

    expect(res.status).toBe(400);
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
      if (/generate_series/i.test(s)) {
        return {
          rows: [
            {
              week_start: '2026-04-20',
              recommended_tier: 'starter',
              completed_switches: '5',
              monthly_savings_cents: '180000',
            },
            {
              week_start: '2026-04-20',
              recommended_tier: 'pro',
              completed_switches: '1',
              monthly_savings_cents: '25000',
            },
            {
              week_start: '2026-04-20',
              recommended_tier: 'enterprise',
              completed_switches: '0',
              monthly_savings_cents: '0',
            },
            {
              week_start: '2026-04-27',
              recommended_tier: 'starter',
              completed_switches: '7',
              monthly_savings_cents: '240000',
            },
            {
              week_start: '2026-04-27',
              recommended_tier: 'pro',
              completed_switches: '1',
              monthly_savings_cents: '25000',
            },
            {
              week_start: '2026-04-27',
              recommended_tier: 'enterprise',
              completed_switches: '0',
              monthly_savings_cents: '0',
            },
          ],
        };
      }
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
      if (/GROUP BY direction\b/i.test(s)) {
        return {
          rows: [
            {
              direction: 'upgrade',
              impressions: '40',
              clicks: '6',
              completed_switches: '2',
              monthly_savings_cents: '50000',
            },
            {
              direction: 'downgrade',
              impressions: '70',
              clicks: '12',
              completed_switches: '11',
              monthly_savings_cents: '380000',
            },
            {
              direction: 'lateral',
              impressions: '10',
              clicks: '0',
              completed_switches: '1',
              monthly_savings_cents: '40000',
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
      byPitch: [
        {
          pitch: 'tier-switch',
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
        {
          pitch: 'annual-only',
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
      ],
      byDirection: [
        {
          direction: 'upgrade',
          impressions: 40,
          clicks: 6,
          completedSwitches: 2,
          monthlySavingsCents: 50000,
        },
        {
          direction: 'downgrade',
          impressions: 70,
          clicks: 12,
          completedSwitches: 11,
          monthlySavingsCents: 380000,
        },
        {
          direction: 'lateral',
          impressions: 10,
          clicks: 0,
          completedSwitches: 1,
          monthlySavingsCents: 40000,
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
      weeklyTrend: {
        windowWeeks: 12,
        weeks: ['2026-04-20', '2026-04-27'],
        byRecommendedTier: [
          {
            recommendedTier: 'starter',
            completedSwitches: [5, 7],
            monthlySavingsCents: [180000, 240000],
          },
          {
            recommendedTier: 'pro',
            completedSwitches: [1, 1],
            monthlySavingsCents: [25000, 25000],
          },
          {
            recommendedTier: 'enterprise',
            completedSwitches: [0, 0],
            monthlySavingsCents: [0, 0],
          },
        ],
      },
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
      byPitch: [
        {
          pitch: 'tier-switch',
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
        {
          pitch: 'annual-only',
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
      ],
      byDirection: [
        {
          direction: 'upgrade',
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
        {
          direction: 'downgrade',
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
        {
          direction: 'lateral',
          impressions: 0,
          clicks: 0,
          completedSwitches: 0,
          monthlySavingsCents: 0,
        },
      ],
      switchPairs: [],
      weeklyTrend: {
        windowWeeks: 12,
        weeks: [],
        byRecommendedTier: [
          {
            recommendedTier: 'starter',
            completedSwitches: [],
            monthlySavingsCents: [],
          },
          {
            recommendedTier: 'pro',
            completedSwitches: [],
            monthlySavingsCents: [],
          },
          {
            recommendedTier: 'enterprise',
            completedSwitches: [],
            monthlySavingsCents: [],
          },
        ],
      },
    });
  });

  it('splits the funnel by pitch (tier-switch vs annual-only) in the dashboard payload', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/GROUP BY pitch\b/i.test(s)) {
        return {
          rows: [
            {
              pitch: 'tier-switch',
              impressions: '80',
              clicks: '12',
              completed_switches: '5',
              monthly_savings_cents: '300000',
            },
            {
              pitch: 'annual-only',
              impressions: '40',
              clicks: '6',
              completed_switches: '3',
              monthly_savings_cents: '13200',
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
    expect(res.body.byPitch).toEqual([
      {
        pitch: 'tier-switch',
        impressions: 80,
        clicks: 12,
        completedSwitches: 5,
        monthlySavingsCents: 300000,
      },
      {
        pitch: 'annual-only',
        impressions: 40,
        clicks: 6,
        completedSwitches: 3,
        monthlySavingsCents: 13200,
      },
    ]);
  });

  it('drops rows with an unknown pitch from the per-pitch breakdown rather than mis-bucketing them', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/GROUP BY pitch\b/i.test(s)) {
        return {
          rows: [
            {
              pitch: 'tier-switch',
              impressions: '7',
              clicks: '3',
              completed_switches: '1',
              monthly_savings_cents: '500',
            },
            {
              pitch: 'mystery-pitch',
              impressions: '99',
              clicks: '99',
              completed_switches: '99',
              monthly_savings_cents: '999999',
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
    expect(res.body.byPitch).toEqual([
      {
        pitch: 'tier-switch',
        impressions: 7,
        clicks: 3,
        completedSwitches: 1,
        monthlySavingsCents: 500,
      },
      {
        pitch: 'annual-only',
        impressions: 0,
        clicks: 0,
        completedSwitches: 0,
        monthlySavingsCents: 0,
      },
    ]);
  });

  it('splits the funnel by direction (upgrade / downgrade / lateral) and surfaces savings for both arms', async () => {
    // Downgrade conversions are written from `schedule_downgrade`
    // (planChange.ts), upgrade conversions from the Stripe webhook —
    // both arms feed the same table and the dashboard must surface
    // each direction's realised savings independently so Sales /
    // Finance can see the downgrade arm's contribution to the
    // banner's "monthly savings unlocked" total.
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/GROUP BY direction\b/i.test(s)) {
        return {
          rows: [
            {
              direction: 'upgrade',
              impressions: '20',
              clicks: '4',
              completed_switches: '2',
              monthly_savings_cents: '50000',
            },
            {
              direction: 'downgrade',
              impressions: '50',
              clicks: '10',
              completed_switches: '8',
              monthly_savings_cents: '420000',
            },
            {
              direction: 'lateral',
              impressions: '30',
              clicks: '3',
              completed_switches: '1',
              monthly_savings_cents: '4400',
            },
            {
              // Defensive: a row that doesn't map to a known
              // direction (e.g. legacy / stale tier name) must not
              // pollute the breakdown.
              direction: 'unknown',
              impressions: '99',
              clicks: '99',
              completed_switches: '99',
              monthly_savings_cents: '999999',
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
    expect(res.body.byDirection).toEqual([
      {
        direction: 'upgrade',
        impressions: 20,
        clicks: 4,
        completedSwitches: 2,
        monthlySavingsCents: 50000,
      },
      {
        direction: 'downgrade',
        impressions: 50,
        clicks: 10,
        completedSwitches: 8,
        monthlySavingsCents: 420000,
      },
      {
        direction: 'lateral',
        impressions: 30,
        clicks: 3,
        completedSwitches: 1,
        monthlySavingsCents: 4400,
      },
    ]);
  });

  it('SQL groups by a derived direction column anchored on tier rank, scoped to recommendation event types only', async () => {
    // The downgrade arm is identified in writers by metadata.source,
    // but the dashboard must derive direction from tier rank so
    // pre-source rows still bucket correctly. Discount-flavored event
    // types must be excluded so the discount funnel stays separate.
    await request(buildPlatformAdminApp()).get('/platform/billing-recommendations');
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    const directionSqls = sqls.filter(
      (s) => /billing_recommendation_events/i.test(s) && /GROUP BY direction\b/i.test(s),
    );
    expect(directionSqls.length).toBe(1);
    const sql = directionSqls[0]!;
    expect(sql).toMatch(/CASE/);
    expect(sql).toMatch(/'upgrade'/);
    expect(sql).toMatch(/'downgrade'/);
    expect(sql).toMatch(/'lateral'/);
    // Recommendation arm only — the discount funnel rolls up separately
    // and would double-count if it leaked in here.
    expect(sql).toMatch(/event_type IN\s*\(\s*'impression',\s*'click',\s*'switch_completed'\s*\)/);
    expect(sql).toMatch(/NOW\(\)\s*-\s*INTERVAL\s*'30 days'/i);
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
    // Accept either the 30d aggregate window or the per-tier weekly trend
    // window — both anchor on NOW() so the test needs no fixture timestamps.
    for (const sql of recSqls) {
      const usesThirtyDayWindow =
        /NOW\(\)\s*-\s*INTERVAL\s*'30 days'/i.test(sql);
      const usesWeeklyTrendWindow =
        /date_trunc\(\s*'week'\s*,\s*NOW\(\)\s*\)/i.test(sql);
      expect(usesThirtyDayWindow || usesWeeklyTrendWindow).toBe(true);
    }
  });

  it('rolls the per-tier weekly trend into a dense weeks axis with parallel completed/savings series', async () => {
    // Sparse matrix with mixed week_start types and out-of-order rows
    // exercises the normalisation + zero-padding path.
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/generate_series/i.test(s)) {
        return {
          rows: [
            {
              week_start: new Date('2026-04-27T00:00:00Z'),
              recommended_tier: 'pro',
              completed_switches: 2,
              monthly_savings_cents: 50000,
            },
            {
              week_start: '2026-04-20',
              recommended_tier: 'starter',
              completed_switches: '4',
              monthly_savings_cents: '120000',
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
    expect(res.body.weeklyTrend).toEqual({
      windowWeeks: 12,
      weeks: ['2026-04-20', '2026-04-27'],
      byRecommendedTier: [
        {
          recommendedTier: 'starter',
          completedSwitches: [4, 0],
          monthlySavingsCents: [120000, 0],
        },
        {
          recommendedTier: 'pro',
          completedSwitches: [0, 2],
          monthlySavingsCents: [0, 50000],
        },
        {
          recommendedTier: 'enterprise',
          completedSwitches: [0, 0],
          monthlySavingsCents: [0, 0],
        },
      ],
    });
  });
});

describe('GET /platform/billing-recommendations/annual-only-tenants', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  function mockTenantRows(rows: Array<Record<string, unknown>>): void {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (
        /FROM billing_recommendation_events e/i.test(s) &&
        /pitch = 'annual-only'/i.test(s)
      ) {
        return { rows };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it('returns the per-tenant annual-only breakdown with normalised numbers and ISO timestamps', async () => {
    const lastImpression = new Date('2026-04-29T18:00:00Z');
    const lastClick = new Date('2026-04-30T12:00:00Z');
    const lastSwitch = new Date('2026-04-30T13:00:00Z');
    mockTenantRows([
      {
        tenant_id: 'tenant-stalled',
        tenant_name: 'Acme',
        tenant_slug: 'acme',
        tenant_plan: 'pro',
        impressions: '5',
        clicks: '2',
        last_impression_at: lastImpression,
        last_click_at: lastClick,
        completed_switch: false,
        last_switch_at: null,
        monthly_savings_cents: '0',
      },
      {
        tenant_id: 'tenant-converted',
        tenant_name: 'Globex',
        tenant_slug: 'globex',
        tenant_plan: 'pro',
        impressions: '3',
        clicks: '1',
        last_impression_at: lastImpression,
        last_click_at: lastClick,
        completed_switch: true,
        last_switch_at: lastSwitch,
        monthly_savings_cents: '4400',
      },
    ]);

    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      windowDays: 30,
      pitch: 'annual-only',
      limit: 200,
      converted: 'all',
      total: 2,
      tenants: [
        {
          tenantId: 'tenant-stalled',
          tenantName: 'Acme',
          tenantSlug: 'acme',
          tenantPlan: 'pro',
          impressions: 5,
          clicks: 2,
          lastImpressionAt: lastImpression.toISOString(),
          lastClickAt: lastClick.toISOString(),
          completedSwitch: false,
          lastSwitchAt: null,
          monthlySavingsCents: 0,
        },
        {
          tenantId: 'tenant-converted',
          tenantName: 'Globex',
          tenantSlug: 'globex',
          tenantPlan: 'pro',
          impressions: 3,
          clicks: 1,
          lastImpressionAt: lastImpression.toISOString(),
          lastClickAt: lastClick.toISOString(),
          completedSwitch: true,
          lastSwitchAt: lastSwitch.toISOString(),
          monthlySavingsCents: 4400,
        },
      ],
    });
  });

  it('SQL is scoped to pitch=annual-only, the trailing 30-day window, and the recommendation event types only', async () => {
    // The discount funnel uses different event_type values and
    // pitch=NULL, so the per-tenant follow-up list must not pick up
    // discount rows. Likewise switch_completed needs to participate
    // so we can distinguish converted vs stalled tenants.
    await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants',
    );
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    const tenantSqls = sqls.filter(
      (s) =>
        /FROM billing_recommendation_events e/i.test(s) &&
        /pitch = 'annual-only'/i.test(s),
    );
    expect(tenantSqls.length).toBe(1);
    const sql = tenantSqls[0]!;
    expect(sql).toMatch(/NOW\(\)\s*-\s*INTERVAL\s*'30 days'/i);
    expect(sql).toMatch(
      /event_type IN\s*\(\s*'impression',\s*'click',\s*'switch_completed'\s*\)/,
    );
    // Stalled-but-clicked tenants must surface first so Sales hits
    // the highest-intent follow-ups at the top of the list.
    expect(sql).toMatch(
      /BOOL_OR\(e\.event_type = 'switch_completed'\)\s*ASC/i,
    );
    expect(sql).toMatch(/LIMIT \$1/);
  });

  it('applies the converted=false filter via HAVING so the DB does the work', async () => {
    await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants?converted=false',
    );
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    const tenantSql = sqls.find(
      (s) =>
        /FROM billing_recommendation_events e/i.test(s) &&
        /pitch = 'annual-only'/i.test(s),
    );
    expect(tenantSql).toBeDefined();
    expect(tenantSql!).toMatch(
      /HAVING BOOL_OR\(e\.event_type = 'switch_completed'\) = FALSE/i,
    );
  });

  it('applies the converted=true filter via HAVING', async () => {
    await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants?converted=true',
    );
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    const tenantSql = sqls.find(
      (s) =>
        /FROM billing_recommendation_events e/i.test(s) &&
        /pitch = 'annual-only'/i.test(s),
    );
    expect(tenantSql!).toMatch(
      /HAVING BOOL_OR\(e\.event_type = 'switch_completed'\) = TRUE/i,
    );
  });

  it('rejects an invalid converted value with 400', async () => {
    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants?converted=maybe',
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric / non-positive limit with 400', async () => {
    const r1 = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants?limit=abc',
    );
    expect(r1.status).toBe(400);
    const r2 = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants?limit=0',
    );
    expect(r2.status).toBe(400);
  });

  it('caps an over-large limit at the configured maximum (1000) instead of 400ing', async () => {
    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants?limit=99999',
    );
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1000);
    const tenantCall = queryMock.mock.calls.find(([sql]) =>
      /FROM billing_recommendation_events e/i.test(String(sql)) &&
      /pitch = 'annual-only'/i.test(String(sql)),
    );
    expect(tenantCall).toBeDefined();
    expect((tenantCall as [string, unknown[]])[1][0]).toBe(1000);
  });

  it('defaults CSV exports to the max limit so Sales gets the full dataset (the table copy promises "see the rest")', async () => {
    // The UI's truncation hint says "filter or export CSV to see the
    // rest" — that promise only holds if CSV bypasses the smaller
    // table-paging default and pulls up to the configured cap.
    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants?format=csv',
    );
    expect(res.status).toBe(200);
    const tenantCall = queryMock.mock.calls.find(([sql]) =>
      /FROM billing_recommendation_events e/i.test(String(sql)) &&
      /pitch = 'annual-only'/i.test(String(sql)),
    );
    expect(tenantCall).toBeDefined();
    expect((tenantCall as [string, unknown[]])[1][0]).toBe(1000);
  });

  it('exports CSV with attachment headers and a sanitised row per tenant', async () => {
    const lastClick = new Date('2026-04-30T12:00:00Z');
    mockTenantRows([
      {
        tenant_id: 'tenant-csv',
        // Leading '=' would be interpreted as a formula by Excel —
        // the csvField sanitiser must prefix it with a single quote.
        tenant_name: '=cmd|evil',
        tenant_slug: 'csv-co',
        tenant_plan: 'pro',
        impressions: '4',
        clicks: '2',
        last_impression_at: lastClick,
        last_click_at: lastClick,
        completed_switch: false,
        last_switch_at: null,
        monthly_savings_cents: '0',
      },
    ]);

    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants?format=csv',
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="annual-only-tenants-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    const body = res.text;
    const [header, ...lines] = body.trim().split(/\r\n/);
    expect(header).toBe(
      'tenant_id,tenant_name,tenant_slug,tenant_plan,impressions,clicks,last_impression_at,last_click_at,completed_switch,last_switch_at,monthly_savings_cents',
    );
    expect(lines).toHaveLength(1);
    // Formula-injection prefix on the malicious tenant_name cell.
    expect(lines[0]).toMatch(/"'=cmd\|evil"|'=cmd\|evil/);
    // Trailing columns: impressions, clicks, ISO timestamp twice,
    // false (no conversion), empty last_switch_at, 0 savings.
    expect(lines[0]).toMatch(/,4,2,/);
    expect(lines[0]).toMatch(/,false,,0$/);
  });

  it('rejects an unknown format value with 400', async () => {
    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-recommendations/annual-only-tenants?format=xml',
    );
    expect(res.status).toBe(400);
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
          pitch: 'tier-switch',
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
      pitch: 'tier-switch',
    });
  });

  it('forwards pitch=annual-only on the optimal-branch annual upgrade so the webhook can attribute the conversion', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/checkout')
      .send({
        plan: 'pro',
        interval: 'annual',
        recommendation: {
          currentTier: 'pro',
          recommendedTier: 'pro',
          monthlySavingsCents: 4400,
          trailingWindowMonths: 3,
          pitch: 'annual-only',
        },
      });

    expect(res.status).toBe(200);
    const args = createCheckoutSessionMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.recommendation).toEqual({
      currentTier: 'pro',
      recommendedTier: 'pro',
      monthlySavingsCents: 4400,
      trailingWindowMonths: 3,
      pitch: 'annual-only',
    });
  });

  it('coerces an unknown pitch to tier-switch rather than dropping the recommendation snapshot entirely', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/checkout')
      .send({
        plan: 'pro',
        interval: 'monthly',
        recommendation: {
          currentTier: 'enterprise',
          recommendedTier: 'pro',
          monthlySavingsCents: 25000,
          pitch: 'something-novel',
        },
      });

    expect(res.status).toBe(200);
    const args = createCheckoutSessionMock.mock.calls[0]![0] as Record<string, unknown>;
    expect((args.recommendation as { pitch: string }).pitch).toBe('tier-switch');
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

  it('forwards a sanitised discount snapshot when at least one identity field is present', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/checkout')
      .send({
        plan: 'pro',
        interval: 'monthly',
        discount: {
          couponId: '  cou_promo20  ',
          promotionCode: 'PROMO20',
        },
      });

    expect(res.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
    const args = createCheckoutSessionMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.discount).toEqual({
      couponId: 'cou_promo20',
      promotionCode: 'PROMO20',
    });
  });

  it('forwards a discount payload with promotionCode only (couponId nulled)', async () => {
    const res = await request(buildBillingApp())
      .post('/billing/checkout')
      .send({
        plan: 'pro',
        interval: 'monthly',
        discount: {
          promotionCode: 'BLACKFRIDAY',
        },
      });

    expect(res.status).toBe(200);
    const args = createCheckoutSessionMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.discount).toEqual({
      couponId: null,
      promotionCode: 'BLACKFRIDAY',
    });
  });

  it('drops the discount payload entirely when neither field sanitises to a non-empty string', async () => {
    // No metadata stamping when both sides sanitise to null.
    const res = await request(buildBillingApp())
      .post('/billing/checkout')
      .send({
        plan: 'pro',
        interval: 'monthly',
        discount: {
          couponId: '   ',
          promotionCode: '',
        },
      });

    expect(res.status).toBe(200);
    const args = createCheckoutSessionMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.discount).toBeUndefined();
  });
});

describe('GET /platform/billing-discount-events', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('rolls up trailing-30-day funnel by (couponId, promotionCode)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/GROUP BY coupon_id, promotion_code/i.test(String(sql))) {
        return {
          rows: [
            {
              coupon_id: 'cou_promo20',
              promotion_code: 'PROMO20',
              impressions: '40',
              clicks: '10',
              completed_switches: '4',
              tenants_clicked: '7',
              tenants_switched: '3',
              last_seen_at: new Date('2026-04-29T12:00:00Z'),
            },
            {
              coupon_id: null,
              promotion_code: 'BLACKFRIDAY',
              impressions: '20',
              clicks: '5',
              completed_switches: '1',
              tenants_clicked: '4',
              tenants_switched: '1',
              last_seen_at: '2026-04-28T09:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-discount-events',
    );

    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
    expect(res.body.impressions).toBe(60);
    expect(res.body.clicks).toBe(15);
    expect(res.body.completedSwitches).toBe(5);
    // CTR = 15 / 60 = 0.25; completion = 5 / 15 ≈ 0.333
    expect(res.body.clickThroughRate).toBeCloseTo(0.25, 5);
    expect(res.body.completionRate).toBeCloseTo(5 / 15, 5);
    expect(res.body.byDiscount).toEqual([
      {
        couponId: 'cou_promo20',
        promotionCode: 'PROMO20',
        impressions: 40,
        clicks: 10,
        completedSwitches: 4,
        tenantsClicked: 7,
        tenantsSwitched: 3,
        clickThroughRate: 10 / 40,
        completionRate: 4 / 10,
        lastSeenAt: '2026-04-29T12:00:00.000Z',
      },
      {
        couponId: null,
        promotionCode: 'BLACKFRIDAY',
        impressions: 20,
        clicks: 5,
        completedSwitches: 1,
        tenantsClicked: 4,
        tenantsSwitched: 1,
        clickThroughRate: 5 / 20,
        completionRate: 1 / 5,
        lastSeenAt: '2026-04-28T09:00:00.000Z',
      },
    ]);
  });

  it('returns zeros and an empty breakdown when no discount events have been recorded', async () => {
    const res = await request(buildPlatformAdminApp()).get(
      '/platform/billing-discount-events',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      windowDays: 30,
      impressions: 0,
      clicks: 0,
      completedSwitches: 0,
      clickThroughRate: 0,
      completionRate: 0,
      byDiscount: [],
    });
  });

  it('queries only the trailing-30-day window and only the three discount event types', async () => {
    await request(buildPlatformAdminApp()).get(
      '/platform/billing-discount-events',
    );
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    const discountSqls = sqls.filter(
      (s) =>
        /billing_recommendation_events/i.test(s)
        && /GROUP BY coupon_id, promotion_code/i.test(s),
    );
    expect(discountSqls.length).toBe(1);
    const sql = discountSqls[0]!;
    expect(sql).toMatch(/NOW\(\)\s*-\s*INTERVAL\s*'30 days'/i);
    expect(sql).toMatch(/discount_impression/);
    expect(sql).toMatch(/discount_click/);
    expect(sql).toMatch(/discount_switch_completed/);
  });
});
