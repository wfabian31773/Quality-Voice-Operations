import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEYS = [
  'APP_ENV',
  'DATABASE_URL',
  'PLATFORM_DB_POOL_URL',
  'DATABASE_URL_PRIVILEGED',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { closePlatformPool, resetPrivilegedFallbackWarningForTests } = await import('./index');
  resetPrivilegedFallbackWarningForTests();
  await closePlatformPool();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('pool URL helpers', () => {
  it('uses DATABASE_URL in development for the restricted pool', async () => {
    process.env.DATABASE_URL = 'postgresql://qvo_app:pw@localhost:5432/qvo';
    const { getRestrictedPoolUrl } = await import('./index');
    expect(getRestrictedPoolUrl()).toBe('postgresql://qvo_app:pw@localhost:5432/qvo');
  });

  it('uses PLATFORM_DB_POOL_URL outside development', async () => {
    process.env.APP_ENV = 'production';
    process.env.PLATFORM_DB_POOL_URL = 'postgresql://qvo_app:pw@db.example.com:6543/postgres';
    const { getRestrictedPoolUrl } = await import('./index');
    expect(getRestrictedPoolUrl()).toBe('postgresql://qvo_app:pw@db.example.com:6543/postgres');
  });

  it('prefers DATABASE_URL_PRIVILEGED for the privileged pool', async () => {
    process.env.DATABASE_URL = 'postgresql://qvo_app:pw@localhost:5432/qvo';
    process.env.DATABASE_URL_PRIVILEGED = 'postgresql://postgres:secret@localhost:5432/qvo';
    const { getPrivilegedPoolUrl } = await import('./index');
    expect(getPrivilegedPoolUrl()).toBe('postgresql://postgres:secret@localhost:5432/qvo');
  });

  it('falls back to the restricted URL with a loud warning', async () => {
    process.env.DATABASE_URL = 'postgresql://postgres:pw@localhost:5432/qvo';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getPrivilegedPoolUrl, resetPrivilegedFallbackWarningForTests } = await import('./index');
    resetPrivilegedFallbackWarningForTests();
    expect(getPrivilegedPoolUrl()).toBe('postgresql://postgres:pw@localhost:5432/qvo');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('DATABASE_URL_PRIVILEGED'))).toBe(true);
  });
});
