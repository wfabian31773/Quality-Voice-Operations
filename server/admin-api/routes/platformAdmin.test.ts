import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: true },
  privQueryMock: vi.fn(),
  poolQueryMock: vi.fn(),
  listLeadsMock: vi.fn(),
  getSalesAlertSettingsMock: vi.fn(),
  getDemoSchedulerSettingsMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
// requirePlatformAdmin from ../middleware/rbac stays real.
vi.mock('../../../platform/db', () => ({
  withPrivilegedClient: async (cb: (c: unknown) => Promise<unknown>) => cb({ query: a.privQueryMock }),
  getPlatformPool: () => ({ query: a.poolQueryMock }),
}));
vi.mock('../../../platform/activation/ActivationService', () => ({ getAllTenantsActivationMetrics: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../platform/analytics', () => ({ getCallAnalytics: vi.fn(), getCampaignAnalytics: vi.fn(), getCostAnalytics: vi.fn() }));
vi.mock('../../../platform/campaigns/CampaignService', () => ({ getCampaign: vi.fn(), getCampaignMetrics: vi.fn(), listContacts: vi.fn() }));
vi.mock('../../../platform/core/phi/redact', () => ({ redactPHI: (s: string) => s }));
vi.mock('../../../platform/billing/cost', () => ({ getConversationCost: vi.fn() }));
vi.mock('../../../platform/billing/tenantCurrency', () => ({ getTenantBillingCurrency: vi.fn().mockResolvedValue('usd') }));
vi.mock('../../../platform/billing/stripe/plans', () => ({ PLAN_MONTHLY_PRICE_CENTS: {}, }));
vi.mock('../../../platform/billing/PlanRecommendationDigestScheduler', () => ({ PLAN_RECOMMENDATION_AUDIT_ACTION: 'plan.recommended' }));
vi.mock('../../../shared/billing/planCatalog', () => ({ PLAN_CATALOG: {} }));
vi.mock('../../../platform/tools/ToolExecutionService', () => ({ listToolExecutions: vi.fn() }));
vi.mock('../services/marketing-leads', () => ({
  iterateLeadsForExport: vi.fn(),
  listLeads: a.listLeadsMock,
  listLeadEvents: vi.fn(),
  listLeadEventAuthors: vi.fn(),
  updateLeadStatus: vi.fn(),
  sendAlertMessage: vi.fn(),
}));
vi.mock('../services/sales-alert-settings', () => ({
  getSalesAlertSettings: a.getSalesAlertSettingsMock,
  setSalesAlertSettings: vi.fn(),
}));
vi.mock('../services/demo-scheduler-settings', () => ({
  getDemoSchedulerSettings: a.getDemoSchedulerSettingsMock,
  setDemoSchedulerSettings: vi.fn(),
  toAdminView: (s: unknown) => s,
  DemoSchedulerSettingsValidationError: class extends Error {},
}));

import router from './platformAdmin';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.privQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.listLeadsMock.mockReset().mockResolvedValue({ leads: [], total: 0, counts: {} });
  a.getSalesAlertSettingsMock.mockReset().mockResolvedValue({ email: null });
  a.getDemoSchedulerSettingsMock.mockReset().mockResolvedValue({ provider: 'calcom' });
});

describe('platform-admin gate', () => {
  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/tenants')).status).toBe(403);
  });
});

describe('GET /platform/tenants', () => {
  it('lists tenants', async () => {
    a.privQueryMock.mockResolvedValue({ rows: [{ id: 't1', name: 'Acme' }] });
    const res = await request(app()).get('/platform/tenants');
    expect(res.status).toBe(200);
    expect(res.body.tenants[0]).toMatchObject({ id: 't1' });
  });
  it('500 on a query failure', async () => {
    a.privQueryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/platform/tenants')).status).toBe(500);
  });
});

describe('GET /platform/stats', () => {
  it('returns aggregated platform stats', async () => {
    a.privQueryMock.mockResolvedValue({ rows: [{ active_tenants: 2, total_tenants: 3 }] });
    const res = await request(app()).get('/platform/stats');
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ active_tenants: 2 });
  });
});

describe('GET /platform/tenants/:id', () => {
  it('404 when the tenant is missing', async () => {
    a.privQueryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/platform/tenants/t9')).status).toBe(404);
  });
  it('returns tenant details', async () => {
    a.privQueryMock.mockResolvedValue({ rows: [{ id: 't1', name: 'Acme' }] });
    expect((await request(app()).get('/platform/tenants/t1')).body.tenant).toMatchObject({ id: 't1' });
  });
});

describe('GET /platform/marketing-leads', () => {
  it('lists marketing leads', async () => {
    a.listLeadsMock.mockResolvedValue({ leads: [{ id: 'l1' }], total: 1, counts: { open: 1 } });
    const res = await request(app()).get('/platform/marketing-leads');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
  it('500 on a service failure', async () => {
    a.listLeadsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/platform/marketing-leads')).status).toBe(500);
  });
});

describe('settings reads', () => {
  it('returns sales-alert settings with env fallbacks', async () => {
    const res = await request(app()).get('/platform/sales-alert-settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('settings');
    expect(res.body).toHaveProperty('fallbacks');
  });
  it('returns demo-scheduler settings', async () => {
    const res = await request(app()).get('/platform/demo-scheduler-settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('settings');
  });
});

describe('GET /platform/notifications', () => {
  it('lists notifications for the user', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ id: 'n1', title: 'Hi' }] });
    const res = await request(app()).get('/platform/notifications');
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
  });
});
