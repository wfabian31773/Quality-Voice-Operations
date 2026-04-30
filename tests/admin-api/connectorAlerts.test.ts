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

  it('exposes dispatchId from metadata so the detail panel can fetch recipient rows', async () => {
    // Alerts dispatched after migration 094 carry a dispatchId in metadata
    // — the detail endpoint uses it to look up per-recipient delivery
    // rows in connector_alert_recipients. Older alerts must keep working
    // (dispatchId === null) and the UI shows an empty state.
    installQueryDispatcher({
      total: 1,
      rows: [
        {
          integration_id: 'int-1',
          type: 'integration',
          created_at: new Date('2026-04-26T18:00:00.000Z'),
          in_app_recipients: 1,
          metadata: {
            integrationId: 'int-1',
            provider: 'salesforce',
            dispatchId: 'disp-abc',
          },
          title: 't',
          message: 'm',
        },
      ],
    });
    const app = await buildApp();
    const res = await request(app).get('/connectors/alerts');
    expect(res.status).toBe(200);
    expect(res.body.alerts[0].dispatchId).toBe('disp-abc');
  });
});

// --------------------------------------------------------------------------
// GET /connectors/alerts/:alertId — detail panel that backs the click-into
// view on the OutageAlertHistory table.
//
// The handler:
//   1. Parses the composite id (`integrationId:type:createdAtMs`).
//   2. Re-aggregates the alert event from tenant_notifications (matched by
//      tenant + type + integrationId + the same minute bucket the listing
//      uses) so the metadata it returns matches the row in the table.
//   3. Pulls per-recipient delivery rows from connector_alert_recipients
//      joined by `dispatch_id` (only present on alerts written after
//      migration 094 — older alerts return `recipientsAvailable: false`).
//   4. Loads the current `integrations` row so admins can see the live
//      lastSyncErrorAt / lastSyncError context alongside the audit trail.
// --------------------------------------------------------------------------
function installDetailDispatcher(payload: {
  alertRow?: Record<string, unknown> | null;
  recipientRows?: Array<Record<string, unknown>>;
  integrationRow?: Record<string, unknown> | null;
}): void {
  queryMock.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('FROM tenant_notifications')) {
      return { rows: payload.alertRow ? [payload.alertRow] : [] };
    }
    if (text.includes('FROM connector_alert_recipients')) {
      return { rows: payload.recipientRows ?? [] };
    }
    if (text.includes('FROM integrations')) {
      return { rows: payload.integrationRow ? [payload.integrationRow] : [] };
    }
    return { rows: [] };
  });
}

