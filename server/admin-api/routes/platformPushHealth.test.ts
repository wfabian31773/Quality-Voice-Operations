import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  withPrivilegedClientMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({ withPrivilegedClient: a.withPrivilegedClientMock }));

import router from './platformPushHealth';

function app() {
  const app = express();
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
  a.withPrivilegedClientMock.mockReset().mockImplementation(async (cb: (c: unknown) => Promise<unknown>) =>
    cb({ query: a.queryMock }),
  );
});

describe('GET /platform/push-health', () => {
  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/push-health')).status).toBe(403);
  });

  it('aggregates totals, per-tenant rows and recent failures', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('affected_tenants')) {
        return { rows: [{ attempts: 10, attempted: 9, accepted: 8, retired: 1, dropped: 1, failure_count: 2, affected_tenants: 1 }] };
      }
      if (sql.includes('GROUP BY p.tenant_id')) {
        return { rows: [{ tenant_id: 't1', tenant_name: 'Acme', tenant_slug: 'acme', attempts: 5, attempted: 5, accepted: 4, retired: 1, dropped: 0, failure_count: 1, last_attempt_at: '2026-05-01T00:00:00Z' }] };
      }
      if (sql.includes('failure_reason IS NOT NULL OR p.dropped > 0')) {
        return { rows: [{ id: 'a1', tenant_id: 't1', event: 'push', attempted: 1, accepted: 0, retired: 0, dropped: 1, failure_reason: 'expo_error', created_at: '2026-05-01T00:00:00Z', tenant_name: 'Acme', tenant_slug: 'acme' }] };
      }
      return { rows: [] };
    });
    const res = await request(app()).get('/platform/push-health?windowDays=14&recentLimit=10');
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(14);
    expect(res.body.totals).toMatchObject({ attempts: 10, accepted: 8, affectedTenants: 1 });
    expect(res.body.perTenant[0]).toMatchObject({ tenantId: 't1', tenantName: 'Acme' });
    expect(res.body.recentFailures[0]).toMatchObject({ id: 'a1', failureReason: 'expo_error' });
  });

  it('clamps an out-of-range window to the max', async () => {
    const res = await request(app()).get('/platform/push-health?windowDays=9999');
    expect(res.body.windowDays).toBe(30);
  });

  it('returns 500 when the query layer throws', async () => {
    a.withPrivilegedClientMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/platform/push-health')).status).toBe(500);
  });
});
