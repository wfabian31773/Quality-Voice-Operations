/**
 * Tests for `GET /platform/plan-recommendation-emails` — the Platform
 * Admin "Plan Emails" tab. Verifies the endpoint scopes to
 * `billing.plan_recommendation_email_sent` audit rows, defaults to the
 * start of the current calendar month, surfaces structured fields out
 * of the audit `changes` payload, and resolves plan tier identifiers
 * to display names via the shared catalog.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
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
    async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) =>
      fn(),
  ),
  withPrivilegedClient: vi.fn(
    async (fn: (c: { query: typeof queryMock }) => Promise<unknown>) => {
      return fn({ query: queryMock });
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
      tenantId: 'tenant-platform',
      userId: 'user-admin',
      role: 'platform_admin',
      isPlatformAdmin: true,
      email: 'admin@acme.test',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole:
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
  requireMiniSystemWrite: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

import platformAdminRoutes from '../../server/admin-api/routes/platformAdmin';
import { PLAN_RECOMMENDATION_AUDIT_ACTION } from '../../platform/billing/PlanRecommendationDigestScheduler';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(platformAdminRoutes);
  return app;
}

const SAMPLE_AUDIT_ROW = {
  audit_log_id: 'audit-1',
  tenant_id: 'tenant-acme',
  occurred_at: new Date('2026-05-12T15:30:00Z'),
  changes: {
    ownerEmail: 'owner@acme.test',
    ownerUserId: 'user-owner',
    tenantName: 'Acme Co',
    messageId: 'msg-1',
    sentBy: 'PlanRecommendationDigestScheduler',
    source: 'scheduled',
    cooldownDays: 28,
    lookbackMonths: 3,
    periodStart: '2026-05-01T00:00:00.000Z',
    currentPlan: 'pro',
    recommendedPlan: 'starter',
    averageMinutes: 220,
    monthlySavings: 300,
    annualSavings: 3600,
    previousEmailedAt: null,
  },
  tenant_name: 'Acme Co',
  tenant_slug: 'acme',
  tenant_plan: 'pro',
  tenant_status: 'active',
};

describe('GET /platform/plan-recommendation-emails', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
  });

  it('returns one row per audit entry with denormalized plan names and savings', async () => {
    const capturedSelectParams: unknown[] = [];

    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (/FROM audit_logs a\s+LEFT JOIN tenants t/i.test(s)) {
        capturedSelectParams.push(...(params ?? []));
        return { rows: [SAMPLE_AUDIT_ROW] };
      }
      if (/SELECT COUNT\(\*\)::int AS total FROM audit_logs/i.test(s)) {
        return { rows: [{ total: 1 }] };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get(
      '/platform/plan-recommendation-emails',
    );

    expect(res.status).toBe(200);
    // Audit-action filter must use the constant exported by the
    // scheduler so a rename in one place can't silently empty the
    // table.
    expect(capturedSelectParams[0]).toBe(PLAN_RECOMMENDATION_AUDIT_ACTION);
    expect(res.body.action).toBe(PLAN_RECOMMENDATION_AUDIT_ACTION);
    expect(res.body.total).toBe(1);
    expect(res.body.events).toHaveLength(1);

    const event = res.body.events[0];
    expect(event.auditLogId).toBe('audit-1');
    expect(event.tenantId).toBe('tenant-acme');
    expect(event.tenantName).toBe('Acme Co');
    expect(event.tenantSlug).toBe('acme');
    expect(event.currentPlan).toBe('pro');
    expect(event.currentPlanName).toBe('Pro');
    expect(event.recommendedPlan).toBe('starter');
    expect(event.recommendedPlanName).toBe('Starter');
    expect(event.monthlySavings).toBe(300);
    expect(event.annualSavings).toBe(3600);
    expect(event.averageMinutes).toBe(220);
    expect(event.ownerEmail).toBe('owner@acme.test');
    expect(event.periodStart).toBe('2026-05-01T00:00:00.000Z');
    expect(event.occurredAt).toBe('2026-05-12T15:30:00.000Z');
  });

  it('defaults the time window to the start of the current UTC month when no `since` is supplied', async () => {
    let captured: unknown[] = [];
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (/FROM audit_logs a\s+LEFT JOIN tenants t/i.test(s)) {
        captured = [...(params ?? [])];
        return { rows: [] };
      }
      if (/SELECT COUNT\(\*\)::int AS total FROM audit_logs/i.test(s)) {
        return { rows: [{ total: 0 }] };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get(
      '/platform/plan-recommendation-emails',
    );

    expect(res.status).toBe(200);
    const sinceParam = captured[1];
    expect(typeof sinceParam).toBe('string');
    const sinceDate = new Date(sinceParam as string);
    const now = new Date();
    expect(sinceDate.getUTCFullYear()).toBe(now.getUTCFullYear());
    expect(sinceDate.getUTCMonth()).toBe(now.getUTCMonth());
    expect(sinceDate.getUTCDate()).toBe(1);
    expect(sinceDate.getUTCHours()).toBe(0);
    expect(sinceDate.getUTCMinutes()).toBe(0);
    // When no `until` is supplied the endpoint omits it entirely so
    // recently-sent emails stay visible.
    expect(res.body.until).toBeNull();
  });

  it('honors `since`/`until` and rejects malformed timestamps', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/FROM audit_logs a\s+LEFT JOIN tenants t/i.test(s)) {
        return { rows: [] };
      }
      if (/SELECT COUNT\(\*\)::int AS total FROM audit_logs/i.test(s)) {
        return { rows: [{ total: 0 }] };
      }
      return { rows: [], rowCount: 0 };
    });

    const ok = await request(buildApp())
      .get('/platform/plan-recommendation-emails')
      .query({ since: '2026-04-01', until: '2026-04-30T23:59:59Z' });

    expect(ok.status).toBe(200);
    expect(ok.body.since).toBe(new Date('2026-04-01').toISOString());
    expect(ok.body.until).toBe(new Date('2026-04-30T23:59:59Z').toISOString());

    const bad = await request(buildApp())
      .get('/platform/plan-recommendation-emails')
      .query({ since: 'not-a-date' });

    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/since/i);
  });

  it('rejects malformed `limit` with a 400 instead of crashing the SQL bind', async () => {
    queryMock.mockImplementation(async () => ({ rows: [] }));

    const nonNumeric = await request(buildApp())
      .get('/platform/plan-recommendation-emails')
      .query({ limit: 'abc' });
    expect(nonNumeric.status).toBe(400);
    expect(nonNumeric.body.error).toMatch(/limit/i);

    const negative = await request(buildApp())
      .get('/platform/plan-recommendation-emails')
      .query({ limit: '-5' });
    expect(negative.status).toBe(400);

    const fractional = await request(buildApp())
      .get('/platform/plan-recommendation-emails')
      .query({ limit: '1.5' });
    expect(fractional.status).toBe(400);
  });

  it('gracefully degrades when an audit row points at a deleted tenant or has malformed `changes`', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/FROM audit_logs a\s+LEFT JOIN tenants t/i.test(s)) {
        return {
          rows: [
            {
              audit_log_id: 'audit-2',
              tenant_id: 'tenant-gone',
              occurred_at: new Date('2026-05-10T08:00:00Z'),
              changes: {
                // Wrong types: the endpoint must coerce to null rather
                // than 500'ing the whole tab when a stale row predates
                // a schema change to the digest payload.
                recommendedPlan: 42,
                currentPlan: null,
                monthlySavings: 'lots',
                annualSavings: undefined,
              },
              tenant_name: null,
              tenant_slug: null,
              tenant_plan: null,
              tenant_status: null,
            },
          ],
        };
      }
      if (/SELECT COUNT\(\*\)::int AS total FROM audit_logs/i.test(s)) {
        return { rows: [{ total: 1 }] };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get(
      '/platform/plan-recommendation-emails',
    );

    expect(res.status).toBe(200);
    const event = res.body.events[0];
    expect(event.tenantName).toBeNull();
    expect(event.tenantSlug).toBeNull();
    expect(event.recommendedPlan).toBeNull();
    expect(event.currentPlan).toBeNull();
    expect(event.monthlySavings).toBeNull();
    expect(event.annualSavings).toBeNull();
    expect(event.recommendedPlanName).toBeNull();
    expect(event.currentPlanName).toBeNull();
  });
});
