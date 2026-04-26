/**
 * Direct coverage for the ConnectorAlertPreferences module and the
 * `/platform/notifications/connector-alerts` GET/PUT routes.
 *
 * The helpers were previously exercised only via SyncErrorAlerter and the
 * ConnectorAuthAlertScheduler; this file pins down the contract per-helper
 * (digest throttle window, mute scope precedence, bulk lookup shape) and
 * adds a route-level test that defaults are returned for new tenants and
 * that PUT enforces manager-or-higher + body validation.
 *
 * A small scheduler test at the bottom re-asserts the headline digest-mode
 * promise — N failing connectors collapse into one tenant email per cycle
 * and a re-run inside the 24h window sends nothing — so a future refactor
 * of either the scheduler OR the preferences module trips this file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

// --------------------------------------------------------------------------
// Shared DB mock — every module under test pulls its pool from here.
// --------------------------------------------------------------------------

const queryMock = vi.fn();
const clientQueryMock = vi.fn();
const clientReleaseMock = vi.fn();

function makeClient() {
  return {
    query: clientQueryMock,
    release: clientReleaseMock,
  };
}

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    query: queryMock,
    connect: async () => makeClient(),
  }),
}));

// The scheduler tests at the bottom of this file drive the real
// ConnectorAlertPreferences module via the alert cycle, so we also need to
// stub out email + in-app notification fanout so nothing escapes the test
// process. The unit/route tests above don't import these modules.

const sendEmailMock = vi.fn(async () => ({ success: true }));
const fanoutInAppMock = vi.fn(async () => undefined);
const filterEmailRecipientsMock = vi.fn(
  async (_tenantId: string, recipients: string[]) => recipients,
);
const writeAuditLogMock = vi.fn(async () => undefined);

vi.mock('../../platform/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...(args as [])),
  connectorSyncErrorEmail: () => ({ subject: 's', html: 'h', text: 't' }),
  connectorReconnectNeededEmail: () => ({ subject: 'r', html: 'h', text: 't' }),
  connectorAutoDisabledEmail: () => ({ subject: 'd', html: 'h', text: 't' }),
  connectorSyncDigestEmail: () => ({ subject: 'digest', html: 'h', text: 't' }),
}));

vi.mock('../../platform/notifications/NotificationPreferences', async () => {
  const actual = await vi.importActual<
    typeof import('../../platform/notifications/NotificationPreferences')
  >('../../platform/notifications/NotificationPreferences');
  return {
    ...actual,
    fanoutInAppNotification: (...args: unknown[]) =>
      fanoutInAppMock(...(args as [])),
    filterEmailRecipientsByPreference: (...args: unknown[]) =>
      filterEmailRecipientsMock(...(args as [string, string[]])),
  };
});

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...(args as [])),
}));

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  clientReleaseMock.mockReset();
  // Default: every transactional client query just succeeds.
  clientQueryMock.mockResolvedValue({ rows: [] });
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  fanoutInAppMock.mockReset();
  fanoutInAppMock.mockResolvedValue(undefined);
  filterEmailRecipientsMock.mockReset();
  filterEmailRecipientsMock.mockImplementation(
    async (_t: string, r: string[]) => r,
  );
  writeAuditLogMock.mockReset();
});

// --------------------------------------------------------------------------
// getConnectorAlertSettings / setConnectorAlertSettings
// --------------------------------------------------------------------------

describe('getConnectorAlertSettings', () => {
  it('returns the DEFAULT_SETTINGS shape when no row exists for the tenant', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { getConnectorAlertSettings, DEFAULT_SETTINGS } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );

    const result = await getConnectorAlertSettings('tenant-1');
    expect(result).toEqual(DEFAULT_SETTINGS);
    // Returned object must be a copy — mutating it mustn't poison the
    // singleton default for the next caller.
    result.digestMode = true;
    expect(DEFAULT_SETTINGS.digestMode).toBe(false);
  });

  it('coerces digest_last_sent_at and updated_at strings into Date objects', async () => {
    const sentIso = '2026-04-25T12:00:00.000Z';
    const updatedIso = '2026-04-25T12:30:00.000Z';
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          digest_mode: true,
          digest_last_sent_at: sentIso,
          updated_at: updatedIso,
          updated_by: 'user-9',
        },
      ],
    });

    const { getConnectorAlertSettings } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    const result = await getConnectorAlertSettings('tenant-1');

    expect(result.digestMode).toBe(true);
    expect(result.digestLastSentAt).toBeInstanceOf(Date);
    expect(result.digestLastSentAt?.toISOString()).toBe(sentIso);
    expect(result.updatedAt?.toISOString()).toBe(updatedIso);
    expect(result.updatedBy).toBe('user-9');
  });

  it('falls open to defaults when the DB query throws (table missing, etc.)', async () => {
    queryMock.mockRejectedValueOnce(new Error('relation "connector_alert_settings" does not exist'));
    const { getConnectorAlertSettings, DEFAULT_SETTINGS } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    const result = await getConnectorAlertSettings('tenant-1');
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('short-circuits with defaults for a missing tenantId without hitting the DB', async () => {
    const { getConnectorAlertSettings, DEFAULT_SETTINGS } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    const result = await getConnectorAlertSettings('');
    expect(result).toEqual(DEFAULT_SETTINGS);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('setConnectorAlertSettings', () => {
  it('upserts digestMode + updated_by and re-reads the canonical row', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT
      .mockResolvedValueOnce({
        rows: [
          {
            digest_mode: true,
            digest_last_sent_at: null,
            updated_at: '2026-04-25T13:00:00.000Z',
            updated_by: 'user-9',
          },
        ],
      });

    const { setConnectorAlertSettings } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    const result = await setConnectorAlertSettings(
      'tenant-1',
      { digestMode: true },
      'user-9',
    );

    expect(result.digestMode).toBe(true);
    expect(result.updatedBy).toBe('user-9');

    // The first call MUST be the upsert with our patch + userId. The
    // SQL uses COALESCE($2, ...) so we pass the boolean directly, not null.
    const upsertCall = queryMock.mock.calls[0];
    expect(String(upsertCall[0])).toContain('INSERT INTO connector_alert_settings');
    expect(upsertCall[1]).toEqual(['tenant-1', true, 'user-9']);
  });

  it('passes null for digestMode when the patch omits it (preserves stored value)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // re-read returns defaults

    const { setConnectorAlertSettings } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    await setConnectorAlertSettings('tenant-1', {}, 'user-9');

    const upsertCall = queryMock.mock.calls[0];
    // Args are [tenantId, digestMode-or-null, userId]. COALESCE lets us
    // update the audit metadata (updated_by/updated_at) without flipping
    // digest_mode when the caller didn't ask to change it.
    expect(upsertCall[1]).toEqual(['tenant-1', null, 'user-9']);
  });

  it('throws when tenantId is missing instead of writing a row with NULL tenant_id', async () => {
    const { setConnectorAlertSettings } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    await expect(setConnectorAlertSettings('', { digestMode: true })).rejects.toThrow(
      /tenantId is required/,
    );
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// recordDigestSent
// --------------------------------------------------------------------------

describe('recordDigestSent', () => {
  it('upserts digest_last_sent_at via NOW() so the 24h throttle starts ticking', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { recordDigestSent } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    await recordDigestSent('tenant-1');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0][0]);
    // Has to be an UPSERT (a plain UPDATE would no-op for tenants that
    // never changed prefs but did receive a digest).
    expect(sql).toContain('INSERT INTO connector_alert_settings');
    expect(sql).toContain('ON CONFLICT (tenant_id)');
    expect(sql).toContain('digest_last_sent_at = NOW()');
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-1']);
  });

  it('swallows DB errors so a broken prefs table never crashes the digest cycle', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection reset'));
    const { recordDigestSent } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    await expect(recordDigestSent('tenant-1')).resolves.toBeUndefined();
  });

  it('is a no-op for an empty tenantId', async () => {
    const { recordDigestSent } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    await recordDigestSent('');
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// getConnectorAlertMutes / replaceConnectorAlertMutes
// --------------------------------------------------------------------------

describe('getConnectorAlertMutes', () => {
  it('returns rows mapped to {scope, target}', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { scope: 'integration', target: 'int-A' },
        { scope: 'provider', target: 'slack' },
      ],
    });
    const { getConnectorAlertMutes } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    const mutes = await getConnectorAlertMutes('tenant-1');
    expect(mutes).toEqual([
      { scope: 'integration', target: 'int-A' },
      { scope: 'provider', target: 'slack' },
    ]);
  });

  it('returns [] when the DB throws so the caller can keep alerting', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    const { getConnectorAlertMutes } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    expect(await getConnectorAlertMutes('tenant-1')).toEqual([]);
  });
});

describe('replaceConnectorAlertMutes', () => {
  it('runs DELETE + per-row INSERT inside a single BEGIN/COMMIT transaction', async () => {
    // The re-read at the end goes through the pool, not the client.
    queryMock.mockResolvedValueOnce({
      rows: [
        { scope: 'provider', target: 'slack' },
        { scope: 'integration', target: 'int-A' },
      ],
    });

    const { replaceConnectorAlertMutes } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    const result = await replaceConnectorAlertMutes(
      'tenant-1',
      [
        { scope: 'provider', target: 'slack' },
        { scope: 'integration', target: 'int-A' },
      ],
      'user-9',
    );

    const sequence = clientQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sequence[0]).toBe('BEGIN');
    expect(sequence[1]).toContain('DELETE FROM connector_alert_mutes');
    expect(sequence[2]).toContain('INSERT INTO connector_alert_mutes');
    expect(sequence[3]).toContain('INSERT INTO connector_alert_mutes');
    expect(sequence[sequence.length - 1]).toBe('COMMIT');
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
  });

  it('ROLLBACKs and rethrows when any insert fails (no half-applied mute list)', async () => {
    clientQueryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text === 'BEGIN') return { rows: [] };
      if (text.includes('DELETE FROM connector_alert_mutes')) return { rows: [] };
      if (text.includes('INSERT INTO connector_alert_mutes')) {
        throw new Error('unique violation');
      }
      return { rows: [] };
    });

    const { replaceConnectorAlertMutes } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    await expect(
      replaceConnectorAlertMutes(
        'tenant-1',
        [{ scope: 'provider', target: 'slack' }],
        'user-9',
      ),
    ).rejects.toThrow(/unique violation/);

    const sequence = clientQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sequence).toContain('BEGIN');
    expect(sequence).toContain('ROLLBACK');
    expect(sequence).not.toContain('COMMIT');
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('drops malformed entries (bad scope, blank target, duplicates) before persisting', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { scope: 'provider', target: 'slack' },
        { scope: 'integration', target: 'int-A' },
      ],
    });

    const { replaceConnectorAlertMutes } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    await replaceConnectorAlertMutes(
      'tenant-1',
      [
        { scope: 'provider', target: '  slack  ' }, // trims whitespace
        { scope: 'provider', target: 'slack' }, // dedupe vs above
        { scope: 'integration', target: 'int-A' },
        // Bad rows that must be filtered out:
        { scope: 'integration' as never, target: '' },
        { scope: 'unknown' as never, target: 'x' },
        { scope: 'provider', target: '   ' },
      ],
      'user-9',
    );

    const insertCalls = clientQueryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO connector_alert_mutes'),
    );
    // 6 raw rows in -> 2 sanitized inserts (slack provider + int-A integration).
    expect(insertCalls).toHaveLength(2);
    const targets = insertCalls.map((c) => (c[1] as unknown[])[2]);
    expect(targets.sort()).toEqual(['int-A', 'slack']);
  });

  it('throws when tenantId is missing rather than wiping every tenant', async () => {
    const { replaceConnectorAlertMutes } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    await expect(
      replaceConnectorAlertMutes('', [{ scope: 'provider', target: 'slack' }]),
    ).rejects.toThrow(/tenantId is required/);
    expect(clientQueryMock).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// isConnectorMuted
// --------------------------------------------------------------------------

describe('isConnectorMuted', () => {
  it('returns true when the provider is muted (case-insensitive)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ scope: 'provider', target: 'slack' }],
    });
    const { isConnectorMuted } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    expect(await isConnectorMuted('tenant-1', 'Slack', 'int-A')).toBe(true);

    // The SQL runs LOWER(target) = LOWER($2) — verify the params we passed.
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('tenant-1');
    expect(params[1]).toBe('Slack');
    expect(params[2]).toBe('int-A');
  });

  it('returns true when only the integration id is muted (provider not in list)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ scope: 'integration', target: 'int-A' }],
    });
    const { isConnectorMuted } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    expect(await isConnectorMuted('tenant-1', 'salesforce', 'int-A')).toBe(true);
  });

  it('returns false when no mute matches', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { isConnectorMuted } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    expect(await isConnectorMuted('tenant-1', 'salesforce', 'int-A')).toBe(false);
  });

  it('treats DB errors as "not muted" — must never silently silence alerts', async () => {
    queryMock.mockRejectedValueOnce(new Error('table missing'));
    const { isConnectorMuted } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    expect(await isConnectorMuted('tenant-1', 'salesforce', 'int-A')).toBe(false);
  });

  it('returns false (no DB call) when tenantId is empty', async () => {
    const { isConnectorMuted } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    expect(await isConnectorMuted('', 'salesforce', 'int-A')).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// loadMuteSetsForTenants
// --------------------------------------------------------------------------

describe('loadMuteSetsForTenants', () => {
  it('returns an empty Map when the input list is empty (no DB call)', async () => {
    const { loadMuteSetsForTenants } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    const result = await loadMuteSetsForTenants([]);
    expect(result.size).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('dedupes and filters falsy tenantIds before issuing the query', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { loadMuteSetsForTenants } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    await loadMuteSetsForTenants(['tenant-1', 'tenant-1', '', 'tenant-2']);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect((params[0] as string[]).sort()).toEqual(['tenant-1', 'tenant-2']);
  });

  it('groups rows into per-tenant {providers, integrations} sets and lowercases providers', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { tenant_id: 'tenant-1', scope: 'provider', target: 'Slack' },
        { tenant_id: 'tenant-1', scope: 'integration', target: 'int-A' },
        { tenant_id: 'tenant-2', scope: 'provider', target: 'HUBSPOT' },
      ],
    });

    const { loadMuteSetsForTenants } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    const result = await loadMuteSetsForTenants(['tenant-1', 'tenant-2', 'tenant-3']);

    const t1 = result.get('tenant-1')!;
    expect(t1.providers.has('slack')).toBe(true);
    expect(t1.integrations.has('int-A')).toBe(true);
    expect(t1.providers.size).toBe(1);
    expect(t1.integrations.size).toBe(1);

    const t2 = result.get('tenant-2')!;
    expect(t2.providers.has('hubspot')).toBe(true);
    expect(t2.integrations.size).toBe(0);

    // tenant-3 had no rows — it should simply be absent from the map so the
    // caller can `.get(...)` and treat undefined as "no mutes".
    expect(result.has('tenant-3')).toBe(false);
  });

  it('returns an empty Map (not throws) when the DB query fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    const { loadMuteSetsForTenants } = await import(
      '../../platform/integrations/connectors/ConnectorAlertPreferences'
    );
    const result = await loadMuteSetsForTenants(['tenant-1']);
    expect(result.size).toBe(0);
  });
});

// --------------------------------------------------------------------------
// HTTP routes: GET/PUT /platform/notifications/connector-alerts
// --------------------------------------------------------------------------
//
// We mount a mini express app with a stub auth middleware so we can drive
// the real route file (and the real `requireRole('manager')` guard) without
// dragging in JWT verification or a live database.

vi.mock('../../server/admin-api/middleware/auth', async () => {
  const actual = await vi.importActual<
    typeof import('../../server/admin-api/middleware/auth')
  >('../../server/admin-api/middleware/auth');
  return {
    ...actual,
    requireAuth: (req: Request, _res: Response, next: NextFunction) => {
      const headerUser = req.headers['x-test-user'];
      if (!headerUser) {
        // Default authenticated user — owner role with platform admin.
        req.user = {
          userId: 'user-1',
          tenantId: 'tenant-1',
          email: 'owner@acme.test',
          role: 'tenant_owner',
          isPlatformAdmin: false,
        };
      } else {
        req.user = JSON.parse(String(headerUser));
      }
      next();
    },
  };
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const router = (
    await import('../../server/admin-api/routes/productionEssentials')
  ).default;
  app.use(router);
  return app;
}

describe('GET /platform/notifications/connector-alerts', () => {
  it('returns DEFAULT_SETTINGS-shaped JSON with no mutes for a brand new tenant', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FROM connector_alert_settings')) return { rows: [] };
      if (text.includes('FROM connector_alert_mutes')) return { rows: [] };
      return { rows: [] };
    });

    const app = await buildApp();
    const res = await request(app).get('/platform/notifications/connector-alerts');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      settings: {
        digestMode: false,
        digestLastSentAt: null,
        updatedAt: null,
      },
      mutes: [],
    });
  });

  it('serializes Date fields as ISO strings and includes the persisted mute list', async () => {
    const sentIso = '2026-04-26T08:00:00.000Z';
    const updatedIso = '2026-04-26T08:30:00.000Z';
    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FROM connector_alert_settings')) {
        return {
          rows: [
            {
              digest_mode: true,
              digest_last_sent_at: sentIso,
              updated_at: updatedIso,
              updated_by: 'user-1',
            },
          ],
        };
      }
      if (text.includes('FROM connector_alert_mutes')) {
        return {
          rows: [
            { scope: 'provider', target: 'slack' },
            { scope: 'integration', target: 'int-A' },
          ],
        };
      }
      return { rows: [] };
    });

    const app = await buildApp();
    const res = await request(app).get('/platform/notifications/connector-alerts');

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      digestMode: true,
      digestLastSentAt: sentIso,
      updatedAt: updatedIso,
    });
    // updatedBy is intentionally NOT exposed on the response.
    expect(res.body.settings.updatedBy).toBeUndefined();
    expect(res.body.mutes).toEqual([
      { scope: 'provider', target: 'slack' },
      { scope: 'integration', target: 'int-A' },
    ]);
  });
});

describe('PUT /platform/notifications/connector-alerts', () => {
  function asUser(role: string, isPlatformAdmin = false) {
    return JSON.stringify({
      userId: 'user-x',
      tenantId: 'tenant-1',
      email: 'u@acme.test',
      role,
      isPlatformAdmin,
    });
  }

  it('rejects viewers (support_reviewer / agent_developer) with 403', async () => {
    const app = await buildApp();
    for (const role of ['support_reviewer', 'agent_developer']) {
      const res = await request(app)
        .put('/platform/notifications/connector-alerts')
        .set('x-test-user', asUser(role))
        .send({ digestMode: true });
      expect(res.status, `role=${role}`).toBe(403);
      // The route handler must never have run for an unauthorized role.
      expect(queryMock).not.toHaveBeenCalled();
    }
  });

  it('allows operations_manager and tenant_owner through', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('INSERT INTO connector_alert_settings')) return { rows: [] };
      if (text.includes('FROM connector_alert_settings')) {
        return {
          rows: [
            {
              digest_mode: true,
              digest_last_sent_at: null,
              updated_at: '2026-04-26T08:30:00.000Z',
              updated_by: 'user-x',
            },
          ],
        };
      }
      if (text.includes('FROM connector_alert_mutes')) return { rows: [] };
      return { rows: [] };
    });

    const app = await buildApp();
    for (const role of ['operations_manager', 'tenant_owner']) {
      queryMock.mockClear();
      const res = await request(app)
        .put('/platform/notifications/connector-alerts')
        .set('x-test-user', asUser(role))
        .send({ digestMode: true });
      expect(res.status, `role=${role}`).toBe(200);
      expect(res.body.settings.digestMode).toBe(true);
    }
  });

  it('returns 400 when digestMode is not a boolean', async () => {
    const app = await buildApp();
    const res = await request(app)
      .put('/platform/notifications/connector-alerts')
      .send({ digestMode: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/digestMode must be a boolean/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 400 when mutes is not an array', async () => {
    const app = await buildApp();
    const res = await request(app)
      .put('/platform/notifications/connector-alerts')
      .send({ mutes: { scope: 'provider', target: 'slack' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mutes must be an array/);
  });

  it('silently drops mute entries with bad scope or blank target rather than 500ing', async () => {
    const inserted: unknown[][] = [];
    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('INSERT INTO connector_alert_settings')) return { rows: [] };
      if (text.includes('FROM connector_alert_settings')) {
        return {
          rows: [
            {
              digest_mode: false,
              digest_last_sent_at: null,
              updated_at: '2026-04-26T08:30:00.000Z',
              updated_by: 'user-1',
            },
          ],
        };
      }
      if (text.includes('FROM connector_alert_mutes')) {
        // Re-read after the replace returns whatever we inserted.
        return {
          rows: inserted.map((p) => ({ scope: p[1], target: p[2] })),
        };
      }
      return { rows: [] };
    });
    clientQueryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('INSERT INTO connector_alert_mutes') && params) {
        inserted.push(params as unknown[]);
      }
      return { rows: [] };
    });

    const app = await buildApp();
    const res = await request(app)
      .put('/platform/notifications/connector-alerts')
      .send({
        mutes: [
          { scope: 'provider', target: 'slack' },
          // Bad rows — the route filters these out before calling replace*.
          { scope: 'whatever', target: 'x' },
          { scope: 'integration', target: '   ' },
          null,
          'not-an-object',
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.mutes).toEqual([{ scope: 'provider', target: 'slack' }]);
    // Only one INSERT row reached the DB.
    const insertRows = clientQueryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO connector_alert_mutes'),
    );
    expect(insertRows).toHaveLength(1);
  });

  it('does NOT touch the mute list when the request omits "mutes"', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('INSERT INTO connector_alert_settings')) return { rows: [] };
      if (text.includes('FROM connector_alert_settings')) {
        return {
          rows: [
            {
              digest_mode: true,
              digest_last_sent_at: null,
              updated_at: '2026-04-26T08:30:00.000Z',
              updated_by: 'user-1',
            },
          ],
        };
      }
      if (text.includes('FROM connector_alert_mutes')) {
        return { rows: [{ scope: 'provider', target: 'slack' }] };
      }
      return { rows: [] };
    });

    const app = await buildApp();
    const res = await request(app)
      .put('/platform/notifications/connector-alerts')
      .send({ digestMode: true });

    expect(res.status).toBe(200);
    // Existing mutes preserved...
    expect(res.body.mutes).toEqual([{ scope: 'provider', target: 'slack' }]);
    // ...because the transactional client (DELETE/INSERT path) was never used.
    expect(clientQueryMock).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Scheduler-level: runConnectorAuthAlertCycle drives ConnectorAlertPreferences
// --------------------------------------------------------------------------
//
// These tests pin down the headline digest-mode contract end-to-end:
//   * digestMode=ON + N failing connectors for a tenant => exactly ONE
//     digest email is sent for that tenant (not N per-event emails).
//   * Re-running the cycle while digest_last_sent_at is inside the 24h
//     throttle window sends nothing (and never stamps auth_alert_sent_at,
//     so the failures stay eligible for the next digest).
//
// They run the real ConnectorAuthAlertScheduler against the real
// ConnectorAlertPreferences module, with only the DB pool, email sender,
// and in-app fan-out replaced with mocks above.

interface FailureRow {
  tenant_id: string;
  integration_id: string;
  provider: string;
  integration_type: string;
  name: string | null;
  last_sync_status: string;
  last_sync_error: string;
  last_sync_error_at: Date | null;
}

interface SchedulerScenario {
  failures: FailureRow[];
  digestMode: boolean;
  digestLastSentAt: Date | null;
  admins: string[];
  /** Records the integration_ids passed to claimAuthAlertSlot (UPDATE integrations …). */
  stampedIntegrations: string[];
  /** Records each upsert into connector_alert_settings issued by recordDigestSent. */
  digestRecordedFor: string[];
}

