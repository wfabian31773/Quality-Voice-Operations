/**
 * Coverage for the Trusted Callers admin API and the campaign activation
 * guard that ensures an outbound campaign cannot be flipped to
 * scheduled/running with a missing or unverified caller ID.
 *
 * Both surfaces are mounted with stubbed auth/RBAC so we can drive them
 * via supertest. The TrustedCallerService is fully mocked so we assert
 * the route layer (validation, audit logging, status codes) without
 * touching Postgres or Twilio.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

const trustedCallerMocks = {
  registerCallerId: vi.fn(),
  listCallerIds: vi.fn(),
  getCallerId: vi.fn(),
  getVerifiedCallerById: vi.fn(),
  deleteCallerId: vi.fn(),
  rotateCallerId: vi.fn(),
  confirmCallerIdVerified: vi.fn(),
  syncCallerIdStatus: vi.fn(),
  resolveCampaignCallerId: vi.fn(),
  isE164: (v: string) => /^\+[1-9]\d{7,14}$/.test(v),
};

vi.mock('../../platform/telephony/TrustedCallerService', () => trustedCallerMocks);

const auditMock = vi.fn();
vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: auditMock,
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      tenantId: 'tenant-A',
      email: 'mgr@acme.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const poolQueryMock = vi.fn();
vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: poolQueryMock }),
  withPrivilegedClient: vi.fn(),
  withTenantContext: vi.fn(),
}));

const campaignsServiceMock = {
  createCampaign: vi.fn(),
  getCampaign: vi.fn(),
  listCampaigns: vi.fn(),
  updateCampaign: vi.fn(),
  deleteCampaign: vi.fn(),
  getCampaignMetrics: vi.fn(),
  getTypeSpecificMetrics: vi.fn(),
  updateContactTypeDisposition: vi.fn(),
  addContacts: vi.fn(),
  listContacts: vi.fn(),
  addToDnc: vi.fn(),
  listDnc: vi.fn(),
  removeFromDnc: vi.fn(),
  getAllCampaignTypes: vi.fn(() => []),
  getValidCampaignTypes: vi.fn(() => []),
  isValidDisposition: vi.fn(() => true),
  checkCampaignCompliance: vi.fn(),
};
vi.mock('../../platform/campaigns', () => campaignsServiceMock);

beforeEach(() => {
  for (const fn of Object.values(trustedCallerMocks)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  trustedCallerMocks.isE164 = (v: string) => /^\+[1-9]\d{7,14}$/.test(v);
  for (const fn of Object.values(campaignsServiceMock)) (fn as ReturnType<typeof vi.fn>).mockReset();
  campaignsServiceMock.getAllCampaignTypes.mockReturnValue([]);
  campaignsServiceMock.getValidCampaignTypes.mockReturnValue([]);
  campaignsServiceMock.isValidDisposition.mockReturnValue(true);
  campaignsServiceMock.checkCampaignCompliance.mockResolvedValue({
    ok: true,
    dncMatchCount: 0,
    complianceScore: 100,
  });
  auditMock.mockReset();
  poolQueryMock.mockReset();
});

async function buildTrustedApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const router = (await import('../../server/admin-api/routes/trustedCallers')).default;
  app.use(router);
  return app;
}

async function buildCampaignsApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const router = (await import('../../server/admin-api/routes/campaigns')).default;
  app.use(router);
  return app;
}

describe('POST /trusted-callers', () => {
  it('rejects non-E.164 phone numbers before reaching Twilio', async () => {
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers')
      .send({ phoneNumber: '212-555-0123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/E\.164/);
    expect(trustedCallerMocks.registerCallerId).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('rejects malformed Trust Hub SIDs without calling Twilio', async () => {
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers')
      .send({ phoneNumber: '+12125550123', trustProductSid: 'BU-not-real' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/trustProductSid/);
    expect(trustedCallerMocks.registerCallerId).not.toHaveBeenCalled();
  });

  it('returns the validation code Twilio handed back and writes an audit log', async () => {
    trustedCallerMocks.registerCallerId.mockResolvedValue({
      id: 'vc-1',
      tenantId: 'tenant-A',
      phoneNumber: '+12125550123',
      friendlyName: 'Sales',
      status: 'pending',
      attestationLevel: null,
      validationCode: '482931',
    });
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers')
      .send({ phoneNumber: '+12125550123', friendlyName: 'Sales' });

    expect(res.status).toBe(201);
    expect(res.body.caller.id).toBe('vc-1');
    expect(res.body.validationCode).toBe('482931');
    expect(trustedCallerMocks.registerCallerId).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-A',
        phoneNumber: '+12125550123',
        friendlyName: 'Sales',
        registeredByUserId: 'user-1',
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'trusted_caller.registered',
        resourceId: 'vc-1',
      }),
    );
  });
});

describe('GET /trusted-callers', () => {
  it('passes the includeRotated flag through to the service', async () => {
    trustedCallerMocks.listCallerIds.mockResolvedValue([]);
    const app = await buildTrustedApp();
    const res = await request(app).get('/trusted-callers?includeRotated=true');
    expect(res.status).toBe(200);
    expect(trustedCallerMocks.listCallerIds).toHaveBeenCalledWith('tenant-A', { includeRotated: true });
  });
});

describe('POST /trusted-callers/:id/verify manual override gate', () => {
  it('rejects manual override without a reason', async () => {
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/verify')
      .send({ manualOverride: true, manualOverrideReason: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/manualOverrideReason/);
    expect(trustedCallerMocks.confirmCallerIdVerified).not.toHaveBeenCalled();
  });

  it('passes manualOverride through to the service when reason is supplied', async () => {
    trustedCallerMocks.confirmCallerIdVerified.mockResolvedValue({
      id: 'vc-1',
      tenantId: 'tenant-A',
      phoneNumber: '+12125550123',
      status: 'verified',
      attestationLevel: 'A',
    });
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/verify')
      .send({
        manualOverride: true,
        manualOverrideReason: 'Self-hosted dev environment without Twilio',
        attestationLevel: 'A',
      });
    expect(res.status).toBe(200);
    expect(trustedCallerMocks.confirmCallerIdVerified).toHaveBeenCalledWith(
      'tenant-A',
      'vc-1',
      expect.objectContaining({
        manualOverride: true,
        manualOverrideReason: 'Self-hosted dev environment without Twilio',
        attestationLevel: 'A',
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'trusted_caller.verified_manual_override',
        severity: 'warning',
      }),
    );
  });

  it('returns 409 when Twilio has not yet recorded the number', async () => {
    trustedCallerMocks.confirmCallerIdVerified.mockRejectedValue(
      new Error('Twilio has not yet recorded this number as a verified outgoing caller ID. Complete the validation call and retry.'),
    );
    const app = await buildTrustedApp();
    const res = await request(app).post('/trusted-callers/vc-1/verify').send({});
    expect(res.status).toBe(409);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('Campaign activation guard', () => {
  beforeEach(() => {
    poolQueryMock.mockResolvedValue({ rows: [{ phone_verified: true }] });
  });

  it('blocks activation when the configured verified caller ID is missing', async () => {
    campaignsServiceMock.getCampaign.mockResolvedValue({
      id: 'camp-1',
      tenantId: 'tenant-A',
      name: 'Spring outreach',
      type: 'outbound_call',
      status: 'draft',
      config: { verifiedCallerId: 'vc-missing' },
    });
    trustedCallerMocks.getVerifiedCallerById.mockResolvedValue(null);

    const app = await buildCampaignsApp();
    const res = await request(app)
      .patch('/campaigns/camp-1')
      .send({ status: 'running' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verified caller ID/i);
    expect(campaignsServiceMock.updateCampaign).not.toHaveBeenCalled();
    expect(trustedCallerMocks.getVerifiedCallerById).toHaveBeenCalledWith('tenant-A', 'vc-missing');
  });

  it('allows activation when the verified caller ID exists', async () => {
    campaignsServiceMock.getCampaign.mockResolvedValue({
      id: 'camp-2',
      tenantId: 'tenant-A',
      name: 'Spring outreach',
      type: 'outbound_call',
      status: 'draft',
      config: {},
    });
    trustedCallerMocks.getVerifiedCallerById.mockResolvedValue({
      id: 'vc-ok',
      tenantId: 'tenant-A',
      phoneNumber: '+12125550123',
      status: 'verified',
      attestationLevel: 'A',
    });
    campaignsServiceMock.updateCampaign.mockResolvedValue({
      id: 'camp-2',
      tenantId: 'tenant-A',
      status: 'running',
      config: { verifiedCallerId: 'vc-ok' },
    });

    const app = await buildCampaignsApp();
    const res = await request(app)
      .patch('/campaigns/camp-2')
      .send({ status: 'running', config: { verifiedCallerId: 'vc-ok' } });

    expect(res.status).toBe(200);
    expect(campaignsServiceMock.updateCampaign).toHaveBeenCalled();
  });

  it('does not consult the trusted caller service when no verifiedCallerId is set', async () => {
    campaignsServiceMock.getCampaign.mockResolvedValue({
      id: 'camp-3',
      tenantId: 'tenant-A',
      name: 'No caller',
      type: 'outbound_call',
      status: 'draft',
      config: {},
    });
    campaignsServiceMock.updateCampaign.mockResolvedValue({
      id: 'camp-3',
      tenantId: 'tenant-A',
      status: 'running',
      config: {},
    });

    const app = await buildCampaignsApp();
    const res = await request(app)
      .patch('/campaigns/camp-3')
      .send({ status: 'running' });

    expect(res.status).toBe(200);
    expect(trustedCallerMocks.getVerifiedCallerById).not.toHaveBeenCalled();
  });

  it('rejects payloads where verifiedCallerId is the wrong type', async () => {
    campaignsServiceMock.getCampaign.mockResolvedValue({
      id: 'camp-4',
      tenantId: 'tenant-A',
      name: 'Bad config',
      type: 'outbound_call',
      status: 'draft',
      config: {},
    });

    const app = await buildCampaignsApp();
    const res = await request(app)
      .patch('/campaigns/camp-4')
      .send({ config: { verifiedCallerId: 12345 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verifiedCallerId/);
  });
});
