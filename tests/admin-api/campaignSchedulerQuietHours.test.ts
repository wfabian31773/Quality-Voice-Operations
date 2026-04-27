/**
 * CampaignScheduler quiet-hours skip-counter coverage.
 *
 * The scheduler reverts contacts to "pending" when they fall outside the
 * called party's local call window. We need to be sure that:
 *
 *   1. Each skip bumps the persistent `quiet_hours_skips` counter on the
 *      campaigns table (so admins can see the metric on
 *      `/campaigns/:id/metrics`).
 *   2. After 5 consecutive quiet-hours skips inside one tick we
 *      short-circuit the dial loop instead of scanning the entire roster.
 *   3. We never call `dialContact` for a contact that was skipped.
 *   4. The `/campaigns/:id/metrics` admin route surfaces the field on the
 *      wire so the UI / public API contract is honored.
 *
 * The test pins a clock at 03:00 America/Los_Angeles (which is also
 * outside the 09:00–20:00 window in any US timezone, so even contacts
 * whose area code maps to Eastern, Central, Mountain, or Pacific are all
 * blocked) and feeds a synthetic batch of 10 contacts through a mocked
 * pool so the scheduler runs end-to-end without a real database.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const {
  queryMock,
  releaseMock,
  connectMock,
  dialContactMock,
  isContactOnDncMock,
} = vi.hoisted(() => {
  const queryMock = vi.fn();
  const releaseMock = vi.fn();
  const connectMock = vi.fn(async () => ({
    query: queryMock,
    release: releaseMock,
  }));
  const dialContactMock = vi.fn(async () => ({ success: true, callSid: 'CA-stub' }));
  const isContactOnDncMock = vi.fn(async () => false);
  return { queryMock, releaseMock, connectMock, dialContactMock, isContactOnDncMock };
});

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
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

vi.mock('../../platform/campaigns/OutboundDialer', () => ({
  dialContact: dialContactMock,
}));

vi.mock('../../platform/campaigns/ComplianceService', () => ({
  isContactOnDnc: isContactOnDncMock,
}));

vi.mock('../../platform/telephony/TrustedCallerService', () => ({
  resolveCampaignCallerId: vi.fn(async () => null),
  getVerifiedCallerById: vi.fn(async () => null),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(async () => {}),
  extractIp: () => '127.0.0.1',
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

import { CampaignScheduler } from '../../platform/campaigns/CampaignScheduler';
import { getCampaignMetrics } from '../../platform/campaigns/CampaignService';
import campaignsRouter from '../../server/admin-api/routes/campaigns';

interface ContactRow {
  id: string;
  tenant_id: string;
  campaign_id: string;
  phone_number: string;
  name: string | null;
  status: string;
  attempt_count: number;
  last_attempted_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function makeContact(id: string, areaCode: string): ContactRow {
  return {
    id,
    tenant_id: 'tenant-1',
    campaign_id: 'camp-1',
    phone_number: `+1${areaCode}5550100`,
    name: null,
    status: 'pending',
    attempt_count: 0,
    last_attempted_at: null,
    metadata: {},
    created_at: '2026-04-27T00:00:00Z',
    updated_at: '2026-04-27T00:00:00Z',
  };
}

interface FakeWorld {
  contacts: Map<string, ContactRow>;
  pendingOrder: string[];
  quietHoursSkips: number;
}

function makeQueryDispatcher(world: FakeWorld) {
  return async (sql: string, values?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };

    // getRunningCampaigns
    if (/SELECT id, tenant_id, agent_id, config FROM campaigns WHERE status = 'running'/i.test(sql)) {
      return {
        rows: [
          {
            id: 'camp-1',
            tenant_id: 'tenant-1',
            agent_id: 'agent-1',
            config: {
              timezone: 'America/Chicago',
              callWindowStart: '09:00',
              callWindowEnd: '20:00',
              daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
              respectContactTimezone: true,
              maxConcurrent: 100,
              maxAttempts: 3,
              retryDelayMinutes: 30,
            },
          },
        ],
        rowCount: 1,
      };
    }

    // tenant active dialing count
    if (/SELECT COUNT\(\*\)::int AS active FROM campaign_contacts\s+WHERE tenant_id = \$1 AND status IN \('dialing', 'connected'\)/i.test(sql)) {
      return { rows: [{ active: 0 }], rowCount: 1 };
    }
    // tenant settings
    if (/SELECT settings FROM tenants WHERE id = \$1/i.test(sql)) {
      return { rows: [{ settings: { maxConcurrentCampaignCalls: 100 } }], rowCount: 1 };
    }
    // campaign active dialing count
    if (/SELECT COUNT\(\*\)::int AS active FROM campaign_contacts\s+WHERE campaign_id = \$1/i.test(sql)) {
      return { rows: [{ active: 0 }], rowCount: 1 };
    }

    // getNextPendingContact (UPDATE ... SKIP LOCKED)
    if (/UPDATE campaign_contacts\s+SET status = 'dialing'/i.test(sql)) {
      const excludeIds = (Array.isArray(values) && values.length >= 5
        ? (values[4] as string[])
        : []) ?? [];
      const excluded = new Set(excludeIds);
      const nextId = world.pendingOrder.find(
        (id) => !excluded.has(id) && world.contacts.get(id)?.status === 'pending',
      );
      if (!nextId) return { rows: [], rowCount: 0 };
      const row = world.contacts.get(nextId)!;
      row.status = 'dialing';
      row.attempt_count += 1;
      row.last_attempted_at = '2026-04-27T03:00:00Z';
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // revertContactToPending
    if (/UPDATE campaign_contacts\s+SET status = 'pending'/i.test(sql)) {
      const id = String(values?.[0] ?? '');
      const row = world.contacts.get(id);
      if (row && row.status === 'dialing') {
        row.status = 'pending';
        row.attempt_count = Math.max(row.attempt_count - 1, 0);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // increment quiet_hours_skips
    if (/UPDATE campaigns\s+SET quiet_hours_skips/i.test(sql)) {
      const delta = Number(values?.[2] ?? 0);
      world.quietHoursSkips += delta;
      return { rows: [], rowCount: 1 };
    }

    // checkCampaignCompletion: getCampaign
    if (/SELECT \* FROM campaigns WHERE id = \$1 AND tenant_id = \$2/i.test(sql)) {
      return {
        rows: [
          {
            id: 'camp-1',
            tenant_id: 'tenant-1',
            agent_id: 'agent-1',
            name: 'Test',
            type: 'outbound_call',
            status: 'running',
            config: {},
            scheduled_at: null,
            started_at: null,
            completed_at: null,
            created_at: '2026-04-27T00:00:00Z',
            updated_at: '2026-04-27T00:00:00Z',
          },
        ],
        rowCount: 1,
      };
    }
    // checkCampaignCompletion: actionable count
    if (/SELECT COUNT\(\*\) AS actionable FROM campaign_contacts/i.test(sql)) {
      return { rows: [{ actionable: '5' }], rowCount: 1 };
    }

    // metrics aggregator: status counts
    if (/FROM campaign_contacts\s+WHERE campaign_id = \$1 AND tenant_id = \$2\s+GROUP BY status/i.test(sql)) {
      const counts = new Map<string, number>();
      for (const row of world.contacts.values()) {
        counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      }
      return {
        rows: Array.from(counts.entries()).map(([status, count]) => ({ status, count })),
        rowCount: counts.size,
      };
    }
    // metrics aggregator: attempted
    if (/SELECT COUNT\(\*\)::int AS attempted FROM campaign_contact_attempts/i.test(sql)) {
      return { rows: [{ attempted: 0 }], rowCount: 1 };
    }
    // metrics aggregator: read quiet_hours_skips
    if (/SELECT COALESCE\(quiet_hours_skips, 0\)::bigint AS quiet_hours_skips/i.test(sql)) {
      return { rows: [{ quiet_hours_skips: String(world.quietHoursSkips) }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };
}

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  dialContactMock.mockClear();
  isContactOnDncMock.mockClear();
});

describe('CampaignScheduler quiet-hours skip telemetry', () => {
  it('counts every quiet-hours skip and stops after 5 consecutive ones', async () => {
    // 11:00 UTC === 03:00 Pacific === 06:00 Eastern. Both fall outside
    // the 09:00–20:00 call window, so every contact in the roster is
    // skipped and the scheduler should hit the consecutive-skip ceiling.
    const fixedNow = new Date(Date.UTC(2026, 3, 27, 11, 0, 0));
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    // 10 east-coast contacts. The first 5 will all be skipped, the loop
    // should break at the cap, and contacts 6–10 must remain pending and
    // never reach `dialContact`.
    const ids = Array.from({ length: 10 }, (_, i) => `contact-${i + 1}`);
    const world: FakeWorld = {
      contacts: new Map(ids.map((id) => [id, makeContact(id, '212')])),
      pendingOrder: ids.slice(),
      quietHoursSkips: 0,
    };
    queryMock.mockImplementation(makeQueryDispatcher(world));

    const scheduler = new CampaignScheduler({
      outboundCallbackBaseUrl: 'https://example.test',
      statusCallbackUrl: 'https://example.test/status',
    });
    // Expose the private tick for direct control without running a timer.
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    // Skip cap is 5 — that's how many times we should have bumped the
    // counter before short-circuiting.
    expect(world.quietHoursSkips).toBe(5);

    // None of the contacts should have been dialed.
    expect(dialContactMock).not.toHaveBeenCalled();

    // The scheduler reverts each skipped contact back to pending so it
    // can be retried after the window opens.
    const stillPending = Array.from(world.contacts.values())
      .filter((c) => c.status === 'pending').length;
    expect(stillPending).toBe(world.contacts.size);

    // Contacts 6–10 were never touched (the cap fired before we got to
    // them), so their attempt_count should still be 0.
    for (let i = 5; i < 10; i++) {
      expect(world.contacts.get(`contact-${i + 1}`)!.attempt_count).toBe(0);
    }

    // The first 5 were each picked once and reverted, so attempt_count
    // is back at 0 (revertContactToPending decrements it).
    for (let i = 0; i < 5; i++) {
      expect(world.contacts.get(`contact-${i + 1}`)!.attempt_count).toBe(0);
    }

    vi.useRealTimers();
  });

  it('exposes quietHoursSkips on getCampaignMetrics so /campaigns/:id/metrics can render it', async () => {
    const fixedNow = new Date(Date.UTC(2026, 3, 27, 11, 0, 0));
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const ids = Array.from({ length: 10 }, (_, i) => `contact-${i + 1}`);
    const world: FakeWorld = {
      contacts: new Map(ids.map((id) => [id, makeContact(id, '212')])),
      pendingOrder: ids.slice(),
      quietHoursSkips: 0,
    };
    queryMock.mockImplementation(makeQueryDispatcher(world));

    const scheduler = new CampaignScheduler({
      outboundCallbackBaseUrl: 'https://example.test',
      statusCallbackUrl: 'https://example.test/status',
    });
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    const metrics = await getCampaignMetrics('tenant-1', 'camp-1');
    expect(metrics.quietHoursSkips).toBe(5);
    // Sanity: nothing actually dialed, so dialing/connected counts are 0.
    expect(metrics.dialing).toBe(0);
    expect(metrics.connected).toBe(0);

    vi.useRealTimers();
  });

  it('returns quietHoursSkips through the GET /campaigns/:id/metrics admin route', async () => {
    const fixedNow = new Date(Date.UTC(2026, 3, 27, 11, 0, 0));
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const ids = Array.from({ length: 10 }, (_, i) => `contact-${i + 1}`);
    const world: FakeWorld = {
      contacts: new Map(ids.map((id) => [id, makeContact(id, '212')])),
      pendingOrder: ids.slice(),
      quietHoursSkips: 0,
    };
    queryMock.mockImplementation(makeQueryDispatcher(world));

    const scheduler = new CampaignScheduler({
      outboundCallbackBaseUrl: 'https://example.test',
      statusCallbackUrl: 'https://example.test/status',
    });
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();

    const app = express();
    app.use(express.json());
    app.use(campaignsRouter);

    const res = await request(app).get('/campaigns/camp-1/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      campaignId: 'camp-1',
      metrics: { quietHoursSkips: 5 },
    });

    vi.useRealTimers();
  });
});
