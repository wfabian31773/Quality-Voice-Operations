/** Tests for the plan-recommendation digest scheduler. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const privilegedQueryMock = vi.fn();
const tenantClientQueryMock = vi.fn();
const tenantClientReleaseMock = vi.fn();
const withTenantContextCalls: string[] = [];

vi.mock('../../platform/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../platform/db');
  return {
    ...actual,
    withPrivilegedClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: privilegedQueryMock }),
    ),
    withTenantContext: vi.fn(
      async (
        _client: unknown,
        tenantId: string,
        fn: () => Promise<unknown>,
      ) => {
        withTenantContextCalls.push(tenantId);
        return fn();
      },
    ),
    getPlatformPool: () => ({
      connect: async () => ({
        query: tenantClientQueryMock,
        release: tenantClientReleaseMock,
      }),
    }),
  };
});

vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(),
}));

vi.mock('../../platform/notifications/NotificationPreferences', () => ({
  isChannelEnabled: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/effectiveRate', () => ({
  getTenantEffectiveRate: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  runPlanRecommendationDigestCycle,
  getTenantRecommendationDigestStatus,
  PLAN_RECOMMENDATION_AUDIT_ACTION,
} from '../../platform/billing/PlanRecommendationDigestScheduler';
import { sendEmail } from '../../platform/email/EmailService';
import { writeAuditLog } from '../../platform/audit/AuditService';
import { isChannelEnabled } from '../../platform/notifications/NotificationPreferences';
import { getTenantEffectiveRate } from '../../platform/billing/stripe/effectiveRate';

const sendEmailMock = vi.mocked(sendEmail);
const writeAuditLogMock = vi.mocked(writeAuditLog);
const isChannelEnabledMock = vi.mocked(isChannelEnabled);
const getTenantEffectiveRateMock = vi.mocked(getTenantEffectiveRate);

const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_REPLIT_DEV_DOMAIN = process.env.REPLIT_DEV_DOMAIN;

const PRO_RATE = {
  plan: 'pro' as const,
  basePriceCents: 39_900,
  overageRatePerMinute: 0.12,
  currency: 'usd',
  source: 'catalog' as const,
  basePriceSource: 'catalog' as const,
  overagePriceSource: 'catalog' as const,
  basePriceId: null,
  overagePriceId: null,
};

const STARTER_RATE = {
  plan: 'starter' as const,
  basePriceCents: 9_900,
  overageRatePerMinute: 0.15,
  currency: 'usd',
  source: 'catalog' as const,
  basePriceSource: 'catalog' as const,
  overagePriceSource: 'catalog' as const,
  basePriceId: null,
  overagePriceId: null,
};

const PERIOD_START = new Date('2026-04-01T00:00:00.000Z');

function dueTenantRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tenant_id: 'tenant-1',
    tenant_name: 'Acme Plumbing',
    owner_user_id: 'user-1',
    owner_email: 'owner@acme.test',
    owner_first_name: 'Ada',
    owner_last_name: 'Owner',
    current_period_start: PERIOD_START,
    last_emailed_at: null,
    ...overrides,
  };
}

function mockUsageRows(...minutes: number[]) {
  tenantClientQueryMock.mockImplementation(async (sql: string) => {
    const head = sql.trim().toUpperCase();
    if (head.startsWith('BEGIN') || head.startsWith('COMMIT') || head.startsWith('ROLLBACK')) {
      return { rows: [] };
    }
    return { rows: minutes.map((m) => ({ minutes: String(m) })) };
  });
}

beforeEach(() => {
  privilegedQueryMock.mockReset();
  tenantClientQueryMock.mockReset();
  tenantClientReleaseMock.mockReset();
  sendEmailMock.mockReset();
  writeAuditLogMock.mockReset();
  isChannelEnabledMock.mockReset();
  getTenantEffectiveRateMock.mockReset();
  withTenantContextCalls.length = 0;
  process.env.APP_URL = 'https://app.test.qvo.ai';
  delete process.env.REPLIT_DEV_DOMAIN;
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = ORIGINAL_APP_URL;
  }
  if (ORIGINAL_REPLIT_DEV_DOMAIN === undefined) {
    delete process.env.REPLIT_DEV_DOMAIN;
  } else {
    process.env.REPLIT_DEV_DOMAIN = ORIGINAL_REPLIT_DEV_DOMAIN;
  }
});

describe('runPlanRecommendationDigestCycle', () => {
  it('is a no-op when no tenants are due', async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [] });

    const result = await runPlanRecommendationDigestCycle();

    expect(result.scanned).toBe(0);
    expect(result.emailed).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
    expect(tenantClientQueryMock).not.toHaveBeenCalled();
  });

  it('emails the owner and writes a period-keyed audit row when a cheaper plan exists', async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [dueTenantRow()] });
    mockUsageRows(300, 300, 300);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(true);
    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_1' });
    writeAuditLogMock.mockResolvedValueOnce(undefined);

    const result = await runPlanRecommendationDigestCycle();

    expect(result.emailed).toBe(1);
    expect(withTenantContextCalls).toEqual(['tenant-1']);
    expect(tenantClientReleaseMock).toHaveBeenCalled();

    const sentMessage = sendEmailMock.mock.calls[0][0];
    expect(sentMessage.to).toBe('owner@acme.test');
    expect(sentMessage.html).toContain('https://app.test.qvo.ai/billing');
    expect(sentMessage.subject).toMatch(/save \$/i);
    expect(sentMessage.subject).toContain('Starter');

    const auditCall = writeAuditLogMock.mock.calls[0][0];
    expect(auditCall.action).toBe(PLAN_RECOMMENDATION_AUDIT_ACTION);
    expect(auditCall.actorUserId).toBeNull();
    expect(auditCall.actorRole).toBe('system');
    expect(auditCall.changes).toMatchObject({
      currentPlan: 'pro',
      recommendedPlan: 'starter',
      sentBy: 'PlanRecommendationDigestScheduler',
      messageId: 'msg_1',
      periodStart: PERIOD_START.toISOString(),
    });
  });

  it('eligibility SQL gates on billing-cycle close and casts periodStart to timestamptz', async () => {
    // Comparing the JSON-stored ISO-8601 value as TEXT to TIMESTAMP::text
    // never matches; lock in the timestamptz casts on both sides.
    privilegedQueryMock.mockResolvedValueOnce({ rows: [] });

    await runPlanRecommendationDigestCycle();

    expect(privilegedQueryMock).toHaveBeenCalledTimes(1);
    const sql = privilegedQueryMock.mock.calls[0][0] as string;

    expect(sql).toMatch(/JOIN\s+subscriptions/i);
    expect(sql).toMatch(/status\s+IN\s*\(\s*'active'\s*,\s*'past_due'\s*\)/i);
    expect(sql).toMatch(/current_period_start\s*>\s*s\.created_at\s*\+\s*INTERVAL/i);
    expect(sql).toMatch(/changes->>'periodStart'\)::timestamptz/);
    expect(sql).toMatch(/s\.current_period_start\s+AT\s+TIME\s+ZONE\s+'UTC'/i);
    expect(sql).toMatch(/last_emailed_period_start[\s\S]*<>[\s\S]*current_period_start\s+AT\s+TIME\s+ZONE\s+'UTC'/i);

    expect(privilegedQueryMock.mock.calls[0][1][0]).toBe(
      PLAN_RECOMMENDATION_AUDIT_ACTION,
    );
  });

  it('persists periodStart as ISO-8601 parseable by Postgres ::timestamptz', async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [dueTenantRow()] });
    mockUsageRows(300, 300, 300);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(true);
    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_1' });

    await runPlanRecommendationDigestCycle();

    const persisted = (writeAuditLogMock.mock.calls[0][0].changes as {
      periodStart: string;
    }).periodStart;
    expect(persisted).toBe('2026-04-01T00:00:00.000Z');
    expect(new Date(persisted).getTime()).toBe(PERIOD_START.getTime());
  });

  it('skips tenants who are already on the cheapest plan (no email, no audit)', async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [dueTenantRow()] });
    mockUsageRows(100, 100, 100);
    getTenantEffectiveRateMock.mockResolvedValueOnce(STARTER_RATE);

    const result = await runPlanRecommendationDigestCycle();

    expect(result.skippedAlreadyOptimal).toBe(1);
    expect(result.emailed).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('skips tenants whose owner has opted out of billing emails', async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [dueTenantRow()] });
    mockUsageRows(300, 300, 300);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(false);

    const result = await runPlanRecommendationDigestCycle();

    expect(result.skippedOptedOut).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
    expect(isChannelEnabledMock).toHaveBeenCalledWith('user-1', 'billing', 'email');
  });

  it('skips tenants with zero trailing AI-minute usage', async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [dueTenantRow()] });
    mockUsageRows(0, 0, 0);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);

    const result = await runPlanRecommendationDigestCycle();

    expect(result.skippedNoUsage).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
    expect(isChannelEnabledMock).not.toHaveBeenCalled();
  });

  it('does NOT write the audit row when the email send fails (so the next tick retries)', async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [dueTenantRow()] });
    mockUsageRows(300, 300, 300);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(true);
    sendEmailMock.mockResolvedValueOnce({
      success: false,
      error: 'temporary smtp glitch',
    });

    const result = await runPlanRecommendationDigestCycle();

    expect(result.failed).toBe(1);
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('bails out cleanly when no absolute base URL is configured', async () => {
    delete process.env.APP_URL;
    delete process.env.REPLIT_DEV_DOMAIN;

    const result = await runPlanRecommendationDigestCycle();

    expect(result.skippedNoBaseUrl).toBe(1);
    expect(privilegedQueryMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

/**
 * Per-tenant status snapshot used by the in-app /billing recommendation
 * card. Tests focus on the *contract* the UI relies on — every reason
 * branch + a `nextScheduledAt` clamped sensibly relative to the period
 * and cooldown gates — rather than on the internal SQL shape, which the
 * scheduler-cycle tests above already lock down.
 */
