import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const a = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));

vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.poolQueryMock }) }));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import {
  getSalesAlertSettings, setSalesAlertSettings, getAdminBaseUrl, getSalesInboxDeepLink,
  DEFAULT_SALES_ALERT_SETTINGS,
} from './sales-alert-settings';

const URL_KEYS = ['PLATFORM_ADMIN_BASE_URL', 'ADMIN_PUBLIC_URL', 'APP_PUBLIC_URL', 'ADMIN_API_BASE_URL'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  for (const k of URL_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of URL_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('getSalesAlertSettings', () => {
  it('returns defaults when no row exists', async () => {
    expect(await getSalesAlertSettings()).toEqual(DEFAULT_SALES_ALERT_SETTINGS);
  });
  it('coerces a stored value, filtering invalid email recipients and non-https slack urls', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ value: {
      channels: { email: false, slack: true },
      emailRecipients: ['good@x.com', 'bad-email', '  spaced@y.com  '],
      slackWebhookUrl: 'http://insecure',
      notifyOnNewLead: false,
    } }] });
    const s = await getSalesAlertSettings();
    expect(s.channels.email).toBe(false);
    expect(s.emailRecipients).toEqual(['good@x.com', 'spaced@y.com']);
    expect(s.slackWebhookUrl).toBeNull();
    expect(s.notifyOnNewLead).toBe(false);
  });
  it('falls back to defaults on a query error', async () => {
    a.poolQueryMock.mockRejectedValue(new Error('db down'));
    expect(await getSalesAlertSettings()).toEqual(DEFAULT_SALES_ALERT_SETTINGS);
  });
});

describe('setSalesAlertSettings', () => {
  it('merges the patch over current settings and persists', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('SELECT value') ? { rows: [] } : { rows: [] },
    );
    const next = await setSalesAlertSettings(
      { channels: { email: true, slack: false }, emailRecipients: ['a@b.com', 'nope'], slackWebhookUrl: 'https://hooks.slack.com/x', notifyOnBookingCancelled: false },
      'admin-1',
    );
    expect(next.channels).toEqual({ email: true, slack: false });
    expect(next.emailRecipients).toEqual(['a@b.com']);
    expect(next.slackWebhookUrl).toBe('https://hooks.slack.com/x');
    expect(next.notifyOnBookingCancelled).toBe(false);
    // The persistence INSERT ran with the serialized value.
    const insertCall = a.poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO platform_settings'));
    expect(insertCall).toBeTruthy();
  });
  it('nulls a non-https slack webhook in the patch', async () => {
    const next = await setSalesAlertSettings({ slackWebhookUrl: 'ftp://nope' }, null);
    expect(next.slackWebhookUrl).toBeNull();
  });
});

describe('url helpers', () => {
  it('getAdminBaseUrl prefers PLATFORM_ADMIN_BASE_URL and trims trailing slashes', () => {
    process.env.PLATFORM_ADMIN_BASE_URL = 'https://admin.example.com/';
    expect(getAdminBaseUrl()).toBe('https://admin.example.com');
  });
  it('getAdminBaseUrl falls back through the candidate chain', () => {
    process.env.ADMIN_API_BASE_URL = 'https://api.example.com';
    expect(getAdminBaseUrl()).toBe('https://api.example.com');
  });
  it('getAdminBaseUrl returns empty string when nothing is set', () => {
    expect(getAdminBaseUrl()).toBe('');
  });
  it('getSalesInboxDeepLink builds an absolute link with a lead anchor', () => {
    process.env.PLATFORM_ADMIN_BASE_URL = 'https://admin.example.com';
    expect(getSalesInboxDeepLink(42)).toBe('https://admin.example.com/admin/sales-inbox#lead-42');
  });
  it('getSalesInboxDeepLink falls back to a relative path with no lead', () => {
    expect(getSalesInboxDeepLink(null)).toBe('/admin/sales-inbox');
  });
});
