/**
 * Route-level coverage for `GET /connectors/alerts`.
 *
 * The endpoint collapses fanned-out per-user `tenant_notifications` rows
 * back into a single alert event keyed by `(integrationId, type, minute)`,
 * scopes to the caller's tenant, paginates, and joins to `integrations` so
 * each alert carries the connector's display name.
 *
 * We mount the real router with a stub `requireAuth` middleware and
 * intercept every DB call via the shared platform pool mock so we can
 * assert both the SQL shape (tenant scoping, GROUP BY by minute, LIMIT/
 * OFFSET, integration name join) and the response body the UI consumes.
 *
 * Top-level imports in the route file (connector adapters, audit log,
 * etc.) are mocked away because the alerts handler only needs the auth
 * middleware and the dynamically-imported platform pool to function.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  withPrivilegedClient: vi.fn(),
}));

// --------------------------------------------------------------------------
// Stub every other top-level import the connectors route file pulls in.
// The alerts handler only uses the auth middleware + the dynamic db import.
// --------------------------------------------------------------------------

vi.mock('../../platform/integrations/connectors', () => ({
  listConnectorConfigs: vi.fn(),
  upsertConnector: vi.fn(),
  deleteConnector: vi.fn(),
  getConnectorById: vi.fn(),
  getConnectorConfig: vi.fn(),
  connectorService: {},
}));

vi.mock('../../platform/integrations/connectors/adapters/salesforce', () => ({
  fetchSalesforceTaskPicklists: vi.fn(),
}));
vi.mock('../../platform/integrations/connectors/adapters/hubspot', () => ({
  fetchHubSpotDealPipelines: vi.fn(),
}));
vi.mock('../../platform/integrations/connectors/adapters/pipedrive', () => ({
  fetchPipedrivePipelinesAndStages: vi.fn(),
}));
vi.mock('../../platform/integrations/connectors/adapters/google-calendar', () => ({
  fetchGoogleCalendarList: vi.fn(),
}));
vi.mock('../../platform/integrations/connectors/adapters/outlook-calendar', () => ({
  fetchOutlookCalendarList: vi.fn(),
}));
vi.mock('../../platform/integrations/connectors/zohoRegion', () => ({
  resolveZohoApiDomain: vi.fn(),
  resolveZohoAccountsServer: vi.fn(),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () =>
    (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Stub auth middleware. Tests can override the injected user via the
// `x-test-user` header (parsed as JSON) so we can verify cross-tenant
// isolation without juggling JWT signing.
vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    const headerUser = req.headers['x-test-user'];
    if (headerUser) {
      req.user = JSON.parse(String(headerUser));
    } else {
      req.user = {
        userId: 'user-1',
        tenantId: 'tenant-A',
        email: 'owner@acme.test',
        role: 'tenant_owner',
        isPlatformAdmin: false,
      };
    }
    next();
  },
}));

beforeEach(() => {
  queryMock.mockReset();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const router = (await import('../../server/admin-api/routes/connectors')).default;
  app.use(router);
  return app;
}

// Helper: dispatch query results based on which SQL the handler is running.
//
//   - The COUNT(*) total query starts with `\n      SELECT COUNT(*)::bigint`.
//   - The grouped row query starts with `\n      SELECT\n        metadata->>...`.
//   - The integration-name lookup is `SELECT id, name FROM integrations`.
//
// Tests pass in the rows + the expected total; the helper hands the right
// payload to each call so we can also assert the SQL shape (tenant scoping,
// GROUP BY by minute, LIMIT/OFFSET).
type QueryDispatch = {
  total: number;
  rows: Array<Record<string, unknown>>;
  names?: Array<{ id: string; name: string | null }>;
};
function installQueryDispatcher(dispatch: QueryDispatch): void {
  queryMock.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('COUNT(*)::bigint AS total')) {
      return { rows: [{ total: String(dispatch.total) }] };
    }
    if (text.includes('AS in_app_recipients')) {
      return { rows: dispatch.rows };
    }
    if (text.includes('FROM integrations')) {
      return { rows: dispatch.names ?? [] };
    }
    return { rows: [] };
  });
}

describe('GET /connectors/alerts', () => {
  it('collapses 3 fanned-out per-user rows into a single alert with inAppRecipientCount=3', async () => {
    // The DB does the GROUP BY; we simulate the post-aggregation row shape
    // (one row per (integrationId, type, minute) bucket with COUNT(*) as
    // in_app_recipients) and assert the route maps it 1:1 to the response.
    const createdAt = new Date('2026-04-26T18:30:00.000Z');
    const meta = {
      integrationId: 'int-1',
      provider: 'salesforce',
      connectorType: 'crm',
      errorMessage: 'API rate limit',
      firstFailedAt: '2026-04-26T17:45:00.000Z',
      outageMinutes: 45,
      // recipientCount/emailRecipientCount are the EMAIL audience size at
      // dispatch time (different from the in-app fan-out count).
      recipientCount: 2,
      emailRecipientCount: 2,
    };
    installQueryDispatcher({
      total: 1,
      rows: [
        {
          integration_id: 'int-1',
          type: 'integration',
          created_at: createdAt,
          in_app_recipients: 3,
          metadata: meta,
          title: 'Salesforce integration is failing',
          message: 'Latest sync failed.',
        },
      ],
      names: [{ id: 'int-1', name: 'Salesforce - Production' }],
    });

    const app = await buildApp();
    const res = await request(app).get('/connectors/alerts');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alerts).toHaveLength(1);
    const alert = res.body.alerts[0];
    expect(alert.integrationId).toBe('int-1');
    // The display-name JOIN actually populated integrationName.
    expect(alert.integrationName).toBe('Salesforce - Production');
    expect(alert.provider).toBe('salesforce');
    expect(alert.connectorType).toBe('crm');
    // 3 fan-out rows -> inAppRecipientCount=3.
    expect(alert.inAppRecipientCount).toBe(3);
    // Email recipient count comes from metadata, not the in-app fan-out.
    expect(alert.recipientCount).toBe(2);
    expect(alert.outageMinutes).toBe(45);
    expect(alert.firstFailedAt).toBe('2026-04-26T17:45:00.000Z');
    expect(alert.errorMessage).toBe('API rate limit');
    expect(alert.channel).toBe('email');
    expect(alert.createdAt).toBe(createdAt.toISOString());

    // SQL shape assertions: every alert query must scope by tenant_id and
    // group by minute so different fan-outs in the same minute don't bleed
    // into each other across tenants.
    const totalCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('COUNT(*)::bigint AS total'),
    );
    expect(totalCall).toBeDefined();
    expect(String(totalCall![0])).toContain('tenant_id = $1');
    expect((totalCall![1] as unknown[])[0]).toBe('tenant-A');

    const rowsCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('AS in_app_recipients'),
    );
    expect(rowsCall).toBeDefined();
    const rowsSql = String(rowsCall![0]);
    expect(rowsSql).toContain('tenant_id = $1');
    expect(rowsSql).toContain("date_trunc('minute', created_at)");
    expect(rowsSql).toContain("type IN ('integration', 'integration_sms')");
    expect((rowsCall![1] as unknown[])[0]).toBe('tenant-A');
  });

  it('falls back to the in-app fan-out count when older alerts have no recipientCount in metadata', async () => {
    // Pre-enrichment alerts persisted no recipientCount/emailRecipientCount,
    // so the route must fall back to the COUNT(*) of in-app rows so the UI
    // doesn't show "0 recipients" for historical events.
    installQueryDispatcher({
      total: 1,
      rows: [
        {
          integration_id: 'int-old',
          type: 'integration',
          created_at: new Date('2026-04-01T12:00:00.000Z'),
          in_app_recipients: 4,
          metadata: { integrationId: 'int-old', provider: 'hubspot' },
          title: 'HubSpot down',
          message: 'msg',
        },
      ],
      names: [],
    });

    const app = await buildApp();
    const res = await request(app).get('/connectors/alerts');

    expect(res.status).toBe(200);
    const alert = res.body.alerts[0];
    expect(alert.recipientCount).toBe(4);
    expect(alert.inAppRecipientCount).toBe(4);
    // outageMinutes/firstFailedAt absent from old metadata -> null.
    expect(alert.outageMinutes).toBeNull();
    expect(alert.firstFailedAt).toBeNull();
    // Integration name JOIN found nothing -> null (not undefined).
    expect(alert.integrationName).toBeNull();
  });

  it('reports type=integration_sms rows with channel=sms', async () => {
    installQueryDispatcher({
      total: 1,
      rows: [
        {
          integration_id: 'int-1',
          type: 'integration_sms',
          created_at: new Date('2026-04-26T18:30:00.000Z'),
          in_app_recipients: 2,
          metadata: {
            integrationId: 'int-1',
            provider: 'salesforce',
            smsAttempted: 2,
            smsSucceeded: 1,
            twilioConfigured: true,
            recipientCount: 2,
          },
          title: 'SMS dispatched',
          message: 'msg',
        },
      ],
    });

    const app = await buildApp();
    const res = await request(app).get('/connectors/alerts');

    expect(res.status).toBe(200);
    const alert = res.body.alerts[0];
    expect(alert.type).toBe('integration_sms');
    expect(alert.channel).toBe('sms');
    expect(alert.smsAttempted).toBe(2);
    expect(alert.smsSucceeded).toBe(1);
    expect(alert.twilioConfigured).toBe(true);
  });

  it('scopes results by tenant: a different tenant sees only its own alerts', async () => {
    // We "store" two tenants' alerts in our mock by branching on the
    // tenantId param ($1). If the route ever drops the tenant_id WHERE
    // clause, both tenants would see each other's rows.
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      const text = String(sql);
      const tenantParam = params[0];
      if (text.includes('COUNT(*)::bigint AS total')) {
        return {
          rows: [{ total: tenantParam === 'tenant-A' ? '1' : '2' }],
        };
      }
      if (text.includes('AS in_app_recipients')) {
        if (tenantParam === 'tenant-A') {
          return {
            rows: [
              {
                integration_id: 'int-A',
                type: 'integration',
                created_at: new Date('2026-04-26T18:00:00.000Z'),
                in_app_recipients: 1,
                metadata: { integrationId: 'int-A', provider: 'salesforce' },
                title: 'A',
                message: 'm',
              },
            ],
          };
        }
        return {
          rows: [
            {
              integration_id: 'int-B1',
              type: 'integration',
              created_at: new Date('2026-04-26T19:00:00.000Z'),
              in_app_recipients: 1,
              metadata: { integrationId: 'int-B1', provider: 'hubspot' },
              title: 'B1',
              message: 'm',
            },
            {
              integration_id: 'int-B2',
              type: 'integration',
              created_at: new Date('2026-04-26T20:00:00.000Z'),
              in_app_recipients: 1,
              metadata: { integrationId: 'int-B2', provider: 'hubspot' },
              title: 'B2',
              message: 'm',
            },
          ],
        };
      }
      if (text.includes('FROM integrations')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const app = await buildApp();
    const tenantAUser = JSON.stringify({
      userId: 'u-A',
      tenantId: 'tenant-A',
      email: 'a@a.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    });
    const tenantBUser = JSON.stringify({
      userId: 'u-B',
      tenantId: 'tenant-B',
      email: 'b@b.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    });

    const resA = await request(app)
      .get('/connectors/alerts')
      .set('x-test-user', tenantAUser);
    const resB = await request(app)
      .get('/connectors/alerts')
      .set('x-test-user', tenantBUser);

    expect(resA.status).toBe(200);
    expect(resA.body.total).toBe(1);
    expect(resA.body.alerts).toHaveLength(1);
    expect(resA.body.alerts[0].integrationId).toBe('int-A');

    expect(resB.status).toBe(200);
    expect(resB.body.total).toBe(2);
    expect(resB.body.alerts.map((a: { integrationId: string }) => a.integrationId))
      .toEqual(expect.arrayContaining(['int-B1', 'int-B2']));
    // Tenant-B never sees tenant-A's int-A alert.
    expect(resB.body.alerts.find((a: { integrationId: string }) => a.integrationId === 'int-A'))
      .toBeUndefined();

    // Every DB call must have carried the requesting tenant's ID as $1.
    for (const call of queryMock.mock.calls) {
      const params = call[1] as unknown[];
      expect(params[0] === 'tenant-A' || params[0] === 'tenant-B').toBe(true);
    }
  });

  it('paginates: page=2&limit=5 passes (5,5) as LIMIT/OFFSET and echoes them in the response', async () => {
    installQueryDispatcher({ total: 17, rows: [] });

    const app = await buildApp();
    const res = await request(app).get('/connectors/alerts?page=2&limit=5');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(17);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(5);

    const rowsCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('AS in_app_recipients'),
    );
    expect(rowsCall).toBeDefined();
    const params = rowsCall![1] as unknown[];
    // tenantId is $1; LIMIT/OFFSET are appended at the end.
    expect(params[0]).toBe('tenant-A');
    expect(params[params.length - 2]).toBe(5); // LIMIT
    expect(params[params.length - 1]).toBe(5); // OFFSET
    const sql = String(rowsCall![0]);
    expect(sql).toMatch(/LIMIT\s+\$\d+\s+OFFSET\s+\$\d+/);
  });

  it('caps limit at 100 even when the caller asks for more', async () => {
    installQueryDispatcher({ total: 0, rows: [] });

    const app = await buildApp();
    const res = await request(app).get('/connectors/alerts?limit=999');

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);

    const rowsCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('AS in_app_recipients'),
    );
    const params = rowsCall![1] as unknown[];
    expect(params[params.length - 2]).toBe(100);
    expect(params[params.length - 1]).toBe(0);
  });

  it('joins to integrations to populate integrationName for each alert', async () => {
    installQueryDispatcher({
      total: 2,
      rows: [
        {
          integration_id: 'int-1',
          type: 'integration',
          created_at: new Date('2026-04-26T18:00:00.000Z'),
          in_app_recipients: 1,
          metadata: { integrationId: 'int-1', provider: 'salesforce' },
          title: 't',
          message: 'm',
        },
        {
          integration_id: 'int-2',
          type: 'integration_sms',
          created_at: new Date('2026-04-26T18:05:00.000Z'),
          in_app_recipients: 2,
          metadata: { integrationId: 'int-2', provider: 'hubspot' },
          title: 't',
          message: 'm',
        },
      ],
      names: [
        { id: 'int-1', name: 'Salesforce Sandbox' },
        { id: 'int-2', name: 'HubSpot Marketing' },
      ],
    });

    const app = await buildApp();
    const res = await request(app).get('/connectors/alerts');

    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(2);
    const byId = Object.fromEntries(
      res.body.alerts.map((a: { integrationId: string; integrationName: string | null }) => [
        a.integrationId,
        a.integrationName,
      ]),
    );
    expect(byId['int-1']).toBe('Salesforce Sandbox');
    expect(byId['int-2']).toBe('HubSpot Marketing');

    // The name lookup query must scope by tenant_id AND restrict to the
    // collected integration IDs (not a tenant-wide scan).
    const nameCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('FROM integrations'),
    );
    expect(nameCall).toBeDefined();
    const sql = String(nameCall![0]);
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toContain('id = ANY($2::text[])');
    const params = nameCall![1] as unknown[];
    expect(params[0]).toBe('tenant-A');
    expect(params[1]).toEqual(expect.arrayContaining(['int-1', 'int-2']));
  });

  it('applies the integrationId query filter so admins can drill into a single connector', async () => {
    installQueryDispatcher({ total: 0, rows: [] });

    const app = await buildApp();
    const res = await request(app).get('/connectors/alerts?integrationId=int-XYZ');
    expect(res.status).toBe(200);

    const rowsCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('AS in_app_recipients'),
    );
    expect(rowsCall).toBeDefined();
    const params = rowsCall![1] as unknown[];
    // tenantId at $1, integrationId pushed at $2 before LIMIT/OFFSET.
    expect(params[0]).toBe('tenant-A');
    expect(params).toContain('int-XYZ');
    expect(String(rowsCall![0])).toContain("metadata->>'integrationId' = $");
  });

  it('returns 500 (not a 200 with stale data) when the DB throws', async () => {
    queryMock.mockRejectedValue(new Error('db down'));
    const app = await buildApp();
    const res = await request(app).get('/connectors/alerts');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to list connector outage alerts/);
  });
});
