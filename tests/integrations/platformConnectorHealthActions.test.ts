/**
 * Tests for the platform-admin "fix unhealthy connector" action endpoints
 * mounted at /platform/connector-health/integrations/:tenantId/:integrationId/{refresh,alert}.
 *
 * We exercise the route handlers in isolation by mocking the auth middleware,
 * the DB helper that loads the integration row, the OAuth refresh helper, the
 * reconnect-email dispatcher, and the audit logger. The router itself is the
 * real module — we only inject minimal infrastructure around it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';

const ensureFreshOAuthTokenMock = vi.fn<(config: unknown, opts?: { force?: boolean }) => Promise<void>>();
const isRefreshableProviderMock = vi.fn<(provider: string) => boolean>();
const getConnectorConfigMock = vi.fn<(tenantId: string, type: string, provider: string) => Promise<unknown>>();
const listConnectorTokenHealthMock = vi.fn<(providers: string[]) => Promise<Array<Record<string, unknown>>>>();
const getRefreshableProvidersMock = vi.fn<() => string[]>();
const dispatchConnectorAuthAlertMock = vi.fn<(params: Record<string, unknown>) => Promise<{
  status: 'sent' | 'throttled' | 'no_recipients' | 'skipped';
  emailedRecipients: number;
}>>();
const writeAuditLogMock = vi.fn<(event: Record<string, unknown>) => Promise<void>>();
const withPrivilegedClientMock = vi.fn<(fn: (client: unknown) => Promise<unknown>) => Promise<unknown>>();

let integrationRow: Record<string, unknown> | null = null;

vi.mock('../../platform/db', () => ({
  withPrivilegedClient: (fn: (client: unknown) => Promise<unknown>) =>
    withPrivilegedClientMock(fn),
  getPlatformPool: () => ({ query: vi.fn() }),
}));

vi.mock('../../platform/integrations/connectors', () => ({
  ensureFreshOAuthToken: (config: unknown, opts?: { force?: boolean }) =>
    ensureFreshOAuthTokenMock(config, opts),
  isRefreshableProvider: (provider: string) => isRefreshableProviderMock(provider),
  getConnectorConfig: (tenantId: string, type: string, provider: string) =>
    getConnectorConfigMock(tenantId, type, provider),
  listConnectorTokenHealth: (providers: string[]) => listConnectorTokenHealthMock(providers),
}));

vi.mock('../../platform/integrations/connectors/tokenRefresh', () => ({
  getRefreshableProviders: () => getRefreshableProvidersMock(),
}));

vi.mock('../../platform/integrations/connectors/ConnectorAuthAlertScheduler', () => ({
  dispatchConnectorAuthAlert: (params: Record<string, unknown>) =>
    dispatchConnectorAuthAlertMock(params),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: (event: Record<string, unknown>) => writeAuditLogMock(event),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: Record<string, unknown> }).user = {
      userId: 'admin-user-1',
      tenantId: 'platform-tenant',
      email: 'admin@example.com',
      role: 'tenant_owner',
      isPlatformAdmin: true,
    };
    next();
  },
}));

const TENANT_ID = randomUUID();
const INTEGRATION_ID = randomUUID();

async function buildApp() {
  // Import after mocks register so the route file picks up the mocked deps.
  const routerModule = await import('../../server/admin-api/routes/platformConnectorHealth');
  const app = express();
  app.use(express.json());
  app.use('/api', routerModule.default);
  return app;
}

beforeEach(() => {
  ensureFreshOAuthTokenMock.mockReset();
  isRefreshableProviderMock.mockReset();
  isRefreshableProviderMock.mockReturnValue(true);
  getConnectorConfigMock.mockReset();
  getConnectorConfigMock.mockResolvedValue({ tenantId: TENANT_ID, provider: 'hubspot' });
  listConnectorTokenHealthMock.mockReset();
  listConnectorTokenHealthMock.mockResolvedValue([]);
  getRefreshableProvidersMock.mockReset();
  getRefreshableProvidersMock.mockReturnValue(['hubspot', 'pipedrive']);
  dispatchConnectorAuthAlertMock.mockReset();
  writeAuditLogMock.mockReset();
  writeAuditLogMock.mockResolvedValue(undefined);
  withPrivilegedClientMock.mockReset();
  integrationRow = {
    id: INTEGRATION_ID,
    tenant_id: TENANT_ID,
    integration_type: 'crm',
    provider: 'hubspot',
    name: 'HubSpot',
    is_enabled: true,
    last_sync_status: 'needs_reconnect',
    last_sync_error: 'invalid_grant',
    last_sync_error_at: new Date('2026-04-20T12:00:00Z'),
    auth_alert_sent_at: null,
  };
  withPrivilegedClientMock.mockImplementation(async (fn) =>
    fn({
      query: async () => ({ rows: integrationRow ? [integrationRow] : [], rowCount: integrationRow ? 1 : 0 }),
    }),
  );
});

describe('POST /platform/connector-health/integrations/:tenantId/:integrationId/refresh', () => {
  it('rejects malformed UUIDs without touching the connector layer', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/platform/connector-health/integrations/not-a-uuid/also-not-a-uuid/refresh')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid/);
    expect(getConnectorConfigMock).not.toHaveBeenCalled();
    expect(ensureFreshOAuthTokenMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the integration row is missing', async () => {
    integrationRow = null;
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/platform/connector-health/integrations/${TENANT_ID}/${INTEGRATION_ID}/refresh`)
      .send({});
    expect(res.status).toBe(404);
    expect(ensureFreshOAuthTokenMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the provider does not support OAuth refresh', async () => {
    isRefreshableProviderMock.mockReturnValue(false);
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/platform/connector-health/integrations/${TENANT_ID}/${INTEGRATION_ID}/refresh`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not support/);
    expect(ensureFreshOAuthTokenMock).not.toHaveBeenCalled();
  });

  it('forces a refresh, returns ok, and writes a success audit row', async () => {
    ensureFreshOAuthTokenMock.mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/platform/connector-health/integrations/${TENANT_ID}/${INTEGRATION_ID}/refresh`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(ensureFreshOAuthTokenMock).toHaveBeenCalledTimes(1);
    expect(ensureFreshOAuthTokenMock.mock.calls[0][1]).toEqual({ force: true });
    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditLogMock.mock.calls[0][0];
    expect(audit.action).toBe('connector.admin_refresh_succeeded');
    expect(audit.tenantId).toBe(TENANT_ID);
    expect(audit.resourceId).toBe(INTEGRATION_ID);
    expect(audit.actorRole).toBe('platform_admin');
  });

  it('surfaces refresh failures as 502 with the provider error and writes a failure audit row', async () => {
    ensureFreshOAuthTokenMock.mockRejectedValue(new Error('invalid_grant: refresh token expired'));
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/platform/connector-health/integrations/${TENANT_ID}/${INTEGRATION_ID}/refresh`)
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/invalid_grant/);
    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditLogMock.mock.calls[0][0];
    expect(audit.action).toBe('connector.admin_refresh_failed');
    expect((audit.changes as Record<string, unknown>).error).toMatch(/invalid_grant/);
  });
});

describe('POST /platform/connector-health/integrations/:tenantId/:integrationId/alert', () => {
  it('rejects malformed UUIDs', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/platform/connector-health/integrations/bad/bad/alert')
      .send({});
    expect(res.status).toBe(400);
    expect(dispatchConnectorAuthAlertMock).not.toHaveBeenCalled();
  });

  it('forces a reconnect-email dispatch and returns the delivery summary', async () => {
    dispatchConnectorAuthAlertMock.mockResolvedValue({ status: 'sent', emailedRecipients: 2 });
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/platform/connector-health/integrations/${TENANT_ID}/${INTEGRATION_ID}/alert`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('sent');
    expect(res.body.emailedRecipients).toBe(2);
    expect(res.body.message).toMatch(/Reconnect email sent to 2 admins/);

    expect(dispatchConnectorAuthAlertMock).toHaveBeenCalledTimes(1);
    const params = dispatchConnectorAuthAlertMock.mock.calls[0][0];
    expect(params.force).toBe(true);
    expect(params.tenantId).toBe(TENANT_ID);
    expect(params.integrationId).toBe(INTEGRATION_ID);
    expect(params.provider).toBe('hubspot');
    expect(params.connectorType).toBe('crm');
    expect(params.reason).toBe('needs_reconnect');

    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditLogMock.mock.calls[0][0];
    expect(audit.action).toBe('connector.admin_alert_reissued');
    expect((audit.changes as Record<string, unknown>).status).toBe('sent');
    expect((audit.changes as Record<string, unknown>).emailedRecipients).toBe(2);
  });

  it('chooses reason="auth_error" when the connector is in error (not needs_reconnect)', async () => {
    integrationRow = { ...(integrationRow as Record<string, unknown>), last_sync_status: 'error' };
    dispatchConnectorAuthAlertMock.mockResolvedValue({ status: 'sent', emailedRecipients: 1 });
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/platform/connector-health/integrations/${TENANT_ID}/${INTEGRATION_ID}/alert`)
      .send({});
    expect(res.status).toBe(200);
    const params = dispatchConnectorAuthAlertMock.mock.calls[0][0];
    expect(params.reason).toBe('auth_error');
  });

  it('returns 200 with informative message when no admin recipients are eligible', async () => {
    dispatchConnectorAuthAlertMock.mockResolvedValue({ status: 'no_recipients', emailedRecipients: 0 });
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/platform/connector-health/integrations/${TENANT_ID}/${INTEGRATION_ID}/alert`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('no_recipients');
    expect(res.body.message).toMatch(/No tenant admin recipients/);
  });

  it('returns 500 when the dispatcher itself throws', async () => {
    dispatchConnectorAuthAlertMock.mockRejectedValue(new Error('SMTP exploded'));
    const app = await buildApp();
    const res = await request(app)
      .post(`/api/platform/connector-health/integrations/${TENANT_ID}/${INTEGRATION_ID}/alert`)
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/SMTP exploded/);
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });
});

describe('GET /platform/connector-health (token health surface)', () => {
  const FIFTEEN_MIN = 15 * 60 * 1000;

  function withGetClient(connectorRows: Array<Record<string, unknown>>) {
    // The GET handler issues 3 sequential queries: connectors, summary,
    // events. We satisfy them in order so the response body is fully
    // populated for the token-health assertions below.
    let call = 0;
    withPrivilegedClientMock.mockImplementation(async (fn) =>
      fn({
        query: async () => {
          call += 1;
          if (call === 1) return { rows: connectorRows };
          if (call === 2) {
            return {
              rows: [{
                needs_reconnect: '0',
                sync_error: '0',
                healthy: String(connectorRows.length),
                total: String(connectorRows.length),
                affected_tenants: '0',
              }],
            };
          }
          return { rows: [] };
        },
      }),
    );
  }

  it('returns tokenHealth with computed status and stale flags', async () => {
    withGetClient([]);
    const now = Date.now();
    listConnectorTokenHealthMock.mockResolvedValue([
      {
        // Healthy: token issued recently and expires far in the future.
        tenantId: 't-healthy',
        tenantName: 'Healthy Tenant',
        tenantSlug: 'healthy',
        integrationId: 'int-healthy',
        integrationType: 'crm',
        provider: 'hubspot',
        name: 'HubSpot',
        isEnabled: true,
        lastSyncStatus: 'success',
        lastSyncAt: new Date(now - 60_000).toISOString(),
        lastSyncErrorAt: null,
        tokenIssuedAt: now - 30 * 60 * 1000,
        tokenExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
        tokenDecryptFailed: false,
      },
      {
        // Expiring: less than 24h to go but still valid.
        tenantId: 't-expiring',
        tenantName: 'Expiring Soon',
        tenantSlug: 'expiring',
        integrationId: 'int-expiring',
        integrationType: 'crm',
        provider: 'pipedrive',
        name: 'Pipedrive',
        isEnabled: true,
        lastSyncStatus: 'success',
        lastSyncAt: null,
        lastSyncErrorAt: null,
        tokenIssuedAt: now - 23 * 60 * 60 * 1000,
        tokenExpiresAt: now + 30 * 60 * 1000,
        tokenDecryptFailed: false,
      },
      {
        // Expired and stale: been past expiry for 5 cycles → stale.
        tenantId: 't-stale-expired',
        tenantName: 'Stale Expired',
        tenantSlug: 'stale-exp',
        integrationId: 'int-stale-exp',
        integrationType: 'crm',
        provider: 'hubspot',
        name: null,
        isEnabled: true,
        lastSyncStatus: 'success',
        lastSyncAt: null,
        lastSyncErrorAt: null,
        tokenIssuedAt: null,
        tokenExpiresAt: now - 5 * FIFTEEN_MIN,
        tokenDecryptFailed: false,
      },
      {
        // Needs reconnect, error stamped >2 cycles ago → stale.
        tenantId: 't-needs-reconnect',
        tenantName: 'Needs Reconnect',
        tenantSlug: 'reconnect',
        integrationId: 'int-needs-reconnect',
        integrationType: 'crm',
        provider: 'hubspot',
        name: 'HubSpot',
        isEnabled: true,
        lastSyncStatus: 'needs_reconnect',
        lastSyncAt: null,
        lastSyncErrorAt: new Date(now - 3 * FIFTEEN_MIN).toISOString(),
        tokenIssuedAt: now - 26 * 60 * 60 * 1000,
        tokenExpiresAt: now - 60_000,
        tokenDecryptFailed: false,
      },
      {
        // Unknown: no expires_at recorded.
        tenantId: 't-unknown',
        tenantName: 'No Token',
        tenantSlug: 'no-token',
        integrationId: 'int-unknown',
        integrationType: 'crm',
        provider: 'hubspot',
        name: 'HubSpot',
        isEnabled: true,
        lastSyncStatus: 'success',
        lastSyncAt: null,
        lastSyncErrorAt: null,
        tokenIssuedAt: null,
        tokenExpiresAt: null,
        tokenDecryptFailed: false,
      },
    ]);

    const app = await buildApp();
    const res = await request(app).get('/api/platform/connector-health');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tokenHealth)).toBe(true);
    expect(res.body.tokenHealthRefreshIntervalMs).toBe(FIFTEEN_MIN);
    expect(res.body.tokenHealthExpiringHorizonMs).toBe(24 * 60 * 60 * 1000);
    expect(res.body.tokenHealthStaleCycleThreshold).toBe(2);
    expect(getRefreshableProvidersMock).toHaveBeenCalled();
    expect(listConnectorTokenHealthMock).toHaveBeenCalledWith(['hubspot', 'pipedrive']);

    const byId = new Map<string, Record<string, unknown>>();
    for (const r of res.body.tokenHealth as Array<Record<string, unknown>>) {
      byId.set(r.integrationId as string, r);
    }

    expect(byId.get('int-healthy')?.status).toBe('healthy');
    expect(byId.get('int-healthy')?.stale).toBe(false);

    expect(byId.get('int-expiring')?.status).toBe('expiring');
    expect(byId.get('int-expiring')?.stale).toBe(false);

    const staleExpired = byId.get('int-stale-exp')!;
    expect(staleExpired.status).toBe('expired');
    expect(staleExpired.stale).toBe(true);
    expect(staleExpired.expiresInMs as number).toBeLessThan(0);

    const needsReconnect = byId.get('int-needs-reconnect')!;
    expect(needsReconnect.status).toBe('needs_reconnect');
    expect(needsReconnect.stale).toBe(true);

    const unknown = byId.get('int-unknown')!;
    expect(unknown.status).toBe('unknown');
    expect(unknown.expiresInMs).toBeNull();
    expect(unknown.cyclesSinceRefresh).toBeNull();
  });

  it('falls back to an empty tokenHealth array when the snapshot helper throws', async () => {
    withGetClient([]);
    listConnectorTokenHealthMock.mockRejectedValue(new Error('decrypt blew up'));
    const app = await buildApp();
    const res = await request(app).get('/api/platform/connector-health');
    expect(res.status).toBe(200);
    expect(res.body.tokenHealth).toEqual([]);
    // The rest of the payload still comes through.
    expect(res.body.summary).toBeDefined();
    expect(res.body.connectors).toEqual([]);
  });
});
