import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPlatformConfig, isProduction, isDevelopment } from './config';
import { validateEnv, getRequiredSecrets } from './validate';

const KEYS = [
  'APP_ENV',
  'DATABASE_URL',
  'PLATFORM_DB_POOL_URL',
  'PORT',
  'LOG_LEVEL',
  'BUILD_VERSION',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getPlatformConfig', () => {
  it('reads development config and defaults', () => {
    process.env.DATABASE_URL = 'postgres://dev';
    const cfg = getPlatformConfig();
    expect(cfg).toMatchObject({
      env: 'development',
      port: 8000,
      logLevel: 'info',
      databaseUrl: 'postgres://dev',
      buildVersion: 'local',
    });
  });

  it('honors PORT, LOG_LEVEL and BUILD_VERSION overrides', () => {
    process.env.DATABASE_URL = 'postgres://dev';
    process.env.PORT = '9090';
    process.env.LOG_LEVEL = 'debug';
    process.env.BUILD_VERSION = 'abc123';
    const cfg = getPlatformConfig();
    expect(cfg.port).toBe(9090);
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.buildVersion).toBe('abc123');
  });

  it('tolerates a missing dev database url (warns, empty string)', () => {
    expect(getPlatformConfig().databaseUrl).toBe('');
  });

  it('requires PLATFORM_DB_POOL_URL outside development', () => {
    process.env.APP_ENV = 'production';
    expect(() => getPlatformConfig()).toThrow('PLATFORM_DB_POOL_URL is not set');
    process.env.PLATFORM_DB_POOL_URL = 'postgres://prod';
    expect(getPlatformConfig().databaseUrl).toBe('postgres://prod');
  });
});

describe('isProduction / isDevelopment', () => {
  it('reflects APP_ENV', () => {
    expect(isDevelopment()).toBe(true);
    expect(isProduction()).toBe(false);
    process.env.APP_ENV = 'production';
    expect(isProduction()).toBe(true);
    expect(isDevelopment()).toBe(false);
    process.env.APP_ENV = 'staging';
    expect(isDevelopment()).toBe(false);
    expect(isProduction()).toBe(false);
  });
});

describe('getRequiredSecrets', () => {
  it('includes DATABASE_URL in development and the pool url otherwise', () => {
    expect(getRequiredSecrets()).toContain('DATABASE_URL');
    process.env.APP_ENV = 'production';
    const prod = getRequiredSecrets();
    expect(prod).toContain('PLATFORM_DB_POOL_URL');
    expect(prod).not.toContain('DATABASE_URL');
  });
});

describe('validateEnv', () => {
  it('does not throw when all required keys are present', () => {
    process.env.PRESENT_KEY = 'x';
    expect(() => validateEnv(['PRESENT_KEY'])).not.toThrow();
    delete process.env.PRESENT_KEY;
  });

  it('throws in production when required keys are missing', () => {
    process.env.APP_ENV = 'production';
    expect(() => validateEnv(['DEFINITELY_MISSING_KEY'])).toThrow('Missing required secrets in production');
  });

  it('only warns (no throw) when missing outside production', () => {
    expect(() => validateEnv(['DEFINITELY_MISSING_KEY'])).not.toThrow();
  });
});