describe('GET /connectors/alerts/:alertId', () => {
  it('returns the full alert + per-recipient delivery rows + connector context', async () => {
    const createdAt = new Date('2026-04-26T18:30:00.000Z');
    installDetailDispatcher({
      alertRow: {
        created_at: createdAt,
        in_app_recipients: 2,
        metadata: {
          integrationId: 'int-1',
          provider: 'salesforce',
          connectorType: 'crm',
          dispatchId: 'disp-1',
          recipientCount: 2,
          smsAttempted: 2,
          smsSucceeded: 1,
          twilioConfigured: true,
          firstFailedAt: '2026-04-26T17:45:00.000Z',
          outageMinutes: 45,
          errorMessage: 'API rate limit',
          link: 'https://app.example/connectors',
        },
        title: 'SMS dispatched',
        message: 'msg',
      },
      recipientRows: [
        {
          user_id: 'user-1',
          recipient_name: 'Ada Lovelace',
          recipient_email: 'ada@acme.test',
          recipient_phone: '+15555550101',
          delivery_status: 'sent',
          delivery_error: null,
          twilio_status_code: 201,
          // Twilio statusCallback already promoted user-1 to delivered.
          twilio_message_status: 'delivered',
          twilio_error_code: null,
          twilio_message_sid: 'SMaaaa1111',
          delivery_status_updated_at: new Date('2026-04-26T18:30:05.000Z'),
          dispatched_at: new Date('2026-04-26T18:30:01.000Z'),
        },
        {
          user_id: 'user-2',
          recipient_name: 'Grace Hopper',
          recipient_email: 'grace@acme.test',
          recipient_phone: '+15555550102',
          delivery_status: 'failed',
          delivery_error: 'Invalid number',
          twilio_status_code: 400,
          // Carrier reported "invalid number" — terminal failure.
          twilio_message_status: 'undelivered',
          twilio_error_code: 21211,
          twilio_message_sid: 'SMbbbb2222',
          delivery_status_updated_at: new Date('2026-04-26T18:30:06.000Z'),
          dispatched_at: new Date('2026-04-26T18:30:02.000Z'),
        },
      ],
      integrationRow: {
        id: 'int-1',
        name: 'Salesforce - Production',
        provider: 'salesforce',
        connector_type: 'crm',
        last_sync_at: new Date('2026-04-26T18:25:00.000Z'),
        last_sync_status: 'failed',
        last_sync_error: 'API rate limit exceeded',
        last_sync_error_at: new Date('2026-04-26T18:25:00.000Z'),
      },
    });

    const app = await buildApp();
    const alertId = `int-1:integration_sms:${createdAt.getTime()}`;
    const res = await request(app).get(
      `/connectors/alerts/${encodeURIComponent(alertId)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(alertId);
    expect(res.body.integrationId).toBe('int-1');
    expect(res.body.channel).toBe('sms');
    expect(res.body.dispatchId).toBe('disp-1');
    expect(res.body.recipientsAvailable).toBe(true);
    expect(res.body.recipients).toHaveLength(2);
    expect(res.body.recipients[0]).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@acme.test',
      phone: '+15555550101',
      deliveryStatus: 'sent',
      twilioStatusCode: 201,
      twilioMessageStatus: 'delivered',
      twilioErrorCode: null,
      twilioMessageSid: 'SMaaaa1111',
      deliveryStatusUpdatedAt: '2026-04-26T18:30:05.000Z',
    });
    expect(res.body.recipients[1]).toMatchObject({
      deliveryStatus: 'failed',
      deliveryError: 'Invalid number',
      twilioMessageStatus: 'undelivered',
      twilioErrorCode: 21211,
      twilioMessageSid: 'SMbbbb2222',
      deliveryStatusUpdatedAt: '2026-04-26T18:30:06.000Z',
    });
    expect(res.body.liveTrackingAvailable).toBe(false);
    expect(res.body.integration).toMatchObject({
      id: 'int-1',
      name: 'Salesforce - Production',
      lastSyncStatus: 'failed',
      lastSyncError: 'API rate limit exceeded',
    });
    expect(res.body.firstFailedAt).toBe('2026-04-26T17:45:00.000Z');
    expect(res.body.outageMinutes).toBe(45);
    expect(res.body.errorMessage).toBe('API rate limit');
    expect(res.body.reconnectLink).toBe('https://app.example/connectors');

    // Tenant scoping on every query: the SELECT from tenant_notifications,
    // the recipient lookup, and the integration context lookup must all
    // pin tenant_id = $1 to the requesting tenant.
    for (const call of queryMock.mock.calls) {
      const sql = String(call[0]);
      const params = call[1] as unknown[];
      expect(sql).toContain('tenant_id = $1');
      expect(params[0]).toBe('tenant-A');
    }

    // The recipient lookup must filter by dispatch_id so a different
    // dispatch in the same minute bucket can't bleed in.
    const recipientCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('FROM connector_alert_recipients'),
    );
    expect(recipientCall).toBeDefined();
    expect((recipientCall![1] as unknown[])[1]).toBe('disp-1');
  });

  it('returns recipientsAvailable=false (and skips the recipient query) for old alerts with no dispatchId', async () => {
    const createdAt = new Date('2026-04-01T12:00:00.000Z');
    installDetailDispatcher({
      alertRow: {
        created_at: createdAt,
        in_app_recipients: 1,
        metadata: { integrationId: 'int-old', provider: 'hubspot' },
        title: 't',
        message: 'm',
      },
      integrationRow: {
        id: 'int-old',
        name: 'HubSpot',
        provider: 'hubspot',
        connector_type: 'crm',
        last_sync_at: null,
        last_sync_status: null,
        last_sync_error: null,
        last_sync_error_at: null,
      },
    });

    const app = await buildApp();
    const alertId = `int-old:integration:${createdAt.getTime()}`;
    const res = await request(app).get(
      `/connectors/alerts/${encodeURIComponent(alertId)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.dispatchId).toBeNull();
    expect(res.body.recipientsAvailable).toBe(false);
    expect(res.body.recipients).toEqual([]);

    // We must NOT have hit the recipient table — there's no dispatchId to
    // join on, so the query would be unconstrained.
    const recipientCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('FROM connector_alert_recipients'),
    );
    expect(recipientCall).toBeUndefined();
  });

  it('reports liveTrackingAvailable=true while at least one SMS recipient is mid-flight', async () => {
    // The detail panel's auto-refresh / "Live" badge is driven entirely
    // by this flag. If it ever regresses to `false` while Twilio still
    // has callbacks in flight (queued / sent / sending) the panel will
    // stop polling and admins will see stale "Sent" badges instead of
    // the eventual "Delivered" / "Failed" outcome.
    const createdAt = new Date('2026-04-26T18:30:00.000Z');
    installDetailDispatcher({
      alertRow: {
        created_at: createdAt,
        in_app_recipients: 2,
        metadata: {
          integrationId: 'int-1',
          provider: 'salesforce',
          dispatchId: 'disp-live',
          smsAttempted: 2,
          smsSucceeded: 2,
          twilioConfigured: true,
        },
        title: 'SMS dispatched',
        message: 'msg',
      },
      recipientRows: [
        {
          user_id: 'user-1',
          recipient_name: 'Ada',
          recipient_email: null,
          recipient_phone: '+15555550101',
          delivery_status: 'sent',
          delivery_error: null,
          twilio_status_code: 201,
          twilio_message_status: 'queued', // non-terminal — still tracking.
          twilio_error_code: null,
          twilio_message_sid: 'SMlive1',
          delivery_status_updated_at: new Date('2026-04-26T18:30:01.000Z'),
          dispatched_at: new Date('2026-04-26T18:30:01.000Z'),
        },
        {
          user_id: 'user-2',
          recipient_name: 'Grace',
          recipient_email: null,
          recipient_phone: '+15555550102',
          delivery_status: 'sent',
          delivery_error: null,
          twilio_status_code: 201,
          twilio_message_status: 'delivered', // already terminal.
          twilio_error_code: null,
          twilio_message_sid: 'SMlive2',
          delivery_status_updated_at: new Date('2026-04-26T18:30:05.000Z'),
          dispatched_at: new Date('2026-04-26T18:30:01.000Z'),
        },
      ],
      integrationRow: {
        id: 'int-1',
        name: 'Salesforce',
        provider: 'salesforce',
        connector_type: 'crm',
        last_sync_at: null,
        last_sync_status: null,
        last_sync_error: null,
        last_sync_error_at: null,
      },
    });

    const app = await buildApp();
    const alertId = `int-1:integration_sms:${createdAt.getTime()}`;
    const res = await request(app).get(
      `/connectors/alerts/${encodeURIComponent(alertId)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.liveTrackingAvailable).toBe(true);
  });

  it('reports liveTrackingAvailable=true for email alerts when a recipient still has a non-terminal email_provider_event', async () => {
    const createdAt = new Date('2026-04-26T18:30:00.000Z');
    installDetailDispatcher({
      alertRow: {
        created_at: createdAt,
        in_app_recipients: 1,
        metadata: {
          integrationId: 'int-1',
          provider: 'salesforce',
          dispatchId: 'disp-email',
        },
        title: 'Email dispatched',
        message: 'msg',
      },
      recipientRows: [
        {
          user_id: 'user-1',
          recipient_name: 'Ada',
          recipient_email: 'ada@acme.test',
          recipient_phone: null,
          delivery_status: 'sent',
          delivery_error: null,
          twilio_status_code: null,
          twilio_message_status: null,
          twilio_error_code: null,
          twilio_message_sid: null,
          email_message_id: 'msg-abc@acme.test',
          email_provider_event: null,
          delivery_status_updated_at: null,
          dispatched_at: createdAt,
        },
      ],
      integrationRow: null,
    });

    const app = await buildApp();
    const alertId = `int-1:integration:${createdAt.getTime()}`;
    const res = await request(app).get(
      `/connectors/alerts/${encodeURIComponent(alertId)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('email');
    expect(res.body.liveTrackingAvailable).toBe(true);
    expect(res.body.recipients[0].emailMessageId).toBe('msg-abc@acme.test');
    expect(res.body.recipients[0].emailProviderEvent).toBeNull();
  });

  it('reports liveTrackingAvailable=false for email alerts once every recipient has reached a terminal email event', async () => {
    const createdAt = new Date('2026-04-26T18:30:00.000Z');
    installDetailDispatcher({
      alertRow: {
        created_at: createdAt,
        in_app_recipients: 1,
        metadata: {
          integrationId: 'int-1',
          provider: 'salesforce',
          dispatchId: 'disp-email-done',
        },
        title: 'Email dispatched',
        message: 'msg',
      },
      recipientRows: [
        {
          user_id: 'user-1',
          recipient_name: 'Ada',
          recipient_email: 'ada@acme.test',
          recipient_phone: null,
          delivery_status: 'sent',
          delivery_error: null,
          twilio_status_code: null,
          twilio_message_status: null,
          twilio_error_code: null,
          twilio_message_sid: null,
          email_message_id: 'msg-done@acme.test',
          email_provider_event: 'delivered',
          delivery_status_updated_at: createdAt,
          dispatched_at: createdAt,
        },
      ],
      integrationRow: null,
    });

    const app = await buildApp();
    const alertId = `int-1:integration:${createdAt.getTime()}`;
    const res = await request(app).get(
      `/connectors/alerts/${encodeURIComponent(alertId)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('email');
    expect(res.body.liveTrackingAvailable).toBe(false);
    expect(res.body.recipients[0].emailProviderEvent).toBe('delivered');
  });

  it('reports liveTrackingAvailable=false for email alerts when no email_message_id was captured (legacy or console-mode send)', async () => {
    const createdAt = new Date('2026-04-26T18:30:00.000Z');
    installDetailDispatcher({
      alertRow: {
        created_at: createdAt,
        in_app_recipients: 1,
        metadata: {
          integrationId: 'int-1',
          provider: 'salesforce',
          dispatchId: 'disp-email-legacy',
        },
        title: 'Email dispatched',
        message: 'msg',
      },
      recipientRows: [
        {
          user_id: 'user-1',
          recipient_name: 'Ada',
          recipient_email: 'ada@acme.test',
          recipient_phone: null,
          delivery_status: 'sent',
          delivery_error: null,
          twilio_status_code: null,
          twilio_message_status: null,
          twilio_error_code: null,
          twilio_message_sid: null,
          email_message_id: null,
          email_provider_event: null,
          delivery_status_updated_at: null,
          dispatched_at: createdAt,
        },
      ],
      integrationRow: null,
    });

    const app = await buildApp();
    const alertId = `int-1:integration:${createdAt.getTime()}`;
    const res = await request(app).get(
      `/connectors/alerts/${encodeURIComponent(alertId)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('email');
    expect(res.body.liveTrackingAvailable).toBe(false);
  });

  it('returns 404 when the alert has no matching tenant_notifications row (cross-tenant safety)', async () => {
    installDetailDispatcher({ alertRow: null });
    const app = await buildApp();
    const alertId = `int-other-tenant:integration:${Date.now()}`;
    const res = await request(app).get(
      `/connectors/alerts/${encodeURIComponent(alertId)}`,
    );
    expect(res.status).toBe(404);
  });

  it('rejects malformed alert ids with 400', async () => {
    const app = await buildApp();
    const bad = await request(app).get('/connectors/alerts/not-a-real-id');
    expect(bad.status).toBe(400);

    const wrongType = await request(app).get(
      `/connectors/alerts/${encodeURIComponent('int-1:not_a_type:123')}`,
    );
    expect(wrongType.status).toBe(400);

    const nanTimestamp = await request(app).get(
      `/connectors/alerts/${encodeURIComponent('int-1:integration:notanumber')}`,
    );
    expect(nanTimestamp.status).toBe(400);
  });

  it('returns the alert with integration=null when the underlying connector has been deleted', async () => {
    // Audit trail survives integration deletes — the alert row is still
    // in tenant_notifications, but `integrations` no longer has a match.
    const createdAt = new Date('2026-04-26T18:30:00.000Z');
    installDetailDispatcher({
      alertRow: {
        created_at: createdAt,
        in_app_recipients: 1,
        metadata: {
          integrationId: 'int-deleted',
          provider: 'salesforce',
          dispatchId: 'disp-x',
        },
        title: 't',
        message: 'm',
      },
      recipientRows: [
        {
          user_id: 'user-1',
          recipient_name: 'Ada',
          recipient_email: 'ada@acme.test',
          recipient_phone: null,
          delivery_status: 'sent',
          delivery_error: null,
          twilio_status_code: null,
          twilio_message_status: null,
          twilio_error_code: null,
          twilio_message_sid: null,
          delivery_status_updated_at: null,
          dispatched_at: createdAt,
        },
      ],
      integrationRow: null,
    });

    const app = await buildApp();
    const alertId = `int-deleted:integration:${createdAt.getTime()}`;
    const res = await request(app).get(
      `/connectors/alerts/${encodeURIComponent(alertId)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.integration).toBeNull();
    // Recipients still come back because they're a separate table.
    expect(res.body.recipients).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// POST /connectors/alerts/:alertId/resend — admin "Resend to failed
// recipients" action.
//
// The handler:
//   1. Re-aggregates the alert metadata to recover the dispatchId/provider
//      it was originally sent under.
//   2. Defers the actual resend to
//      `resendConnectorAlertToFailedRecipients` in SyncErrorAlerter (mocked
//      here so we can assert the route wires it up correctly without
//      touching email/Twilio).
//   3. Writes an audit log entry and echoes the resend outcome counts.
// --------------------------------------------------------------------------
const resendMock = vi.fn();
vi.mock('../../platform/integrations/connectors/SyncErrorAlerter', () => ({
  resendConnectorAlertToFailedRecipients: (...args: unknown[]) =>
    resendMock(...(args as [])),
}));

describe('POST /connectors/alerts/:alertId/resend', () => {
  beforeEach(() => {
    resendMock.mockReset();
  });

  function installResendDispatcher(payload: {
    alertRow?: Record<string, unknown> | null;
    tenantRow?: { name: string | null } | null;
  }): void {
    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FROM tenant_notifications')) {
        return { rows: payload.alertRow ? [payload.alertRow] : [] };
      }
      if (text.includes('FROM tenants')) {
        return { rows: payload.tenantRow ? [payload.tenantRow] : [] };
      }
      return { rows: [] };
    });
  }

  it('resends to failed recipients and echoes the per-channel outcome counts', async () => {
    const createdAt = new Date('2026-04-26T18:30:00.000Z');
    installResendDispatcher({
      alertRow: {
        metadata: {
          integrationId: 'int-1',
          provider: 'salesforce',
          dispatchId: 'disp-1',
          errorMessage: 'API rate limit',
          firstFailedAt: '2026-04-26T17:45:00.000Z',
          outageMinutes: 45,
        },
      },
      tenantRow: { name: 'Acme Corp' },
    });
    resendMock.mockResolvedValue({
      channel: 'email',
      candidates: 2,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
      twilioConfigured: true,
    });

    const app = await buildApp();
    const alertId = `int-1:integration:${createdAt.getTime()}`;
    const res = await request(app).post(
      `/connectors/alerts/${encodeURIComponent(alertId)}/resend`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      alertId,
      dispatchId: 'disp-1',
      channel: 'email',
      candidates: 2,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
    });

    // The route must hand the resend helper the metadata it just looked up
    // — including the original dispatchId, the channel-derived
    // notificationType, and the tenant name so the SMS/email body can be
    // rebuilt with the same prefix the original used.
    expect(resendMock).toHaveBeenCalledTimes(1);
    expect(resendMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-A',
      integrationId: 'int-1',
      dispatchId: 'disp-1',
      notificationType: 'integration',
      provider: 'salesforce',
      errorMessage: 'API rate limit',
      firstFailedAt: '2026-04-26T17:45:00.000Z',
      outageMinutes: 45,
      tenantName: 'Acme Corp',
    });
  });

  it('passes notificationType=integration_sms when the alert id is for an SMS dispatch', async () => {
    const createdAt = new Date('2026-04-26T18:30:00.000Z');
    installResendDispatcher({
      alertRow: {
        metadata: {
          integrationId: 'int-1',
          provider: 'hubspot',
          dispatchId: 'disp-sms',
          errorMessage: 'Auth failed',
          firstFailedAt: '2026-04-26T16:00:00.000Z',
          outageMinutes: 150,
        },
      },
      tenantRow: { name: 'Acme' },
    });
    resendMock.mockResolvedValue({
      channel: 'sms',
      candidates: 1,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 1,
      twilioConfigured: false,
    });

    const app = await buildApp();
    const alertId = `int-1:integration_sms:${createdAt.getTime()}`;
    const res = await request(app).post(
      `/connectors/alerts/${encodeURIComponent(alertId)}/resend`,
    );

    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('sms');
    expect(res.body.skipped).toBe(1);
    expect(res.body.twilioConfigured).toBe(false);
    expect(resendMock.mock.calls[0][0].notificationType).toBe('integration_sms');
  });

  it('returns 409 when the original alert pre-dates the dispatchId migration', async () => {
    // Old alerts with no dispatchId in metadata can't be resent because we
    // have no way to look up the per-recipient audit rows that drive the
    // retry. The endpoint must say so explicitly instead of attempting the
    // resend with a null dispatchId.
    const createdAt = new Date('2026-01-01T12:00:00.000Z');
    installResendDispatcher({
      alertRow: {
        metadata: { integrationId: 'int-old', provider: 'salesforce' },
      },
      tenantRow: { name: 'Acme' },
    });

    const app = await buildApp();
    const alertId = `int-old:integration:${createdAt.getTime()}`;
    const res = await request(app).post(
      `/connectors/alerts/${encodeURIComponent(alertId)}/resend`,
    );

    expect(res.status).toBe(409);
    expect(resendMock).not.toHaveBeenCalled();
  });

  it('returns 404 when no matching alert exists for the requesting tenant', async () => {
    installResendDispatcher({ alertRow: null });

    const app = await buildApp();
    const alertId = `int-x:integration:${Date.now()}`;
    const res = await request(app).post(
      `/connectors/alerts/${encodeURIComponent(alertId)}/resend`,
    );

    expect(res.status).toBe(404);
    expect(resendMock).not.toHaveBeenCalled();
  });

  it('rejects malformed alert ids with 400 without invoking the resender', async () => {
    const app = await buildApp();
    const bad = await request(app).post('/connectors/alerts/not-a-real-id/resend');
    expect(bad.status).toBe(400);
    expect(resendMock).not.toHaveBeenCalled();

    const wrongType = await request(app).post(
      `/connectors/alerts/${encodeURIComponent('int-1:nope:123')}/resend`,
    );
    expect(wrongType.status).toBe(400);
    expect(resendMock).not.toHaveBeenCalled();
  });
});
