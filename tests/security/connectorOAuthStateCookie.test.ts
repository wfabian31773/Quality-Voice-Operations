/**
 * Regression test for BL-027 — verifies the OAuth `state` cookie set by
 * `connectorOAuth.ts` carries the four required security attributes:
 *
 *   - `HttpOnly`
 *   - `Secure` (only when `APP_ENV` is production-like)
 *   - `SameSite=Lax`
 *   - `Max-Age=600`
 *
 * The cookie binds the URL `state` parameter to the user's browser session so
 * a leaked state value (referer, browser history, server logs) cannot be
 * replayed by an attacker. The callback verifies the cookie equals the
 * `state` query parameter before doing the token exchange.
 *
 * We mount the real `connectorOAuth` router on top of express + cookie-parser,
 * stub the auth + RBAC middleware, and assert the Set-Cookie header on
 * `/connectors/oauth/hubspot/init`. We also assert the callback rejects when
 * the cookie is missing or mismatched, to lock in the cookie binding itself
 * rather than just the attributes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const ORIGINAL_APP_ENV = process.env.APP_ENV;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID;
const ORIGINAL_HUBSPOT_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const ORIGINAL_ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;

// --- Module mocks ---------------------------------------------------------
//
// The OAuth router pulls in connector adapters, the audit log, and the
// region resolver at import time. None of that is needed for cookie
// behaviour, so we stub them away.

vi.mock('../../platform/integrations/connectors', () => ({
  upsertConnector: vi.fn(),
}));

vi.mock('../../platform/integrations/connectors/zohoRegion', () => ({
  resolveZohoAccountsServer: vi.fn(),
  resolveZohoApiDomain: vi.fn(),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () =>
    (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      tenantId: 'tenant-A',
      email: 'owner@acme.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    };
    next();
  },
}));

beforeAll(() => {
  // Force production-like behaviour so the `Secure` attribute is asserted.
  // We restore both `APP_ENV` and `NODE_ENV` after the suite runs so other
  // tests are unaffected.
  process.env.APP_ENV = 'production';
  process.env.NODE_ENV = 'production';
  process.env.HUBSPOT_CLIENT_ID = 'test-hubspot-client-id';
  process.env.HUBSPOT_CLIENT_SECRET = 'test-hubspot-client-secret';
  process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret-for-state-cookie';
});

afterAll(() => {
  if (ORIGINAL_APP_ENV === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = ORIGINAL_APP_ENV;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_HUBSPOT_CLIENT_ID === undefined) delete process.env.HUBSPOT_CLIENT_ID;
  else process.env.HUBSPOT_CLIENT_ID = ORIGINAL_HUBSPOT_CLIENT_ID;
  if (ORIGINAL_HUBSPOT_CLIENT_SECRET === undefined) delete process.env.HUBSPOT_CLIENT_SECRET;
  else process.env.HUBSPOT_CLIENT_SECRET = ORIGINAL_HUBSPOT_CLIENT_SECRET;
  if (ORIGINAL_ADMIN_JWT_SECRET === undefined) delete process.env.ADMIN_JWT_SECRET;
  else process.env.ADMIN_JWT_SECRET = ORIGINAL_ADMIN_JWT_SECRET;
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  // The security-options helper caches `isProductionLike()` indirectly via
  // the `ALLOWED_ORIGINS` cache; force a clean slate just in case another
  // test has cached the dev-mode allow-list.
  const security = await import('../../server/admin-api/middleware/security');
  security.__resetAllowedOriginsForTests();
  const router = (await import('../../server/admin-api/routes/connectorOAuth')).default;
  app.use('/', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Pulls the `oauth_state_<provider>` Set-Cookie line out of the response. We
 * normalise the supertest `set-cookie` header (which can be a string, an
 * array, or undefined) into an array first.
 */
function findStateCookie(res: request.Response, provider: string): string {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = cookies.find((c) => c.startsWith(`oauth_state_${provider}=`));
  if (!match) {
    throw new Error(
      `Expected Set-Cookie for oauth_state_${provider}; got: ${JSON.stringify(cookies)}`,
    );
  }
  return match;
}

