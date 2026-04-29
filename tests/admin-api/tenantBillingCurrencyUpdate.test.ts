/**
 * Coverage for the tenant Settings → "Billing currency" flow added in
 * task #1007.
 *
 *   - GET  /tenants/me/supported-currencies returns the curated list.
 *   - PATCH /tenants/me { billingCurrency } validates the ISO 4217 code,
 *     normalizes it to lowercase, writes it to `tenants.billing_currency`,
 *     invalidates the per-tenant currency cache, and emits an audit log
 *     entry on a real change.
 *   - Unsupported / malformed codes are rejected with 400 and never
 *     touch the database.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      email: 'owner@acme.test',
      role: 'owner',
      isPlatformAdmin: false,
    };
    next();
  },
  invalidateTenantStatusCache: vi.fn(),
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const writeAuditLogMock = vi.fn(async () => undefined);
vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: writeAuditLogMock,
  extractIp: () => '127.0.0.1',
}));

const invalidateTenantCurrencyCacheMock = vi.fn();
vi.mock('../../platform/billing/tenantCurrency', () => ({
  invalidateTenantCurrencyCache: invalidateTenantCurrencyCacheMock,
}));

vi.mock('../../platform/tenant/provisioning/TenantProvisioningService', () => ({
  getProvisioningStatus: vi.fn(),
  provisionTenant: vi.fn(),
}));

vi.mock('../../platform/agent-templates/registry', () => ({
  getRegisteredTemplates: () => [],
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({}),
}));

vi.mock('../../platform/billing/stripe/plans', () => ({
  PLAN_LIMITS: { starter: {} },
}));

vi.mock('../../platform/activation/ActivationService', () => ({
  getActivationMilestones: vi.fn(),
  dismissTooltip: vi.fn(),
  getDismissedTooltips: vi.fn(),
}));

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  writeAuditLogMock.mockClear();
  invalidateTenantCurrencyCacheMock.mockClear();
});

async function buildApp(): Promise<express.Express> {
  const router = (await import('../../server/admin-api/routes/tenants')).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('GET /tenants/me/supported-currencies', () => {
  it('returns the curated supported-currency list', async () => {
    const app = await buildApp();
    const res = await request(app).get('/tenants/me/supported-currencies');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.currencies)).toBe(true);
    expect(res.body.currencies.length).toBeGreaterThan(5);
    const codes = res.body.currencies.map((c: { code: string }) => c.code);
    expect(codes).toContain('usd');
    expect(codes).toContain('eur');
    expect(codes).toContain('gbp');
    // Codes must already be lowercase to match how the DB stores them.
    for (const code of codes) {
      expect(code).toBe(code.toLowerCase());
      expect(code).toHaveLength(3);
    }
  });
});

describe('PATCH /tenants/me — billingCurrency', () => {
  it('updates billing_currency, drops the cache, and writes an audit log on a real change', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL|set_config/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SELECT COALESCE\(billing_currency/i.test(s)) {
        return { rows: [{ billing_currency: 'usd' }], rowCount: 1 };
      }
      if (/UPDATE tenants SET/i.test(s)) {
        return {
          rows: [
            {
              id: 'tenant-1',
              name: 'Acme',
              slug: 'acme',
              domain: null,
              status: 'active',
              plan: 'pro',
              settings: {},
              sms_alerts_disabled: false,
              billing_currency: 'eur',
              updated_at: new Date().toISOString(),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = await buildApp();
    const res = await request(app)
      .patch('/tenants/me')
      .send({ billingCurrency: 'EUR' });

    expect(res.status).toBe(200);
    expect(res.body.tenant.billing_currency).toBe('eur');

    // The UPDATE statement actually persists the new column value.
    const updateCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE tenants SET/i.test(c[0] as string),
    );
    expect(updateCall, 'expected an UPDATE tenants call').toBeTruthy();
    expect(String(updateCall![0])).toMatch(/billing_currency = \$/);
    expect(updateCall![1]).toContain('eur');

    // Cache invalidated so cost screens re-resolve immediately.
    expect(invalidateTenantCurrencyCacheMock).toHaveBeenCalledWith('tenant-1');

    // Audit log written with from/to delta.
    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const auditEvent = writeAuditLogMock.mock.calls[0][0] as Record<string, unknown>;
    expect(auditEvent.action).toBe('tenant.billing_currency_changed');
    expect(auditEvent.tenantId).toBe('tenant-1');
    expect(auditEvent.actorUserId).toBe('user-1');
    expect(auditEvent.changes).toEqual({ from: 'usd', to: 'eur' });
  });

  it('skips audit log + cache invalidation when the currency is unchanged', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL|set_config/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SELECT COALESCE\(billing_currency/i.test(s)) {
        return { rows: [{ billing_currency: 'eur' }], rowCount: 1 };
      }
      if (/UPDATE tenants SET/i.test(s)) {
        return {
          rows: [{ id: 'tenant-1', billing_currency: 'eur', settings: {}, sms_alerts_disabled: false }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = await buildApp();
    const res = await request(app)
      .patch('/tenants/me')
      .send({ billingCurrency: 'eur' });

    expect(res.status).toBe(200);
    expect(invalidateTenantCurrencyCacheMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('rejects an unsupported but valid-shape currency code with HTTP 400 + supported list', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL|set_config/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SELECT COALESCE\(billing_currency/i.test(s)) {
        return { rows: [{ billing_currency: 'usd' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = await buildApp();
    const res = await request(app)
      .patch('/tenants/me')
      .send({ billingCurrency: 'xyz' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid billingCurrency/);
    expect(Array.isArray(res.body.supported)).toBe(true);
    // The UPDATE must NOT fire on a validation failure.
    const updateCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE tenants SET/i.test(c[0] as string),
    );
    expect(updateCall).toBeUndefined();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
    expect(invalidateTenantCurrencyCacheMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-3-letter) currency before any DB work', async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch('/tenants/me')
      .send({ billingCurrency: 'euro' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/3-letter ISO 4217/);
    // Pre-DB shape check: nothing should hit Postgres at all.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects a non-string currency value with HTTP 400', async () => {
    const app = await buildApp();
    const res = await request(app)
      .patch('/tenants/me')
      .send({ billingCurrency: 123 });

    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('lets a legacy tenant whose stored code is outside the curated list save unrelated fields', async () => {
    // Simulate a tenant whose `billing_currency` was set (e.g. via a
    // historical backfill) to a code we don't expose in the picker
    // anymore. The Settings UI re-sends that legacy code on every save
    // because it pre-fills the form from the API response. The PATCH
    // route must treat the unchanged value as a no-op rather than
    // rejecting the entire save.
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL|set_config/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SELECT COALESCE\(billing_currency/i.test(s)) {
        return { rows: [{ billing_currency: 'cny' }], rowCount: 1 };
      }
      if (/UPDATE tenants SET/i.test(s)) {
        return {
          rows: [
            {
              id: 'tenant-1',
              name: 'Renamed',
              billing_currency: 'cny',
              settings: {},
              sms_alerts_disabled: false,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = await buildApp();
    const res = await request(app)
      .patch('/tenants/me')
      .send({ name: 'Renamed', billingCurrency: 'cny' });

    expect(res.status).toBe(200);
    expect(res.body.tenant.billing_currency).toBe('cny');

    // The UPDATE should *not* re-set billing_currency (it's a no-op),
    // and we should not pretend to "change" to the same value.
    const updateCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE tenants SET/i.test(c[0] as string),
    );
    expect(updateCall, 'expected an UPDATE tenants call').toBeTruthy();
    expect(String(updateCall![0])).not.toMatch(/billing_currency = \$/);
    expect(updateCall![1]).not.toContain('cny');
    expect(writeAuditLogMock).not.toHaveBeenCalled();
    expect(invalidateTenantCurrencyCacheMock).not.toHaveBeenCalled();
  });

  it('does not require billingCurrency — other fields still patch in isolation', async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL|set_config/i.test(s)) return { rows: [], rowCount: 0 };
      if (/UPDATE tenants SET/i.test(s)) {
        return {
          rows: [
            {
              id: 'tenant-1',
              name: 'Renamed',
              billing_currency: 'usd',
              settings: {},
              sms_alerts_disabled: false,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = await buildApp();
    const res = await request(app).patch('/tenants/me').send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    // The UPDATE should not include billing_currency when the field was
    // omitted from the body — we only touch what the caller sent.
    const updateCall = queryMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE tenants SET/i.test(c[0] as string),
    );
    expect(updateCall, 'expected an UPDATE tenants call').toBeTruthy();
    expect(String(updateCall![0])).not.toMatch(/billing_currency = \$/);
    expect(invalidateTenantCurrencyCacheMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });
});
