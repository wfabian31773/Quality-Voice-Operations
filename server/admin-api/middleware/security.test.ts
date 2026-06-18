import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isProductionLike, authCookieOptions, oauthStateCookieOptions, parseAllowedOrigins,
  corsOptions, securityHeaders, assertProductionSecrets, __resetAllowedOriginsForTests,
} from './security';

const ENV_KEYS = [
  'APP_ENV', 'NODE_ENV', 'ALLOWED_ORIGINS', 'ADMIN_JWT_SECRET', 'TURNSTILE_SECRET_KEY',
  'CONNECTOR_EMAIL_WEBHOOK_SECRET', 'CONNECTOR_ENCRYPTION_KEY',
  'BOOK_DEMO_SCHEDULER_PROVIDER', 'VITE_BOOK_DEMO_SCHEDULER_PROVIDER', 'CALENDLY_WEBHOOK_SECRET',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  __resetAllowedOriginsForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetAllowedOriginsForTests();
});

describe('isProductionLike', () => {
  it('is true for APP_ENV=production / staging', () => {
    process.env.APP_ENV = 'production';
    expect(isProductionLike()).toBe(true);
    process.env.APP_ENV = 'staging';
    expect(isProductionLike()).toBe(true);
  });
  it('is false for APP_ENV=development', () => {
    process.env.APP_ENV = 'development';
    expect(isProductionLike()).toBe(false);
  });
  it('falls back to NODE_ENV only when APP_ENV is unset', () => {
    process.env.NODE_ENV = 'production';
    expect(isProductionLike()).toBe(true);
    process.env.APP_ENV = 'development';
    expect(isProductionLike()).toBe(false); // APP_ENV wins
  });
});

describe('cookie options', () => {
  it('auth cookie is httpOnly + lax, secure only in prod', () => {
    expect(authCookieOptions()).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: false, path: '/' });
    process.env.APP_ENV = 'production';
    expect(authCookieOptions().secure).toBe(true);
  });
  it('auth cookie honours overrides', () => {
    expect(authCookieOptions({ maxAge: 123 }).maxAge).toBe(123);
  });
  it('oauth state cookie is scoped to /connectors/oauth', () => {
    expect(oauthStateCookieOptions()).toMatchObject({ httpOnly: true, path: '/connectors/oauth' });
  });
});

describe('parseAllowedOrigins', () => {
  it('returns an empty set for undefined', () => {
    expect(parseAllowedOrigins(undefined).size).toBe(0);
  });
  it('splits, trims, and drops trailing slashes', () => {
    const set = parseAllowedOrigins('https://a.com/, https://b.com ,, https://c.com');
    expect([...set]).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });
});

describe('corsOptions', () => {
  it('reflects any origin in dev', () => {
    expect(corsOptions()).toMatchObject({ origin: true, credentials: true });
  });
  it('in prod allows listed origins and a missing origin, rejects unknown', () => {
    process.env.APP_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    const opts = corsOptions();
    const origin = opts.origin as (o: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => void;

    let okListed: boolean | undefined;
    origin('https://app.example.com/', (_e, ok) => { okListed = ok; });
    expect(okListed).toBe(true);

    let okNoOrigin: boolean | undefined;
    origin(undefined, (_e, ok) => { okNoOrigin = ok; });
    expect(okNoOrigin).toBe(true);

    let err: Error | null = null;
    origin('https://evil.example.com', (e) => { err = e; });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('securityHeaders', () => {
  it('sets nosniff + SAMEORIGIN in dev and DENY in prod', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as never;
    const next = vi.fn();
    securityHeaders()({} as never, res, next);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(next).toHaveBeenCalled();

    process.env.APP_ENV = 'production';
    const prodHeaders: Record<string, string> = {};
    securityHeaders()({} as never, { setHeader: (k: string, v: string) => { prodHeaders[k] = v; } } as never, vi.fn());
    expect(prodHeaders['X-Frame-Options']).toBe('DENY');
  });
});

describe('assertProductionSecrets', () => {
  it('is a no-op outside production', () => {
    process.env.APP_ENV = 'development';
    expect(() => assertProductionSecrets()).not.toThrow();
  });
  it('throws in production when required secrets are missing', () => {
    process.env.APP_ENV = 'production';
    expect(() => assertProductionSecrets()).toThrow(/Refusing to start/);
  });
  it('passes in production when all required secrets are set', () => {
    process.env.APP_ENV = 'production';
    process.env.ADMIN_JWT_SECRET = 's';
    process.env.ALLOWED_ORIGINS = 'https://a.com';
    process.env.TURNSTILE_SECRET_KEY = 's';
    process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET = 's';
    expect(() => assertProductionSecrets()).not.toThrow();
  });
  it('additionally requires CALENDLY_WEBHOOK_SECRET when the demo provider is Calendly', () => {
    process.env.APP_ENV = 'production';
    process.env.ADMIN_JWT_SECRET = 's';
    process.env.ALLOWED_ORIGINS = 'https://a.com';
    process.env.TURNSTILE_SECRET_KEY = 's';
    process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET = 's';
    process.env.BOOK_DEMO_SCHEDULER_PROVIDER = 'calendly';
    expect(() => assertProductionSecrets()).toThrow(/CALENDLY_WEBHOOK_SECRET/);
    process.env.CALENDLY_WEBHOOK_SECRET = 's';
    expect(() => assertProductionSecrets()).not.toThrow();
  });
});
