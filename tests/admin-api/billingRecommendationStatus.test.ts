/**
 * Coverage for `GET /billing/recommendation-status` (Task #1242):
 *
 *   GET /billing/recommendation-status
 *
 * Powers the "Next recommendation review: <date>" status line on the
 * in-app /billing recommendation card. Tests focus on the two
 * properties the UI relies on: (1) the route always returns 200 with a
 * structured `{ status }` payload — even for tenants with no
 * subscription / no usage / no owner — and (2) it delegates to
 * `getTenantRecommendationDigestStatus` with the *authenticated*
 * tenant id (never a query param), so a manager can't poke at another
 * tenant's digest schedule.
 *
 * Mocking strategy mirrors `billingTrailingUsage.test.ts`: stub the
 * route's collaborators rather than the platform DB, since the helper
 * itself is exercised end-to-end in
 * `tests/billing/planRecommendationDigestScheduler.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const getTenantRecommendationDigestStatusMock = vi.fn();

vi.mock('../../platform/billing/PlanRecommendationDigestScheduler', () => ({
  getTenantRecommendationDigestStatus: (...args: unknown[]) =>
    getTenantRecommendationDigestStatusMock(...args),
  // Other named exports are referenced indirectly by the scheduler module
  // but never invoked from the route, so a no-op stub is enough.
  PLAN_RECOMMENDATION_AUDIT_ACTION: 'billing.plan_recommendation_email_sent',
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: vi.fn(), connect: vi.fn() }),
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
}));

vi.mock('../../platform/billing/budget/checkBudget', () => ({
  checkBudget: vi.fn(),
}));

const currentUser = {
  tenantId: 'tenant-rec-status',
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

beforeEach(() => {
  getTenantRecommendationDigestStatusMock.mockReset();
});

describe('GET /billing/recommendation-status', () => {
  it("returns the helper's snapshot verbatim under a top-level `status` key", async () => {
    const snapshot = {
      reason: 'scheduled' as const,
      lastEmailedAt: '2026-04-02T00:00:00.000Z',
      nextScheduledAt: '2026-04-30T00:00:00.000Z',
      cooldownDays: 28,
      lookbackMonths: 3,
      ownerOptedIn: true,
    };
    getTenantRecommendationDigestStatusMock.mockResolvedValueOnce(snapshot);

    const res = await request(buildApp()).get('/billing/recommendation-status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: snapshot });
  });

  it('passes the authenticated tenant id to the helper (not a query/path param)', async () => {
    getTenantRecommendationDigestStatusMock.mockResolvedValueOnce({
      reason: 'no_active_subscription',
      lastEmailedAt: null,
      nextScheduledAt: null,
      cooldownDays: 28,
      lookbackMonths: 3,
      ownerOptedIn: true,
    });

    await request(buildApp())
      // Try to spoof a different tenant via the query string — the
      // route should ignore it and use req.user.tenantId instead.
      .get('/billing/recommendation-status?tenantId=tenant-other');

    expect(getTenantRecommendationDigestStatusMock).toHaveBeenCalledWith(
      'tenant-rec-status',
    );
  });

  it('still returns 200 with a placeholder payload when the tenant has no subscription', async () => {
    getTenantRecommendationDigestStatusMock.mockResolvedValueOnce({
      reason: 'no_active_subscription',
      lastEmailedAt: null,
      nextScheduledAt: null,
      cooldownDays: 28,
      lookbackMonths: 3,
      ownerOptedIn: true,
    });

    const res = await request(buildApp()).get('/billing/recommendation-status');

    expect(res.status).toBe(200);
    expect(res.body.status.reason).toBe('no_active_subscription');
    expect(res.body.status.nextScheduledAt).toBeNull();
  });

  it('returns 500 with a structured error body when the helper throws', async () => {
    getTenantRecommendationDigestStatusMock.mockRejectedValueOnce(
      new Error('database is down'),
    );

    const res = await request(buildApp()).get('/billing/recommendation-status');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load recommendation status' });
  });
});