describe('getTenantRecommendationDigestStatus', () => {
  function lookupRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      owner_user_id: 'user-1',
      status: 'active',
      current_period_start: new Date('2026-04-01T00:00:00.000Z'),
      current_period_end: new Date('2026-05-01T00:00:00.000Z'),
      last_emailed_at: null,
      last_emailed_period_start: null,
      ...overrides,
    };
  }

  it("returns 'no_active_subscription' when the tenant has no subscription row", async () => {
    privilegedQueryMock.mockResolvedValueOnce({
      rows: [lookupRow({ status: null, current_period_start: null })],
    });

    const status = await getTenantRecommendationDigestStatus('tenant-1');

    expect(status.reason).toBe('no_active_subscription');
    expect(status.nextScheduledAt).toBeNull();
    expect(getTenantEffectiveRateMock).not.toHaveBeenCalled();
  });

  it("returns 'no_active_subscription' when the tenant row is missing entirely", async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [] });

    const status = await getTenantRecommendationDigestStatus('tenant-missing');

    expect(status.reason).toBe('no_active_subscription');
    expect(status.nextScheduledAt).toBeNull();
  });

  it("returns 'no_usage' when the trailing window has no AI minutes", async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [lookupRow()] });
    mockUsageRows(0, 0, 0);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(true);

    const status = await getTenantRecommendationDigestStatus('tenant-1');

    expect(status.reason).toBe('no_usage');
    expect(status.nextScheduledAt).toBeNull();
  });

  it("returns 'already_optimal' when the tenant is on the cheapest plan for their usage", async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [lookupRow()] });
    mockUsageRows(100, 100, 100);
    getTenantEffectiveRateMock.mockResolvedValueOnce(STARTER_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(true);

    const status = await getTenantRecommendationDigestStatus('tenant-1');

    expect(status.reason).toBe('already_optimal');
    expect(status.nextScheduledAt).toBeNull();
  });

  it("returns 'opted_out' when the owner disabled billing emails (preempts the recommendation)", async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [lookupRow()] });
    mockUsageRows(300, 300, 300);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(false);

    const status = await getTenantRecommendationDigestStatus('tenant-1');

    expect(status.reason).toBe('opted_out');
    expect(status.ownerOptedIn).toBe(false);
    expect(status.nextScheduledAt).toBeNull();
    expect(isChannelEnabledMock).toHaveBeenCalledWith('user-1', 'billing', 'email');
  });

  it("returns 'scheduled' with nextScheduledAt = now when both gates are open", async () => {
    privilegedQueryMock.mockResolvedValueOnce({
      rows: [lookupRow({ last_emailed_at: null, last_emailed_period_start: null })],
    });
    mockUsageRows(300, 300, 300);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(true);

    const before = Date.now();
    const status = await getTenantRecommendationDigestStatus('tenant-1');
    const after = Date.now();

    expect(status.reason).toBe('scheduled');
    expect(status.nextScheduledAt).not.toBeNull();
    const ts = new Date(status.nextScheduledAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 5);
  });

  it("returns 'scheduled' with nextScheduledAt clamped to the period end when already emailed this cycle", async () => {
    // Period end deliberately in the FUTURE so the period-gate clamp
    // wins over the `now` floor — otherwise the assertion is sensitive
    // to whatever wall-clock the test runner happens to be at.
    const now = Date.now();
    const periodStart = new Date(now - 5 * 24 * 60 * 60 * 1000);
    const periodEnd = new Date(now + 25 * 24 * 60 * 60 * 1000);
    const lastEmailedAt = new Date(now - 4 * 24 * 60 * 60 * 1000);
    privilegedQueryMock.mockResolvedValueOnce({
      rows: [
        lookupRow({
          current_period_start: periodStart,
          current_period_end: periodEnd,
          last_emailed_at: lastEmailedAt,
          last_emailed_period_start: periodStart,
        }),
      ],
    });
    mockUsageRows(300, 300, 300);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(true);

    const status = await getTenantRecommendationDigestStatus('tenant-1');

    expect(status.reason).toBe('scheduled');
    expect(status.nextScheduledAt).toBe(periodEnd.toISOString());
    expect(status.lastEmailedAt).toBe(lastEmailedAt.toISOString());
  });

  it("returns 'scheduled' with nextScheduledAt clamped to last_emailed_at + cooldown when cooldown is the binding gate", async () => {
    // 1-day-old email, cooldown defaults to 28 days, period gate is open
    // (different period from current) — cooldown should win.
    const lastEmailedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    privilegedQueryMock.mockResolvedValueOnce({
      rows: [
        lookupRow({
          last_emailed_at: lastEmailedAt,
          last_emailed_period_start: new Date('2026-03-01T00:00:00.000Z'),
        }),
      ],
    });
    mockUsageRows(300, 300, 300);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(true);

    const status = await getTenantRecommendationDigestStatus('tenant-1');

    expect(status.reason).toBe('scheduled');
    expect(status.nextScheduledAt).not.toBeNull();
    const ts = new Date(status.nextScheduledAt!).getTime();
    const expected = lastEmailedAt.getTime() + status.cooldownDays * 24 * 60 * 60 * 1000;
    expect(ts).toBe(expected);
  });

  it('exposes the scheduler config (cooldownDays + lookbackMonths) so the UI can explain cadence', async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [lookupRow()] });
    mockUsageRows(300, 300, 300);
    getTenantEffectiveRateMock.mockResolvedValueOnce(PRO_RATE);
    isChannelEnabledMock.mockResolvedValueOnce(true);

    const status = await getTenantRecommendationDigestStatus('tenant-1');

    expect(status.cooldownDays).toBeGreaterThan(0);
    expect(status.lookbackMonths).toBeGreaterThan(0);
  });
});
