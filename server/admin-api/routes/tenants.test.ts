import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'me@x.com', role: 'tenant_owner', isPlatformAdmin: false },
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  getProvisioningStatusMock: vi.fn(),
  provisionTenantMock: vi.fn(),
  getRegisteredTemplatesMock: vi.fn(),
  stripeRetrieveMock: vi.fn(),
  getActivationMilestonesMock: vi.fn(),
  dismissTooltipMock: vi.fn(),
  getDismissedTooltipsMock: vi.fn(),
  invalidateCurrencyMock: vi.fn(),
  isSupportedCurrencyMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  invalidateStatusMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
  invalidateTenantStatusCache: a.invalidateStatusMock,
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/tenant/provisioning/TenantProvisioningService', () => ({
  getProvisioningStatus: a.getProvisioningStatusMock,
  provisionTenant: a.provisionTenantMock,
}));
vi.mock('../../../platform/agent-templates/registry', () => ({ getRegisteredTemplates: a.getRegisteredTemplatesMock }));
vi.mock('../../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({ checkout: { sessions: { retrieve: a.stripeRetrieveMock } } }),
}));
vi.mock('../../../platform/billing/stripe/plans', () => ({
  PLAN_LIMITS: { starter: { monthlyCallLimit: 100, monthlySmsLimit: 100, monthlyAiMinuteLimit: 100, overageEnabled: false } },
}));
vi.mock('../../../platform/activation/ActivationService', () => ({
  getActivationMilestones: a.getActivationMilestonesMock,
  dismissTooltip: a.dismissTooltipMock,
  getDismissedTooltips: a.getDismissedTooltipsMock,
}));
vi.mock('../../../platform/billing/tenantCurrency', () => ({ invalidateTenantCurrencyCache: a.invalidateCurrencyMock }));
vi.mock('../../../platform/billing/supportedCurrencies', () => ({
  SUPPORTED_BILLING_CURRENCIES: [{ code: 'usd' }, { code: 'eur' }],
  isSupportedBillingCurrency: a.isSupportedCurrencyMock,
}));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));

import tenantsRouter from './tenants';

function app() {
  const app = express();
  app.use(express.json());
  app.use(tenantsRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'tenant_owner';
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.releaseMock.mockReset();
  a.getProvisioningStatusMock.mockReset().mockResolvedValue({ status: 'active' });
  a.provisionTenantMock.mockReset().mockResolvedValue(undefined);
  a.getRegisteredTemplatesMock.mockReset().mockReturnValue([{ key: 'dental' }]);
  a.stripeRetrieveMock.mockReset();
  a.getActivationMilestonesMock.mockReset().mockResolvedValue([]);
  a.dismissTooltipMock.mockReset().mockResolvedValue(undefined);
  a.getDismissedTooltipsMock.mockReset().mockResolvedValue([]);
  a.invalidateCurrencyMock.mockReset();
  a.isSupportedCurrencyMock.mockReset().mockReturnValue(true);
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
  a.invalidateStatusMock.mockReset();
  process.env.APP_ENV = 'development';
});
afterEach(() => { delete process.env.APP_ENV; });

describe('GET /tenants/me', () => {
  it('returns the tenant', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM tenants') ? { rows: [{ id: 't1', name: 'Acme' }] } : { rows: [] },
    );
    const res = await request(app()).get('/tenants/me');
    expect(res.body.tenant).toMatchObject({ id: 't1' });
  });

  it('returns 404 when not found', async () => {
    expect((await request(app()).get('/tenants/me')).status).toBe(404);
  });
});

describe('GET /tenants/me/provisioning-status', () => {
  it('returns the status', async () => {
    a.getProvisioningStatusMock.mockResolvedValue({ status: 'active' });
    expect((await request(app()).get('/tenants/me/provisioning-status')).body).toEqual({ status: 'active' });
  });

  it('auto-provisions a pending tenant in dev mode', async () => {
    a.getProvisioningStatusMock.mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'active' });
    const res = await request(app()).get('/tenants/me/provisioning-status');
    expect(res.body).toEqual({ status: 'active' });
    expect(a.provisionTenantMock).toHaveBeenCalled();
  });

  it('returns 500 on failure', async () => {
    a.getProvisioningStatusMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/tenants/me/provisioning-status')).status).toBe(500);
  });
});

