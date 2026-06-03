import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Stub the public-API auth/scope/rate-limit middleware to pass-through and
// inject a user; mock the composed handlers borrowed from calls.ts/campaigns.ts.
// The real rbac requireRole gate is kept so the write-route role check runs.
const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  listCallsHandler: vi.fn((_req, res) => res.json({ route: 'listCalls' })),
  getCallHandler: vi.fn((_req, res) => res.json({ route: 'getCall' })),
  listCampaignsHandler: vi.fn((_req, res) => res.json({ route: 'listCampaigns' })),
  getCampaignMetricsHandler: vi.fn((_req, res) => res.json({ route: 'campaignMetrics' })),
  addContactsHandler: vi.fn((_req, res) => res.json({ route: 'addContacts' })),
}));

vi.mock('../middleware/auth', () => ({ requireAuth: (_r: unknown, _s: unknown, n: () => void) => n() }));
vi.mock('../middleware/apiKeyAuth', () => ({
  requireApiKeyOrJwt: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../middleware/apiKeyScope', () => ({
  requireApiKeyPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('./calls', () => ({ listCallsHandler: a.listCallsHandler, getCallHandler: a.getCallHandler }));
vi.mock('./campaigns', () => ({
  listCampaignsHandler: a.listCampaignsHandler,
  getCampaignMetricsHandler: a.getCampaignMetricsHandler,
  addContactsHandler: a.addContactsHandler,
}));

import publicApiRouter from './publicApi';

function app() {
  const app = express();
  app.use(express.json());
  app.use(publicApiRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  for (const v of Object.values(a)) if (typeof v === 'function' && 'mockClear' in v) (v as ReturnType<typeof vi.fn>).mockClear();
});

describe('public API v1 read routes', () => {
  it('routes GET /api/v1/calls to the calls list handler', async () => {
    const res = await request(app()).get('/api/v1/calls');
    expect(res.body).toEqual({ route: 'listCalls' });
    expect(a.listCallsHandler).toHaveBeenCalled();
  });

  it('routes GET /api/v1/calls/:id to the get-call handler', async () => {
    expect((await request(app()).get('/api/v1/calls/c1')).body).toEqual({ route: 'getCall' });
  });

  it('routes GET /api/v1/campaigns to the campaigns list handler', async () => {
    expect((await request(app()).get('/api/v1/campaigns')).body).toEqual({ route: 'listCampaigns' });
  });

  it('routes GET /api/v1/campaigns/:id/analytics to the metrics handler', async () => {
    expect((await request(app()).get('/api/v1/campaigns/c1/analytics')).body).toEqual({ route: 'campaignMetrics' });
  });
});

describe('public API v1 write route', () => {
  it('allows a manager to add contacts', async () => {
    const res = await request(app()).post('/api/v1/campaigns/c1/contacts').send({ contacts: [] });
    expect(res.body).toEqual({ route: 'addContacts' });
    expect(a.addContactsHandler).toHaveBeenCalled();
  });

  it('blocks a viewer from the write route via the real rbac gate', async () => {
    a.user.role = 'support_reviewer';
    const res = await request(app()).post('/api/v1/campaigns/c1/contacts').send({ contacts: [] });
    expect(res.status).toBe(403);
    expect(a.addContactsHandler).not.toHaveBeenCalled();
  });
});
