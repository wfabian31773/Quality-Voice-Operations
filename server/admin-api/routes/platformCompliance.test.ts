import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: true },
  queryMock: vi.fn(),
  runAllIsolationTestsMock: vi.fn(),
  getSchedulerStatusMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  withPrivilegedClient: async (cb: (c: unknown) => Promise<unknown>) => cb({ query: a.queryMock }),
}));
vi.mock('../../../platform/security/TenantIsolationService', () => ({ runAllIsolationTests: a.runAllIsolationTestsMock }));
vi.mock('../../../platform/security/EncryptionService', () => ({ getOrCreateTenantDEK: vi.fn() }));
vi.mock('../../../platform/security/TenantIsolationScheduler', () => ({ getTenantIsolationSchedulerStatus: a.getSchedulerStatusMock }));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/email/EmailService', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('../../../platform/email/templates', () => ({ encryptionInitializationReminderEmail: () => ({ subject: 's', html: 'h', text: 't' }) }));

import router from './platformCompliance';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.queryMock.mockReset().mockResolvedValue({ rows: [{}] });
  a.runAllIsolationTestsMock.mockReset().mockResolvedValue({ passed: 5, failed: 0, results: [] });
  a.getSchedulerStatusMock.mockReset().mockReturnValue({ running: true });
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
});

describe('platform-admin gate', () => {
  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/compliance/overview')).status).toBe(403);
  });
});

describe('GET read routes', () => {
  it('overview aggregates compliance stats', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants')) return { rows: [{ total_tenants: 3, active_tenants: 2, suspended_tenants: 1 }] };
      return { rows: [{}] };
    });
    const res = await request(app()).get('/platform/compliance/overview');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tenants');
    expect(res.body).toHaveProperty('encryption');
    expect(res.body).toHaveProperty('isolationTests');
  });
  it('overview 500 on query failure', async () => {
    a.queryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/platform/compliance/overview')).status).toBe(500);
  });
  it('audit-log list', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('COUNT(*)') ? { rows: [{ total: '0' }] } : { rows: [] },
    );
    expect((await request(app()).get('/platform/compliance/audit-log')).status).toBe(200);
  });
  it('encryption status', async () => {
    expect((await request(app()).get('/platform/compliance/encryption')).status).toBe(200);
  });
  it('deletion-requests', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/platform/compliance/deletion-requests')).status).toBe(200);
  });
  it('isolation-tests', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/platform/compliance/isolation-tests')).status).toBe(200);
  });
  it('platform-admins', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ id: 'u1', email: 'a@x.com' }] });
    expect((await request(app()).get('/platform/compliance/platform-admins')).status).toBe(200);
  });
  it('encrypted-fields', async () => {
    expect((await request(app()).get('/platform/compliance/encrypted-fields')).status).toBe(200);
  });
});

describe('POST /platform/compliance/isolation-tests/run', () => {
  it('runs the isolation suite', async () => {
    const res = await request(app()).post('/platform/compliance/isolation-tests/run').send({});
    expect(res.status).toBe(200);
    expect(a.runAllIsolationTestsMock).toHaveBeenCalled();
  });
});
