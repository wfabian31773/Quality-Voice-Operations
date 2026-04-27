/**
 * TCPA-compliance coverage for the campaigns admin API and supporting
 * platform helpers.
 *
 * The tests mount the campaigns route with a mocked `getPlatformPool` so we
 * can drive query results from each test, plus mocks for the auth/RBAC
 * middleware and field encryption. We assert three pieces:
 *
 *   1. PATCH /campaigns/:id refuses to flip status -> running when the
 *      campaign has any contact whose plaintext phone is on `dnc_list`.
 *   2. The same handler still accepts the update once the offending
 *      contacts are removed.
 *   3. GET /campaigns/:id/compliance returns the full report (score,
 *      DNC matches, recommendations) so the UI can render it.
 *
 * Quiet-hours/area-code logic is exercised in a sibling describe block via
 * the pure `evaluateQuietHours` helper, no DB needed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn()),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/security/FieldEncryption', () => ({
  encryptSensitiveField: vi.fn(async (_t: string, v: string) => v),
  decryptSensitiveField: vi.fn(async (_t: string, v: string) =>
    v.startsWith('env1:') ? v.slice('env1:'.length) : v,
  ),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(async () => {}),
  extractIp: () => '127.0.0.1',
}));

const getVerifiedCallerByIdMock = vi.fn(async () => null);
vi.mock('../../platform/telephony/TrustedCallerService', () => ({
  getVerifiedCallerById: (...args: unknown[]) => getVerifiedCallerByIdMock(...args as [string, string]),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'admin',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import campaignsRouter from '../../server/admin-api/routes/campaigns';
import { evaluateQuietHours } from '../../platform/campaigns/QuietHours';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(campaignsRouter);
  return app;
}

interface QueryStubMatcher {
  match: (sql: string, values?: unknown[]) => boolean;
  rows: Record<string, unknown>[];
  rowCount?: number;
}

function makeQueryStub(matchers: QueryStubMatcher[]): typeof queryMock {
  return vi.fn(async (sql: string, values?: unknown[]) => {
    for (const m of matchers) {
      if (m.match(sql, values)) {
        return { rows: m.rows, rowCount: m.rowCount ?? m.rows.length };
      }
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
}

const sampleCampaignRow = {
  id: 'camp-1',
  tenant_id: 'tenant-1',
  agent_id: 'agent-1',
  name: 'Outbound test',
  type: 'outbound_call',
  status: 'draft',
  config: { timezone: 'America/New_York', callWindowStart: '09:00', callWindowEnd: '20:00' },
  scheduled_at: null,
  started_at: null,
  completed_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  getVerifiedCallerByIdMock.mockReset();
  getVerifiedCallerByIdMock.mockResolvedValue(null);
});

describe('PATCH /campaigns/:id launch pre-flight', () => {
  it('refuses to flip a campaign to running when contacts are on the DNC list', async () => {
    queryMock.mockImplementation(makeQueryStub([
      // user phone_verified check
      {
        match: (sql) => /phone_verified FROM users/i.test(sql),
        rows: [{ phone_verified: true }],
      },
      // getCampaign — used twice (verify + merged config)
      {
        match: (sql) => /SELECT \* FROM campaigns WHERE id = \$1/i.test(sql),
        rows: [sampleCampaignRow],
      },
      // dnc_list lookup for the tenant
      {
        match: (sql) => /SELECT phone_number FROM dnc_list/i.test(sql),
        rows: [{ phone_number: '+15551234567' }],
      },
      // counts: total + opted_out
      {
        match: (sql) => /COUNT\(\*\) FILTER \(WHERE status = 'opted_out'\)/.test(sql),
        rows: [{ total: 2, opted_out: 0 }],
      },
      // first batch of contact rows for decrypt + DNC compare
      {
        match: (sql) => /SELECT id, phone_number, name, created_at FROM campaign_contacts/i.test(sql),
        rows: [
          { id: 'c1', phone_number: 'env1:+15551234567', name: 'Alice', created_at: '2026-04-27T00:00:00Z' },
          { id: 'c2', phone_number: 'env1:+15559999999', name: 'Bob', created_at: '2026-04-27T00:00:01Z' },
        ],
      },
    ]));

    const app = buildApp();
    const res = await request(app).patch('/campaigns/camp-1').send({ status: 'running' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/do-not-call/i);
    expect(res.body.compliance.dncMatchCount).toBe(1);
    expect(res.body.compliance.dncMatches[0]).toMatchObject({
      contactId: 'c1',
      contactName: 'Alice',
    });
    expect(res.body.compliance.dncMatches[0].phoneRedacted).toEqual(expect.any(String));
    expect(res.body.compliance.complianceScore).toBeLessThanOrEqual(30);
  });

  it('allows the launch once DNC matches are cleared', async () => {
    queryMock.mockImplementation(makeQueryStub([
      {
        match: (sql) => /phone_verified FROM users/i.test(sql),
        rows: [{ phone_verified: true }],
      },
      {
        match: (sql) => /SELECT \* FROM campaigns WHERE id = \$1/i.test(sql),
        rows: [sampleCampaignRow],
      },
      {
        match: (sql) => /SELECT phone_number FROM dnc_list/i.test(sql),
        rows: [],
      },
      {
        match: (sql) => /COUNT\(\*\) FILTER \(WHERE status = 'opted_out'\)/.test(sql),
        rows: [{ total: 2, opted_out: 0 }],
      },
      {
        match: (sql) => /SELECT id, phone_number, name, created_at FROM campaign_contacts/i.test(sql),
        rows: [
          { id: 'c1', phone_number: 'env1:+15551234567', name: 'Alice', created_at: '2026-04-27T00:00:00Z' },
          { id: 'c2', phone_number: 'env1:+15559999999', name: 'Bob', created_at: '2026-04-27T00:00:01Z' },
        ],
      },
      // UPDATE campaigns
      {
        match: (sql) => /UPDATE campaigns SET/i.test(sql),
        rows: [{ ...sampleCampaignRow, status: 'running' }],
      },
    ]));

    const app = buildApp();
    const res = await request(app).patch('/campaigns/camp-1').send({ status: 'running' });

    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe('running');
  });
});

describe('PATCH /campaigns/:id launch fail-closed on truncated preflight', () => {
  it('refuses to launch when the campaign exceeds the pre-flight scan ceiling', async () => {
    // Lower the pre-flight cap via env (read at module load) so the test
    // can drive the truncation branch with a tiny roster.
    process.env.CAMPAIGN_PREFLIGHT_MAX_CONTACTS = '4';
    process.env.CAMPAIGN_PREFLIGHT_BATCH_SIZE = '2';
    vi.resetModules();
    const compliance = await import('../../platform/campaigns/ComplianceService');

    const stubClient = {
      query: vi.fn(async (sql: string) => {
        if (/SELECT phone_number FROM dnc_list/i.test(sql)) return { rows: [] };
        if (/COUNT\(\*\) FILTER \(WHERE status = 'opted_out'\)/.test(sql)) {
          return { rows: [{ total: 50, opted_out: 0 }] };
        }
        if (/SELECT id, phone_number, name, created_at FROM campaign_contacts/i.test(sql)) {
          // Always return full batches so the pager keeps going until the
          // (lowered) cap is reached.
          const rows = Array.from({ length: 2 }, (_, i) => ({
            id: `c-${Math.random().toString(36).slice(2, 8)}-${i}`,
            phone_number: `env1:+1555${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`,
            name: null,
            created_at: new Date(Date.now() + Math.random() * 1000).toISOString(),
          }));
          return { rows };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(stubClient as unknown as Awaited<ReturnType<typeof connectMock>>);

    const result = await compliance.checkCampaignCompliance('tenant-1', 'camp-1', {
      config: { timezone: 'America/New_York', callWindowStart: '09:00', callWindowEnd: '20:00' },
    } as Parameters<typeof compliance.checkCampaignCompliance>[2]);

    expect(result.preflightTruncated).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.recommendations.some((r: string) => /pre-flight limit/i.test(r))).toBe(true);

    delete process.env.CAMPAIGN_PREFLIGHT_MAX_CONTACTS;
    delete process.env.CAMPAIGN_PREFLIGHT_BATCH_SIZE;
  });
});

describe('POST /campaigns/:id/scrub-dnc', () => {
  it('flips DNC matches to opted_out with reason=dnc_match and re-runs the launch', async () => {
    let updateCampaignCalls = 0;
    const updateOptedOutCalls: Array<{ sql: string; values?: unknown[] }> = [];
    let dncListReturned = true;

    queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };

      if (/phone_verified FROM users/i.test(sql)) {
        return { rows: [{ phone_verified: true }], rowCount: 1 };
      }
      if (/SELECT \* FROM campaigns WHERE id = \$1/i.test(sql)) {
        return { rows: [sampleCampaignRow], rowCount: 1 };
      }
      if (/SELECT phone_number FROM dnc_list/i.test(sql)) {
        // First call returns the matches; subsequent calls (post-scrub
        // re-check) return an empty list so compliance.ok is true.
        if (dncListReturned) {
          dncListReturned = false;
          return { rows: [{ phone_number: '+15551234567' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/COUNT\(\*\) FILTER \(WHERE status = 'opted_out'\)/.test(sql)) {
        return { rows: [{ total: 2, opted_out: 0 }], rowCount: 1 };
      }
      // findDncMatchingContactIds scan (selects without `name`)
      if (/SELECT id, phone_number, created_at FROM campaign_contacts/i.test(sql)) {
        return {
          rows: [
            { id: '00000000-0000-0000-0000-000000000001', phone_number: 'env1:+15551234567', created_at: '2026-04-27T00:00:00Z' },
            { id: '00000000-0000-0000-0000-000000000002', phone_number: 'env1:+15559999999', created_at: '2026-04-27T00:00:01Z' },
          ],
          rowCount: 2,
        };
      }
      // checkCampaignCompliance scan (selects with `name`)
      if (/SELECT id, phone_number, name, created_at FROM campaign_contacts/i.test(sql)) {
        return {
          rows: [
            { id: '00000000-0000-0000-0000-000000000002', phone_number: 'env1:+15559999999', name: 'Bob', created_at: '2026-04-27T00:00:01Z' },
          ],
          rowCount: 1,
        };
      }
      // bulkMarkOptedOut UPDATE
      if (/UPDATE campaign_contacts[\s\S]+SET status = 'opted_out'/i.test(sql)) {
        updateOptedOutCalls.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
      // updateCampaign
      if (/UPDATE campaigns SET/i.test(sql)) {
        updateCampaignCalls++;
        return { rows: [{ ...sampleCampaignRow, status: 'running' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = buildApp();
    const res = await request(app)
      .post('/campaigns/camp-1/scrub-dnc')
      .send({ retryStatus: 'running' });

    expect(res.status).toBe(200);
    expect(res.body.scrubbed).toBe(1);
    expect(res.body.compliance.dncMatchCount).toBe(0);
    expect(res.body.compliance.ok).toBe(true);
    expect(res.body.campaign).toMatchObject({ status: 'running' });
    expect(res.body.retryError).toBeNull();
    expect(updateCampaignCalls).toBe(1);

    // The bulk update must reference the matching contact id and
    // stamp metadata.optOutReason = 'dnc_match'.
    expect(updateOptedOutCalls).toHaveLength(1);
    const call = updateOptedOutCalls[0];
    expect(call.sql).toMatch(/optOutReason/);
    const values = call.values as unknown[];
    expect(values[0]).toBe('dnc_match');
    expect(values[3]).toEqual(['00000000-0000-0000-0000-000000000001']);
  });

  it('does not relaunch when the post-scrub compliance check still fails', async () => {
    let updateCampaignCalls = 0;

    queryMock.mockImplementation(async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/phone_verified FROM users/i.test(sql)) return { rows: [{ phone_verified: true }], rowCount: 1 };
      if (/SELECT \* FROM campaigns WHERE id = \$1/i.test(sql)) return { rows: [sampleCampaignRow], rowCount: 1 };
      if (/SELECT phone_number FROM dnc_list/i.test(sql)) {
        return { rows: [{ phone_number: '+15551234567' }], rowCount: 1 };
      }
      if (/COUNT\(\*\) FILTER \(WHERE status = 'opted_out'\)/.test(sql)) {
        // Empty campaign post-scrub triggers ok=false ('Add contacts before launching')
        return { rows: [{ total: 0, opted_out: 0 }], rowCount: 1 };
      }
      if (/SELECT id, phone_number, created_at FROM campaign_contacts/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT id, phone_number, name, created_at FROM campaign_contacts/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE campaign_contacts[\s\S]+SET status = 'opted_out'/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE campaigns SET/i.test(sql)) {
        updateCampaignCalls++;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = buildApp();
    const res = await request(app)
      .post('/campaigns/camp-1/scrub-dnc')
      .send({ retryStatus: 'running' });

    expect(res.status).toBe(200);
    expect(res.body.scrubbed).toBe(0);
    expect(res.body.compliance.ok).toBe(false);
    expect(res.body.campaign).toBeNull();
    expect(res.body.retryError).toEqual(expect.stringMatching(/compliance blocker/i));
    expect(updateCampaignCalls).toBe(0);
  });

  it('rejects an invalid retryStatus', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/campaigns/camp-1/scrub-dnc')
      .send({ retryStatus: 'completed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retryStatus/);
  });

  it('refuses to relaunch when the campaign references a missing verified caller ID', async () => {
    // Mirror the PATCH /campaigns/:id launch gating: if the campaign config
    // points at a verifiedCallerId that no longer exists or isn't verified,
    // the scrub-and-launch path must reject the relaunch — otherwise it
    // could be used as a side door around the trusted-caller check.
    const campaignWithCaller = {
      ...sampleCampaignRow,
      config: { ...sampleCampaignRow.config, verifiedCallerId: 'caller-does-not-exist' },
    };
    queryMock.mockImplementation(async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/phone_verified FROM users/i.test(sql)) return { rows: [{ phone_verified: true }], rowCount: 1 };
      if (/SELECT \* FROM campaigns WHERE id = \$1/i.test(sql)) return { rows: [campaignWithCaller], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    getVerifiedCallerByIdMock.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post('/campaigns/camp-1/scrub-dnc')
      .send({ retryStatus: 'running' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verified caller id/i);
    expect(getVerifiedCallerByIdMock).toHaveBeenCalledWith('tenant-1', 'caller-does-not-exist');
  });
});

describe('GET /campaigns/:id/compliance', () => {
  it('returns a compliance report with the score and DNC matches', async () => {
    queryMock.mockImplementation(makeQueryStub([
      {
        match: (sql) => /SELECT \* FROM campaigns WHERE id = \$1/i.test(sql),
        rows: [sampleCampaignRow],
      },
      {
        match: (sql) => /SELECT phone_number FROM dnc_list/i.test(sql),
        rows: [{ phone_number: '+15551234567' }],
      },
      {
        match: (sql) => /COUNT\(\*\) FILTER \(WHERE status = 'opted_out'\)/.test(sql),
        rows: [{ total: 3, opted_out: 1 }],
      },
      {
        match: (sql) => /SELECT id, phone_number, name, created_at FROM campaign_contacts/i.test(sql),
        rows: [
          { id: 'c1', phone_number: 'env1:+15551234567', name: null, created_at: '2026-04-27T00:00:00Z' },
          { id: 'c2', phone_number: 'env1:+15554443333', name: null, created_at: '2026-04-27T00:00:01Z' },
        ],
      },
    ]));

    const app = buildApp();
    const res = await request(app).get('/campaigns/camp-1/compliance');

    expect(res.status).toBe(200);
    expect(res.body.compliance).toMatchObject({
      ok: false,
      totalContacts: 3,
      optedOutCount: 1,
      dncMatchCount: 1,
    });
    expect(typeof res.body.compliance.complianceScore).toBe('number');
    expect(res.body.compliance.recommendations.some((r: string) => /do-not-call/i.test(r))).toBe(true);
  });
});

describe('getNextPendingContact (skip-list rotation)', () => {
  it('skips contacts whose ids are in the exclude list (prevents quiet-hour starvation)', async () => {
    const captured: Array<{ sql: string; values?: unknown[] }> = [];
    const stubClient = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        captured.push({ sql, values });
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(stubClient as unknown as Awaited<ReturnType<typeof connectMock>>);

    const { getNextPendingContact } = await import('../../platform/campaigns/CampaignService');
    await getNextPendingContact('tenant-1', 'camp-1', 3, 30, ['skip-1', 'skip-2']);

    const updateCall = captured.find((c) => /UPDATE campaign_contacts/.test(c.sql));
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toMatch(/AND id <> ALL\(\$\d+::uuid\[\]\)/);
    // Last param is the excludeIds array
    expect(updateCall!.values).toEqual(expect.arrayContaining([['skip-1', 'skip-2']]));
    // The pick ordering rotates blocked contacts to the back
    expect(updateCall!.sql).toMatch(/ORDER BY[\s\S]*last_attempted_at ASC NULLS FIRST/);
  });
});

describe('evaluateQuietHours (per-area-code TCPA window)', () => {
  it('blocks an east-coast number after 8pm even when the campaign owner is in Pacific time', () => {
    // 2026-04-27 23:30 UTC === 19:30 Eastern (allowed) and 16:30 Pacific.
    // Use 02:30 UTC instead which is 22:30 Eastern (blocked).
    const now = new Date(Date.UTC(2026, 3, 28, 2, 30));
    const decision = evaluateQuietHours('+12025550100', {
      timezone: 'America/Los_Angeles',
      callWindowStart: '09:00',
      callWindowEnd: '20:00',
      respectContactTimezone: true,
    }, now);
    expect(decision.allowed).toBe(false);
    expect(decision.timezone).toBe('America/New_York');
    expect(decision.reason).toBe('outside_window');
  });

  it('allows a Pacific number that is still inside its local window', () => {
    // 2026-04-27 23:30 UTC === 16:30 Pacific.
    const now = new Date(Date.UTC(2026, 3, 27, 23, 30));
    const decision = evaluateQuietHours('+14155550101', {
      timezone: 'America/New_York',
      callWindowStart: '09:00',
      callWindowEnd: '20:00',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      respectContactTimezone: true,
    }, now);
    expect(decision.allowed).toBe(true);
    expect(decision.timezone).toBe('America/Los_Angeles');
  });

  it('falls back to the campaign timezone when the area code is unknown', () => {
    // 2026-04-27 13:00 UTC === 09:00 Eastern (allowed if days include monday).
    const now = new Date(Date.UTC(2026, 3, 27, 13, 0));
    const decision = evaluateQuietHours('+449999999999', {
      timezone: 'America/New_York',
      callWindowStart: '09:00',
      callWindowEnd: '20:00',
      daysOfWeek: [1, 2, 3, 4, 5],
      respectContactTimezone: true,
    }, now);
    expect(decision.timezone).toBe('America/New_York');
    expect(decision.allowed).toBe(true);
  });

  it('honors per-area-code overrides over the area-code map', () => {
    const now = new Date(Date.UTC(2026, 3, 27, 14, 0));
    const decision = evaluateQuietHours('+12125550100', {
      timezone: 'America/New_York',
      callWindowStart: '09:00',
      callWindowEnd: '20:00',
      daysOfWeek: [1, 2, 3, 4, 5],
      respectContactTimezone: true,
      areaCodeTimezones: { '212': 'America/Los_Angeles' },
    }, now);
    expect(decision.timezone).toBe('America/Los_Angeles');
    // 14:00 UTC = 07:00 Pacific, before window start
    expect(decision.allowed).toBe(false);
  });
});
