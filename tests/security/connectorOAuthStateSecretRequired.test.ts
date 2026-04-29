/**
 * Regression for Task #621 — `getStateSecret()` in
 * `server/admin-api/routes/connectorOAuth.ts` must NOT silently fall back to
 * the literal `'fallback-dev-secret'` in production-like envs when neither
 * `ADMIN_JWT_SECRET` nor `CONNECTOR_ENCRYPTION_KEY` is set.
 *
 * Scenario the fallback enables: the state cookie protection added by
 * BL-027 / Task #540 is one half of a defense-in-depth pair. The other
 * half is the HMAC-signed `state` value itself — if the signing secret
 * collapses to a known literal, anyone who knows the literal can forge a
 * `state` that passes the signature check, leaving only the cookie
 * binding as a single point of failure. Both halves must be independently
 * sound.
 *
 * Coverage:
 *   1. Production-like env + neither secret set → init returns 500 with the
 *      `OAUTH_STATE_SECRET_NOT_CONFIGURED` code so admins can diagnose it.
 *   2. Production-like env + `ADMIN_JWT_SECRET` set → init still works
 *      (sanity check that the new guard doesn't break healthy configs).
 *   3. Production-like env + `CONNECTOR_ENCRYPTION_KEY` set (alternate
 *      secret name) → init still works.
 *   4. Development env + neither secret set → init still works (the
 *      historical dev fallback is preserved).
 *
 * If a future refactor reintroduces the literal fallback or removes the
 * `isProductionLike()` gate, case (1) will fail loudly.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const ENV_KEYS = [
  'APP_ENV',
  'NODE_ENV',
  'ADMIN_JWT_SECRET',
  'CONNECTOR_ENCRYPTION_KEY',
  'HUBSPOT_CLIENT_ID',
  'HUBSPOT_CLIENT_SECRET',
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

// --- Module mocks --------------------------------------------------------
//
// The OAuth router pulls in real connector adapters, the audit log, and the
// Zoho region resolver at import time. None of that is needed to exercise
// the secret-configuration guard, so we stub them. We also stub the auth
// + RBAC middleware so we can hit the init endpoint as a synthetic admin
// without spinning up a real JWT.

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
      userId: 'state-secret-test-user',
      tenantId: 'state-secret-test-tenant',
      email: 'admin@state-secret.test',
      role: 'tenant_owner',
      isPlatformAdmin: true,
    };
    next();
  },
}));

beforeAll(() => {
  snapshotEnv();
  // HubSpot OAuth client config is needed to get past the
  // "OAuth not configured" early-return; the secret-required test then
  // exercises the next guard on the init path.
  process.env.HUBSPOT_CLIENT_ID = 'test-hubspot-client-id';
  process.env.HUBSPOT_CLIENT_SECRET = 'test-hubspot-client-secret';
});

afterAll(() => {
  restoreEnv();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Each test gets a fresh module graph so the security helper picks up
  // the env mutations the test makes (the cached `ALLOWED_ORIGINS` set
  // reads `isProductionLike()` indirectly).
  vi.resetModules();
});

afterEach(() => {
  // Re-clear any per-test secret/env mutations so the next test starts from
  // the baseline established in `beforeAll`.
  delete process.env.APP_ENV;
  delete process.env.NODE_ENV;
  delete process.env.ADMIN_JWT_SECRET;
  delete process.env.CONNECTOR_ENCRYPTION_KEY;
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const security = await import('../../server/admin-api/middleware/security');
  security.__resetAllowedOriginsForTests();
  const router = (await import('../../server/admin-api/routes/connectorOAuth')).default;
  app.use('/', router);
  return app;
}

describe('connectorOAuth — getStateSecret() must fail closed in production (Task #621)', () => {
  it('init returns 500 with OAUTH_STATE_SECRET_NOT_CONFIGURED when both env vars are missing in production', async () => {
    process.env.APP_ENV = 'production';
    process.env.NODE_ENV = 'production';
    // Both candidate secrets intentionally unset.
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.CONNECTOR_ENCRYPTION_KEY;

    const app = await buildApp();
    const res = await request(app)
      .get('/connectors/oauth/hubspot/init')
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https');

    expect(
      res.status,
      `expected init to fail closed; body=${JSON.stringify(res.body)}`,
    ).toBe(500);
    expect(res.body).toMatchObject({
      code: 'OAUTH_STATE_SECRET_NOT_CONFIGURED',
      missingEnv: 'ADMIN_JWT_SECRET',
    });
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).toMatch(/ADMIN_JWT_SECRET|CONNECTOR_ENCRYPTION_KEY/);

    // Critically: the response must NOT have set the OAuth state cookie,
    // because we never called signState successfully. If a future refactor
    // accidentally signs first then errors, this catches the leak.
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.find((c) => c.startsWith('oauth_state_hubspot='))).toBeUndefined();
  });

  it('init returns 500 with OAUTH_STATE_SECRET_NOT_CONFIGURED when both env vars are missing in staging', async () => {
    process.env.APP_ENV = 'staging';
    delete process.env.NODE_ENV;
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.CONNECTOR_ENCRYPTION_KEY;

    const app = await buildApp();
    const res = await request(app)
      .get('/connectors/oauth/hubspot/init')
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('OAUTH_STATE_SECRET_NOT_CONFIGURED');
  });

  it('init succeeds in production when ADMIN_JWT_SECRET is configured', async () => {
    process.env.APP_ENV = 'production';
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_JWT_SECRET = 'prod-jwt-secret-for-state-cookie';
    delete process.env.CONNECTOR_ENCRYPTION_KEY;

    const app = await buildApp();
    const res = await request(app)
      .get('/connectors/oauth/hubspot/init')
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https');

    expect(
      res.status,
      `expected init to succeed with ADMIN_JWT_SECRET set; body=${JSON.stringify(res.body)}`,
    ).toBe(200);
    expect(typeof res.body.authUrl).toBe('string');
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    expect(cookies.find((c) => c.startsWith('oauth_state_hubspot='))).toBeDefined();
  });

  it('init succeeds in production when only CONNECTOR_ENCRYPTION_KEY is configured', async () => {
    process.env.APP_ENV = 'production';
    process.env.NODE_ENV = 'production';
    delete process.env.ADMIN_JWT_SECRET;
    process.env.CONNECTOR_ENCRYPTION_KEY = 'prod-encryption-key-for-state-cookie';

    const app = await buildApp();
    const res = await request(app)
      .get('/connectors/oauth/hubspot/init')
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https');

    expect(res.status).toBe(200);
    expect(typeof res.body.authUrl).toBe('string');
  });

  it('init still works in development without either secret (preserves dev fallback)', async () => {
    process.env.APP_ENV = 'development';
    process.env.NODE_ENV = 'development';
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.CONNECTOR_ENCRYPTION_KEY;

    const app = await buildApp();
    const res = await request(app)
      .get('/connectors/oauth/hubspot/init')
      .set('host', 'admin.example.com')
      .set('x-forwarded-proto', 'https');

    expect(
      res.status,
      `dev env without secrets must keep working; body=${JSON.stringify(res.body)}`,
    ).toBe(200);
    expect(typeof res.body.authUrl).toBe('string');
  });
});
