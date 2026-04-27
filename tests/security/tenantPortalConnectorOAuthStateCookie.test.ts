/**
 * Tenant-portal regression for BL-027 (per Task #540).
 *
 * The "tenant portal" — the React `client-app` — does not host its own backend
 * OAuth endpoints. It calls into the same `/connectors/oauth/<provider>/init`
 * routes on `server/admin-api/routes/connectorOAuth.ts` that the Platform
 * Admin console uses (see `client-app/src/pages/Connectors.tsx`). That means
 * the per-provider state-cookie protection added by Task #518 already covers
 * tenant-portal users — but only as long as **every** provider's init handler
 * actually calls `setStateCookie()` and **every** callback calls
 * `consumeStateCookie()` with the matching cookie name.
 *
 * The original `connectorOAuthStateCookie.test.ts` only exercises the HubSpot
 * routes. If a future provider is added (or an existing one is refactored)
 * and the author forgets the cookie binding, today's tests would not catch
 * it. This file walks every provider in the OAuth registry and asserts:
 *
 *   1. The init handler sets `oauth_state_<provider>` with all four required
 *      attributes (`HttpOnly`, `Secure` in prod, `SameSite=Lax`, `Max-Age=600`)
 *      and `Path=/connectors/oauth` scoping.
 *   2. The callback rejects the request when the cookie is absent (the
 *      tenant-portal popup-flow case where a stolen / replayed `state` value
 *      arrives without the user's cookie jar).
 *   3. The callback rejects the request when the cookie value does not match
 *      the URL `state` parameter (the CSRF / cookie-fixation case).
 *
 * Together these lock in defense-in-depth for every connector the tenant
 * portal can launch, and will fail loudly the moment a provider is added
 * without the shared `oauthStateCookieOptions()` helper.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const ORIGINAL_ENV: Record<string, string | undefined> = {};

function snapshotEnv(keys: string[]): void {
  for (const key of keys) {
    ORIGINAL_ENV[key] = process.env[key];
  }
}

function restoreEnv(keys: string[]): void {
  for (const key of keys) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

// --- Module mocks --------------------------------------------------------
//
// The OAuth router pulls in real connector adapters, the audit log, and the
// Zoho region resolver at import time. None of that is needed to assert the
// cookie binding, so we stub them here. We also stub `requireAuth` and
// `requireRole` so we can hit the init endpoints as a synthetic tenant
// owner without spinning up a real JWT.

vi.mock('../../platform/integrations/connectors', () => ({
  upsertConnector: vi.fn(),
}));

vi.mock('../../platform/integrations/connectors/zohoRegion', () => ({
  resolveZohoAccountsServer: vi.fn().mockReturnValue('https://accounts.zoho.com'),
  resolveZohoApiDomain: vi.fn().mockReturnValue('https://www.zohoapis.com'),
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
      userId: 'tenant-portal-user-1',
      tenantId: 'tenant-portal-tenant-A',
      email: 'owner@tenant-portal.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    };
    next();
  },
}));

/**
 * The full set of OAuth providers exposed to tenant-portal users via the
 * connectors page. This list mirrors `OAUTH_PROVIDER_REGISTRY` in
 * `connectorOAuth.ts` — keeping them in lockstep is the whole point of this
 * test. Each entry carries the env vars its init/callback handlers read so we
 * can populate them before booting the router.
 */
const TENANT_PORTAL_OAUTH_PROVIDERS = [
  {
    provider: 'hubspot',
    env: { id: 'HUBSPOT_CLIENT_ID', secret: 'HUBSPOT_CLIENT_SECRET' },
  },
  {
    provider: 'google',
    env: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
  },
  {
    provider: 'outlook',
    env: { id: 'MICROSOFT_CLIENT_ID', secret: 'MICROSOFT_CLIENT_SECRET' },
  },
  {
    provider: 'slack',
    env: { id: 'SLACK_CLIENT_ID', secret: 'SLACK_CLIENT_SECRET' },
  },
  {
    provider: 'pipedrive',
    env: { id: 'PIPEDRIVE_CLIENT_ID', secret: 'PIPEDRIVE_CLIENT_SECRET' },
  },
  {
    provider: 'salesforce',
    env: { id: 'SALESFORCE_CLIENT_ID', secret: 'SALESFORCE_CLIENT_SECRET' },
  },
  {
    provider: 'quickbooks',
    env: { id: 'QUICKBOOKS_CLIENT_ID', secret: 'QUICKBOOKS_CLIENT_SECRET' },
  },
  {
    provider: 'zoho',
    env: { id: 'ZOHO_CLIENT_ID', secret: 'ZOHO_CLIENT_SECRET' },
  },
] as const;

