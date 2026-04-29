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
  attachTrustHubRegistration: vi.fn(),
  readTrustHubSnapshot: vi.fn(),
  isE164: (v: string) => /^\+[1-9]\d{7,14}$/.test(v),
};

vi.mock('../../platform/telephony/TrustedCallerService', () => trustedCallerMocks);

const trustHubServiceMock = {
  submitTrustHubRegistration: vi.fn(),
  fetchTrustHubStatus: vi.fn(),
  simplifyStatus: (status: string | null | undefined) => status ?? 'draft',
  TrustHubApiError: class TrustHubApiError extends Error {
    constructor(
      public httpStatus: number,
      public httpMethod: string,
      public requestPath: string,
      public responseBody: string,
    ) {
      super(`Twilio Trust Hub ${httpMethod} ${requestPath} failed with ${httpStatus}: ${responseBody}`);
      this.name = 'TrustHubApiError';
    }
  },
  SHAKEN_CUSTOMER_PROFILE_POLICY_SID: 'RNcp',
  SHAKEN_TRUST_PRODUCT_POLICY_SID: 'RNtp',
};
vi.mock('../../platform/telephony/TrustHubService', () => trustHubServiceMock);

const auditMock = vi.fn();
vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: auditMock,
  extractIp: () => '127.0.0.1',
}));

// Role overrides per request — mutated via vi.hoisted so the vi.mock factory
// can capture them safely. Defaults match the original behavior (manager-equivalent
// owner on tenant-A) so all existing assertions keep passing unchanged.
const mockAuthState = vi.hoisted(() => ({ role: 'tenant_owner' as string }));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      tenantId: 'tenant-A',
      email: 'mgr@acme.test',
      role: mockAuthState.role,
      isPlatformAdmin: mockAuthState.role === 'platform_admin',
    };
    next();
  },
}));

const ROLE_RANK: Record<string, number> = {
  agent: 1,
  operator: 2,
  manager: 3,
  tenant_owner: 4,
  platform_admin: 5,
};

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: (required: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      const userRank = ROLE_RANK[req.user?.role ?? ''] ?? 0;
      const requiredRank = ROLE_RANK[required] ?? 0;
      if (userRank >= requiredRank) return next();
      return res.status(403).json({ error: 'Insufficient permissions' });
    },
}));

const poolQueryMock = vi.fn();
const clientQueryMock = vi.fn();
const clientReleaseMock = vi.fn();
vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    query: poolQueryMock,
    connect: async () => ({ query: clientQueryMock, release: clientReleaseMock }),
  }),
  withPrivilegedClient: vi.fn(),
  withTenantContext: async (
    _client: unknown,
    _tenantId: string,
    fn: () => Promise<unknown>,
  ) => fn(),
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
  trustHubServiceMock.submitTrustHubRegistration.mockReset();
  trustHubServiceMock.fetchTrustHubStatus.mockReset();
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
  clientQueryMock.mockReset();
  clientReleaseMock.mockReset();
  mockAuthState.role = 'tenant_owner';
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

