import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  clientQueryMock: vi.fn(),
  poolQueryMock: vi.fn(),
  privQueryMock: vi.fn(),
  releaseMock: vi.fn(),
}));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }), query: a.poolQueryMock }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
  withPrivilegedClient: async (cb: (c: unknown) => Promise<unknown>) => cb({ query: a.privQueryMock }),
}));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));
vi.mock('./security', () => ({ isProductionLike: () => false }));

import {
  requireAuth, issueToken, invalidateTenantStatusCache, clearTenantStatusCache, tenantStatusCacheSize,
} from './auth';

const SECRET = 'test-jwt-secret';

function app() {
  const app = express();
  app.use(express.json());
  // A route that is NOT in the pending-allow list (triggers the tenant-status gate).
  app.get('/dashboard', requireAuth, (req, res) => res.json({ ok: true, user: req.user }));
  // A route that IS allow-listed for pending tenants (skips the status query).
  app.get('/auth/me', requireAuth, (req, res) => res.json({ ok: true, user: req.user }));
  return app;
}

function token(overrides: Record<string, unknown> = {}) {
  return issueToken({ userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false, ...overrides } as never);
}

beforeAll(() => { process.env.ADMIN_JWT_SECRET = SECRET; });
afterAll(() => { delete process.env.ADMIN_JWT_SECRET; });

beforeEach(() => {
  clearTenantStatusCache();
  a.clientQueryMock.mockReset().mockImplementation(async (sql: string) =>
    sql.includes('FROM user_roles') ? { rows: [{ role: 'operations_manager' }] } : { rows: [] },
  );
  a.privQueryMock.mockReset().mockResolvedValue({ rows: [{ is_platform_admin: false }] });
  a.poolQueryMock.mockReset().mockImplementation(async (sql: string) =>
    sql.includes('FROM tenants') ? { rows: [{ status: 'active' }] } : { rows: [] },
  );
  a.releaseMock.mockReset();
});

describe('issueToken + requireAuth round trip', () => {
  it('401 when no token is present', async () => {
    expect((await request(app()).get('/auth/me')).status).toBe(401);
  });
  it('401 for an invalid token', async () => {
    expect((await request(app()).get('/auth/me').set('Authorization', 'Bearer not-a-jwt')).status).toBe(401);
  });
  it('authenticates a valid token on an allow-listed pending path', async () => {
    const res = await request(app()).get('/auth/me').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ userId: 'u1', tenantId: 't1', role: 'operations_manager' });
  });
  it('403 when the user has no active role in the tenant', async () => {
    a.clientQueryMock.mockImplementation(async () => ({ rows: [] }));
    const res = await request(app()).get('/auth/me').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(403);
  });
});

describe('tenant-status pending gate', () => {
  it('allows an active tenant on a gated path and caches the status', async () => {
    const res = await request(app()).get('/dashboard').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(tenantStatusCacheSize()).toBe(1);
  });
  it('blocks a pending tenant with TENANT_NOT_PROVISIONED', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM tenants') ? { rows: [{ status: 'pending' }] } : { rows: [] },
    );
    const res = await request(app()).get('/dashboard').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('TENANT_NOT_PROVISIONED');
  });
});

describe('tenant status cache helpers', () => {
  it('invalidate removes a cached entry; clear empties the cache', async () => {
    await request(app()).get('/dashboard').set('Authorization', `Bearer ${token()}`);
    expect(tenantStatusCacheSize()).toBe(1);
    invalidateTenantStatusCache('t1');
    expect(tenantStatusCacheSize()).toBe(0);

    await request(app()).get('/dashboard').set('Authorization', `Bearer ${token()}`);
    expect(tenantStatusCacheSize()).toBe(1);
    clearTenantStatusCache();
    expect(tenantStatusCacheSize()).toBe(0);
  });
});
