/**
 * Task #919 — verifies the connector OAuth router writes a
 * `connector.oauth_attempt_blocked` audit event whenever an init handler
 * rejects with `OAUTH_NOT_CONFIGURED` because the server's
 * `*_CLIENT_ID` env var isn't set.
 *
 * The Platform Admin Integrations Status panel reads these events
 * (`server/admin-api/routes/platformIntegrationsStatus.ts`) to surface a
 * "blocked attempts" demand signal per provider so admins know which
 * missing credentials to wire up first.
 *
 * For each init route we assert:
 *
 *   1. The HTTP response is the documented 400 / `OAUTH_NOT_CONFIGURED`
 *      contract — the audit-log change must not regress the body the
 *      tenant portal already depends on.
 *   2. `writeAuditLog` is called with the full event the platform
 *      reports against:
 *        - action `connector.oauth_attempt_blocked`
 *        - resourceType `connector`
 *        - resourceId equal to the *connectorProvider* (so the audit
 *          query joins the same way as `connector.oauth_connected` —
 *          notably `google → google-calendar`,
 *          `outlook → outlook-calendar`).
 *        - tenantId / actorUserId / actorRole from the authenticated
 *          request so the row is attributable.
 *        - `changes.missingEnv` so ops can find out *what* was missing
 *          without re-reading the registry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const TRACKED_ENV = [
  'HUBSPOT_CLIENT_ID',
  'GOOGLE_CLIENT_ID',
  'MICROSOFT_CLIENT_ID',
  'SLACK_CLIENT_ID',
  'PIPEDRIVE_CLIENT_ID',
  'SALESFORCE_CLIENT_ID',
  'QUICKBOOKS_CLIENT_ID',
  'ZOHO_CLIENT_ID',
  'ADMIN_JWT_SECRET',
];

// Minimal mocks for the heavy adapters/region helpers the router pulls
// in at import time — the blocked-attempt path never touches them.
vi.mock('../../platform/integrations/connectors', () => ({
  upsertConnector: vi.fn(),
}));

vi.mock('../../platform/integrations/connectors/zohoRegion', () => ({
  resolveZohoAccountsServer: vi.fn(),
  resolveZohoApiDomain: vi.fn(),
}));

const writeAuditLogMock = vi.fn(async () => {});
vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: writeAuditLogMock,
  extractIp: () => '203.0.113.7',
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-42',
      tenantId: 'tenant-acme',
      email: 'manager@acme.test',
      role: 'manager',
      isPlatformAdmin: false,
    };
    next();
  },
}));

beforeAll(() => {
  for (const key of TRACKED_ENV) {
    ORIGINAL_ENV[key] = process.env[key];
    delete process.env[key];
  }
  // The router needs *some* state-signing secret in dev to start the
  // OAuth flow — but we never reach that branch here because the init
  // handler short-circuits on the missing client id. Set it anyway so
  // a future regression that reorders the checks is loud.
  process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';
});

afterAll(() => {
  for (const key of TRACKED_ENV) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

beforeEach(() => {
  writeAuditLogMock.mockClear();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const router = (await import('../../server/admin-api/routes/connectorOAuth')).default;
  app.use(router);
  return app;
}

interface InitCase {
  routeProvider: string;
  connectorProvider: string;
  missingEnv: string;
}

// `routeProvider` is the path segment, `connectorProvider` is what the
// audit log records and what the `integrations` table / status panel
// joins on. The two diverge for calendar providers — keeping the
// mapping in the test guards against silent drift.
const CASES: InitCase[] = [
  { routeProvider: 'hubspot', connectorProvider: 'hubspot', missingEnv: 'HUBSPOT_CLIENT_ID' },
  { routeProvider: 'google', connectorProvider: 'google-calendar', missingEnv: 'GOOGLE_CLIENT_ID' },
  { routeProvider: 'outlook', connectorProvider: 'outlook-calendar', missingEnv: 'MICROSOFT_CLIENT_ID' },
  { routeProvider: 'slack', connectorProvider: 'slack', missingEnv: 'SLACK_CLIENT_ID' },
  { routeProvider: 'pipedrive', connectorProvider: 'pipedrive', missingEnv: 'PIPEDRIVE_CLIENT_ID' },
  { routeProvider: 'salesforce', connectorProvider: 'salesforce', missingEnv: 'SALESFORCE_CLIENT_ID' },
  { routeProvider: 'quickbooks', connectorProvider: 'quickbooks', missingEnv: 'QUICKBOOKS_CLIENT_ID' },
  { routeProvider: 'zoho', connectorProvider: 'zoho', missingEnv: 'ZOHO_CLIENT_ID' },
];

describe('connector OAuth init — OAUTH_NOT_CONFIGURED audit logging (Task #919)', () => {
  for (const tc of CASES) {
    it(`writes connector.oauth_attempt_blocked for ${tc.routeProvider}`, async () => {
      const app = await buildApp();
      const res = await request(app).get(`/connectors/oauth/${tc.routeProvider}/init`);

      // The user-facing contract is unchanged.
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OAUTH_NOT_CONFIGURED');
      expect(res.body.provider).toBe(tc.routeProvider);
      expect(res.body.missingEnv).toBe(tc.missingEnv);

      // Exactly one audit log per blocked attempt — never silent, never
      // duplicated (which would inflate the demand counter).
      expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
      const event = writeAuditLogMock.mock.calls[0][0];
      expect(event.action).toBe('connector.oauth_attempt_blocked');
      expect(event.resourceType).toBe('connector');
      expect(event.resourceId).toBe(tc.connectorProvider);
      expect(event.tenantId).toBe('tenant-acme');
      expect(event.actorUserId).toBe('user-42');
      expect(event.actorRole).toBe('manager');
      expect(event.severity).toBe('warning');
      expect(event.ipAddress).toBe('203.0.113.7');
      expect(event.changes).toMatchObject({
        provider: tc.connectorProvider,
        routeProvider: tc.routeProvider,
        missingEnv: tc.missingEnv,
      });
    });
  }

  it('still returns 400 when the audit write itself fails (audit must not block the response)', async () => {
    writeAuditLogMock.mockRejectedValueOnce(new Error('audit db down'));
    const app = await buildApp();
    const res = await request(app).get('/connectors/oauth/hubspot/init');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OAUTH_NOT_CONFIGURED');
  });
});