describe('POST /tenants/me/verify-checkout', () => {
  it('requires a sessionId', async () => {
    expect((await request(app()).post('/tenants/me/verify-checkout').send({})).status).toBe(400);
  });

  it('returns ready immediately when the tenant is already active', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT status FROM tenants') ? { rows: [{ status: 'active' }] } : { rows: [] },
    );
    const res = await request(app()).post('/tenants/me/verify-checkout').send({ sessionId: 'cs_1' });
    expect(res.body).toEqual({ status: 'ready' });
    expect(a.invalidateStatusMock).toHaveBeenCalledWith('t1');
  });

  it('rejects a session belonging to another tenant', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ status: 'pending' }] });
    a.stripeRetrieveMock.mockResolvedValue({ metadata: { tenantId: 'other' }, payment_status: 'paid', status: 'complete' });
    expect((await request(app()).post('/tenants/me/verify-checkout').send({ sessionId: 'cs_1' })).status).toBe(403);
  });

  it('provisions and returns ready when payment is complete', async () => {
    a.clientQueryMock.mockResolvedValue({ rows: [{ status: 'pending' }] });
    a.stripeRetrieveMock.mockResolvedValue({
      metadata: { tenantId: 't1', plan: 'starter' }, payment_status: 'paid', status: 'complete', customer: 'cus_1', subscription: 'sub_1',
    });
    const res = await request(app()).post('/tenants/me/verify-checkout').send({ sessionId: 'cs_1' });
    expect(res.body).toEqual({ status: 'ready' });
    expect(a.provisionTenantMock).toHaveBeenCalledWith('t1', 'u1', 'starter');
  });
});

describe('static lookups', () => {
  it('GET /agent-types', async () => {
    expect((await request(app()).get('/agent-types')).body.agentTypes).toEqual([{ key: 'dental' }]);
  });
  it('GET /tenants/me/supported-currencies', async () => {
    expect((await request(app()).get('/tenants/me/supported-currencies')).body.currencies).toHaveLength(2);
  });
});

describe('PATCH /tenants/me', () => {
  it('rejects an invalid timezone', async () => {
    const res = await request(app()).patch('/tenants/me').send({ timezone: 'Mars/Phobos' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean smsAlertsDisabled', async () => {
    expect((await request(app()).patch('/tenants/me').send({ smsAlertsDisabled: 'yes' })).status).toBe(400);
  });

  it('rejects a malformed billingCurrency', async () => {
    expect((await request(app()).patch('/tenants/me').send({ billingCurrency: 'dollars' })).status).toBe(400);
  });

  it('updates the tenant name', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE tenants') ? { rows: [{ id: 't1', name: 'New Name' }] } : { rows: [] },
    );
    const res = await request(app()).patch('/tenants/me').send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({ name: 'New Name' });
  });

  it('audits a billing-currency change and invalidates the cache', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT COALESCE(billing_currency')) return { rows: [{ billing_currency: 'usd' }] };
      if (sql.includes('UPDATE tenants')) return { rows: [{ id: 't1', billing_currency: 'eur' }] };
      return { rows: [] };
    });
    const res = await request(app()).patch('/tenants/me').send({ billingCurrency: 'EUR' });
    expect(res.status).toBe(200);
    expect(a.invalidateCurrencyMock).toHaveBeenCalledWith('t1');
    expect(a.writeAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'tenant.billing_currency_changed' }));
  });

  it('rejects an unsupported (but well-formed) currency change with 400', async () => {
    a.isSupportedCurrencyMock.mockReturnValue(false);
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT COALESCE(billing_currency') ? { rows: [{ billing_currency: 'usd' }] } : { rows: [] },
    );
    const res = await request(app()).patch('/tenants/me').send({ billingCurrency: 'xyz' });
    expect(res.status).toBe(400);
    expect(res.body.supported).toBeTruthy();
  });
});

describe('activation & tooltips', () => {
  it('GET /tenants/me/activation', async () => {
    a.getActivationMilestonesMock.mockResolvedValue([{ id: 'm1' }]);
    expect((await request(app()).get('/tenants/me/activation')).body.milestones).toHaveLength(1);
  });

  it('GET /tenants/me/tooltips', async () => {
    a.getDismissedTooltipsMock.mockResolvedValue(['welcome']);
    expect((await request(app()).get('/tenants/me/tooltips')).body.dismissed).toEqual(['welcome']);
  });

  it('POST dismiss requires a tooltipKey', async () => {
    expect((await request(app()).post('/tenants/me/tooltips/dismiss').send({})).status).toBe(400);
  });

  it('POST dismiss records the dismissal', async () => {
    const res = await request(app()).post('/tenants/me/tooltips/dismiss').send({ tooltipKey: 'welcome' });
    expect(res.body).toEqual({ success: true });
    expect(a.dismissTooltipMock).toHaveBeenCalledWith('u1', 'welcome');
  });
});
