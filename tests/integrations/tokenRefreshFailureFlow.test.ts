import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// End-to-end coverage for the token-refresh failure pipeline:
//
//   tokenRefresh.handleRefreshFailure
//     -> markConnectorReconnectNeeded (UPDATE integrations)
//        -> dispatchConnectorAuthAlert (in-app row + email + audit)
//
// Postgres + email transport are stubbed in-memory. The test drives a
// permanent OAuth refresh failure (HTTP 401 invalid_grant) and asserts the
// downstream side effects across all three layers, including the 24h
// dedupe / throttle on a second consecutive failure.

const queryMock = vi.fn<
  (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>
>();
const sendEmailMock = vi.fn<(input: Record<string, unknown>) => Promise<{ success: boolean }>>();
const fetchMock = vi.fn();

const fakePool = {
  query: queryMock,
  connect: vi.fn(),
};

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => fakePool,
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  ),
}));

vi.mock('../../platform/email', () => ({
  sendEmail: (input: Record<string, unknown>) => sendEmailMock(input),
  connectorReconnectNeededEmail: () => ({
    subject: 'Reconnect HubSpot',
    html: '<p>reconnect</p>',
    text: 'reconnect',
  }),
  connectorSyncErrorEmail: () => ({
    subject: 'Sync error',
    html: '<p>sync</p>',
    text: 'sync',
  }),
  connectorAutoDisabledEmail: () => ({
    subject: 'Auto-disabled',
    html: '<p>auto</p>',
    text: 'auto',
  }),
  connectorSyncDigestEmail: () => ({
    subject: 'Digest',
    html: '<p>digest</p>',
    text: 'digest',
  }),
}));

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

interface SmartMockState {
  /** Rows captured from INSERT INTO tenant_notifications (param arrays). */
  inAppInserts: unknown[][];
  /** Rows captured from INSERT INTO audit_logs (param arrays). */
  auditInserts: unknown[][];
  /** Captured `last_sync_status` UPDATE param arrays. */
  needsReconnectUpdates: unknown[][];
  /** Mutable state for `integrations.auth_alert_sent_at`. */
  authAlertSentAt: Date | null;
}

function installSmartQueryMock(): SmartMockState {
  const state: SmartMockState = {
    inAppInserts: [],
    auditInserts: [],
    needsReconnectUpdates: [],
    authAlertSentAt: null,
  };

  queryMock.mockImplementation(async (sql, params) => {
    if (typeof sql !== 'string') return { rows: [] };

    // ---- Transaction control + RLS context (no-ops in the stub) ----
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    if (sql.includes('set_config(') && sql.includes('app.tenant_id')) {
      return { rows: [] };
    }

    // ---- markConnectorReconnectNeeded UPDATE ----
    if (
      sql.includes('UPDATE integrations') &&
      sql.includes("SET last_sync_status = 'needs_reconnect'")
    ) {
      state.needsReconnectUpdates.push(params ?? []);
      return { rows: [], rowCount: 1 };
    }

    // ---- dispatchConnectorAuthAlert: SELECT integration row ----
    if (
      sql.includes('FROM integrations') &&
      sql.includes('integration_type::text') &&
      sql.includes('auth_alert_sent_at') &&
      !sql.includes('UPDATE')
    ) {
      return {
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            // Mutable across calls so the second failure looks throttled.
            auth_alert_sent_at: state.authAlertSentAt,
            last_sync_error: 'Token refresh HTTP 401: invalid_grant',
            last_sync_error_at: null,
          },
        ],
      };
    }

    // ---- claimAuthAlertSlot atomic UPDATE ----
    if (
      sql.includes('UPDATE integrations') &&
      sql.includes('SET auth_alert_sent_at = NOW()')
    ) {
      // Honor the SQL's own throttle window: if we already stamped within
      // 24h, the WHERE clause filters us out → rowCount = 0. Otherwise we
      // win the slot and stamp the new time.
      if (
        state.authAlertSentAt &&
        Date.now() - state.authAlertSentAt.getTime() < 24 * 60 * 60 * 1000
      ) {
        return { rows: [], rowCount: 0 };
      }
      state.authAlertSentAt = new Date();
      return { rows: [], rowCount: 1 };
    }

    // ---- getTenantAdmins: tenant name ----
    if (sql.includes('SELECT name FROM tenants')) {
      return { rows: [{ name: 'Acme Co' }] };
    }

    // ---- getTenantAdmins: admin recipients (id + email) ----
    if (
      sql.includes('FROM users u') &&
      sql.includes('LEFT JOIN user_roles')
    ) {
      return {
        rows: [{ id: 'user-a', email: 'admin@acme.test', created_at: new Date() }],
      };
    }

    // ---- recentInAppNotificationExists ----
    if (
      sql.includes('FROM tenant_notifications') &&
      sql.includes("type = 'integration'") &&
      sql.includes("metadata ->> 'integrationId'")
    ) {
      // Mirror the SQL's 24h dedupe semantics: any in-app row already
      // captured in this test counts as a recent duplicate.
      return state.inAppInserts.length > 0 ? { rows: [{ '?column?': 1 }] } : { rows: [] };
    }

    // ---- fanoutInAppNotification: load tenant users restricted to admin IDs ----
    if (
      sql.includes('FROM users') &&
      sql.includes('id = ANY(') &&
      !sql.includes('LEFT JOIN user_roles')
    ) {
      return { rows: [{ id: 'user-a' }] };
    }

    // ---- filterUserIdsByPreference (in_app channel) ----
    if (
      sql.includes('user_notification_preferences') &&
      sql.includes('user_id = ANY(')
    ) {
      return { rows: [] };
    }

    // ---- fanoutInAppNotification: per-user INSERT ----
    if (sql.includes('INSERT INTO tenant_notifications')) {
      state.inAppInserts.push(params ?? []);
      return { rows: [] };
    }

    // ---- filterEmailRecipientsByPreference ----
    if (
      sql.includes('user_notification_preferences') &&
      sql.includes('LOWER(u.email)')
    ) {
      return { rows: [] };
    }

    // ---- writeAuditLog INSERT (handleRefreshFailure best-effort tail) ----
    if (sql.includes('INSERT INTO audit_logs')) {
      state.auditInserts.push(params ?? []);
      return { rows: [] };
    }

    return { rows: [] };
  });

  return state;
}

