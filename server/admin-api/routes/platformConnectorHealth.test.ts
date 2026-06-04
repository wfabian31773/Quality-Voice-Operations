import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// platformConnectorHealth pulls in many connector/telephony scheduler modules
// at import time; stub them all so the router loads without real deps. We
// focus on the main GET snapshot plus the cheap UUID-validation guards on the
// action routes.
const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  withPrivilegedClientMock: vi.fn(),
  queryMock: vi.fn(),
  listConnectorTokenHealthMock: vi.fn(),
  getRefreshableProvidersMock: vi.fn(),
  isRefreshableProviderMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({ withPrivilegedClient: a.withPrivilegedClientMock }));
vi.mock('../../../platform/integrations/connectors', () => ({
  ensureFreshOAuthToken: vi.fn(),
  isRefreshableProvider: a.isRefreshableProviderMock,
  getConnectorConfig: vi.fn(),
  listConnectorConfigs: vi.fn().mockResolvedValue([]),
  listConnectorTokenHealth: a.listConnectorTokenHealthMock,
}));
vi.mock('../../../platform/integrations/connectors/tokenRefresh', () => ({ getRefreshableProviders: a.getRefreshableProvidersMock }));
vi.mock('../../../platform/integrations/connectors/ConnectorAuthAlertScheduler', () => ({ dispatchConnectorAuthAlert: vi.fn() }));
vi.mock('../../../platform/integrations/connectors/connectorStaleHealth', () => ({
  REFRESH_CYCLE_INTERVAL_MS: 1000,
  STALE_CYCLE_THRESHOLD: 2,
  TOKEN_EXPIRING_HORIZON_MS: 1000,
  computeStaleEvaluation: () => ({ status: 'healthy', expiresInMs: null, cyclesSinceRefresh: null, stale: false }),
}));
vi.mock('../../../platform/integrations/connectors/CrmCallerIdentityRevalidationMetrics', () => ({
  getCrmRevalidationMetricsSnapshot: () => ({ scanned: 0 }),
}));
vi.mock('../../../platform/audit/AuditService', () => ({ writeAuditLog: vi.fn(), extractIp: () => '127.0.0.1' }));
vi.mock('../../../platform/telephony/TrustedCallerService', () => ({
  getCallerId: vi.fn(),
  listUnhealthyVerifiedCallers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../platform/telephony/VerifiedCallerHealthScheduler', () => ({ dispatchVerifiedCallerAlert: vi.fn() }));
vi.mock('../../../platform/telephony/VerifiedCallerAlertHistory', () => ({
  getLatestAlertSummariesByCaller: vi.fn().mockResolvedValue(new Map()),
  listVerifiedCallerAlertHistory: vi.fn().mockResolvedValue([]),
}));

import router from './platformConnectorHealth';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
  a.withPrivilegedClientMock.mockReset().mockImplementation(async (cb: (c: unknown) => Promise<unknown>) =>
    cb({ query: a.queryMock }),
  );
  a.listConnectorTokenHealthMock.mockReset().mockResolvedValue([]);
  a.getRefreshableProvidersMock.mockReset().mockReturnValue(['hubspot']);
  a.isRefreshableProviderMock.mockReset().mockReturnValue(true);
});

describe('GET /platform/connector-health', () => {
  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/connector-health')).status).toBe(403);
  });

  it('returns a health snapshot with summary, connectors and clamped window', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM integrations i')) {
        return { rows: [{ id: 'i1', tenant_id: 't1', integration_type: 'crm', provider: 'hubspot', name: 'HS', is_enabled: true, last_sync_status: 'needs_reconnect', last_sync_at: null, last_sync_error: 'expired', last_sync_error_at: null, auth_alert_sent_at: null, recovery_alert_sent_at: null, updated_at: null, tenant_name: 'Acme', tenant_slug: 'acme' }] };
      }
      if (sql.includes('affected_tenants') && sql.includes('FROM integrations')) {
        return { rows: [{ needs_reconnect: '1', sync_error: '0', healthy: '5', total: '6', affected_tenants: '1' }] };
      }
      return { rows: [] };
    });
    const res = await request(app()).get('/platform/connector-health?sinceDays=999');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ needsReconnect: 1, healthy: 5 });
    expect(res.body.connectors[0]).toMatchObject({ integrationId: 'i1', provider: 'hubspot', refreshable: true });
    expect(res.body.window.sinceDays).toBe(30); // clamped from 999
  });

  it('returns 500 when the snapshot query throws', async () => {
    a.withPrivilegedClientMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/platform/connector-health')).status).toBe(500);
  });
});

describe('action route UUID guards', () => {
  it('rejects an invalid tenantId on the refresh route with 400', async () => {
    const res = await request(app()).post('/platform/connector-health/integrations/not-a-uuid/also-bad/refresh');
    expect(res.status).toBe(400);
  });

  it('rejects an invalid id on the outbox retry route with 400', async () => {
    const res = await request(app()).post('/platform/connector-health/outbox/bad/bad/retry');
    expect(res.status).toBe(400);
  });

  it('rejects an invalid tenantId on the tenant-connectors route with 400', async () => {
    const res = await request(app()).get('/platform/tenants/not-a-uuid/connectors');
    expect(res.status).toBe(400);
  });
});
