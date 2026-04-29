/**
 * Tests for the Platform Admin "push delivery health" endpoint
 * (`GET /platform/push-health`). Asserts the route runs the expected
 * aggregation queries against the new push_delivery_attempts table,
 * shapes the response correctly, requires platform admin, and clamps
 * the windowDays / recentLimit query params.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const withPrivilegedClientMock = vi.fn<(fn: (client: unknown) => Promise<unknown>) => Promise<unknown>>();

vi.mock('../../platform/db', () => ({
  withPrivilegedClient: (fn: (client: unknown) => Promise<unknown>) =>
    withPrivilegedClientMock(fn),
  getPlatformPool: () => ({ query: vi.fn() }),
}));

let isPlatformAdmin = true;

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: Record<string, unknown> }).user = {
      userId: 'admin-user-1',
      tenantId: 'platform-tenant',
      email: 'admin@example.com',
      role: isPlatformAdmin ? 'tenant_owner' : 'tenant_member',
      isPlatformAdmin,
    };
    next();
  },
}));

async function buildApp() {
  const routerModule = await import('../../server/admin-api/routes/platformPushHealth');
  const app = express();
  app.use(express.json());
  app.use('/api', routerModule.default);
  return app;
}

beforeEach(() => {
  withPrivilegedClientMock.mockReset();
  isPlatformAdmin = true;
});

describe('GET /platform/push-health', () => {
  it('aggregates totals, per-tenant breakdown, and recent failures from push_delivery_attempts', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    withPrivilegedClientMock.mockImplementation(async (fn) =>
      fn({
        query: async (sql: string, params: unknown[]) => {
          queries.push({ sql, params });
          if (/COUNT\(\*\)::bigint AS attempts/.test(sql) && !/GROUP BY/.test(sql)) {
            return {
              rows: [
                {
                  attempts: '12',
                  attempted: '40',
                  accepted: '30',
                  retired: '4',
                  dropped: '6',
                  failure_count: '3',
                  affected_tenants: '2',
                },
              ],
            };
          }
          if (/GROUP BY/.test(sql)) {
            return {
              rows: [
                {
                  tenant_id: 'tenant-A',
                  tenant_name: 'Acme Plumbing',
                  tenant_slug: 'acme',
                  attempts: '7',
                  attempted: '25',
                  accepted: '20',
                  retired: '3',
                  dropped: '2',
                  failure_count: '2',
                  last_attempt_at: new Date('2026-04-28T12:00:00Z'),
                },
                {
                  tenant_id: 'tenant-B',
                  tenant_name: null,
                  tenant_slug: null,
                  attempts: '5',
                  attempted: '15',
                  accepted: '10',
                  retired: '1',
                  dropped: '4',
                  failure_count: '1',
                  last_attempt_at: new Date('2026-04-27T10:00:00Z'),
                },
              ],
            };
          }
          // Recent failures query
          return {
            rows: [
              {
                id: '1001',
                tenant_id: 'tenant-A',
                tenant_name: 'Acme Plumbing',
                tenant_slug: 'acme',
                event: 'job_assigned',
                attempted: 3,
                accepted: 1,
                retired: 0,
                dropped: 2,
                failure_reason: 'http_status_429',
                created_at: new Date('2026-04-28T11:55:00Z'),
              },
            ],
          };
        },
      }),
    );

    const app = await buildApp();
    const res = await request(app).get('/api/platform/push-health');

    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(7);
    expect(res.body.totals).toEqual({
      attempts: 12,
      attempted: 40,
      accepted: 30,
      retired: 4,
      dropped: 6,
      failureCount: 3,
      affectedTenants: 2,
    });
    expect(res.body.perTenant).toHaveLength(2);
    expect(res.body.perTenant[0]).toMatchObject({
      tenantId: 'tenant-A',
      tenantName: 'Acme Plumbing',
      tenantSlug: 'acme',
      attempts: 7,
      attempted: 25,
      accepted: 20,
      retired: 3,
      dropped: 2,
      failureCount: 2,
    });
    expect(res.body.perTenant[0].lastAttemptAt).toBe('2026-04-28T12:00:00.000Z');
    expect(res.body.perTenant[1]).toMatchObject({
      tenantId: 'tenant-B',
      tenantName: null,
      tenantSlug: null,
    });

    expect(res.body.recentFailures).toHaveLength(1);
    expect(res.body.recentFailures[0]).toMatchObject({
      tenantId: 'tenant-A',
      event: 'job_assigned',
      failureReason: 'http_status_429',
      attempted: 3,
      accepted: 1,
      dropped: 2,
    });
    expect(res.body.recentFailures[0].occurredAt).toBe('2026-04-28T11:55:00.000Z');

    // Sanity: all three queries hit push_delivery_attempts.
    expect(queries).toHaveLength(3);
    for (const q of queries) {
      expect(q.sql).toMatch(/push_delivery_attempts/);
    }
  });

  it('clamps windowDays to [1,30] and recentLimit to [1,200]', async () => {
    const seenParams: unknown[][] = [];
    withPrivilegedClientMock.mockImplementation(async (fn) =>
      fn({
        query: async (_sql: string, params: unknown[]) => {
          seenParams.push(params);
          return { rows: [] };
        },
      }),
    );

    const app = await buildApp();
    // windowDays=999 → 30, recentLimit=9999 → 200
    await request(app).get('/api/platform/push-health?windowDays=999&recentLimit=9999');

    // Each query has [windowDays, ...] (or just [windowDays] for totals)
    expect(seenParams[0]).toEqual([30]);
    // perTenant: [windowDays, perTenantLimit]
    expect(seenParams[1][0]).toBe(30);
    // recentFailures: [windowDays, recentLimit]
    expect(seenParams[2]).toEqual([30, 200]);
  });

  it('returns sane defaults when there are no attempts in the window', async () => {
    withPrivilegedClientMock.mockImplementation(async (fn) =>
      fn({
        query: async (sql: string) => {
          if (!/GROUP BY/.test(sql) && /COUNT\(\*\)/.test(sql)) {
            return {
              rows: [
                {
                  attempts: '0',
                  attempted: '0',
                  accepted: '0',
                  retired: '0',
                  dropped: '0',
                  failure_count: '0',
                  affected_tenants: '0',
                },
              ],
            };
          }
          return { rows: [] };
        },
      }),
    );

    const app = await buildApp();
    const res = await request(app).get('/api/platform/push-health');
    expect(res.status).toBe(200);
    expect(res.body.totals.attempts).toBe(0);
    expect(res.body.perTenant).toEqual([]);
    expect(res.body.recentFailures).toEqual([]);
  });

  it('rejects callers that are not platform admins', async () => {
    isPlatformAdmin = false;
    const app = await buildApp();
    const res = await request(app).get('/api/platform/push-health');
    expect(res.status).toBe(403);
    expect(withPrivilegedClientMock).not.toHaveBeenCalled();
  });
});
