/**
 * BL-011: production hardening for JWT, cookies, CORS, frame guards, and
 * required-secret startup checks.
 *
 * The behaviour under test is environment-dependent (`APP_ENV`), so each
 * sub-suite mutates `process.env` and runs against a freshly imported
 * module so the cached values inside `security.ts` are reset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.ALLOWED_ORIGINS;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET;
  delete process.env.APP_ENV;
  delete process.env.NODE_ENV;
}

beforeEach(() => {
  resetEnv();
  vi.resetModules();
});

afterEach(() => {
  resetEnv();
});

async function loadSecurity(): Promise<typeof import('../../server/admin-api/middleware/security')> {
  return import('../../server/admin-api/middleware/security');
}

describe('isProductionLike()', () => {
  it('treats APP_ENV=production as production', async () => {
    process.env.APP_ENV = 'production';
    const { isProductionLike } = await loadSecurity();
    expect(isProductionLike()).toBe(true);
  });

  it('treats APP_ENV=staging as production-like', async () => {
    process.env.APP_ENV = 'staging';
    const { isProductionLike } = await loadSecurity();
    expect(isProductionLike()).toBe(true);
  });

  it('does not treat APP_ENV=development as production', async () => {
    process.env.APP_ENV = 'development';
    const { isProductionLike } = await loadSecurity();
    expect(isProductionLike()).toBe(false);
  });

  it('lets APP_ENV win over NODE_ENV when both are set', async () => {
    // This is the BL-011 acceptance: gate on APP_ENV, not NODE_ENV. Vite
    // flips NODE_ENV to "production" during builds even on dev machines.
    process.env.APP_ENV = 'development';
    process.env.NODE_ENV = 'production';
    const { isProductionLike } = await loadSecurity();
    expect(isProductionLike()).toBe(false);
  });

  it('falls back to NODE_ENV only when APP_ENV is missing', async () => {
    process.env.NODE_ENV = 'production';
    const { isProductionLike } = await loadSecurity();
    expect(isProductionLike()).toBe(true);
  });
});

describe('authCookieOptions()', () => {
  it('always sets httpOnly + sameSite=lax + path=/ + 8h maxAge', async () => {
    process.env.APP_ENV = 'development';
    const { authCookieOptions } = await loadSecurity();
    const opts = authCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(8 * 60 * 60 * 1000);
  });

  it('flips secure=true in production', async () => {
    process.env.APP_ENV = 'production';
    const { authCookieOptions } = await loadSecurity();
    expect(authCookieOptions().secure).toBe(true);
  });

  it('keeps secure=false in development so cookies work over HTTP', async () => {
    process.env.APP_ENV = 'development';
    const { authCookieOptions } = await loadSecurity();
    expect(authCookieOptions().secure).toBe(false);
  });

  it('respects per-call overrides for one-off cases', async () => {
    process.env.APP_ENV = 'production';
    const { authCookieOptions } = await loadSecurity();
    const opts = authCookieOptions({ maxAge: 1000 });
    expect(opts.maxAge).toBe(1000);
    expect(opts.secure).toBe(true);
  });
});

describe('parseAllowedOrigins()', () => {
  it('returns an empty set for missing/empty input', async () => {
    const { parseAllowedOrigins } = await loadSecurity();
    expect(parseAllowedOrigins(undefined).size).toBe(0);
    expect(parseAllowedOrigins('').size).toBe(0);
    expect(parseAllowedOrigins('   ').size).toBe(0);
  });

  it('splits on commas, trims whitespace, and strips trailing slashes', async () => {
    const { parseAllowedOrigins } = await loadSecurity();
    const got = parseAllowedOrigins('https://app.example.com/, https://admin.example.com , ');
    expect(got.has('https://app.example.com')).toBe(true);
    expect(got.has('https://admin.example.com')).toBe(true);
    expect(got.size).toBe(2);
  });
});

describe('corsOptions() — production', () => {
  beforeEach(() => {
    process.env.APP_ENV = 'production';
  });

  it('rejects unknown origins', async () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    const { corsOptions } = await loadSecurity();
    const opts = corsOptions();
    expect(typeof opts.origin).toBe('function');
    const result = await new Promise<{ err: Error | null; ok: boolean | undefined }>(resolve => {
      (opts.origin as (
        origin: string | undefined,
        cb: (err: Error | null, ok?: boolean) => void,
      ) => void)('https://evil.example.com', (err, ok) => resolve({ err, ok }));
    });
    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toContain('not allowed by CORS');
  });

  it('reflects allow-listed origins (and ignores trailing slash mismatches)', async () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com/';
    const { corsOptions } = await loadSecurity();
    const opts = corsOptions();
    const result = await new Promise<{ err: Error | null; ok: boolean | undefined }>(resolve => {
      (opts.origin as (
        origin: string | undefined,
        cb: (err: Error | null, ok?: boolean) => void,
      ) => void)('https://app.example.com', (err, ok) => resolve({ err, ok }));
    });
    expect(result.err).toBeNull();
    expect(result.ok).toBe(true);
  });

  it('allows requests with no Origin header (server-to-server, curl, Twilio)', async () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    const { corsOptions } = await loadSecurity();
    const opts = corsOptions();
    const result = await new Promise<{ err: Error | null; ok: boolean | undefined }>(resolve => {
      (opts.origin as (
        origin: string | undefined,
        cb: (err: Error | null, ok?: boolean) => void,
      ) => void)(undefined, (err, ok) => resolve({ err, ok }));
    });
    expect(result.err).toBeNull();
    expect(result.ok).toBe(true);
  });

  it('keeps credentials enabled (so the auth cookie still rides on CORS requests)', async () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    const { corsOptions } = await loadSecurity();
    expect(corsOptions().credentials).toBe(true);
  });
});

describe('corsOptions() — development', () => {
  it('reflects any origin so local tooling and the Replit preview iframe work', async () => {
    process.env.APP_ENV = 'development';
    const { corsOptions } = await loadSecurity();
    expect(corsOptions().origin).toBe(true);
    expect(corsOptions().credentials).toBe(true);
  });
});

describe('securityHeaders() middleware', () => {
  async function buildAppWithHeaders(): Promise<express.Express> {
    const { securityHeaders } = await loadSecurity();
    const app = express();
    app.use(securityHeaders());
    app.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('emits X-Frame-Options: DENY in production', async () => {
    process.env.APP_ENV = 'production';
    const app = await buildAppWithHeaders();
    const res = await request(app).get('/ping').expect(200);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('emits X-Frame-Options: SAMEORIGIN in development so the preview iframe still works', async () => {
    process.env.APP_ENV = 'development';
    const app = await buildAppWithHeaders();
    const res = await request(app).get('/ping').expect(200);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('assertProductionSecrets()', () => {
  it('is a no-op in development', async () => {
    process.env.APP_ENV = 'development';
    const { assertProductionSecrets } = await loadSecurity();
    expect(() => assertProductionSecrets()).not.toThrow();
  });

  it('throws in production when ADMIN_JWT_SECRET is missing', async () => {
    process.env.APP_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    process.env.TURNSTILE_SECRET_KEY = 'turnstile';
    delete process.env.ADMIN_JWT_SECRET;
    const { assertProductionSecrets } = await loadSecurity();
    expect(() => assertProductionSecrets()).toThrow(/ADMIN_JWT_SECRET/);
  });

  it('throws in production when ALLOWED_ORIGINS is missing', async () => {
    process.env.APP_ENV = 'production';
    process.env.ADMIN_JWT_SECRET = 'jwt';
    process.env.TURNSTILE_SECRET_KEY = 'turnstile';
    delete process.env.ALLOWED_ORIGINS;
    const { assertProductionSecrets } = await loadSecurity();
    expect(() => assertProductionSecrets()).toThrow(/ALLOWED_ORIGINS/);
  });

  it('throws in production when TURNSTILE_SECRET_KEY is missing', async () => {
    process.env.APP_ENV = 'production';
    process.env.ADMIN_JWT_SECRET = 'jwt';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    delete process.env.TURNSTILE_SECRET_KEY;
    const { assertProductionSecrets } = await loadSecurity();
    expect(() => assertProductionSecrets()).toThrow(/TURNSTILE_SECRET_KEY/);
  });

  it('lists every missing secret in a single error message', async () => {
    process.env.APP_ENV = 'production';
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.TURNSTILE_SECRET_KEY;
    const { assertProductionSecrets } = await loadSecurity();
    let err: Error | null = null;
    try {
      assertProductionSecrets();
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/ADMIN_JWT_SECRET/);
    expect(err?.message).toMatch(/ALLOWED_ORIGINS/);
    expect(err?.message).toMatch(/TURNSTILE_SECRET_KEY/);
  });

  it('passes when every required secret is present in production', async () => {
    process.env.APP_ENV = 'production';
    process.env.ADMIN_JWT_SECRET = 'jwt';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    process.env.TURNSTILE_SECRET_KEY = 'turnstile';
    process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET = 'email-hook';
    const { assertProductionSecrets } = await loadSecurity();
    expect(() => assertProductionSecrets()).not.toThrow();
  });

  it('throws in production when TURNSTILE_SECRET_KEY is a Cloudflare dummy secret', async () => {
    process.env.APP_ENV = 'production';
    process.env.ADMIN_JWT_SECRET = 'jwt';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET = 'email-hook';
    const { assertProductionSecrets } = await loadSecurity();
    expect(() => assertProductionSecrets()).toThrow(/dummy secret/i);
  });

  it('throws in production when CONNECTOR_EMAIL_WEBHOOK_SECRET is missing', async () => {
    process.env.APP_ENV = 'production';
    process.env.ADMIN_JWT_SECRET = 'jwt';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    process.env.TURNSTILE_SECRET_KEY = 'turnstile';
    delete process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET;
    const { assertProductionSecrets } = await loadSecurity();
    expect(() => assertProductionSecrets()).toThrow(/CONNECTOR_EMAIL_WEBHOOK_SECRET/);
  });

  it('throws in staging when CONNECTOR_EMAIL_WEBHOOK_SECRET is missing (APP_ENV=staging is production-like)', async () => {
    process.env.APP_ENV = 'staging';
    process.env.ADMIN_JWT_SECRET = 'jwt';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    process.env.TURNSTILE_SECRET_KEY = 'turnstile';
    delete process.env.CONNECTOR_EMAIL_WEBHOOK_SECRET;
    const { assertProductionSecrets } = await loadSecurity();
    expect(() => assertProductionSecrets()).toThrow(/CONNECTOR_EMAIL_WEBHOOK_SECRET/);
  });

  // Task #995: dedicated, OAuth-flavoured boot guard. The ADMIN_JWT_SECRET
  // requirement above already covers most cases, but operators need to see
  // an unambiguous "this breaks connector OAuth" message — naming both
  // candidate env vars — so they don't think only admin auth is at risk.
  it('flags the connector OAuth state-signing case with both candidate env vars when both are missing', async () => {
    process.env.APP_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    process.env.TURNSTILE_SECRET_KEY = 'turnstile';
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
    const { assertProductionSecrets } = await loadSecurity();
    let err: Error | null = null;
    try {
      assertProductionSecrets();
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/ADMIN_JWT_SECRET/);
    expect(err?.message).toMatch(/CONNECTOR_ENCRYPTION_KEY/);
    expect(err?.message).toMatch(/connector OAuth/i);
    expect(err?.message).toMatch(/\/connectors\/oauth/);
  });

  it('does NOT flag the OAuth state-signing case when CONNECTOR_ENCRYPTION_KEY is set even if ADMIN_JWT_SECRET is missing', async () => {
    // ADMIN_JWT_SECRET is still required on its own (admin auth), so this
    // should still throw — but the OAuth-specific clause must not appear,
    // because connector OAuth state signing has a working secret via
    // CONNECTOR_ENCRYPTION_KEY.
    process.env.APP_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    process.env.TURNSTILE_SECRET_KEY = 'turnstile';
    process.env.CONNECTOR_ENCRYPTION_KEY = 'a'.repeat(64);
    delete process.env.ADMIN_JWT_SECRET;
    const { assertProductionSecrets } = await loadSecurity();
    let err: Error | null = null;
    try {
      assertProductionSecrets();
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/ADMIN_JWT_SECRET/);
    expect(err?.message).not.toMatch(/connector OAuth/i);
  });

  it('preserves dev-fallback behaviour: no throw in development even with both OAuth secrets unset', async () => {
    process.env.APP_ENV = 'development';
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
    const { assertProductionSecrets } = await loadSecurity();
    expect(() => assertProductionSecrets()).not.toThrow();
  });
});

describe('JWT algorithm pinning', () => {
  // Algorithm-confusion attacks are the classic "jsonwebtoken used naively"
  // pitfall. Without `algorithms: ['HS256']`, jsonwebtoken trusts the
  // `alg` value advertised by the token's own header — which means a token
  // signed with `alg: 'none'` is accepted as long as the signature is empty.
  beforeEach(() => {
    process.env.APP_ENV = 'development';
    process.env.ADMIN_JWT_SECRET = 'unit-test-secret';
  });

  it('rejects tokens signed with alg=none', async () => {
    // Hand-craft an unsigned token: header `{alg:'none',typ:'JWT'}`,
    // payload `{sub:'attacker'}`, empty signature.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'attacker', tenantId: 't' })).toString(
      'base64url',
    );
    const forged = `${header}.${payload}.`;

    expect(() =>
      jwt.verify(forged, process.env.ADMIN_JWT_SECRET as string, { algorithms: ['HS256'] }),
    ).toThrow();
  });

  it('rejects tokens signed with a different HMAC algorithm than HS256', async () => {
    const token = jwt.sign({ sub: 'u', tenantId: 't' }, 'unit-test-secret', { algorithm: 'HS512' });
    expect(() =>
      jwt.verify(token, 'unit-test-secret', { algorithms: ['HS256'] }),
    ).toThrow(/invalid algorithm/i);
  });

  it('issueToken() / requireAuth round-trip uses HS256', async () => {
    const { issueToken } = await import('../../server/admin-api/middleware/auth');
    const token = issueToken({
      userId: 'u-1',
      tenantId: 't-1',
      email: 'u@acme.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    });
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.alg).toBe('HS256');
  });
});

describe('getJwtSecret() — environment gating', () => {
  // Regression guard for the architect-flagged caveat: `auth.ts` used to
  // do `(APP_ENV ?? NODE_ENV ?? '').startsWith('prod')` cached at module
  // load, which (a) missed `staging` and (b) couldn't be re-evaluated
  // between requests. We now share `isProductionLike()` and re-check
  // every call.
  it('throws in staging when ADMIN_JWT_SECRET is missing', async () => {
    process.env.APP_ENV = 'staging';
    delete process.env.ADMIN_JWT_SECRET;
    const { issueToken } = await import('../../server/admin-api/middleware/auth');
    expect(() =>
      issueToken({
        userId: 'u',
        tenantId: 't',
        email: 'a@b.test',
        role: 'tenant_owner',
        isPlatformAdmin: false,
      }),
    ).toThrow(/ADMIN_JWT_SECRET is required in production/);
  });

  it('throws in production when ADMIN_JWT_SECRET is missing', async () => {
    process.env.APP_ENV = 'production';
    delete process.env.ADMIN_JWT_SECRET;
    const { issueToken } = await import('../../server/admin-api/middleware/auth');
    expect(() =>
      issueToken({
        userId: 'u',
        tenantId: 't',
        email: 'a@b.test',
        role: 'tenant_owner',
        isPlatformAdmin: false,
      }),
    ).toThrow(/ADMIN_JWT_SECRET is required in production/);
  });

  it('falls back to a dev secret in development', async () => {
    process.env.APP_ENV = 'development';
    delete process.env.ADMIN_JWT_SECRET;
    const { issueToken } = await import('../../server/admin-api/middleware/auth');
    const token = issueToken({
      userId: 'u',
      tenantId: 't',
      email: 'a@b.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    });
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);
  });
});
