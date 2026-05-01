/** Tests for the weekly upgrade vs. downgrade recommendation digest. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const privilegedQueryMock = vi.fn();
const poolQueryMock = vi.fn();

vi.mock('../../platform/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../platform/db');
  return {
    ...actual,
    withPrivilegedClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: privilegedQueryMock }),
    ),
    getPlatformPool: () => ({
      query: poolQueryMock,
    }),
  };
});

vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('../../platform/notifications/NotificationPreferences', () => ({
  filterUserIdsByPreference: vi.fn(),
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
  runRecommendationDirectionDigestCycle,
  aggregateRecommendationsByDirection,
  loadOptedInPlatformAdminRecipients,
} from '../../platform/billing/RecommendationDirectionDigestScheduler';
import { sendEmail } from '../../platform/email/EmailService';
import { filterUserIdsByPreference } from '../../platform/notifications/NotificationPreferences';

const sendEmailMock = vi.mocked(sendEmail);
const filterUserIdsByPreferenceMock = vi.mocked(filterUserIdsByPreference);

const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_REPLIT_DEV_DOMAIN = process.env.REPLIT_DEV_DOMAIN;
const ORIGINAL_COOLDOWN = process.env.RECOMMENDATION_DIRECTION_DIGEST_COOLDOWN_DAYS;
const ORIGINAL_WINDOW = process.env.RECOMMENDATION_DIRECTION_DIGEST_WINDOW_DAYS;

const DIRECTION_ROWS = [
  {
    direction: 'upgrade',
    impressions: '120',
    clicks: '40',
    completed_switches: '8',
    monthly_savings_cents: '320000',
  },
  {
    direction: 'downgrade',
    impressions: '60',
    clicks: '18',
    completed_switches: '6',
    monthly_savings_cents: '210000',
  },
  {
    direction: 'lateral',
    impressions: '5',
    clicks: '2',
    completed_switches: '1',
    monthly_savings_cents: '0',
  },
];

const ADMIN_USERS = [
  { id: 'admin-1', email: 'finance@qvo.test' },
  { id: 'admin-2', email: 'cfo@qvo.test' },
];

beforeEach(() => {
  privilegedQueryMock.mockReset();
  poolQueryMock.mockReset();
  sendEmailMock.mockReset();
  filterUserIdsByPreferenceMock.mockReset();
  process.env.APP_URL = 'https://app.test.qvo.ai';
  delete process.env.REPLIT_DEV_DOMAIN;
  delete process.env.RECOMMENDATION_DIRECTION_DIGEST_COOLDOWN_DAYS;
  delete process.env.RECOMMENDATION_DIRECTION_DIGEST_WINDOW_DAYS;
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
  if (ORIGINAL_REPLIT_DEV_DOMAIN === undefined) delete process.env.REPLIT_DEV_DOMAIN;
  else process.env.REPLIT_DEV_DOMAIN = ORIGINAL_REPLIT_DEV_DOMAIN;
  if (ORIGINAL_COOLDOWN === undefined) delete process.env.RECOMMENDATION_DIRECTION_DIGEST_COOLDOWN_DAYS;
  else process.env.RECOMMENDATION_DIRECTION_DIGEST_COOLDOWN_DAYS = ORIGINAL_COOLDOWN;
  if (ORIGINAL_WINDOW === undefined) delete process.env.RECOMMENDATION_DIRECTION_DIGEST_WINDOW_DAYS;
  else process.env.RECOMMENDATION_DIRECTION_DIGEST_WINDOW_DAYS = ORIGINAL_WINDOW;
});

describe('aggregateRecommendationsByDirection', () => {
  it('returns the three known directions in stable order even when buckets are empty', async () => {
    privilegedQueryMock.mockResolvedValueOnce({
      rows: [
        {
          direction: 'upgrade',
          impressions: '5',
          clicks: '2',
          completed_switches: '1',
          monthly_savings_cents: '4500',
        },
      ],
    });

    const rows = await aggregateRecommendationsByDirection(7);

    expect(rows.map((r) => r.direction)).toEqual(['upgrade', 'downgrade', 'lateral']);
    expect(rows[0]).toMatchObject({
      direction: 'upgrade',
      impressions: 5,
      clicks: 2,
      completedSwitches: 1,
      monthlySavingsCents: 4500,
    });
    // Empty buckets coerce to 0 rather than disappearing.
    expect(rows[1]).toMatchObject({
      direction: 'downgrade',
      impressions: 0,
      clicks: 0,
      completedSwitches: 0,
      monthlySavingsCents: 0,
    });
  });

  it('passes window days as a string-bound interval to keep the index plan', async () => {
    privilegedQueryMock.mockResolvedValueOnce({ rows: [] });

    await aggregateRecommendationsByDirection(14);

    const [sql, params] = privilegedQueryMock.mock.calls[0];
    expect(sql).toMatch(/billing_recommendation_events/);
    expect(sql).toMatch(/event_type IN \('impression', 'click', 'switch_completed'\)/);
    // The CASE clause derives direction from tier rank — must stay
    // identical to the dashboard route's `byDirection` SQL so the email
    // and the in-app tile never disagree.
    expect(sql).toMatch(/WHEN current_tier = recommended_tier THEN 'lateral'/);
    expect(sql).toMatch(/recommended_tier IN \('pro', 'starter'\)/);
    expect(params).toEqual(['14']);
  });

  it('drops unknown direction buckets from the result', async () => {
    privilegedQueryMock.mockResolvedValueOnce({
      rows: [
        {
          direction: 'unknown',
          impressions: '99',
          clicks: '50',
          completed_switches: '10',
          monthly_savings_cents: '99999',
        },
      ],
    });

    const rows = await aggregateRecommendationsByDirection(7);
    // All three known buckets remain at zero.
    expect(rows.every((r) => r.impressions === 0)).toBe(true);
  });
});

describe('loadOptedInPlatformAdminRecipients', () => {
  it('filters out admins who silenced the billing email channel', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        { id: 'admin-1', email: 'a@qvo.test' },
        { id: 'admin-2', email: 'b@qvo.test' },
      ],
    });
    filterUserIdsByPreferenceMock.mockResolvedValueOnce(['admin-1']);

    const recipients = await loadOptedInPlatformAdminRecipients();

    expect(filterUserIdsByPreferenceMock).toHaveBeenCalledWith(
      ['admin-1', 'admin-2'],
      'billing',
      'email',
    );
    expect(recipients).toEqual([{ userId: 'admin-1', email: 'a@qvo.test' }]);
  });

  it('returns empty when no platform admins are configured', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    const recipients = await loadOptedInPlatformAdminRecipients();
    expect(recipients).toEqual([]);
    expect(filterUserIdsByPreferenceMock).not.toHaveBeenCalled();
  });

  it('dedupes case-insensitive duplicate emails so an aliased admin only gets one ping', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        { id: 'admin-1', email: 'Finance@qvo.test' },
        { id: 'admin-2', email: 'finance@qvo.test' },
      ],
    });
    filterUserIdsByPreferenceMock.mockResolvedValueOnce(['admin-1', 'admin-2']);

    const recipients = await loadOptedInPlatformAdminRecipients();

    expect(recipients).toHaveLength(1);
    expect(recipients[0].email.toLowerCase()).toBe('finance@qvo.test');
  });
});

describe('runRecommendationDirectionDigestCycle', () => {
  function mockSettingsRead(value: { sent_at?: string } | null): void {
    poolQueryMock.mockImplementationOnce(async (sql: string) => {
      expect(sql).toMatch(/SELECT value FROM platform_settings/);
      return { rows: value === null ? [] : [{ value }] };
    });
  }

  function mockAdminUsersRead(rows: typeof ADMIN_USERS): void {
    poolQueryMock.mockImplementationOnce(async (sql: string) => {
      expect(sql).toMatch(/is_platform_admin = TRUE/);
      return { rows };
    });
  }

  function mockSettingsWrite(): void {
    poolQueryMock.mockImplementationOnce(async (sql: string) => {
      expect(sql).toMatch(/INSERT INTO platform_settings/);
      return { rowCount: 1, rows: [] };
    });
  }

  it('skips when APP_URL is not configured', async () => {
    delete process.env.APP_URL;
    delete process.env.REPLIT_DEV_DOMAIN;

    const result = await runRecommendationDirectionDigestCycle();

    expect(result.skippedNoBaseUrl).toBe(true);
    expect(result.emailed).toBe(0);
    expect(privilegedQueryMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('skips when still inside cooldown window', async () => {
    const recentSentAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    mockSettingsRead({ sent_at: recentSentAt.toISOString() });

    const result = await runRecommendationDirectionDigestCycle();

    expect(result.skippedCooldown).toBe(true);
    expect(privilegedQueryMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('enforces a true weekly cadence: skip at day 6, send at day 7', async () => {
    // Day 6: still inside the default 7-day cooldown — must NOT send.
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000 - 60_000);
    mockSettingsRead({ sent_at: sixDaysAgo.toISOString() });

    const skipResult = await runRecommendationDirectionDigestCycle();
    expect(skipResult.skippedCooldown).toBe(true);
    expect(skipResult.cooldownDays).toBe(7);
    expect(sendEmailMock).not.toHaveBeenCalled();

    // Day 7+: the daily ticker now lapses past the cooldown boundary
    // and a fresh send goes out.
    poolQueryMock.mockReset();
    sendEmailMock.mockReset();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 - 60_000);
    mockSettingsRead({ sent_at: sevenDaysAgo.toISOString() });
    privilegedQueryMock.mockResolvedValueOnce({ rows: DIRECTION_ROWS });
    mockAdminUsersRead(ADMIN_USERS);
    filterUserIdsByPreferenceMock.mockResolvedValueOnce(['admin-1', 'admin-2']);
    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_2' });
    mockSettingsWrite();

    const sendResult = await runRecommendationDirectionDigestCycle();
    expect(sendResult.skippedCooldown).toBe(false);
    expect(sendResult.emailed).toBe(2);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('skips silently when no activity is recorded in the window', async () => {
    mockSettingsRead(null);
    privilegedQueryMock.mockResolvedValueOnce({ rows: [] }); // no events

    const result = await runRecommendationDirectionDigestCycle();

    expect(result.skippedNoActivity).toBe(true);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Crucially: cooldown row not written, so when activity returns the
    // next tick can send immediately.
    const settingsWrites = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO platform_settings'),
    );
    expect(settingsWrites).toHaveLength(0);
  });

  it('skips when there are no opted-in platform admins', async () => {
    mockSettingsRead(null);
    privilegedQueryMock.mockResolvedValueOnce({ rows: DIRECTION_ROWS });
    mockAdminUsersRead(ADMIN_USERS);
    filterUserIdsByPreferenceMock.mockResolvedValueOnce([]); // everyone opted out

    const result = await runRecommendationDirectionDigestCycle();

    expect(result.skippedNoRecipients).toBe(true);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends the digest to opted-in admins and records the cooldown', async () => {
    mockSettingsRead(null); // never sent
    privilegedQueryMock.mockResolvedValueOnce({ rows: DIRECTION_ROWS });
    mockAdminUsersRead(ADMIN_USERS);
    filterUserIdsByPreferenceMock.mockResolvedValueOnce(['admin-1', 'admin-2']);
    sendEmailMock.mockResolvedValueOnce({ success: true, messageId: 'msg_1' });
    mockSettingsWrite();

    const result = await runRecommendationDirectionDigestCycle();

    expect(result.emailed).toBe(2);
    expect(result.recipients).toBe(2);
    expect(result.skippedCooldown).toBe(false);

    const sent = sendEmailMock.mock.calls[0][0];
    expect(sent.to).toBe('finance@qvo.test, cfo@qvo.test');
    expect(sent.subject).toMatch(/Weekly recommendation digest/);
    // Email surfaces upgrade and downgrade arms separately + combined.
    expect(sent.html).toContain('Upgrade arm');
    expect(sent.html).toContain('Downgrade arm');
    expect(sent.html).toContain('Combined monthly savings unlocked');
    // $5,300.00 = (320000 + 210000) / 100
    expect(sent.html).toContain('$5,300.00');
    // Deep link to the platform admin dashboard.
    expect(sent.html).toContain('/admin/billing-recommendations');
  });

  it('does not record the cooldown when the email send fails', async () => {
    mockSettingsRead(null);
    privilegedQueryMock.mockResolvedValueOnce({ rows: DIRECTION_ROWS });
    mockAdminUsersRead(ADMIN_USERS);
    filterUserIdsByPreferenceMock.mockResolvedValueOnce(['admin-1']);
    sendEmailMock.mockResolvedValueOnce({
      success: false,
      error: 'SMTP timeout',
      permanent: false,
    });

    const result = await runRecommendationDirectionDigestCycle();

    expect(result.failed).toBe(true);
    expect(result.emailed).toBe(0);
    const settingsWrites = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO platform_settings'),
    );
    expect(settingsWrites).toHaveLength(0);
  });

  it('respects an env-configured cooldown override', async () => {
    process.env.RECOMMENDATION_DIRECTION_DIGEST_COOLDOWN_DAYS = '14';
    // Sent 10 days ago — would normally be eligible (default 6-day cooldown)
    // but the 14-day override should suppress.
    const lastSent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    mockSettingsRead({ sent_at: lastSent.toISOString() });

    const result = await runRecommendationDirectionDigestCycle();

    expect(result.skippedCooldown).toBe(true);
    expect(result.cooldownDays).toBe(14);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
