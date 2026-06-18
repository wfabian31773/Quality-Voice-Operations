import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'me@x.com', role: 'tenant_owner', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  getEncryptionStatusMock: vi.fn(),
  rotateTenantDEKMock: vi.fn(),
  getOrCreateTenantDEKMock: vi.fn(),
  runAllIsolationTestsMock: vi.fn(),
  exportUserDataMock: vi.fn(),
  eraseUserDataMock: vi.fn(),
  createGdprRequestMock: vi.fn(),
  completeGdprRequestMock: vi.fn(),
  listGdprRequestsMock: vi.fn(),
  listApiKeysMock: vi.fn(),
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
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/security/EncryptionService', () => ({
  getEncryptionStatus: a.getEncryptionStatusMock,
  rotateTenantDEK: a.rotateTenantDEKMock,
  getOrCreateTenantDEK: a.getOrCreateTenantDEKMock,
}));
vi.mock('../../../platform/security/TenantIsolationService', () => ({ runAllIsolationTests: a.runAllIsolationTestsMock }));
vi.mock('../../../platform/security/GdprService', () => ({
  exportUserData: a.exportUserDataMock,
  eraseUserData: a.eraseUserDataMock,
  createGdprRequest: a.createGdprRequestMock,
  completeGdprRequest: a.completeGdprRequestMock,
  listGdprRequests: a.listGdprRequestsMock,
}));
vi.mock('../../../platform/rbac/ApiKeyService', () => ({ listApiKeys: a.listApiKeysMock }));

import router from './compliance';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'tenant_owner';
  a.user.userId = 'u1';
  a.queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.releaseMock.mockReset();
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
  a.getEncryptionStatusMock.mockReset().mockResolvedValue({ encryptionEnabled: true, activeKeys: 1, lastKeyRotation: null });
  a.rotateTenantDEKMock.mockReset().mockResolvedValue({ keyId: 'k2' });
  a.getOrCreateTenantDEKMock.mockReset().mockResolvedValue({ keyId: 'k1' });
  a.runAllIsolationTestsMock.mockReset().mockResolvedValue({ failed: 0 });
  a.exportUserDataMock.mockReset().mockResolvedValue({ calls: [] });
  a.eraseUserDataMock.mockReset().mockResolvedValue({ erasedFields: ['email'] });
  a.createGdprRequestMock.mockReset().mockResolvedValue('req-1');
  a.completeGdprRequestMock.mockReset().mockResolvedValue(undefined);
  a.listGdprRequestsMock.mockReset().mockResolvedValue([]);
  a.listApiKeysMock.mockReset().mockResolvedValue([]);
});

describe('GET /compliance/audit-log/export', () => {
  it('exports CSV and writes an audit log', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM audit_logs a') ? { rows: [{ id: '1', action: 'login', resource_type: 'session', occurred_at: '2026-05-01T00:00:00Z' }] } : { rows: [] },
    );
    const res = await request(app()).get('/compliance/audit-log/export?action=login');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('login');
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'audit_log.exported' }));
  });
  it('rejects a viewer via rbac', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).get('/compliance/audit-log/export')).status).toBe(403);
  });
  it('500 + rollback on error', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/compliance/audit-log/export')).status).toBe(500);
  });
});

describe('encryption endpoints', () => {
  it('GET status', async () => {
    expect((await request(app()).get('/compliance/encryption-status')).body).toMatchObject({ encryptionEnabled: true });
  });
  it('initialize (owner) writes critical audit', async () => {
    const res = await request(app()).post('/compliance/encryption/initialize');
    expect(res.body).toEqual({ keyId: 'k1', status: 'initialized' });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'encryption.initialized' }));
  });
  it('initialize rejects a manager', async () => {
    a.user.role = 'operations_manager';
    expect((await request(app()).post('/compliance/encryption/initialize')).status).toBe(403);
  });
  it('rotate (owner)', async () => {
    expect((await request(app()).post('/compliance/encryption/rotate')).body).toEqual({ keyId: 'k2', status: 'rotated' });
  });
  it('rotate 500 on failure', async () => {
    a.rotateTenantDEKMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).post('/compliance/encryption/rotate')).status).toBe(500);
  });
});

