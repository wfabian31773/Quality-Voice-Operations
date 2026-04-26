import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

interface CapturedRes {
  statusCode: number;
  body: Record<string, unknown> | null;
}

function makeRes(): { res: Response; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: null };
  const res = {
    status: (code: number) => {
      captured.statusCode = code;
      return {
        json: (body: Record<string, unknown>) => {
          captured.body = body;
        },
      };
    },
  } as unknown as Response;
  return { res, captured };
}

const ROLE_ROW = [{ role: 'tenant_owner' }];
const ADMIN_ROW = [{ is_platform_admin: false }];
const ACTIVE_TENANT = [{ status: 'active' }];
const PENDING_TENANT = [{ status: 'pending' }];

interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

interface DbBehavior {
  tenantStatusRows?: Array<Record<string, unknown>>;
  tenantStatusError?: Error;
  roleRows?: Array<Record<string, unknown>>;
  roleQueryError?: Error;
  adminRows?: Array<Record<string, unknown>>;
}

function buildPlatformDbMock(behavior: DbBehavior) {
  const poolQuery = vi.fn(async () => {
    if (behavior.tenantStatusError) throw behavior.tenantStatusError;
    return { rows: behavior.tenantStatusRows ?? ACTIVE_TENANT };
  });

  const connect = vi.fn(async (): Promise<MockClient> => {
    const client: MockClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
          return { rows: [] };
        }
        if (/FROM user_roles/i.test(sql)) {
          if (behavior.roleQueryError) throw behavior.roleQueryError;
          return { rows: behavior.roleRows ?? ROLE_ROW };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    return client;
  });

  return {
    poolQuery,
    connect,
    getPlatformPool: () => ({ connect, query: poolQuery }),
    withTenantContext: vi.fn(async () => {}),
    withPrivilegedClient: vi.fn(async (fn: (c: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const privClient = {
        query: vi.fn(async () => ({ rows: behavior.adminRows ?? ADMIN_ROW })),
      };
      return fn(privClient);
    }),
  };
}

async function loadAuthModule(behavior: DbBehavior) {
  const dbMock = buildPlatformDbMock(behavior);
  vi.resetModules();
  vi.doMock('../../platform/db', () => ({
    getPlatformPool: dbMock.getPlatformPool,
    withTenantContext: dbMock.withTenantContext,
    withPrivilegedClient: dbMock.withPrivilegedClient,
  }));
  vi.doMock('../../platform/core/logger', () => ({
    createLogger: () => ({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    }),
  }));
  vi.doMock('../../server/admin-api/middleware/tenantGuard', () => ({
    requireTenantContext: (_req: Request, _res: Response, next: NextFunction) => next(),
  }));
  const mod = await import('../../server/admin-api/middleware/auth');
  return { mod, dbMock };
}

function makeReqWithToken(secret: string, tenantId: string, userId: string): Request {
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ sub: userId, tenantId, email: 'u@test' }, secret, { expiresIn: '1h' });
  return {
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
    method: 'GET',
    path: '/something',
  } as unknown as Request;
}

beforeEach(() => {
  process.env.ADMIN_JWT_SECRET = 'test-secret-for-auth-middleware';
  vi.resetModules();
});

describe('resolveCurrentRole error handling', () => {
  it('returns 500 with correlationId when DB throws (not 403)', async () => {
    const { mod } = await loadAuthModule({
      roleQueryError: new Error('connection terminated unexpectedly'),
    });
    mod.clearTenantStatusCache();

    const req = makeReqWithToken(process.env.ADMIN_JWT_SECRET!, 't1', 'u1');
    const { res, captured } = makeRes();
    let nextCalled = false;
    mod.requireAuth(req, res, () => { nextCalled = true; });

    await new Promise((r) => setTimeout(r, 20));
    expect(captured.statusCode).toBe(500);
    expect(captured.body).toMatchObject({ error: 'Failed to verify authorization' });
    expect(captured.body?.correlationId).toEqual(expect.any(String));
    expect(nextCalled).toBe(false);
  });

  it('returns 403 when user has no role rows (not 500)', async () => {
    const { mod } = await loadAuthModule({ roleRows: [] });
    mod.clearTenantStatusCache();

    const req = makeReqWithToken(process.env.ADMIN_JWT_SECRET!, 't1', 'u1');
    const { res, captured } = makeRes();
    mod.requireAuth(req, res, () => {});

    await new Promise((r) => setTimeout(r, 20));
    expect(captured.statusCode).toBe(403);
    expect(captured.body).toMatchObject({ error: 'No active role in this tenant' });
  });
});