const ENV_KEYS = [
  'APP_ENV',
  'NODE_ENV',
  'ADMIN_JWT_SECRET',
  ...TENANT_PORTAL_OAUTH_PROVIDERS.flatMap((p) => [p.env.id, p.env.secret]),
];

beforeAll(() => {
  snapshotEnv(ENV_KEYS);
  // Force production-like behaviour so the `Secure` attribute is asserted.
  process.env.APP_ENV = 'production';
  process.env.NODE_ENV = 'production';
  process.env.ADMIN_JWT_SECRET = 'tenant-portal-test-jwt-secret-for-state-cookie';
  for (const { env } of TENANT_PORTAL_OAUTH_PROVIDERS) {
    process.env[env.id] = `test-${env.id.toLowerCase()}`;
    process.env[env.secret] = `test-${env.secret.toLowerCase()}`;
  }
});

afterAll(() => {
  restoreEnv(ENV_KEYS);
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  // The security helper caches `isProductionLike()` indirectly via the
  // `ALLOWED_ORIGINS` cache; reset to avoid bleed-through from sibling
  // suites that toggled env vars.
  const security = await import('../../server/admin-api/middleware/security');
  security.__resetAllowedOriginsForTests();
  const router = (await import('../../server/admin-api/routes/connectorOAuth')).default;
  app.use('/', router);
  return app;
}

/**
 * Pulls the `oauth_state_<provider>` Set-Cookie line out of the response.
 * Supertest normalises `set-cookie` into a string, an array, or undefined —
 * we coerce to an array so callers can search uniformly.
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

/**
 * Extracts the raw state value from the `Set-Cookie` line returned by an
 * init endpoint. We URL-decode because Express percent-encodes cookie values
 * (the HMAC-signed state contains `.` which is fine, but base64url padding
 * could trip future-provider state encodings).
 */
function extractStateValue(setCookie: string): string {
  const valuePart = setCookie.split(';')[0].split('=').slice(1).join('=');
  return decodeURIComponent(valuePart);
}

describe('tenant-portal connector OAuth — state cookie uniformity (BL-027 / Task #540)', () => {
  describe.each(TENANT_PORTAL_OAUTH_PROVIDERS)(
    '$provider',
    ({ provider }) => {
      it('init sets oauth_state_<provider> with HttpOnly, Secure, SameSite=Lax, Max-Age=600, Path scoping', async () => {
        const app = await buildApp();
        const res = await request(app)
          .get(`/connectors/oauth/${provider}/init`)
          .set('host', 'tenant-portal.example.com')
          .set('x-forwarded-proto', 'https');

        // The init endpoint returns the provider's authorize URL as JSON. If
        // it returned 400 the env wiring above is wrong, not the cookie code.
        expect(
          res.status,
          `init for ${provider} returned ${res.status}: ${JSON.stringify(res.body)}`,
        ).toBe(200);
        expect(typeof res.body.authUrl).toBe('string');

        const setCookie = findStateCookie(res, provider);

        // The four required attributes per BL-027 / RFC 9700 §4.7.
        expect(setCookie, `oauth_state_${provider} missing HttpOnly`).toMatch(/HttpOnly/i);
        expect(setCookie, `oauth_state_${provider} missing Secure (prod)`).toMatch(/Secure/i);
        expect(setCookie, `oauth_state_${provider} missing SameSite=Lax`).toMatch(/SameSite=Lax/i);
        expect(setCookie, `oauth_state_${provider} missing Max-Age=600`).toMatch(/Max-Age=600(?!\d)/i);

        // Cookie must be scoped to the OAuth route prefix so it never leaks
        // onto unrelated tenant-portal endpoints.
        expect(setCookie, `oauth_state_${provider} not scoped to /connectors/oauth`).toMatch(
          /Path=\/connectors\/oauth/i,
        );
      });

      it('callback rejects when the state cookie is missing', async () => {
        const app = await buildApp();
        const init = await request(app)
          .get(`/connectors/oauth/${provider}/init`)
          .set('host', 'tenant-portal.example.com')
          .set('x-forwarded-proto', 'https');
        const stateValue = extractStateValue(findStateCookie(init, provider));

        // Hit the callback WITHOUT sending the cookie back — simulates a
        // CSRF / replayed `state` arriving without the user's cookie jar.
        // QuickBooks needs a `realmId` to get past the early-return that
        // happens before the cookie check, so we always supply one. Other
        // providers ignore unknown query params.
        const res = await request(app)
          .get(`/connectors/oauth/${provider}/callback`)
          .query({ code: 'test-code', state: stateValue, realmId: 'test-realm' })
          .set('host', 'tenant-portal.example.com')
          .set('x-forwarded-proto', 'https');

        expect(
          res.status,
          `${provider} callback should reject missing cookie; body=${res.text.slice(0, 200)}`,
        ).toBe(400);
        expect(res.text).toMatch(/Invalid or expired state/);
      });

      it('callback rejects + clears the cookie when it does not match the URL state', async () => {
        const app = await buildApp();
        const init = await request(app)
          .get(`/connectors/oauth/${provider}/init`)
          .set('host', 'tenant-portal.example.com')
          .set('x-forwarded-proto', 'https');
        const stateValue = extractStateValue(findStateCookie(init, provider));

        // Send the cookie back with an attacker-controlled value so the
        // constant-time compare against the URL `state` fails. We use a
        // value the same length to make sure we exercise the
        // `crypto.timingSafeEqual` path rather than the length short-circuit.
        const decoyState = stateValue
          .replace(/./g, 'x')
          .slice(0, stateValue.length);

        const res = await request(app)
          .get(`/connectors/oauth/${provider}/callback`)
          .query({ code: 'test-code', state: stateValue, realmId: 'test-realm' })
          .set('host', 'tenant-portal.example.com')
          .set('x-forwarded-proto', 'https')
          .set(
            'Cookie',
            `oauth_state_${provider}=${encodeURIComponent(decoyState)}`,
          );

        expect(
          res.status,
          `${provider} callback should reject mismatched cookie; body=${res.text.slice(0, 200)}`,
        ).toBe(400);
        expect(res.text).toMatch(/Invalid or expired state/);

        // Even on rejection the cookie must be cleared so a leaked state
        // value cannot be replayed against a stale cookie.
        const clearRaw = res.headers['set-cookie'];
        const clearCookies = Array.isArray(clearRaw) ? clearRaw : clearRaw ? [clearRaw] : [];
        const cleared = clearCookies.find((c) => c.startsWith(`oauth_state_${provider}=`));
        expect(cleared, `${provider} callback should clear the state cookie on rejection`).toBeDefined();
        // Express clears cookies by setting Expires in 1970.
        expect(cleared!).toMatch(/Expires=Thu, 01 Jan 1970/i);
      });
    },
  );

  it('every advertised tenant-portal provider has a corresponding init route', async () => {
    // Defense-in-depth: if `OAUTH_PROVIDER_REGISTRY` in the router gains a
    // new provider but a sibling test forgets to add it here, this assertion
    // surfaces the gap. We compare against the `availability` endpoint which
    // enumerates the real registry rather than re-importing internals.
    const app = await buildApp();
    const res = await request(app)
      .get('/connectors/oauth/availability')
      .set('host', 'tenant-portal.example.com')
      .set('x-forwarded-proto', 'https');
    expect(res.status).toBe(200);
    const advertised = Object.keys(res.body.providers ?? {}).sort();
    const covered = TENANT_PORTAL_OAUTH_PROVIDERS.map((p) => p.provider).sort();
    expect(
      advertised,
      'OAUTH_PROVIDER_REGISTRY drifted from the tenant-portal coverage list — add the new provider to TENANT_PORTAL_OAUTH_PROVIDERS in this file.',
    ).toEqual(covered);
  });
});
