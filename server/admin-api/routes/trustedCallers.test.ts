import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  registerCallerIdMock: vi.fn(),
  listCallerIdsMock: vi.fn(),
  getCallerIdMock: vi.fn(),
  deleteCallerIdMock: vi.fn(),
  rotateCallerIdMock: vi.fn(),
  confirmCallerIdVerifiedMock: vi.fn(),
  syncCallerIdStatusMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.queryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<unknown>) => cb(),
}));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/telephony/TrustedCallerService', () => ({
  registerCallerId: a.registerCallerIdMock,
  listCallerIds: a.listCallerIdsMock,
  getCallerId: a.getCallerIdMock,
  deleteCallerId: a.deleteCallerIdMock,
  rotateCallerId: a.rotateCallerIdMock,
  confirmCallerIdVerified: a.confirmCallerIdVerifiedMock,
  syncCallerIdStatus: a.syncCallerIdStatusMock,
  attachTrustHubRegistration: vi.fn(),
  readTrustHubSnapshot: vi.fn(),
  isE164: (v: string) => /^\+[1-9]\d{6,14}$/.test(v),
}));
vi.mock('../../../platform/telephony/TrustHubService', () => ({
  submitTrustHubRegistration: vi.fn(),
  fetchTrustHubStatus: vi.fn(),
  TrustHubApiError: class TrustHubApiError extends Error {},
}));

import router from './trustedCallers';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
  a.registerCallerIdMock.mockReset().mockResolvedValue({ id: 'c1', validationCode: '1234' });
  a.listCallerIdsMock.mockReset().mockResolvedValue([]);
  a.getCallerIdMock.mockReset();
  a.deleteCallerIdMock.mockReset();
  a.rotateCallerIdMock.mockReset();
  a.confirmCallerIdVerifiedMock.mockReset().mockResolvedValue({ id: 'c1', attestationLevel: 'A' });
  a.syncCallerIdStatusMock.mockReset();
});

describe('GET /trusted-callers', () => {
  it('lists callers', async () => {
    a.listCallerIdsMock.mockResolvedValue([{ id: 'c1' }]);
    expect((await request(app()).get('/trusted-callers')).body.callers).toHaveLength(1);
  });
  it('500 on failure', async () => {
    a.listCallerIdsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/trusted-callers')).status).toBe(500);
  });
});

describe('GET /trusted-callers/:id', () => {
  it('404 when missing', async () => {
    a.getCallerIdMock.mockResolvedValue(null);
    expect((await request(app()).get('/trusted-callers/c1')).status).toBe(404);
  });
  it('returns the caller', async () => {
    a.getCallerIdMock.mockResolvedValue({ id: 'c1' });
    expect((await request(app()).get('/trusted-callers/c1')).body.caller).toMatchObject({ id: 'c1' });
  });
});

describe('GET /trusted-callers/:id/history', () => {
  it('404 when the caller is missing', async () => {
    a.getCallerIdMock.mockResolvedValue(null);
    expect((await request(app()).get('/trusted-callers/c1/history')).status).toBe(404);
  });
  it('returns audit events', async () => {
    a.getCallerIdMock.mockResolvedValue({ id: 'c1' });
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM audit_logs a') ? { rows: [{ id: 'ev1', action: 'trusted_caller.registered' }] } : { rows: [] },
    );
    const res = await request(app()).get('/trusted-callers/c1/history');
    expect(res.body).toMatchObject({ callerId: 'c1' });
    expect(res.body.events).toHaveLength(1);
  });
});

describe('POST /trusted-callers', () => {
  it('requires a phone number', async () => {
    expect((await request(app()).post('/trusted-callers').send({})).status).toBe(400);
  });
  it('rejects a non-E.164 number', async () => {
    expect((await request(app()).post('/trusted-callers').send({ phoneNumber: '5551234' })).status).toBe(400);
  });
  it('rejects a malformed Trust Hub SID', async () => {
    const res = await request(app()).post('/trusted-callers').send({ phoneNumber: '+12125550123', trustHubProfileSid: 'nope' });
    expect(res.status).toBe(400);
  });
  it('registers a caller and returns the validation code', async () => {
    const res = await request(app()).post('/trusted-callers').send({ phoneNumber: '+12125550123', friendlyName: 'Front desk' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ validationCode: '1234' });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trusted_caller.registered' }));
  });
  it('maps a Twilio error to 502', async () => {
    a.registerCallerIdMock.mockRejectedValue(new Error('Twilio rejected the number'));
    expect((await request(app()).post('/trusted-callers').send({ phoneNumber: '+12125550123' })).status).toBe(502);
  });
});

describe('POST /trusted-callers/:id/verify', () => {
  it('rejects an invalid attestation level', async () => {
    expect((await request(app()).post('/trusted-callers/c1/verify').send({ attestationLevel: 'Z' })).status).toBe(400);
  });
  it('blocks a manager manual-override (owner only)', async () => {
    const res = await request(app()).post('/trusted-callers/c1/verify').send({ manualOverride: true, manualOverrideReason: 'dev' });
    expect(res.status).toBe(403);
  });
  it('requires a reason for an owner manual-override', async () => {
    a.user.role = 'tenant_owner';
    expect((await request(app()).post('/trusted-callers/c1/verify').send({ manualOverride: true })).status).toBe(400);
  });
  it('confirms verification', async () => {
    const res = await request(app()).post('/trusted-callers/c1/verify').send({ attestationLevel: 'A' });
    expect(res.body.caller).toMatchObject({ attestationLevel: 'A' });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trusted_caller.verified' }));
  });
  it('maps a "not yet" error to 409', async () => {
    a.confirmCallerIdVerifiedMock.mockRejectedValue(new Error('Caller is not yet verified'));
    expect((await request(app()).post('/trusted-callers/c1/verify').send({})).status).toBe(409);
  });
});

describe('POST /trusted-callers/:id/sync', () => {
  it('returns the synced caller', async () => {
    a.syncCallerIdStatusMock.mockResolvedValue({ id: 'c1', status: 'verified' });
    expect((await request(app()).post('/trusted-callers/c1/sync')).body.caller).toMatchObject({ status: 'verified' });
  });
  it('404 on sync failure', async () => {
    a.syncCallerIdStatusMock.mockRejectedValue(new Error('not found'));
    expect((await request(app()).post('/trusted-callers/c1/sync')).status).toBe(404);
  });
});

describe('DELETE /trusted-callers/:id', () => {
  it('deletes a caller + audit', async () => {
    a.deleteCallerIdMock.mockResolvedValue(true);
    expect((await request(app()).delete('/trusted-callers/c1')).body).toEqual({ deleted: true });
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trusted_caller.deleted' }));
  });
  it('404 when nothing deleted', async () => {
    a.deleteCallerIdMock.mockResolvedValue(false);
    expect((await request(app()).delete('/trusted-callers/c1')).status).toBe(404);
  });
});
