import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  withPrivilegedClientMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({ withPrivilegedClient: a.withPrivilegedClientMock }));

import router from './platformIntegrationsStatus';

function app() {
  const app = express();
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  // loadTenantDemand runs 3 queries; an empty result is fine (route still 200s).
  a.withPrivilegedClientMock.mockReset().mockImplementation(async (cb: (c: unknown) => Promise<unknown>) =>
    cb({ query: async () => ({ rows: [] }) }),
  );
});
afterEach(() => {
  delete process.env.HUBSPOT_CLIENT_ID;
  delete process.env.HUBSPOT_CLIENT_SECRET;
});

describe('GET /platform/integrations-status', () => {
  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/integrations-status')).status).toBe(403);
  });

  it('reports a provider as configured when its required env is present', async () => {
    process.env.HUBSPOT_CLIENT_ID = 'id';
    process.env.HUBSPOT_CLIENT_SECRET = 'secret';
    const res = await request(app()).get('/platform/integrations-status');
    expect(res.status).toBe(200);
    const hubspot = res.body.providers.find((p: { provider: string }) => p.provider === 'hubspot');
    expect(hubspot.configured).toBe(true);
    expect(hubspot.missingEnv).toEqual([]);
    expect(res.body.summary.configured).toBeGreaterThanOrEqual(1);
  });

  it('reports missing env for an unconfigured provider', async () => {
    const res = await request(app()).get('/platform/integrations-status');
    const sf = res.body.providers.find((p: { provider: string }) => p.provider === 'salesforce');
    expect(sf.configured).toBe(false);
    expect(sf.missingEnv.length).toBeGreaterThan(0);
    expect(res.body.summary.missing).toBeGreaterThanOrEqual(1);
  });

  it('still responds when the demand query layer fails (best-effort)', async () => {
    a.withPrivilegedClientMock.mockRejectedValue(new Error('db down'));
    const res = await request(app()).get('/platform/integrations-status');
    expect(res.status).toBe(200);
    expect(res.body.providers.length).toBeGreaterThan(0);
  });
});