describe('POST /trusted-callers/:id/trust-hub', () => {
  const baseProfile = {
    legalName: 'Acme Robotics, Inc.',
    websiteUrl: 'https://acme.example',
    businessRegistrationNumber: '12-3456789',
    businessRegistrationIdType: 'EIN',
    businessIndustry: 'TECHNOLOGY',
    businessIdentityType: 'direct_customer',
    notificationEmail: 'compliance@acme.example',
    address: {
      street: '500 Market Street',
      city: 'San Francisco',
      region: 'CA',
      postalCode: '94110',
      isoCountry: 'US',
    },
    contact: {
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@acme.example',
      phoneNumber: '+14155550100',
      jobTitle: 'COO',
    },
  };

  beforeEach(() => {
    trustedCallerMocks.getCallerId.mockResolvedValue({
      id: 'vc-1',
      tenantId: 'tenant-A',
      phoneNumber: '+12125550123',
      status: 'verified',
      metadata: null,
    });
    trustedCallerMocks.readTrustHubSnapshot.mockReturnValue(null);
  });

  it('returns 404 when the caller does not belong to the tenant', async () => {
    trustedCallerMocks.getCallerId.mockResolvedValue(null);
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-missing/trust-hub')
      .send({ profile: baseProfile });
    expect(res.status).toBe(404);
    expect(trustHubServiceMock.submitTrustHubRegistration).not.toHaveBeenCalled();
  });

  it('rejects an invalid website URL before calling Twilio', async () => {
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/trust-hub')
      .send({ profile: { ...baseProfile, websiteUrl: 'not-a-url' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/websiteUrl/);
    expect(trustHubServiceMock.submitTrustHubRegistration).not.toHaveBeenCalled();
  });

  it('rejects a non-E.164 contact phone number', async () => {
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/trust-hub')
      .send({
        profile: {
          ...baseProfile,
          contact: { ...baseProfile.contact, phoneNumber: '212-555-0100' },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contact\.phoneNumber/);
  });

  it('rejects an unsupported business industry', async () => {
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/trust-hub')
      .send({ profile: { ...baseProfile, businessIndustry: 'CRYPTO_PUMP' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/businessIndustry/);
  });

  it('rejects a non-2-letter ISO country code', async () => {
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/trust-hub')
      .send({
        profile: {
          ...baseProfile,
          address: { ...baseProfile.address, isoCountry: 'USA' },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/isoCountry/);
  });

  it('rejects brand.enabled=true without a recognized brandType', async () => {
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/trust-hub')
      .send({
        profile: baseProfile,
        brand: { enabled: true, brandType: 'NONSENSE' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/brandType/);
  });

  it('persists the snapshot, writes an audit log, and returns 201 on success', async () => {
    trustHubServiceMock.submitTrustHubRegistration.mockResolvedValue({
      submitted: true,
      snapshot: {
        customerProfile: { sid: 'BU-cp', status: 'pending-review', validUntil: null, failureReason: null },
        trustProduct: { sid: 'BU-tp', status: 'pending-review', validUntil: null, failureReason: null },
        brand: null,
        businessInfoEndUserSid: 'IT-biz',
        addressEndUserSid: 'IT-addr',
        representativeEndUserSid: 'IT-rep',
      },
    });
    trustedCallerMocks.attachTrustHubRegistration.mockResolvedValue({
      id: 'vc-1',
      tenantId: 'tenant-A',
      phoneNumber: '+12125550123',
      trustHubProfileSid: 'BU-cp',
      trustProductSid: 'BU-tp',
    });

    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/trust-hub')
      .send({ profile: baseProfile });

    expect(res.status).toBe(201);
    expect(res.body.trustHub.customerProfile.sid).toBe('BU-cp');
    expect(res.body.trustHub.trustProduct.sid).toBe('BU-tp');

    expect(trustHubServiceMock.submitTrustHubRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ legalName: 'Acme Robotics, Inc.' }),
        brand: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(trustedCallerMocks.attachTrustHubRegistration).toHaveBeenCalledWith(
      'tenant-A',
      'vc-1',
      expect.objectContaining({
        customerProfile: expect.objectContaining({ sid: 'BU-cp' }),
        trustProduct: expect.objectContaining({ sid: 'BU-tp' }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'trusted_caller.trust_hub_submitted',
        resourceId: 'vc-1',
      }),
    );
  });

  it('reuses SIDs from a prior partial run (passes existing into the orchestrator)', async () => {
    trustedCallerMocks.readTrustHubSnapshot.mockReturnValue({
      customerProfile: { sid: 'BU-prev-cp', status: 'twilio-rejected', validUntil: null, failureReason: 'bad photo' },
      trustProduct: { sid: 'BU-prev-tp', status: 'draft', validUntil: null, failureReason: null },
      brand: null,
      businessInfoEndUserSid: 'IT-biz-prev',
      addressEndUserSid: 'IT-addr-prev',
      representativeEndUserSid: 'IT-rep-prev',
    });
    trustHubServiceMock.submitTrustHubRegistration.mockResolvedValue({
      submitted: true,
      snapshot: {
        customerProfile: { sid: 'BU-prev-cp', status: 'pending-review', validUntil: null, failureReason: null },
        trustProduct: { sid: 'BU-prev-tp', status: 'pending-review', validUntil: null, failureReason: null },
        brand: null,
        businessInfoEndUserSid: 'IT-biz-prev',
        addressEndUserSid: 'IT-addr-prev',
        representativeEndUserSid: 'IT-rep-prev',
      },
    });
    trustedCallerMocks.attachTrustHubRegistration.mockResolvedValue({ id: 'vc-1' });

    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/trust-hub')
      .send({ profile: baseProfile });

    expect(res.status).toBe(201);
    expect(trustHubServiceMock.submitTrustHubRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        existing: expect.objectContaining({
          customerProfileSid: 'BU-prev-cp',
          trustProductSid: 'BU-prev-tp',
          businessInfoEndUserSid: 'IT-biz-prev',
        }),
      }),
    );
  });

  it('falls back to legacy SID columns when no metadata.trustHub snapshot exists', async () => {
    trustedCallerMocks.getCallerId.mockResolvedValue({
      id: 'vc-1',
      tenantId: 'tenant-A',
      phoneNumber: '+12125550123',
      trustHubProfileSid: 'BU-legacy-cp',
      trustProductSid: 'BU-legacy-tp',
      metadata: null,
    });
    trustedCallerMocks.readTrustHubSnapshot.mockReturnValue(null);
    trustHubServiceMock.submitTrustHubRegistration.mockResolvedValue({
      submitted: true,
      snapshot: {
        customerProfile: { sid: 'BU-legacy-cp', status: 'pending-review', validUntil: null, failureReason: null },
        trustProduct: { sid: 'BU-legacy-tp', status: 'pending-review', validUntil: null, failureReason: null },
        brand: null,
        businessInfoEndUserSid: 'IT-biz-new',
        addressEndUserSid: 'IT-addr-new',
        representativeEndUserSid: 'IT-rep-new',
      },
    });
    trustedCallerMocks.attachTrustHubRegistration.mockResolvedValue({ id: 'vc-1' });

    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/trust-hub')
      .send({ profile: baseProfile });

    expect(res.status).toBe(201);
    expect(trustHubServiceMock.submitTrustHubRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        existing: expect.objectContaining({
          customerProfileSid: 'BU-legacy-cp',
          trustProductSid: 'BU-legacy-tp',
        }),
      }),
    );
  });

  it('reuses a preexisting brandSid from legacy columns to avoid duplicate brand registration', async () => {
    trustedCallerMocks.getCallerId.mockResolvedValue({
      id: 'vc-1',
      tenantId: 'tenant-A',
      phoneNumber: '+12125550123',
      trustHubProfileSid: 'BU-legacy-cp',
      trustProductSid: 'BU-legacy-tp',
      brandSid: 'BN-legacy-brand',
      metadata: null,
    });
    trustedCallerMocks.readTrustHubSnapshot.mockReturnValue(null);
    trustHubServiceMock.submitTrustHubRegistration.mockResolvedValue({
      submitted: true,
      snapshot: {
        customerProfile: { sid: 'BU-legacy-cp', status: 'twilio-approved', validUntil: null, failureReason: null },
        trustProduct: { sid: 'BU-legacy-tp', status: 'twilio-approved', validUntil: null, failureReason: null },
        brand: { sid: 'BN-legacy-brand', status: 'PENDING', validUntil: null, failureReason: null },
        businessInfoEndUserSid: 'IT-biz',
        addressEndUserSid: 'IT-addr',
        representativeEndUserSid: 'IT-rep',
      },
    });
    trustedCallerMocks.attachTrustHubRegistration.mockResolvedValue({ id: 'vc-1' });

    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/trust-hub')
      .send({ profile: baseProfile, brand: { enabled: true, brandType: 'STANDARD' } });

    expect(res.status).toBe(201);
    expect(trustHubServiceMock.submitTrustHubRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        existing: expect.objectContaining({
          customerProfileSid: 'BU-legacy-cp',
          trustProductSid: 'BU-legacy-tp',
          brandSid: 'BN-legacy-brand',
        }),
      }),
    );
  });

  it('maps Twilio HTTP failures to 502', async () => {
    trustHubServiceMock.submitTrustHubRegistration.mockRejectedValue(
      new trustHubServiceMock.TrustHubApiError(422, 'POST', '/CustomerProfiles', 'Invalid'),
    );
    const app = await buildTrustedApp();
    const res = await request(app)
      .post('/trusted-callers/vc-1/trust-hub')
      .send({ profile: baseProfile });
    expect(res.status).toBe(502);
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trusted_caller.trust_hub_submitted' }),
    );
  });
});

describe('GET /trusted-callers/:id/trust-hub', () => {
  it('returns null stored/live when no snapshot is attached', async () => {
    trustedCallerMocks.getCallerId.mockResolvedValue({ id: 'vc-1', tenantId: 'tenant-A', metadata: null });
    trustedCallerMocks.readTrustHubSnapshot.mockReturnValue(null);
    const app = await buildTrustedApp();
    const res = await request(app).get('/trusted-callers/vc-1/trust-hub');
    expect(res.status).toBe(200);
    expect(res.body.stored).toBeNull();
    expect(res.body.live).toBeNull();
    expect(trustHubServiceMock.fetchTrustHubStatus).not.toHaveBeenCalled();
  });

  it('returns the stored snapshot plus a live Twilio status when a snapshot exists', async () => {
    const stored = {
      customerProfile: { sid: 'BU-cp', status: 'pending-review', validUntil: null, failureReason: null },
      trustProduct: { sid: 'BU-tp', status: 'pending-review', validUntil: null, failureReason: null },
      brand: null,
      businessInfoEndUserSid: 'IT-biz',
      addressEndUserSid: 'IT-addr',
      representativeEndUserSid: 'IT-rep',
    };
    trustedCallerMocks.getCallerId.mockResolvedValue({ id: 'vc-1', tenantId: 'tenant-A', metadata: { trustHub: stored } });
    trustedCallerMocks.readTrustHubSnapshot.mockReturnValue(stored);
    const live = { ...stored, customerProfile: { ...stored.customerProfile, status: 'twilio-approved' } };
    trustHubServiceMock.fetchTrustHubStatus.mockResolvedValue(live);
    trustedCallerMocks.attachTrustHubRegistration.mockResolvedValue({
      id: 'vc-1', tenantId: 'tenant-A', metadata: { trustHub: live },
    });

    const app = await buildTrustedApp();
    const res = await request(app).get('/trusted-callers/vc-1/trust-hub');
    expect(res.status).toBe(200);
    expect(res.body.live.customerProfile.status).toBe('twilio-approved');
    expect(trustedCallerMocks.attachTrustHubRegistration).toHaveBeenCalledWith(
      'tenant-A',
      'vc-1',
      expect.objectContaining({
        customerProfile: expect.objectContaining({ status: 'twilio-approved' }),
      }),
      expect.objectContaining({ source: 'sync' }),
    );
  });

  it('does not write back when live status matches stored status', async () => {
    const stored = {
      customerProfile: { sid: 'BU-cp', status: 'pending-review', validUntil: null, failureReason: null },
      trustProduct: { sid: 'BU-tp', status: 'pending-review', validUntil: null, failureReason: null },
      brand: null,
      businessInfoEndUserSid: null,
      addressEndUserSid: null,
      representativeEndUserSid: null,
    };
    trustedCallerMocks.getCallerId.mockResolvedValue({ id: 'vc-1', tenantId: 'tenant-A', metadata: { trustHub: stored } });
    trustedCallerMocks.readTrustHubSnapshot.mockReturnValue(stored);
    trustHubServiceMock.fetchTrustHubStatus.mockResolvedValue(stored);

    const app = await buildTrustedApp();
    const res = await request(app).get('/trusted-callers/vc-1/trust-hub');
    expect(res.status).toBe(200);
    expect(trustedCallerMocks.attachTrustHubRegistration).not.toHaveBeenCalled();
  });

  it('returns the stored snapshot with live=null when Twilio is unreachable', async () => {
    const stored = {
      customerProfile: { sid: 'BU-cp', status: 'pending-review', validUntil: null, failureReason: null },
      trustProduct: { sid: 'BU-tp', status: 'pending-review', validUntil: null, failureReason: null },
      brand: null,
      businessInfoEndUserSid: null,
      addressEndUserSid: null,
      representativeEndUserSid: null,
    };
    trustedCallerMocks.getCallerId.mockResolvedValue({ id: 'vc-1', tenantId: 'tenant-A', metadata: { trustHub: stored } });
    trustedCallerMocks.readTrustHubSnapshot.mockReturnValue(stored);
    trustHubServiceMock.fetchTrustHubStatus.mockRejectedValue(new Error('Twilio down'));

    const app = await buildTrustedApp();
    const res = await request(app).get('/trusted-callers/vc-1/trust-hub');
    expect(res.status).toBe(200);
    expect(res.body.stored).not.toBeNull();
    expect(res.body.live).toBeNull();
  });
});

describe('GET /trusted-callers/:id/history', () => {
  it('returns 403 when the caller is below manager role', async () => {
    mockAuthState.role = 'operator';
    const app = await buildTrustedApp();
    const res = await request(app).get('/trusted-callers/vc-1/history');
    expect(res.status).toBe(403);
    expect(trustedCallerMocks.getCallerId).not.toHaveBeenCalled();
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller does not belong to the tenant', async () => {
    trustedCallerMocks.getCallerId.mockResolvedValue(null);
    const app = await buildTrustedApp();
    const res = await request(app).get('/trusted-callers/vc-missing/history');
    expect(res.status).toBe(404);
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it('returns audit events filtered to the caller and tenant, newest first', async () => {
    trustedCallerMocks.getCallerId.mockResolvedValue({
      id: 'vc-1',
      tenantId: 'tenant-A',
      phoneNumber: '+12125550123',
    });
    const sampleRows = [
      {
        id: 'a3',
        action: 'trusted_caller.trust_hub_submitted',
        resource_type: 'trusted_caller',
        resource_id: 'vc-1',
        changes: {},
        before_state: null,
        after_state: { customerProfileSid: 'BU-cp', trustProductSid: 'BU-tp', brandSid: null },
        severity: 'info',
        ip_address: '10.0.0.1',
        occurred_at: '2026-04-29T12:34:56Z',
        actor_user_id: 'user-1',
        actor_role: 'tenant_owner',
        actor_email: 'mgr@acme.test',
      },
      {
        id: 'a1',
        action: 'trusted_caller.registered',
        resource_type: 'trusted_caller',
        resource_id: 'vc-1',
        changes: {},
        before_state: null,
        after_state: { phoneNumber: '+12125550123', friendlyName: 'Sales' },
        severity: 'info',
        ip_address: '10.0.0.1',
        occurred_at: '2026-04-01T00:00:00Z',
        actor_user_id: 'user-1',
        actor_role: 'tenant_owner',
        actor_email: 'mgr@acme.test',
      },
    ];
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('audit_logs')) return { rows: sampleRows };
      return { rows: [] };
    });

    const app = await buildTrustedApp();
    const res = await request(app).get('/trusted-callers/vc-1/history');

    expect(res.status).toBe(200);
    expect(res.body.callerId).toBe('vc-1');
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].action).toBe('trusted_caller.trust_hub_submitted');
    expect(res.body.events[1].action).toBe('trusted_caller.registered');

    // Confirm the SQL bound the caller id and tenant, and ordered by occurred_at DESC.
    const auditCall = clientQueryMock.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('audit_logs'),
    );
    expect(auditCall).toBeDefined();
    const [, params] = auditCall as [string, unknown[]];
    expect(params[0]).toBe('tenant-A');
    expect(params[1]).toBe('vc-1');
    expect((auditCall as [string, unknown[]])[0]).toMatch(/ORDER BY a\.occurred_at DESC/);
    // The query also pulls in rotated-from events tied to the retired side.
    expect((auditCall as [string, unknown[]])[0]).toMatch(/changes->>'fromId'/);
    expect(clientReleaseMock).toHaveBeenCalled();
  });

  it('clamps the limit query param to the [1, 200] range', async () => {
    trustedCallerMocks.getCallerId.mockResolvedValue({ id: 'vc-1', tenantId: 'tenant-A' });
    clientQueryMock.mockResolvedValue({ rows: [] });

    const app = await buildTrustedApp();
    const res = await request(app).get('/trusted-callers/vc-1/history?limit=9999');
    expect(res.status).toBe(200);
    const auditCall = clientQueryMock.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('audit_logs'),
    );
    const [, params] = auditCall as [string, unknown[]];
    expect(params[2]).toBe(200);
  });

  it('returns 500 when the audit query fails and releases the client', async () => {
    trustedCallerMocks.getCallerId.mockResolvedValue({ id: 'vc-1', tenantId: 'tenant-A' });
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('audit_logs')) throw new Error('db down');
      return { rows: [] };
    });

    const app = await buildTrustedApp();
    const res = await request(app).get('/trusted-callers/vc-1/history');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/history/);
    expect(clientReleaseMock).toHaveBeenCalled();
  });
});
