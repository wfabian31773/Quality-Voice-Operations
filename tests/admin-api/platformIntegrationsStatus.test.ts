/**
 * Route-level coverage for `GET /platform/integrations-status`.
 *
 * The endpoint reports each OAuth provider's credential status and adds
 * per-provider tenant demand counts so platform admins can prioritise
 * the integrations they need to wire up. Demand is aggregated from:
 *
 *   - `integrations.tenant_id` grouped by `provider` (`is_enabled` filter
 *     for the "enabled" subtotal, full count for "total")
 *   - `audit_logs(action='connector.oauth_connected')` grouped by
 *     `resource_id` (lifetime "attempted" count)
 *
 * We mount the real router with stubbed auth/RBAC middleware and
 * intercept the privileged DB client so we can assert the SQL shape and
 * the response body the platform admin UI consumes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  withPrivilegedClient: async (
    fn: (client: { query: typeof queryMock }) => Promise<unknown>,
  ) => fn({ query: queryMock }),
  getPlatformPool: vi.fn(),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'admin-1',
      tenantId: 'platform',
      email: 'ops@acme.test',
      role: 'platform_admin',
      isPlatformAdmin: true,
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const ENV_KEYS = [
  'HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET',
  'SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET', 'SALESFORCE_LOGIN_URL',
  'PIPEDRIVE_CLIENT_ID', 'PIPEDRIVE_CLIENT_SECRET',
  'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT_ID',
  'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET',
  'QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET', 'QUICKBOOKS_ENV',
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  queryMock.mockReset();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const router = (await import('../../server/admin-api/routes/platformIntegrationsStatus')).default;
  app.use(router);
  return app;
}

interface IntegrationsStatusBody {
  providers: Array<{
    provider: string;
    connectorProvider: string;
    label: string;
    category: string;
    configured: boolean;
    requiredEnv: string[];
    missingEnv: string[];
    optionalEnv: Array<{ name: string; set: boolean }>;
    docsUrl: string;
    enabledTenantCount: number;
    totalTenantCount: number;
    attemptedTenantCount: number;
  }>;
  summary: { total: number; configured: number; missing: number; blockedTenantDemand: number };
}

describe('GET /platform/integrations-status', () => {
  it('reports configured providers and aggregates per-provider tenant demand', async () => {
    process.env.HUBSPOT_CLIENT_ID = 'hub-id';
    process.env.HUBSPOT_CLIENT_SECRET = 'hub-secret';
    process.env.GOOGLE_CLIENT_ID = 'g-id';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';

    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FROM integrations')) {
        return {
          rows: [
            { provider: 'hubspot', enabled_tenants: '5', total_tenants: '7' },
            { provider: 'salesforce', enabled_tenants: '0', total_tenants: '3' },
            { provider: 'google-calendar', enabled_tenants: '2', total_tenants: '2' },
          ],
        };
      }
      if (text.includes('FROM audit_logs')) {
        return {
          rows: [
            { provider: 'hubspot', attempted_tenants: '9' },
            { provider: 'salesforce', attempted_tenants: '4' },
            { provider: 'pipedrive', attempted_tenants: '1' },
          ],
        };
      }
      return { rows: [] };
    });

    const app = await buildApp();
    const res = await request(app).get('/platform/integrations-status');
    expect(res.status).toBe(200);
    const body = res.body as IntegrationsStatusBody;

    const byProvider = Object.fromEntries(body.providers.map((p) => [p.provider, p]));

    expect(byProvider['hubspot'].configured).toBe(true);
    expect(byProvider['hubspot'].missingEnv).toEqual([]);
    expect(byProvider['hubspot'].enabledTenantCount).toBe(5);
    expect(byProvider['hubspot'].totalTenantCount).toBe(7);
    expect(byProvider['hubspot'].attemptedTenantCount).toBe(9);

    expect(byProvider['google-calendar'].configured).toBe(true);
    expect(byProvider['google-calendar'].enabledTenantCount).toBe(2);
    expect(byProvider['google-calendar'].attemptedTenantCount).toBe(0);

    expect(byProvider['salesforce'].configured).toBe(false);
    expect(byProvider['salesforce'].missingEnv).toEqual([
      'SALESFORCE_CLIENT_ID',
      'SALESFORCE_CLIENT_SECRET',
    ]);
    expect(byProvider['salesforce'].enabledTenantCount).toBe(0);
    expect(byProvider['salesforce'].totalTenantCount).toBe(3);
    expect(byProvider['salesforce'].attemptedTenantCount).toBe(4);

    expect(byProvider['pipedrive'].configured).toBe(false);
    expect(byProvider['pipedrive'].enabledTenantCount).toBe(0);
    expect(byProvider['pipedrive'].attemptedTenantCount).toBe(1);

    expect(byProvider['zoho']).toBeDefined();
    expect(byProvider['zoho'].configured).toBe(false);
    expect(byProvider['zoho'].enabledTenantCount).toBe(0);
    expect(byProvider['zoho'].attemptedTenantCount).toBe(0);

    expect(body.summary.total).toBe(body.providers.length);
    expect(body.summary.configured).toBe(2);
    expect(body.summary.missing).toBe(body.providers.length - 2);
    // blockedTenantDemand sums max(enabled, attempted) across UN-configured providers:
    //   salesforce: max(0, 4) = 4
    //   pipedrive:  max(0, 1) = 1
    //   others:     0
    expect(body.summary.blockedTenantDemand).toBe(5);
  });

  it('falls back to zero counts and continues serving when the demand query fails', async () => {
    queryMock.mockRejectedValue(new Error('db down'));

    const app = await buildApp();
    const res = await request(app).get('/platform/integrations-status');
    expect(res.status).toBe(200);
    const body = res.body as IntegrationsStatusBody;
    expect(body.providers.length).toBeGreaterThan(0);
    for (const p of body.providers) {
      expect(p.enabledTenantCount).toBe(0);
      expect(p.totalTenantCount).toBe(0);
      expect(p.attemptedTenantCount).toBe(0);
    }
    expect(body.summary.blockedTenantDemand).toBe(0);
  });

  it('issues both the integrations and audit_logs aggregations with the expected shape', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const app = await buildApp();
    await request(app).get('/platform/integrations-status');

    const sqlTexts = queryMock.mock.calls.map((c) => String(c[0]));
    const integrationsCall = sqlTexts.find((s) => s.includes('FROM integrations'));
    const auditCall = sqlTexts.find((s) => s.includes('FROM audit_logs'));
    expect(integrationsCall).toBeDefined();
    expect(auditCall).toBeDefined();
    expect(integrationsCall!).toContain('GROUP BY provider');
    expect(integrationsCall!).toContain("FILTER (WHERE is_enabled = true)");
    expect(auditCall!).toContain("action = 'connector.oauth_connected'");
    expect(auditCall!).toContain('GROUP BY resource_id');
  });
});