function installSchedulerScenario(scenario: SchedulerScenario): void {
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql);

    // findPendingAuthFailures
    if (text.includes('FROM integrations') && text.includes('auth_alert_sent_at IS NULL')) {
      return { rows: scenario.failures };
    }

    // dispatchConnectorAuthAlert: per-integration row lookup
    if (
      text.includes('FROM integrations') &&
      text.includes('WHERE tenant_id = $1 AND id = $2')
    ) {
      const integrationId = (params?.[1] as string) ?? '';
      const match = scenario.failures.find((f) => f.integration_id === integrationId);
      if (!match) return { rows: [] };
      return {
        rows: [
          {
            name: match.name,
            integration_type: match.integration_type,
            // null => not throttled at the per-integration level.
            auth_alert_sent_at: null,
            last_sync_error: match.last_sync_error,
            last_sync_error_at: match.last_sync_error_at,
          },
        ],
      };
    }

    // claimAuthAlertSlot — only fires for non-digest dispatches OR after a
    // successful digest send. Either way we want to capture which integration
    // got stamped.
    if (text.includes('UPDATE integrations') && text.includes('auth_alert_sent_at = NOW()')) {
      scenario.stampedIntegrations.push((params?.[0] as string) ?? '');
      return { rowCount: 1, rows: [] };
    }

    // loadMuteSetsForTenants — no mutes in these scenarios.
    if (text.includes('FROM connector_alert_mutes')) {
      return { rows: [] };
    }

    // getConnectorAlertSettings
    if (
      text.includes('FROM connector_alert_settings') &&
      text.includes('WHERE tenant_id = $1')
    ) {
      return {
        rows: [
          {
            digest_mode: scenario.digestMode,
            digest_last_sent_at: scenario.digestLastSentAt,
            updated_at: null,
            updated_by: null,
          },
        ],
      };
    }

    // recordDigestSent (UPSERT into connector_alert_settings)
    if (text.includes('INSERT INTO connector_alert_settings')) {
      scenario.digestRecordedFor.push((params?.[0] as string) ?? '');
      return { rows: [] };
    }

    // recentInAppNotificationExists
    if (text.includes('FROM tenant_notifications')) {
      return { rows: [] };
    }

    // getTenantAdmins: tenant name lookup
    if (text.includes('FROM tenants') && text.includes('WHERE id = $1')) {
      return { rows: [{ name: 'Acme' }] };
    }

    // getTenantAdmins: admin user lookup. The production query checks both
    // user_roles (canonical) and users.role (legacy) so we just match on the
    // FROM users / LEFT JOIN user_roles shape rather than a brittle role list.
    if (text.includes('FROM users') && text.includes('user_roles')) {
      return {
        rows: scenario.admins.map((email, idx) => ({
          id: `user-${idx}`,
          email,
        })),
      };
    }

    return { rows: [] };
  });
}

