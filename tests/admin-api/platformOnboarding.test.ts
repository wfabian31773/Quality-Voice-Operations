/**
 * Coverage for the Platform Admin onboarding-visibility endpoints (Task #612 / #994):
 *
 *   GET /platform/tenants                   — list tenants with latest-owner onboarding badge
 *   GET /platform/tenants/:id/onboarding    — per-owner step + completed flag
 *   GET /platform/onboarding-funnel         — step 1 / 2 / 3 / completed funnel
 *
 * The endpoints all read `users.preferences.onboarding_step` +
 * `onboarding_completed` joined to `user_roles` filtered to `tenant_owner`.
 * These tests mock the platform pool / RBAC middleware and assert:
 *
 *   - The SQL filters scope to `tenant_owner` (not every seat) and to
 *     non-revoked role rows.
 *   - The SQL coerces the JSONB step into a clamped [1..3] integer and the
 *     completed flag into a boolean so the UI never has to deal with NaN.
 *   - The funnel parameterises `days` via `make_interval` (no string
 *     interpolation) and clamps a hostile `?days=99999` to 365.
 *   - 404 is returned when the requested tenant doesn't exist.
 *   - The list endpoint surfaces the most-recent owner's onboarding state
 *     via a LATERAL join so the All Tenants table can render a badge
 *     without admins expanding each row.
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
    async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  ),
  // Faithful enough re-implementation: open a "transaction", run the body
  // with our queryMock, commit / rollback on the way out. The route code
  // only cares that it gets a `client.query` it can call.
  withPrivilegedClient: vi.fn(async (fn: (c: { query: typeof queryMock }) => Promise<unknown>) => {
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
  }),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// The route file pulls in a few unrelated services at import time; stub
// them so we don't have to wire up email / Slack / etc.
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
      tenantId: 'tenant-admin',
      userId: 'admin-user',
      role: 'admin',
      isPlatformAdmin: true,
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireMiniSystemWrite: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import platformAdminRoutes from '../../server/admin-api/routes/platformAdmin';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', platformAdminRoutes);
  return app;
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
});

function captureSql(): string[] {
  return queryMock.mock.calls.map((c) => String(c[0]));
}

function captureParams(): unknown[][] {
  return queryMock.mock.calls.map((c) => (c[1] as unknown[]) ?? []);
}

describe('GET /platform/tenants (Task #994 — onboarding badge column)', () => {
  it('joins each tenant to its most-recent active owner via LATERAL', async () => {
    const tenantRows = [
      {
        id: 'tenant-a',
        name: 'Acme',
        slug: 'acme',
        status: 'active',
        plan: 'pro',
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-04-15T00:00:00Z',
        user_count: '3',
        total_calls: '120',
        last_call_at: '2026-04-20T00:00:00Z',
        calls_last_30d: '40',
        latest_owner_onboarding_step: 2,
        latest_owner_onboarding_completed: false,
      },
      {
        id: 'tenant-b',
        name: 'Stale',
        slug: 'stale',
        status: 'active',
        plan: 'starter',
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
        user_count: '1',
        total_calls: '0',
        last_call_at: null,
        calls_last_30d: '0',
        latest_owner_onboarding_step: null,
        latest_owner_onboarding_completed: null,
      },
    ];
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM tenants t/.test(sql) && /LATERAL/i.test(sql)) {
        return { rows: tenantRows };
      }
      return { rows: [] };
    });

    const res = await request(buildApp()).get('/platform/tenants');
    expect(res.status).toBe(200);
    expect(res.body.tenants).toEqual(tenantRows);

    const sql = captureSql().find((s) => /FROM tenants t/.test(s) && /LATERAL/i.test(s)) ?? '';
    // Latest owner is found via a LATERAL subquery scoped to non-revoked
    // tenant_owner rows so the list query stays a single round-trip.
    expect(sql).toMatch(/LEFT\s+JOIN\s+LATERAL/i);
    expect(sql).toMatch(/ur\.role\s*=\s*'tenant_owner'/);
    expect(sql).toMatch(/ur\.revoked_at\s+IS\s+NULL/);
    // Most-recently granted owner wins when a tenant has more than one.
    expect(sql).toMatch(/ORDER\s+BY\s+ur\.granted_at\s+DESC\s+NULLS\s+LAST/i);
    expect(sql).toMatch(/LIMIT\s+1/i);
    // The same defensive JSONB parsing as the per-tenant onboarding
    // endpoint so a corrupt legacy row can't 500 the entire list.
    expect(sql).toMatch(/GREATEST\(1,\s*LEAST\(3/);
    expect(sql).toMatch(/'\^\[0-9\]\+\$'/);
    expect(sql).toMatch(/LOWER\(u\.preferences->>'onboarding_completed'\)\s*=\s*'true'/);
    // The boolean comparison must be COALESCE'd to FALSE so an owner
    // whose preferences blob is missing the `onboarding_completed` key
    // still renders an in-progress badge instead of a NULL placeholder.
    expect(sql).toMatch(/COALESCE\(\s*\(LOWER\(u\.preferences->>'onboarding_completed'\)\s*=\s*'true'\),\s*FALSE\s*\)/);
    // Both onboarding columns must be exposed on the projection so the
    // client can render the badge.
    expect(sql).toMatch(/latest_owner_onboarding_step/);
    expect(sql).toMatch(/latest_owner_onboarding_completed/);
    // Task #1132 — the customer-picked IANA timezone (`tenants.timezone`,
    // written by General Settings) is surfaced on the list endpoint so
    // support / ops can answer "their schedule looks wrong" tickets
    // without dropping into psql.
    expect(sql).toMatch(/t\.timezone/);
  });

  it('returns step + completed=false for an owner whose preferences lack the completed key', async () => {
    // Mirrors what Postgres would project for an owner whose
    // `users.preferences` blob doesn't contain `onboarding_completed`
    // at all (a common state for accounts created before the wizard
    // was introduced or for owners who never advanced past step 1).
    // The COALESCE in the LATERAL projection guarantees `false` —
    // not `null` — so the badge renders as "Step 1/3" instead of an
    // em-dash placeholder.
    const tenantRows = [
      {
        id: 'tenant-c',
        name: 'New Signup',
        slug: 'new-signup',
        status: 'active',
        plan: 'starter',
        created_at: '2026-04-25T00:00:00Z',
        updated_at: '2026-04-25T00:00:00Z',
        user_count: '1',
        total_calls: '0',
        last_call_at: null,
        calls_last_30d: '0',
        latest_owner_onboarding_step: 1,
        latest_owner_onboarding_completed: false,
      },
    ];
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM tenants t/.test(sql) && /LATERAL/i.test(sql)) {
        return { rows: tenantRows };
      }
      return { rows: [] };
    });

    const res = await request(buildApp()).get('/platform/tenants');
    expect(res.status).toBe(200);
    expect(res.body.tenants[0].latest_owner_onboarding_step).toBe(1);
    expect(res.body.tenants[0].latest_owner_onboarding_completed).toBe(false);
  });
});

describe('GET /platform/tenants/:id (Task #1132 — timezone column)', () => {
  it('projects t.timezone so the detail panel can render the customer timezone', async () => {
    // The Platform Admin TenantDetailPanel reads `tenant.timezone` to
    // surface the customer-picked IANA value (NULL for legacy rows
    // pre-dating migration 097). Lock the SELECT shape here so a
    // future refactor can't quietly drop the column.
    const detailRow = {
      id: 'tenant-tz',
      name: 'Timezone Test',
      slug: 'timezone-test',
      status: 'active',
      plan: 'pro',
      timezone: 'America/Los_Angeles',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-15T00:00:00Z',
      user_count: '3',
      agent_count: '2',
      phone_number_count: '1',
      total_calls: '120',
      total_cost_cents: '4500',
      last_downgrade_at: null,
    };
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM tenants t\b/.test(sql) && /WHERE t\.id = \$1/.test(sql)) {
        return { rows: [detailRow] };
      }
      return { rows: [] };
    });

    const res = await request(buildApp()).get('/platform/tenants/tenant-tz');
    expect(res.status).toBe(200);
    expect(res.body.tenant).toEqual(detailRow);
    expect(res.body.tenant.timezone).toBe('America/Los_Angeles');

    const sql = captureSql().find((s) => /FROM tenants t\b/.test(s) && /WHERE t\.id = \$1/.test(s)) ?? '';
    expect(sql).toMatch(/t\.timezone/);
  });
});

describe('GET /platform/tenants/:id/onboarding', () => {
  it('returns 404 when the tenant does not exist', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM tenants/.test(sql)) return { rows: [] };
      return { rows: [] };
    });

    const res = await request(buildApp()).get('/platform/tenants/missing/onboarding');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Tenant not found' });
  });

  it('scopes to non-revoked tenant_owner rows and clamps step to [1..3]', async () => {
    const ownerRows = [
      {
        user_id: 'u-1',
        email: 'owner@example.com',
        first_name: 'Olivia',
        last_name: 'Owner',
        created_at: '2026-04-01T00:00:00Z',
        last_login_at: '2026-04-15T00:00:00Z',
        role_granted_at: '2026-04-01T00:05:00Z',
        onboarding_completed: false,
        onboarding_step: 2,
      },
    ];
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM tenants/.test(sql)) {
        return { rows: [{ id: 'tenant-x' }] };
      }
      if (/FROM user_roles ur/.test(sql)) {
        return { rows: ownerRows };
      }
      return { rows: [] };
    });

    const res = await request(buildApp()).get('/platform/tenants/tenant-x/onboarding');
    expect(res.status).toBe(200);
    expect(res.body.owners).toEqual(ownerRows);

    const sql = captureSql().find((s) => /FROM user_roles ur/.test(s)) ?? '';
    expect(sql).toMatch(/ur\.role\s*=\s*'tenant_owner'/);
    expect(sql).toMatch(/ur\.revoked_at\s+IS\s+NULL/);
    // Step clamped server-side so the UI never has to deal with NaN /
    // out-of-range values from a stale row.
    expect(sql).toMatch(/GREATEST\(1,\s*LEAST\(3/);
    // Defensive int cast — must regex-guard the JSONB value rather than
    // attempting a raw `::int` cast that would 500 on garbage like 'abc'.
    expect(sql).toMatch(/'\^\[0-9\]\+\$'/);
    // Completed flag whitelist: must compare to literal 'true' rather
    // than performing a `::boolean` cast that throws on 'maybe' / '{}'.
    expect(sql).toMatch(/LOWER\(u\.preferences->>'onboarding_completed'\)\s*=\s*'true'/);

    const params = captureParams().find((p) => p.includes('tenant-x'));
    expect(params).toContain('tenant-x');
  });

  it('does not 500 when the JSONB step is malformed (regex guard handles non-numeric)', async () => {
    // Simulate a Postgres response where the regex guard already kicked
    // in: even with a stored value like 'abc', the SELECT projects the
    // clamped default of 1 and the route succeeds. The point of this
    // case is that the SQL contract (regex-guarded CASE + whitelist
    // boolean compare) returns clean values instead of raising
    // `invalid input syntax for type integer/boolean`.
    const ownerRows = [
      {
        user_id: 'u-2',
        email: 'broken@example.com',
        first_name: null,
        last_name: null,
        created_at: '2026-04-01T00:00:00Z',
        last_login_at: null,
        role_granted_at: null,
        // What the SQL would project for `preferences = {"onboarding_step":"abc","onboarding_completed":"maybe"}`.
        onboarding_completed: false,
        onboarding_step: 1,
      },
    ];
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM tenants/.test(sql)) {
        return { rows: [{ id: 'tenant-y' }] };
      }
      if (/FROM user_roles ur/.test(sql)) {
        return { rows: ownerRows };
      }
      return { rows: [] };
    });

    const res = await request(buildApp()).get('/platform/tenants/tenant-y/onboarding');
    expect(res.status).toBe(200);
    expect(res.body.owners).toEqual(ownerRows);
  });
});

describe('GET /platform/onboarding-funnel', () => {
  it('aggregates owners by step bucket using parameterised days', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/WITH owners AS/.test(sql)) {
        return {
          rows: [
            { total: 10, completed: 4, step_1: 2, step_2: 3, step_3: 1 },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await request(buildApp())
      .get('/platform/onboarding-funnel?days=30');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      days: 30,
      funnel: { total: 10, completed: 4, step_1: 2, step_2: 3, step_3: 1 },
    });

    const sql = captureSql().find((s) => /WITH owners AS/.test(s)) ?? '';
    // Owners scoped to non-revoked tenant_owner seats only.
    expect(sql).toMatch(/ur\.role\s*=\s*'tenant_owner'/);
    expect(sql).toMatch(/ur\.revoked_at\s+IS\s+NULL/);
    // Window parameterised with make_interval so a malicious `days` value
    // can't escape the SQL string.
    expect(sql).toMatch(/make_interval\(days\s*=>\s*\$1::int\)/);
    // FILTER expressions break the funnel into discrete buckets.
    expect(sql).toMatch(/FILTER\s*\(WHERE\s+completed\)/i);
    expect(sql).toMatch(/FILTER\s*\(WHERE\s+NOT\s+completed\s+AND\s+step\s*=\s*1\)/i);
    expect(sql).toMatch(/FILTER\s*\(WHERE\s+NOT\s+completed\s+AND\s+step\s*=\s*2\)/i);
    expect(sql).toMatch(/FILTER\s*\(WHERE\s+NOT\s+completed\s+AND\s+step\s*=\s*3\)/i);
    // Defensive casts to keep a corrupt JSONB row from 500'ing the
    // funnel: regex-guarded int parse + literal 'true' comparison
    // instead of raw `::int` / `::boolean` casts.
    expect(sql).toMatch(/'\^\[0-9\]\+\$'/);
    expect(sql).toMatch(/LOWER\(u\.preferences->>'onboarding_completed'\)\s*=\s*'true'/);

    const params = captureParams().find((p) => p.includes(30));
    expect(params).toEqual([30]);
  });

  it('clamps absurd day windows to 365 and defaults missing/invalid values to 30', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/WITH owners AS/.test(sql)) {
        return { rows: [{ total: 0, completed: 0, step_1: 0, step_2: 0, step_3: 0 }] };
      }
      return { rows: [] };
    });

    const huge = await request(buildApp())
      .get('/platform/onboarding-funnel?days=99999');
    expect(huge.status).toBe(200);
    expect(huge.body.days).toBe(365);

    queryMock.mockClear();
    const def = await request(buildApp()).get('/platform/onboarding-funnel');
    expect(def.status).toBe(200);
    expect(def.body.days).toBe(30);
    const params = captureParams().find((p) => p.includes(30));
    expect(params).toEqual([30]);

    queryMock.mockClear();
    const bad = await request(buildApp())
      .get('/platform/onboarding-funnel?days=abc');
    expect(bad.status).toBe(200);
    expect(bad.body.days).toBe(30);
  });
});
