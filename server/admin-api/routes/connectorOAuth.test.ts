import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  writeAuditLogMock: vi.fn(),
  upsertConnectorMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
// requireRole from ../middleware/rbac stays real (operations_manager satisfies 'manager').
vi.mock('../middleware/security', () => ({
  isProductionLike: () => false,
  oauthStateCookieOptions: () => ({ httpOnly: true }),
}));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: a.writeAuditLogMock, extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/integrations/connectors', () => ({ upsertConnector: a.upsertConnectorMock }));
vi.mock('../../../platform/integrations/connectors/zohoRegion', () => ({
  resolveZohoAccountsServer: () => 'https://accounts.zoho.com',
  resolveZohoApiDomain: () => 'https://www.zohoapis.com',
}));

import router from './connectorOAuth';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const ENV_KEYS = ['HUBSPOT_CLIENT_ID', 'GOOGLE_CLIENT_ID', 'SLACK_CLIENT_ID'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.writeAuditLogMock.mockReset().mockResolvedValue(undefined);
  a.upsertConnectorMock.mockReset().mockResolvedValue({ id: 'c1' });
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('GET /connectors/oauth/availability', () => {
  it('reports per-provider availability', async () => {
    const res = await request(app()).get('/connectors/oauth/availability');
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveProperty('hubspot');
  });
});

describe('provider init handlers', () => {
  it('rejects a viewer via the manager role gate', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).get('/connectors/oauth/hubspot/init')).status).toBe(403);
  });
  it('returns 400 OAUTH_NOT_CONFIGURED when the client id is missing', async () => {
    const res = await request(app()).get('/connectors/oauth/hubspot/init');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OAUTH_NOT_CONFIGURED');
  });
  it('returns an auth URL when HubSpot is configured', async () => {
    process.env.HUBSPOT_CLIENT_ID = 'hs-client';
    const res = await request(app()).get('/connectors/oauth/hubspot/init');
    expect(res.status).toBe(200);
    expect(res.body.authUrl).toContain('app.hubspot.com');
    expect(res.body).toHaveProperty('redirectUri');
  });
  it('returns an auth URL when Google is configured', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-client';
    const res = await request(app()).get('/connectors/oauth/google/init');
    expect(res.status).toBe(200);
    expect(res.body.authUrl).toContain('accounts.google.com');
  });
  it('returns an auth URL when Slack is configured', async () => {
    process.env.SLACK_CLIENT_ID = 'sl-client';
    const res = await request(app()).get('/connectors/oauth/slack/init');
    expect(res.status).toBe(200);
    expect(res.body.authUrl).toContain('slack.com');
  });
});

describe('provider callback handlers', () => {
  it('hubspot callback rejects a missing code/state', async () => {
    expect((await request(app()).get('/connectors/oauth/hubspot/callback')).status).toBe(400);
  });
  it('google callback rejects a missing code/state', async () => {
    expect((await request(app()).get('/connectors/oauth/google/callback')).status).toBe(400);
  });
});
