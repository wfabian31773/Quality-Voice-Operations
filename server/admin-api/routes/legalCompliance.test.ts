import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  sendEmailMock: vi.fn(),
  discoverTenantScopedTablesMock: vi.fn(),
  executeExplicitTenantDeletesMock: vi.fn(),
  verifyTenantRowsRemovedMock: vi.fn(),
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
vi.mock('../../../platform/compliance/HealthcareDeletionVerificationService', () => ({
  discoverTenantScopedTables: a.discoverTenantScopedTablesMock,
  executeExplicitTenantDeletes: a.executeExplicitTenantDeletesMock,
  verifyTenantRowsRemoved: a.verifyTenantRowsRemovedMock,
}));

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
  a.discoverTenantScopedTablesMock.mockReset().mockResolvedValue([
    { table: 'call_sessions', deleteRule: 'CASCADE' },
    { table: 'escalation_tasks', deleteRule: null },
    { table: 'audit_logs', deleteRule: 'CASCADE' },
    { table: 'tenant_deletion_requests', deleteRule: 'SET NULL' },
  ]);
  a.executeExplicitTenantDeletesMock.mockReset().mockResolvedValue(undefined);
  a.verifyTenantRowsRemovedMock.mockReset().mockResolvedValue({ verified: true, remaining: [] });
  process.env.QVO_PII_LOOKUP_HMAC_KEY = 'a-secure-lookup-key-with-at-least-32-characters';
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

  it('fails closed when certifications, BAAs, and residency are not owner-verified', async () => {
    const res = await request(app()).get('/public/posture');

    expect(res.status).toBe(200);
    expect(res.body.frameworks).toHaveLength(5);
    expect(res.body.frameworks.every((framework: { status: string }) => framework.status === 'not_verified')).toBe(true);
    expect(res.body.baa).toMatchObject({
      available: false,
      plans: [],
      contact: '/contact',
    });
    expect(res.body.data_residency).toMatchObject({
      verified: false,
      primary_region: 'Not contractually committed',
    });

    const serialized = JSON.stringify(res.body).toLowerCase();
    expect(serialized).not.toContain('available with baa');
    expect(serialized).not.toContain('countersigned on request');
    expect(serialized).not.toContain('status":"compliant');
    expect(serialized).not.toContain('target q4');
    expect(serialized).not.toContain('@qvo.example');
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

const externalDeletionEvidence = {
  twilio: 'evidence/deletion/twilio-1',
  openai: 'evidence/deletion/openai-1',
  hosting: 'evidence/deletion/hosting-1',
  messaging_connectors: 'evidence/deletion/connectors-1',
  logs_backups: 'evidence/deletion/logs-backups-1',
};

describe('POST /admin/privacy/deletion-request/:id/execute', () => {
  beforeEach(() => { a.user.isPlatformAdmin = true; });

  it('requires external processor deletion evidence before destructive work', async () => {
    const res = await request(app()).post('/admin/privacy/deletion-request/d1/execute').send({});
    expect(res.status).toBe(400);
    expect(a.queryMock).not.toHaveBeenCalled();
  });

  it('fails closed on an unclassified tenant data store', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenant_deletion_requests')) return { rows: [{ id: 'd1', tenant_id: 't1', requested_by: 'u1', scheduled_for: '2026-07-01T00:00:00.000Z', status: 'pending' }] };
      return { rows: [] };
    });
    a.discoverTenantScopedTablesMock.mockResolvedValue([
      { table: 'call_sessions', deleteRule: 'CASCADE' },
      { table: 'new_phi_store', deleteRule: null },
    ]);
    const res = await request(app()).post('/admin/privacy/deletion-request/d1/execute').send({ externalDeletionEvidence });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'Tenant deletion data-control review is incomplete' });
    expect(a.executeExplicitTenantDeletesMock).not.toHaveBeenCalled();
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM tenants'))).toBe(false);
  });

  it('records redacted evidence and commits only after first-party verification passes', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenant_deletion_requests')) return { rows: [{ id: 'd1', tenant_id: 't1', requested_by: 'u1', scheduled_for: '2026-07-01T00:00:00.000Z', status: 'pending' }] };
      if (sql.includes('SELECT name FROM tenants')) return { rows: [{ name: 'Clinic' }] };
      if (sql.includes('SELECT email FROM users')) return { rows: [{ email: 'owner@example.test' }] };
      return { rows: [], rowCount: 1 };
    });
    const res = await request(app()).post('/admin/privacy/deletion-request/d1/execute').send({ externalDeletionEvidence });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ executed: true, firstPartyVerified: true, externalEvidenceRecorded: true });
    expect(a.executeExplicitTenantDeletesMock).toHaveBeenCalled();
    expect(a.verifyTenantRowsRemovedMock).toHaveBeenCalled();
    const finalUpdate = a.queryMock.mock.calls.find(([sql]) => String(sql).includes('first_party_verification'));
    expect(finalUpdate?.[1]).toContain('[REDACTED AFTER VERIFIED DELETION]');
    expect(JSON.stringify(finalUpdate?.[1])).not.toContain('Clinic');
    const firstPartyProof = JSON.parse(String(finalUpdate?.[1]?.[3])) as Record<string, unknown>;
    expect(firstPartyProof.executorFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(firstPartyProof)).not.toContain('u1');
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('COMMIT'))).toBe(true);
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'privacy.deletion_execution_started',
    }));
  });

  it('rolls back a failed verification without writing a false deletion-executed audit event', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenant_deletion_requests')) return { rows: [{ id: 'd1', tenant_id: 't1', requested_by: 'u1', scheduled_for: '2026-07-01T00:00:00.000Z', status: 'pending' }] };
      if (sql.includes('SELECT name FROM tenants')) return { rows: [{ name: 'Clinic' }] };
      if (sql.includes('SELECT email FROM users')) return { rows: [{ email: 'owner@example.test' }] };
      return { rows: [], rowCount: 1 };
    });
    a.verifyTenantRowsRemovedMock.mockResolvedValue({
      verified: false, remaining: [{ table: 'call_sessions', count: 1 }],
    });

    const res = await request(app()).post('/admin/privacy/deletion-request/d1/execute').send({ externalDeletionEvidence });

    expect(res.status).toBe(500);
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('ROLLBACK'))).toBe(true);
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('COMMIT'))).toBe(false);
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'privacy.deletion_execution_started',
    }));
    expect(a.writeAuditLogMock).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'privacy.deletion_executed',
    }));
  });
});