describe('connectorOAuth — state cookie security attributes (BL-027)', () => {
  it('init sets the state cookie with HttpOnly, Secure, SameSite=Lax, Max-Age=600', async () => {
    const app = await buildApp();
    const res = await request(app)
      .get('/connectors/oauth/hubspot/init')
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(200);
    expect(res.body.authUrl).toMatch(/^https:\/\/app\.hubspot\.com\/oauth\/authorize/);

    const setCookie = findStateCookie(res, 'hubspot');

    // The four required attributes per BL-027 / RFC 9700 §4.7.
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=600(?!\d)/i);

    // Also assert the cookie is scoped to the OAuth route prefix so it never
    // leaks onto unrelated endpoints.
    expect(setCookie).toMatch(/Path=\/connectors\/oauth/i);
  });

  it('init omits the Secure flag in development (APP_ENV != production)', async () => {
    process.env.APP_ENV = 'development';
    process.env.NODE_ENV = 'development';
    // Re-import so the module-level isProductionLike snapshot is re-evaluated
    // against the new env. `vi.resetModules` ensures both the security helper
    // and the OAuth router get fresh copies.
    vi.resetModules();
    try {
      const app = await buildApp();
      const res = await request(app)
        .get('/connectors/oauth/hubspot/init')
        .set('host', 'admin.example.com')
        .set('x-forwarded-proto', 'https');

      expect(res.status).toBe(200);
      const setCookie = findStateCookie(res, 'hubspot');
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).not.toMatch(/Secure/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).toMatch(/Max-Age=600(?!\d)/i);
    } finally {
      // Restore prod env + reset module cache for the rest of the suite.
      process.env.APP_ENV = 'production';
      process.env.NODE_ENV = 'production';
      vi.resetModules();
    }
  });

  it('callback rejects when the state cookie is missing', async () => {
    const app = await buildApp();
    // Grab a valid state from init so the HMAC + age checks would pass.
    const init = await request(app)
      .get('/connectors/oauth/hubspot/init')
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https');
    const setCookie = findStateCookie(init, 'hubspot');
    const stateValue = decodeURIComponent(
      setCookie.split(';')[0].split('=').slice(1).join('='),
    );

    // Hit the callback WITHOUT sending the cookie back.
    const res = await request(app)
      .get('/connectors/oauth/hubspot/callback')
      .query({ code: 'test-code', state: stateValue })
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Invalid or expired state/);
  });

  it('callback rejects when the state cookie does not match the URL state', async () => {
    const app = await buildApp();
    const init = await request(app)
      .get('/connectors/oauth/hubspot/init')
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https');
    const setCookie = findStateCookie(init, 'hubspot');
    const stateValue = decodeURIComponent(
      setCookie.split(';')[0].split('=').slice(1).join('='),
    );

    // Send the cookie back, but with a different value than the URL state
    // parameter — this simulates a CSRF / replay attempt.
    const res = await request(app)
      .get('/connectors/oauth/hubspot/callback')
      .query({ code: 'test-code', state: stateValue })
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https')
      .set('Cookie', `oauth_state_hubspot=${encodeURIComponent('attacker-controlled-state')}`);

    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Invalid or expired state/);
  });

  it('callback clears the state cookie after consumption', async () => {
    const app = await buildApp();
    const init = await request(app)
      .get('/connectors/oauth/hubspot/init')
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https');
    const setCookie = findStateCookie(init, 'hubspot');
    const stateValue = decodeURIComponent(
      setCookie.split(';')[0].split('=').slice(1).join('='),
    );

    // Even the rejection path must clear the cookie so a leaked state cannot
    // be replayed against a stale cookie. We send a deliberately mismatched
    // cookie so we exit before the (stubbed) HubSpot token exchange.
    const res = await request(app)
      .get('/connectors/oauth/hubspot/callback')
      .query({ code: 'test-code', state: stateValue })
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https')
      .set('Cookie', `oauth_state_hubspot=${encodeURIComponent('mismatch')}`);

    expect(res.status).toBe(400);
    const clearRaw = res.headers['set-cookie'];
    const clearCookies = Array.isArray(clearRaw) ? clearRaw : clearRaw ? [clearRaw] : [];
    const cleared = clearCookies.find((c) => c.startsWith('oauth_state_hubspot='));
    expect(cleared, 'callback should clear the state cookie').toBeDefined();
    // Express clears cookies by setting an empty value with an expiry in the
    // past (Expires=Thu, 01 Jan 1970 00:00:00 GMT).
    expect(cleared!).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });
});