describe('tenant status pending-gate cache', () => {
  it('caches active tenant status and skips DB on second call', async () => {
    const { mod, dbMock } = await loadAuthModule({ tenantStatusRows: ACTIVE_TENANT });
    mod.clearTenantStatusCache();

    const req1 = makeReqWithToken(process.env.ADMIN_JWT_SECRET!, 't-cache', 'u1');
    const { res: res1 } = makeRes();
    mod.requireAuth(req1, res1, () => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(dbMock.poolQuery).toHaveBeenCalledTimes(1);

    const req2 = makeReqWithToken(process.env.ADMIN_JWT_SECRET!, 't-cache', 'u1');
    const { res: res2 } = makeRes();
    mod.requireAuth(req2, res2, () => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(dbMock.poolQuery).toHaveBeenCalledTimes(1);
  });

  it('returns 403 TENANT_NOT_PROVISIONED for pending tenants on gated paths', async () => {
    const { mod } = await loadAuthModule({ tenantStatusRows: PENDING_TENANT });
    mod.clearTenantStatusCache();

    const req = makeReqWithToken(process.env.ADMIN_JWT_SECRET!, 't-pending', 'u1');
    const { res, captured } = makeRes();
    mod.requireAuth(req, res, () => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(captured.statusCode).toBe(403);
    expect(captured.body).toMatchObject({ error: 'TENANT_NOT_PROVISIONED' });
  });

  it('returns 500 with correlationId when tenant-status query throws', async () => {
    const { mod } = await loadAuthModule({
      tenantStatusError: new Error('relation tenants does not exist'),
    });
    mod.clearTenantStatusCache();

    const req = makeReqWithToken(process.env.ADMIN_JWT_SECRET!, 't-err', 'u1');
    const { res, captured } = makeRes();
    mod.requireAuth(req, res, () => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(captured.statusCode).toBe(500);
    expect(captured.body).toMatchObject({ error: 'Unable to verify tenant status' });
    expect(captured.body?.correlationId).toEqual(expect.any(String));
  });

  it('invalidateTenantStatusCache forces a fresh DB read', async () => {
    const { mod, dbMock } = await loadAuthModule({ tenantStatusRows: ACTIVE_TENANT });
    mod.clearTenantStatusCache();

    const req1 = makeReqWithToken(process.env.ADMIN_JWT_SECRET!, 't-inv', 'u1');
    const { res: res1 } = makeRes();
    mod.requireAuth(req1, res1, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(dbMock.poolQuery).toHaveBeenCalledTimes(1);

    mod.invalidateTenantStatusCache('t-inv');

    const req2 = makeReqWithToken(process.env.ADMIN_JWT_SECRET!, 't-inv', 'u1');
    const { res: res2 } = makeRes();
    mod.requireAuth(req2, res2, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(dbMock.poolQuery).toHaveBeenCalledTimes(2);
  });

  it('skips tenant status check on allow-listed pending paths', async () => {
    const { mod, dbMock } = await loadAuthModule({});
    mod.clearTenantStatusCache();

    const req = makeReqWithToken(process.env.ADMIN_JWT_SECRET!, 't-allow', 'u1');
    (req as { path: string }).path = '/tenants/me/verify-checkout';
    const { res } = makeRes();
    mod.requireAuth(req, res, () => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(dbMock.poolQuery).not.toHaveBeenCalled();
  });
});

describe('platform/db is statically imported (no per-request dynamic import)', () => {
  it('source contains static import and no `await import("../../../platform/db")`', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'server/admin-api/middleware/auth.ts'),
      'utf-8',
    );
    expect(src).toMatch(/^import .* from ['"]\.\.\/\.\.\/\.\.\/platform\/db['"]/m);
    expect(src).not.toMatch(/await\s+import\(\s*['"]\.\.\/\.\.\/\.\.\/platform\/db['"]\s*\)/);
  });
});