function makeFailure(overrides: Partial<FailureRow> = {}): FailureRow {
  return {
    tenant_id: 'tenant-1',
    integration_id: 'int-1',
    provider: 'salesforce',
    integration_type: 'crm',
    name: 'Acme Salesforce',
    last_sync_status: 'needs_reconnect',
    last_sync_error: '401 unauthorized',
    last_sync_error_at: new Date(Date.now() - 30 * 60 * 1000),
    ...overrides,
  };
}

describe('runConnectorAuthAlertCycle — end-to-end via ConnectorAlertPreferences', () => {
  it('digest mode collapses N failing connectors for one tenant into a single email', async () => {
    const scenario: SchedulerScenario = {
      failures: [
        makeFailure({ integration_id: 'int-A', provider: 'salesforce' }),
        makeFailure({ integration_id: 'int-B', provider: 'hubspot' }),
        makeFailure({ integration_id: 'int-C', provider: 'quickbooks' }),
      ],
      digestMode: true,
      // Throttle window is open — no digest has been sent yet.
      digestLastSentAt: null,
      admins: ['admin@acme.test'],
      stampedIntegrations: [],
      digestRecordedFor: [],
    };
    installSchedulerScenario(scenario);

    const { runConnectorAuthAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );
    const result = await runConnectorAuthAlertCycle();

    // Exactly ONE digest email — not three per-event emails.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(result.digestEmailsSent).toBe(1);
    // `alerted` reflects every connector folded into the digest.
    expect(result.alerted).toBe(3);
    // recordDigestSent fired once for the tenant so the next 24h are throttled.
    expect(scenario.digestRecordedFor).toEqual(['tenant-1']);
    // Every queued integration was stamped — but ONLY after the digest
    // delivered. If we'd stamped before the send, an SMTP outage would
    // silently drop these from every future cycle.
    expect(scenario.stampedIntegrations.sort()).toEqual(['int-A', 'int-B', 'int-C']);
    // In-app notifications still fan out per-connector (subject to dedupe).
    expect(fanoutInAppMock).toHaveBeenCalledTimes(3);
  });

  it('a re-run inside the 24h digest throttle window sends nothing and stamps nothing', async () => {
    const scenario: SchedulerScenario = {
      failures: [
        makeFailure({ integration_id: 'int-A' }),
        makeFailure({ integration_id: 'int-B', provider: 'hubspot' }),
      ],
      digestMode: true,
      // Last digest 1 hour ago — well inside DIGEST_THROTTLE_MS (24h).
      digestLastSentAt: new Date(Date.now() - 60 * 60 * 1000),
      admins: ['admin@acme.test'],
      stampedIntegrations: [],
      digestRecordedFor: [],
    };
    installSchedulerScenario(scenario);

    const { runConnectorAuthAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );
    const result = await runConnectorAuthAlertCycle();

    // No digest email went out and the metric reflects that.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.digestEmailsSent).toBe(0);
    // Crucially: no integration was stamped. If we had stamped them, the
    // failures would be filtered out of `findPendingAuthFailures` for the
    // next 24h and would silently miss the next digest.
    expect(scenario.stampedIntegrations).toEqual([]);
    // And no second recordDigestSent (which would push the throttle window
    // forward and silence even more cycles).
    expect(scenario.digestRecordedFor).toEqual([]);
  });
});
