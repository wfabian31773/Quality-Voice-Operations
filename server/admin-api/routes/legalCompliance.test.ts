import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  sendEmailMock: vi.fn(),
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
vi.mock('../../../platform/email/EmailService', () => ({ sendEmail: a.sendEmailMock }));

import router from './legalCompliance';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.user.isPlatformAdmin = false;
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
  a.sendEmailMock.mockReset().mockResolvedValue({ success: true });
});

describe('GET /public/subprocessors', () => {
  it('lists active subprocessors', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ id: 's1', name: 'Twilio', purpose: 'telephony' }] });
    expect((await request(app()).get('/public/subprocessors')).body.subprocessors).toHaveLength(1);
  });
  it('500 on failure', async () => {
    a.queryMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/public/subprocessors')).status).toBe(500);
  });
});

describe('GET /public/posture', () => {
  it('builds and validates the security posture document', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ id: 's1', name: 'Twilio', purpose: 'telephony', data_types: 'call audio', location: 'US', website: 'https://twilio.com' }] });
    const res = await request(app()).get('/public/posture');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 1 });
    expect(res.body.frameworks.length).toBeGreaterThanOrEqual(1);
    expect(res.body.subprocessors[0]).toMatchObject({ name: 'Twilio' });
  });
});

describe('admin subprocessors', () => {
  beforeEach(() => { a.user.isPlatformAdmin = true; });

  it('rejects a non-platform-admin', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/admin/subprocessors')).status).toBe(403);
  });
  it('lists all subprocessors (incl. inactive)', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ id: 's1', is_active: false }] });
    expect((await request(app()).get('/admin/subprocessors')).body.subprocessors).toHaveLength(1);
  });
  it('create requires name/purpose/data_types', async () => {
    expect((await request(app()).post('/admin/subprocessors').send({ name: 'X' })).status).toBe(400);
  });
  it('creates a subprocessor', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ id: 's9', name: 'New' }] });
    const res = await request(app()).post('/admin/subprocessors').send({ name: 'New', purpose: 'p', data_types: 'd' });
    expect(res.body.subprocessor).toMatchObject({ id: 's9' });
  });
  it('patch 404 when missing', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).patch('/admin/subprocessors/s1').send({ name: 'Renamed' })).status).toBe(404);
  });
  it('patch updates a subprocessor', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ id: 's1', name: 'Renamed' }] });
    expect((await request(app()).patch('/admin/subprocessors/s1').send({ name: 'Renamed' })).body.subprocessor).toMatchObject({ name: 'Renamed' });
  });
  it('deletes a subprocessor', async () => {
    expect((await request(app()).delete('/admin/subprocessors/s1')).body).toEqual({ deleted: true });
  });
});

describe('GET /privacy/deletion-request', () => {
  it('returns the pending deletion request (or null)', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ id: 'd1', status: 'pending' }] });
    expect((await request(app()).get('/privacy/deletion-request')).body.request).toMatchObject({ id: 'd1' });
  });
  it('returns null when none pending', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/privacy/deletion-request')).body).toEqual({ request: null });
  });
});

describe('GET /legal/dpa', () => {
  it('returns the DPA document text', async () => {
    const res = await request(app()).get('/legal/dpa');
    expect(res.status).toBe(200);
    expect(res.text).toContain('DATA PROCESSING ADDENDUM');
  });
});