async function flushFireAndForget(state: { inAppInserts: unknown[][] }): Promise<void> {
  // markConnectorReconnectNeeded fires the dispatch via void (async () => ...).
  // The dynamic import (`./ConnectorAuthAlertScheduler`) can take a few hundred
  // ms on cold start, so poll until either the in-app row lands or we hit a
  // generous deadline. This keeps the fast path fast and avoids flakes when
  // CI is busy.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    if (state.inAppInserts.length > 0) break;
  }
  // Drain any trailing microtasks (audit log, sendEmail) once the in-app
  // row has landed.
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  fetchMock.mockReset();
  fakePool.connect.mockReset();
  fakePool.connect.mockImplementation(async () => ({
    query: queryMock,
    release: vi.fn(),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.HUBSPOT_CLIENT_ID = 'test-client-id';
  process.env.HUBSPOT_CLIENT_SECRET = 'test-client-secret';
  // Ensure our smart mock picks up a clean state per test.
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

function expiredHubspotConfig() {
  return {
    integrationId: 'int-1',
    tenantId: 'tenant-1' as unknown as string,
    connectorType: 'crm' as const,
    provider: 'hubspot',
    isEnabled: true,
    credentials: {
      access_token: 'old-access-token',
      refresh_token: 'old-refresh-token',
      // 60s in the past → shouldRefresh() returns true.
      token_expires_at: String(Date.now() - 60_000),
    },
  };
}

describe('token refresh failure → reconnect alert pipeline', () => {
  it('flips the integration to needs_reconnect and dispatches exactly one in-app row + one email', async () => {
    const state = installSmartQueryMock();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_grant"}',
    } as unknown as Response);

    const { ensureFreshOAuthToken } = await import(
      '../../platform/integrations/connectors/tokenRefresh'
    );

    await expect(ensureFreshOAuthToken(expiredHubspotConfig())).rejects.toThrow();
    await flushFireAndForget(state);

    // 1. Integration was flipped to `needs_reconnect`.
    expect(state.needsReconnectUpdates.length).toBe(1);
    expect(state.needsReconnectUpdates[0]).toEqual([
      'tenant-1',
      'int-1',
      'OAuth token refresh failed: Token refresh HTTP 401: {"error":"invalid_grant"}',
    ]);

    // 2. Exactly one tenant_notifications row inserted, type='integration'.
    expect(state.inAppInserts.length).toBe(1);
    const row = state.inAppInserts[0];
    expect(row[0]).toBe('tenant-1');         // tenant_id
    expect(row[1]).toBe('user-a');           // user_id (per-user fan-out)
    expect(row[2]).toBe('integration');      // type / category
    const metadata = JSON.parse(row[5] as string);
    expect(metadata.integrationId).toBe('int-1');
    expect(metadata.provider).toBe('hubspot');
    expect(metadata.reason).toBe('needs_reconnect');

    // 3. Exactly one email queued via the test transport.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect((sendEmailMock.mock.calls[0][0] as { to: string }).to).toBe('admin@acme.test');

    // 4. Best-effort audit log row was written with the right action.
    expect(state.auditInserts.length).toBe(1);
    expect(state.auditInserts[0][3]).toBe('connector.token_refresh_failed');
    expect(state.auditInserts[0][5]).toBe('int-1');
  });

  it('a second permanent refresh failure within 24h does not produce duplicate notifications', async () => {
    const state = installSmartQueryMock();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_grant"}',
    } as unknown as Response);

    const { ensureFreshOAuthToken } = await import(
      '../../platform/integrations/connectors/tokenRefresh'
    );

    // First failure: full pipeline runs.
    await expect(ensureFreshOAuthToken(expiredHubspotConfig())).rejects.toThrow();
    await flushFireAndForget(state);

    expect(state.inAppInserts.length).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    // Second failure shortly after: the integration row now reports a
    // recent auth_alert_sent_at, so dispatchConnectorAuthAlert short-
    // circuits on the 24h throttle. No new in-app row, no new email.
    await expect(ensureFreshOAuthToken(expiredHubspotConfig())).rejects.toThrow();
    await flushFireAndForget(state);

    // The status flip itself is idempotent (called every failure), so we
    // expect two UPDATE calls. The downstream alert side effects must NOT
    // double up.
    expect(state.needsReconnectUpdates.length).toBe(2);
    expect(state.inAppInserts.length).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});
