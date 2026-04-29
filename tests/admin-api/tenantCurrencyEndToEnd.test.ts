/**
 * End-to-end coverage for the per-tenant `billing_currency` plumbing
 * documented in task #634.
 *
 * The backend stores currency as a lowercase 3-letter code on
 * `tenants.billing_currency` (defaulting to `usd`). Cost-screen
 * endpoints surface that code so the React layer can format dollar
 * amounts in the tenant's preferred currency.
 *
 * These tests mount the real routers with a mocked platform pool that
 * always returns `billing_currency = 'eur'` for the active tenant, and
 * assert that:
 *
 *   - GET /tenants/me echoes the lowercased code on the tenant blob
 *   - GET /analytics/costs adds `currency: 'eur'` to the response
 *   - GET /analytics/revenue adds `currency: 'eur'` to the response
 *   - GET /calls/:id adds `currency: 'eur'` alongside the cost breakdown
 *   - `normalizeCurrencyCode` lowercases mixed-case input and falls
 *     back to `usd` when the value is missing or malformed
 *
 * The currency cache inside `tenantCurrency.ts` is invalidated between
 * cases so each request hits the mocked SELECT.
 */
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
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/core/phi/redact', () => ({
  redactPHI: (v: string) => v,
}));

vi.mock('../../platform/billing/cost', () => ({
  getConversationCost: vi.fn(async () => ({
    callSessionId: 'call-1',
    sttCostCents: 5,
    llmCostCents: 10,
    ttsCostCents: 3,
    infraCostCents: 1,
    totalCostCents: 19,
    modelTier: 'standard',
    modelUsed: 'gpt-4o-mini',
    inputTokens: 100,
    outputTokens: 50,
    cacheHits: 0,
    createdAt: new Date().toISOString(),
  })),
  getCostOptimizationAnalytics: vi.fn(async () => ({
    totalConversations: 12,
    totalCostCents: 4321,
    avgCostPerConversationCents: 360,
    savingsBreakdown: {
      cacheSavingsCents: 0,
      routingSavingsCents: 0,
      compressionSavingsCents: 0,
      totalSavingsCents: 100,
    },
  })),
  getConversationCosts: vi.fn(async () => ({ costs: [], total: 0 })),
  getCostBudgetSettings: vi.fn(async () => null),
  upsertCostBudgetSettings: vi.fn(async () => ({})),
  getCacheStats: vi.fn(async () => ({})),
  getRoutingDistribution: vi.fn(async () => ([])),
}));

vi.mock('../../platform/analytics/CallViewSubscriberNotifier', () => ({
  notifySubscriberChanges: vi.fn(async () => undefined),
  diffSubscribers: vi.fn(() => ({ added: [], removed: [] })),
}));

vi.mock('../../platform/analytics', () => ({
  getCallAnalytics: vi.fn(),
  getCampaignAnalytics: vi.fn(),
  getAgentAnalytics: vi.fn(),
  getCostAnalytics: vi.fn(async () => ({
    totalCallCostCents: 1234,
    avgCostPerCallCents: 42,
    dailyBreakdown: [],
  })),
  getRevenueAttribution: vi.fn(async () => ({
    totalRevenueCents: 50_000,
    bookedCalls: 17,
    conversionRate: 0.21,
  })),
  getSentimentTrends: vi.fn(),
  getAgentSentiments: vi.fn(),
  getTopicDistribution: vi.fn(),
  getTopicTrends: vi.fn(),
  getConversionFunnel: vi.fn(),
  getConversionTrends: vi.fn(),
  getQualityAnalytics: vi.fn(),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-eur',
      userId: 'user-1',
      email: 'eu@acme.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    };
    next();
  },
}));

const SAMPLE_CALL_ROW = {
  id: 'call-1',
  tenant_id: 'tenant-eur',
  agent_id: 'agent-1',
  caller_number: '+15551112222',
  called_number: '+15553334444',
  direction: 'inbound',
  lifecycle_state: 'CALL_COMPLETED',
  start_time: new Date().toISOString(),
  end_time: new Date().toISOString(),
  duration_seconds: 60,
  total_cost_cents: 19,
  environment: 'development',
  created_at: new Date().toISOString(),
  language: 'en',
  agent_name: 'Reception',
};

