/**
 * Coverage for the per-tenant `tenants.timezone` column plumbing
 * (task #1000).
 *
 * Migration 097 added a `timezone` column to the tenants table; the
 * scheduling code (`getTenantTimezone` in
 * `server/admin-api/routes/scheduling.ts`) reads it as the source of
 * truth for recurring-series expansion and override conflict checks.
 * This test mounts the real `/tenants/me` router with a mocked pool
 * and asserts that:
 *
 *   - GET /tenants/me echoes the column value on the tenant blob.
 *   - PATCH /tenants/me with a valid IANA `timezone` writes the
 *     column (the UPDATE statement names `timezone = $N`) and the
 *     RETURNING projection surfaces the updated value.
 *   - PATCH /tenants/me with a junk `timezone` rejects with 400 and
 *     does NOT issue any UPDATE — guarding the scheduler from a
 *     value `Intl.supportedValuesOf` would not accept.
 *   - PATCH /tenants/me without a `timezone` field leaves the column
 *     out of the UPDATE entirely (preserving the existing value).
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

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-a',
      userId: 'user-1',
      email: 'owner@acme.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    };
    next();
  },
  invalidateTenantStatusCache: vi.fn(),
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// `routes/tenants.ts` pulls in a fairly heavy graph of platform helpers at
// import time. The test only exercises the `/tenants/me` GET + PATCH
// handlers, so we stub the rest with no-ops.
vi.mock('../../platform/tenant/provisioning/TenantProvisioningService', () => ({
  getProvisioningStatus: vi.fn(),
  provisionTenant: vi.fn(),
}));
vi.mock('../../platform/agent-templates/registry', () => ({
  getRegisteredTemplates: vi.fn(() => []),
}));
vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: vi.fn(),
}));
vi.mock('../../platform/billing/stripe/plans', () => ({
  PLAN_LIMITS: { starter: {} },
}));
vi.mock('../../platform/activation/ActivationService', () => ({
  getActivationMilestones: vi.fn(),
  dismissTooltip: vi.fn(),
  getDismissedTooltips: vi.fn(),
}));

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

async function buildApp(): Promise<express.Express> {
  const router = (await import('../../server/admin-api/routes/tenants')).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('tenants.timezone column surfaces in /tenants/me', () => {
  it('GET /tenants/me echoes the stored timezone on the tenant blob', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(s)) return { rows: [], rowCount: 0 };
      if (/set_config/i.test(s)) return { rows: [], rowCount: 0 };
      if (/FROM tenants\s+WHERE id = \$1/i.test(s)) {
        return {
          rows: [{
            id: 'tenant-a',
            name: 'Acme',
            slug: 'acme',
            domain: null,
            status: 'active',
            plan: 'pro',
            settings: {},
            feature_flags: {},
            sms_alerts_disabled: false,
            billing_currency: 'usd',
            timezone: 'Europe/London',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = await buildApp();
    const res = await request(app).get('/tenants/me');

    expect(res.status).toBe(200);
    expect(res.body.tenant?.timezone).toBe('Europe/London');

    // The SELECT must keep the COALESCE that defaults legacy rows to
    // 'America/New_York' so a tenant without an explicit timezone never
    // surfaces NULL — that would break the scheduler's wall-clock math.
    const tenantSelect = queryMock.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        /FROM tenants\s+WHERE id = \$1/i.test(c[0] as string),
    );
    expect(tenantSelect, 'expected the tenant detail SELECT to fire').toBeTruthy();
    expect(String(tenantSelect![0])).toMatch(
      /COALESCE\(\s*timezone\s*,\s*'America\/New_York'\s*\)/i,
    );
  });

  it('PATCH /tenants/me with a valid timezone updates the column', async () => {
    queryMock.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
      const s = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(s)) return { rows: [], rowCount: 0 };
      if (/set_config/i.test(s)) return { rows: [], rowCount: 0 };
      if (/^\s*UPDATE tenants/i.test(s)) {
        // Echo the value the handler bound for `timezone = $N` so the test
        // can assert the round-trip without re-deriving the position.
        const tzIndexMatch = s.match(/timezone\s*=\s*\$(\d+)/i);
        const tz =
          tzIndexMatch
            ? params[Number(tzIndexMatch[1]) - 1] as string | undefined
            : undefined;
        return {
          rows: [{
            id: 'tenant-a',
            name: 'Acme',
            slug: 'acme',
            domain: null,
            status: 'active',
            plan: 'pro',
            settings: {},
            sms_alerts_disabled: false,
            timezone: tz ?? 'America/New_York',
            updated_at: new Date().toISOString(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = await buildApp();
    const res = await request(app)
      .patch('/tenants/me')
      .send({ timezone: 'America/Los_Angeles' });

    expect(res.status).toBe(200);
    expect(res.body.tenant?.timezone).toBe('America/Los_Angeles');

    const updateCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && /^\s*UPDATE tenants/i.test(c[0] as string),
    );
    expect(updateCall, 'expected an UPDATE tenants statement').toBeTruthy();
    expect(String(updateCall![0])).toMatch(/timezone\s*=\s*\$\d+/i);
    // The bound value list must contain the new IANA zone so the scheduler
    // sees the change on the next read of `tenants.timezone`.
    expect(updateCall![1] as unknown[]).toContain('America/Los_Angeles');
  });

  it('PATCH /tenants/me rejects an invalid timezone with 400 and skips the UPDATE', async () => {
    queryMock.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    const app = await buildApp();
    const res = await request(app)
      .patch('/tenants/me')
      .send({ timezone: 'Not/A_Real_Zone' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid timezone/i);

    const updateCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && /^\s*UPDATE tenants/i.test(c[0] as string),
    );
    expect(updateCall, 'invalid timezone must short-circuit before UPDATE').toBeFalsy();
  });

  it('PATCH /tenants/me without a timezone field leaves the column untouched', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(s)) return { rows: [], rowCount: 0 };
      if (/set_config/i.test(s)) return { rows: [], rowCount: 0 };
      if (/^\s*UPDATE tenants/i.test(s)) {
        return {
          rows: [{
            id: 'tenant-a',
            name: 'Renamed',
            slug: 'acme',
            domain: null,
            status: 'active',
            plan: 'pro',
            settings: {},
            sms_alerts_disabled: false,
            timezone: 'America/New_York',
            updated_at: new Date().toISOString(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = await buildApp();
    const res = await request(app)
      .patch('/tenants/me')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    const updateCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && /^\s*UPDATE tenants/i.test(c[0] as string),
    );
    expect(updateCall, 'expected an UPDATE tenants statement').toBeTruthy();
    // `timezone = $N` must NOT appear in the SET list when the body omits
    // the field — otherwise an unrelated PATCH would clobber the column.
    expect(String(updateCall![0])).not.toMatch(/timezone\s*=\s*\$\d+/i);
  });
});
