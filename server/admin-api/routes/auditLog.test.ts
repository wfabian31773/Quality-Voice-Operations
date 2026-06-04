import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.queryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));

import auditLogRouter from './auditLog';

function app() {
  const app = express();
  app.use(express.json());
  app.use(auditLogRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
});

describe('GET /audit-log', () => {
  it('returns events with pagination metadata', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total: '42' }] };
      if (sql.includes('FROM audit_logs')) return { rows: [{ id: 'a1', action: 'login' }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/audit-log?limit=10&page=2');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 42, page: 2, limit: 10 });
    expect(res.body.events).toHaveLength(1);
  });

  it('applies action/user/date filters to the query', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('COUNT(*)') ? { rows: [{ total: '0' }] } : { rows: [] },
    );
    await request(app()).get('/audit-log?action=login&userId=u9&since=2026-01-01&until=2026-02-01');
    const dataCall = a.queryMock.mock.calls.find(([sql]) => String(sql).includes('FROM audit_logs') && !String(sql).includes('COUNT'));
    expect(dataCall).toBeTruthy();
    expect(String(dataCall![0])).toContain('a.action = $2');
    expect(dataCall![1]).toEqual(expect.arrayContaining(['login', 'u9', '2026-01-01', '2026-02-01']));
  });

  it('caps the limit at 100', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('COUNT(*)') ? { rows: [{ total: '0' }] } : { rows: [] },
    );
    const res = await request(app()).get('/audit-log?limit=9999');
    expect(res.body.limit).toBe(100);
  });

  it('rejects a viewer via the real rbac gate', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).get('/audit-log')).status).toBe(403);
  });

  it('returns 500 and rolls back on query failure', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    const res = await request(app()).get('/audit-log');
    expect(res.status).toBe(500);
    expect(a.queryMock.mock.calls.some(([sql]) => /ROLLBACK/i.test(String(sql)))).toBe(true);
  });
});
