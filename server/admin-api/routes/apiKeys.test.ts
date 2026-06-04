import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  generateApiKeyMock: vi.fn(),
  listApiKeysMock: vi.fn(),
  revokeApiKeyMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/rbac/ApiKeyService', () => ({
  generateApiKey: a.generateApiKeyMock,
  listApiKeys: a.listApiKeysMock,
  revokeApiKey: a.revokeApiKeyMock,
}));
vi.mock('../../../platform/audit/AuditService', () => ({
  writeAuditLog: a.writeAuditLogMock,
  extractIp: () => '127.0.0.1',
}));

import apiKeysRouter from './apiKeys';

function app() {
  const app = express();
  app.use(express.json());
  app.use(apiKeysRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.listApiKeysMock.mockReset().mockResolvedValue([]);
  a.generateApiKeyMock.mockReset();
  a.revokeApiKeyMock.mockReset();
  a.writeAuditLogMock.mockReset();
});

describe('GET /settings/api-keys', () => {
  it('lists keys for the tenant', async () => {
    a.listApiKeysMock.mockResolvedValue([{ id: 'k1' }]);
    const res = await request(app()).get('/settings/api-keys');
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
  });

  it('rejects a viewer via the real rbac gate', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).get('/settings/api-keys')).status).toBe(403);
  });

  it('returns 500 on failure', async () => {
    a.listApiKeysMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/settings/api-keys')).status).toBe(500);
  });
});

describe('POST /settings/api-keys', () => {
  it('rejects a missing name', async () => {
    const res = await request(app()).post('/settings/api-keys').send({ scopes: ['*'] });
    expect(res.status).toBe(400);
  });

  it('creates a key, returns the plaintext once, and writes an audit log', async () => {
    a.generateApiKeyMock.mockResolvedValue({ key: { id: 'k1' }, plaintextKey: 'secret-123' });
    const res = await request(app()).post('/settings/api-keys').send({ name: '  CI key  ', scopes: ['read'] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: { id: 'k1' }, plaintextKey: 'secret-123' });
    expect(a.generateApiKeyMock).toHaveBeenCalledWith('t1', 'CI key', ['read'], null);
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'api_key.created', resourceId: 'k1' }));
  });

  it('returns 500 on failure', async () => {
    a.generateApiKeyMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).post('/settings/api-keys').send({ name: 'x' })).status).toBe(500);
  });
});

describe('DELETE /settings/api-keys/:id', () => {
  it('revokes a key and writes an audit log', async () => {
    a.revokeApiKeyMock.mockResolvedValue(true);
    const res = await request(app()).delete('/settings/api-keys/k1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'api_key.revoked' }));
  });

  it('returns 404 when the key was not found', async () => {
    a.revokeApiKeyMock.mockResolvedValue(false);
    expect((await request(app()).delete('/settings/api-keys/missing')).status).toBe(404);
  });

  it('returns 500 on failure', async () => {
    a.revokeApiKeyMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).delete('/settings/api-keys/k1')).status).toBe(500);
  });
});
