import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const a = vi.hoisted(() => ({ poolQueryMock: vi.fn() }));

vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.poolQueryMock }) }));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import {
  encryptSchedulerSecret, decryptSchedulerSecret, resolveEnvFallbackConfig,
  getDemoSchedulerSettings, getPublicDemoSchedulerConfig, getActiveCalcomWebhookSecret,
  getActiveCalendlyWebhookSecret, toAdminView, setDemoSchedulerSettings,
  DemoSchedulerSettingsValidationError,
} from './demo-scheduler-settings';

const ENV_KEYS = ['BOOK_DEMO_SCHEDULER_PROVIDER', 'VITE_BOOK_DEMO_SCHEDULER_PROVIDER', 'VITE_BOOK_DEMO_SCHEDULER_URL', 'CALCOM_WEBHOOK_SECRET', 'CALENDLY_WEBHOOK_SECRET'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('encrypt/decrypt round trip', () => {
  it('decrypts what it encrypts', () => {
    const secret = 'super-secret-webhook-key';
    const ct = encryptSchedulerSecret(secret);
    expect(ct).not.toContain(secret);
    expect(decryptSchedulerSecret(ct)).toBe(secret);
  });
});

describe('resolveEnvFallbackConfig', () => {
  it('defaults to cal.com', () => {
    expect(resolveEnvFallbackConfig()).toMatchObject({ provider: 'cal.com' });
  });
  it('honours a calendly provider override', () => {
    process.env.BOOK_DEMO_SCHEDULER_PROVIDER = 'calendly';
    expect(resolveEnvFallbackConfig().provider).toBe('calendly');
  });
});

describe('getDemoSchedulerSettings', () => {
  it('uses the env fallback when there is no DB row', async () => {
    const s = await getDemoSchedulerSettings();
    expect(s.provider).toBe('cal.com');
    expect(s.calcomWebhookSecretEncrypted).toBeNull();
  });
  it('coerces a stored value', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ value: { provider: 'calendly', embedUrl: 'https://calendly.com/qvo', calcomWebhookSecretEncrypted: 'abc' } }] });
    const s = await getDemoSchedulerSettings();
    expect(s.provider).toBe('calendly');
    expect(s.calcomWebhookSecretEncrypted).toBe('abc');
  });
  it('falls back on a query error', async () => {
    a.poolQueryMock.mockRejectedValue(new Error('db down'));
    expect((await getDemoSchedulerSettings()).provider).toBe('cal.com');
  });
  it('getPublicDemoSchedulerConfig exposes only provider + embedUrl', async () => {
    const cfg = await getPublicDemoSchedulerConfig();
    expect(Object.keys(cfg).sort()).toEqual(['embedUrl', 'provider']);
  });
});

describe('active webhook secrets', () => {
  it('prefers the env var for Cal.com', async () => {
    process.env.CALCOM_WEBHOOK_SECRET = 'env-calcom-secret';
    expect(await getActiveCalcomWebhookSecret()).toBe('env-calcom-secret');
  });
  it('decrypts the DB secret when no env var is set (Cal.com)', async () => {
    const ct = encryptSchedulerSecret('db-calcom-secret-xyz');
    a.poolQueryMock.mockResolvedValue({ rows: [{ value: { provider: 'cal.com', embedUrl: 'https://cal.com/qvo', calcomWebhookSecretEncrypted: ct } }] });
    expect(await getActiveCalcomWebhookSecret()).toBe('db-calcom-secret-xyz');
  });
  it('returns null when no Cal.com secret exists anywhere', async () => {
    expect(await getActiveCalcomWebhookSecret()).toBeNull();
  });
  it('prefers the env var for Calendly', async () => {
    process.env.CALENDLY_WEBHOOK_SECRET = 'env-calendly-secret';
    expect(await getActiveCalendlyWebhookSecret()).toBe('env-calendly-secret');
  });
  it('returns null when no Calendly secret exists anywhere', async () => {
    expect(await getActiveCalendlyWebhookSecret()).toBeNull();
  });
});

describe('toAdminView', () => {
  it('reports configured flags without leaking secrets', () => {
    const view = toAdminView({ provider: 'cal.com', embedUrl: 'https://cal.com/x', calcomWebhookSecretEncrypted: 'ct', calendlyWebhookSecretEncrypted: null });
    expect(view).toEqual({ provider: 'cal.com', embedUrl: 'https://cal.com/x', calcomWebhookSecretConfigured: true, calendlyWebhookSecretConfigured: false });
  });
});

describe('setDemoSchedulerSettings', () => {
  it('rejects an invalid provider', async () => {
    await expect(setDemoSchedulerSettings({ provider: 'google' as never }, 'admin')).rejects.toBeInstanceOf(DemoSchedulerSettingsValidationError);
  });
  it('rejects an invalid embed URL', async () => {
    await expect(setDemoSchedulerSettings({ embedUrl: 'not-a-url' }, 'admin')).rejects.toBeInstanceOf(DemoSchedulerSettingsValidationError);
  });
  it('rejects a too-short webhook secret', async () => {
    await expect(setDemoSchedulerSettings({ calcomWebhookSecret: 'short' }, 'admin')).rejects.toBeInstanceOf(DemoSchedulerSettingsValidationError);
  });
  it('encrypts a valid secret and persists', async () => {
    const next = await setDemoSchedulerSettings({ calcomWebhookSecret: 'a-sufficiently-long-secret' }, 'admin');
    expect(next.calcomWebhookSecretEncrypted).toBeTruthy();
    expect(decryptSchedulerSecret(next.calcomWebhookSecretEncrypted!)).toBe('a-sufficiently-long-secret');
    const insertCall = a.poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO platform_settings'));
    expect(insertCall).toBeTruthy();
  });
  it('clears a secret when passed null', async () => {
    const next = await setDemoSchedulerSettings({ calendlyWebhookSecret: null }, 'admin');
    expect(next.calendlyWebhookSecretEncrypted).toBeNull();
  });
});