describe('GET /compliance/tenant-isolation', () => {
  it('returns isolation test results', async () => {
    a.runAllIsolationTestsMock.mockResolvedValue({ failed: 0, passed: 5 });
    expect((await request(app()).get('/compliance/tenant-isolation')).body).toMatchObject({ failed: 0 });
  });
  it('500 on failure', async () => {
    a.runAllIsolationTestsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/compliance/tenant-isolation')).status).toBe(500);
  });
});

describe('roles', () => {
  it('lists roles', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM user_roles ur') ? { rows: [{ id: 'u2', email: 'a@x.com', role: 'agent_developer' }] } : { rows: [] },
    );
    expect((await request(app()).get('/compliance/roles')).body.roles).toHaveLength(1);
  });
  it('PATCH validates the role', async () => {
    expect((await request(app()).patch('/compliance/roles/u2').send({ role: 'god' })).status).toBe(400);
  });
  it('PATCH blocks changing your own role', async () => {
    expect((await request(app()).patch('/compliance/roles/u1').send({ role: 'operations_manager' })).status).toBe(400);
  });
  it('PATCH updates a role with audit', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT role FROM user_roles')) return { rows: [{ role: 'support_reviewer' }] };
      if (sql.includes('UPDATE user_roles SET')) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });
    const res = await request(app()).patch('/compliance/roles/u2').send({ role: 'operations_manager' });
    expect(res.body).toEqual({ updated: true, role: 'operations_manager' });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.role_changed' }));
  });
  it('PATCH 404 when user not in tenant', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE user_roles SET') ? { rows: [], rowCount: 0 } : { rows: [] },
    );
    expect((await request(app()).patch('/compliance/roles/ghost').send({ role: 'agent_developer' })).status).toBe(404);
  });
  it('DELETE blocks removing your own role', async () => {
    expect((await request(app()).delete('/compliance/roles/u1')).status).toBe(400);
  });
  it('DELETE removes a role', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('DELETE FROM user_roles') ? { rows: [], rowCount: 1 } : { rows: [{ role: 'agent_developer' }] },
    );
    expect((await request(app()).delete('/compliance/roles/u2')).body).toEqual({ removed: true });
  });
  it('DELETE 404 when missing', async () => {
    a.queryMock.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    expect((await request(app()).delete('/compliance/roles/ghost')).status).toBe(404);
  });
});

describe('GET /compliance/soc2-checklist', () => {
  it('assembles the checklist from encryption/keys/counts/isolation', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM audit_logs')) return { rows: [{ cnt: '5' }] };
      if (sql.includes('FROM user_roles')) return { rows: [{ cnt: '3' }] };
      return { rows: [] };
    });
    a.listApiKeysMock.mockResolvedValue([{ id: 'k1' }]);
    const res = await request(app()).get('/compliance/soc2-checklist');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.checklist)).toBe(true);
    expect(res.body.checklist.find((c: { id: string }) => c.id === 'encryption_at_rest').status).toBe('implemented');
  });
  it('500 when encryption status fetch fails', async () => {
    a.getEncryptionStatusMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/compliance/soc2-checklist')).status).toBe(500);
  });
});

describe('GDPR endpoints', () => {
  it('export requires email', async () => {
    expect((await request(app()).post('/compliance/gdpr/export').send({})).status).toBe(400);
  });
  it('export runs the data export + audit', async () => {
    a.exportUserDataMock.mockResolvedValue({ calls: [1] });
    const res = await request(app()).post('/compliance/gdpr/export').send({ email: 'sub@x.com' });
    expect(res.body).toMatchObject({ requestId: 'req-1' });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'gdpr.data_exported' }));
  });
  it('erase requires email', async () => {
    expect((await request(app()).post('/compliance/gdpr/erase').send({})).status).toBe(400);
  });
  it('erase runs erasure + audit', async () => {
    const res = await request(app()).post('/compliance/gdpr/erase').send({ email: 'sub@x.com' });
    expect(res.body.result).toMatchObject({ erasedFields: ['email'] });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'gdpr.data_erased' }));
  });
  it('export rejects a manager (owner-only)', async () => {
    a.user.role = 'operations_manager';
    expect((await request(app()).post('/compliance/gdpr/export').send({ email: 'x@y.com' })).status).toBe(403);
  });
  it('GET requests lists GDPR requests', async () => {
    a.listGdprRequestsMock.mockResolvedValue([{ id: 'req-1' }]);
    expect((await request(app()).get('/compliance/gdpr/requests')).body.requests).toHaveLength(1);
  });
});