beforeEach(async () => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();

  // The currency lookup memoizes per-tenant for 60s. Drop it so each
  // test exercises the full SELECT path against the mocked pool.
  const mod = await import('../../platform/billing/tenantCurrency');
  mod.invalidateTenantCurrencyCache();

  queryMock.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [], rowCount: 0 };
    if (/SET LOCAL/i.test(s)) return { rows: [], rowCount: 0 };
    if (/set_config/i.test(s)) return { rows: [], rowCount: 0 };

    // /tenants/me detail: return a tenant whose billing_currency = 'eur'
    if (/FROM tenants\s+WHERE id = \$1/i.test(s)) {
      return {
        rows: [
          {
            id: 'tenant-eur',
            name: 'Acme EU',
            slug: 'acme-eu',
            domain: 'acme.eu',
            status: 'active',
            plan: 'pro',
            settings: {},
            feature_flags: {},
            sms_alerts_disabled: false,
            billing_currency: 'eur',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        rowCount: 1,
      };
    }

    // /calls/:id detail
    if (/FROM call_sessions cs/i.test(s) && /cs\.id = \$1/.test(s)) {
      return { rows: [SAMPLE_CALL_ROW], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  });
});

async function buildApp(routerPath: string): Promise<express.Express> {
  const router = (await import(routerPath)).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('tenant billing_currency surfaces in cost screens', () => {
  it('GET /tenants/me echoes the stored lowercase currency code', async () => {
    const app = await buildApp('../../server/admin-api/routes/tenants');
    const res = await request(app).get('/tenants/me');

    expect(res.status).toBe(200);
    expect(res.body.tenant).toBeTruthy();
    expect(res.body.tenant.billing_currency).toBe('eur');

    // The SELECT must keep the COALESCE that defaults legacy rows to USD,
    // otherwise tenants without an explicit override would surface NULL
    // and break the React currency hook downstream.
    const tenantSelect = queryMock.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        /FROM tenants\s+WHERE id = \$1/i.test(c[0] as string),
    );
    expect(tenantSelect, 'expected the tenant detail SELECT to fire').toBeTruthy();
    expect(String(tenantSelect![0])).toMatch(/COALESCE\(\s*billing_currency\s*,\s*'usd'\s*\)/i);
  });

  it('GET /analytics/costs adds the tenant currency to the payload', async () => {
    const app = await buildApp('../../server/admin-api/routes/analytics');
    const res = await request(app).get('/analytics/costs?range=30d');

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('eur');
    // Sanity: the spread payload from getCostAnalytics is preserved.
    expect(res.body.totalCallCostCents).toBe(1234);
  });

  it('GET /analytics/revenue adds the tenant currency to the payload', async () => {
    const app = await buildApp('../../server/admin-api/routes/analytics');
    const res = await request(app).get('/analytics/revenue?range=30d');

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('eur');
    expect(res.body.totalRevenueCents).toBe(50_000);
  });

  it('GET /cost-optimization/analytics adds the tenant currency to the payload', async () => {
    const app = await buildApp('../../server/admin-api/routes/costOptimization');
    const res = await request(app).get('/cost-optimization/analytics?range=30d');

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('eur');
    expect(res.body.totalCostCents).toBe(4321);
  });

  it('GET /calls/:id includes the tenant currency alongside the cost breakdown', async () => {
    const app = await buildApp('../../server/admin-api/routes/calls');
    const res = await request(app).get('/calls/call-1');

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('eur');
    expect(res.body.call?.id).toBe('call-1');
    expect(res.body.costBreakdown?.totalCostCents).toBe(19);
  });
});

describe('normalizeCurrencyCode', () => {
  it('lowercases a mixed-case 3-letter code', async () => {
    const { normalizeCurrencyCode } = await import('../../platform/billing/tenantCurrency');
    expect(normalizeCurrencyCode('EUR')).toBe('eur');
    expect(normalizeCurrencyCode('  Gbp  ')).toBe('gbp');
  });

  it('falls back to usd for null/empty/malformed input', async () => {
    const { normalizeCurrencyCode } = await import('../../platform/billing/tenantCurrency');
    expect(normalizeCurrencyCode(null)).toBe('usd');
    expect(normalizeCurrencyCode(undefined)).toBe('usd');
    expect(normalizeCurrencyCode('')).toBe('usd');
    expect(normalizeCurrencyCode('eu')).toBe('usd');
    expect(normalizeCurrencyCode('euros')).toBe('usd');
  });
});
