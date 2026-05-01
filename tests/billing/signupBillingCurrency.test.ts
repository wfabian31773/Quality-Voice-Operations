/**
 * Task #1137: confirms /auth/signup persists the visitor's chosen
 * display currency to `tenants.billing_currency` so the first
 * post-signup screen renders converted figures (no USD flash) and
 * the in-app `useTenantCurrency` hook resolves the same code that
 * was picked on /pricing or /signup.
 *
 * Contract pinned by these tests:
 *   - When `billingCurrency` is on the curated allowlist (case-
 *     insensitive), it is normalized to lowercase and used as the 5th
 *     parameter of the `INSERT INTO tenants ... billing_currency`
 *     statement.
 *   - When the body omits `billingCurrency` entirely, the route
 *     falls back to `usd` (preserving the pre-task default).
 *   - When the body sends an unsupported code, the route ignores it
 *     and falls back to `usd` rather than persisting bad data.
 *   - The Stripe checkout session metadata also carries
 *     `billingCurrency` so downstream webhooks / dashboards can
 *     reconcile the visitor's selection against the persisted row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const ORIGINAL_ENV = { ...process.env };

interface CapturedQuery {
  sql: string;
  values?: unknown[];
}

let capturedQueries: CapturedQuery[] = [];

const checkoutCreateMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        capturedQueries.push({ sql, values });
        const trimmed = sql.trimStart();
        if (
          trimmed.startsWith('BEGIN')
          || trimmed.startsWith('COMMIT')
          || trimmed.startsWith('ROLLBACK')
          || trimmed.startsWith('SET LOCAL')
        ) {
          return { rows: [] };
        }
        if (trimmed.startsWith('SELECT id FROM users')) {
          return { rows: [] };
        }
        if (trimmed.startsWith('INSERT INTO tenants')) {
          return { rows: [{ id: 'tenant-uuid' }] };
        }
        if (trimmed.startsWith('INSERT INTO users')) {
          return { rows: [{ id: 'user-uuid' }] };
        }
        if (trimmed.startsWith('INSERT INTO user_roles')) {
          return { rows: [] };
        }
        if (trimmed.startsWith('DELETE')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    }),
  }),
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    checkout: { sessions: { create: checkoutCreateMock } },
  }),
}));

vi.mock('../../platform/billing/stripe/plans', () => ({
  getPlanPriceId: () => 'price_test_pro_monthly',
  TRIAL_LIMITS: { durationDays: 14 },
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../platform/email', () => ({
  sendEmail: vi.fn(async () => undefined),
  emailVerificationEmail: () => ({ subject: 's', html: 'h', text: 't' }),
}));

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.TURNSTILE_SECRET_KEY;
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-min-32-chars-12345678';
  process.env.APP_URL = process.env.APP_URL ?? 'http://localhost:5173';
}

beforeEach(() => {
  resetEnv();
  capturedQueries = [];
  checkoutCreateMock.mockReset();
  checkoutCreateMock.mockResolvedValue({ url: 'https://checkout.stripe.test/pay' });
  vi.resetModules();
});

afterEach(() => {
  resetEnv();
});

async function mountAuthRouter() {
  const authModule = await import('../../server/admin-api/routes/auth');
  const app = express();
  app.use(express.json());
  app.use(authModule.default);
  return app;
}

function findTenantInsert(): CapturedQuery | undefined {
  return capturedQueries.find((q) => q.sql.includes('INSERT INTO tenants'));
}

describe('POST /auth/signup — billing_currency persistence', () => {
  it('persists a supported display currency to tenants.billing_currency (lowercased)', async () => {
    const app = await mountAuthRouter();

    const res = await request(app).post('/auth/signup').send({
      name: 'Test Org EUR',
      email: `eur+${Date.now()}@example.com`,
      password: 'long-enough-password',
      plan: 'pro',
      interval: 'monthly',
      billingCurrency: 'EUR',
    });

    expect(res.status).toBe(201);
    const insert = findTenantInsert();
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('billing_currency');
    // 5th positional parameter ($5) is billing_currency in the INSERT
    expect(insert!.values?.[4]).toBe('eur');
  });

  it('falls back to usd when billingCurrency is omitted', async () => {
    const app = await mountAuthRouter();

    const res = await request(app).post('/auth/signup').send({
      name: 'Test Org Default',
      email: `default+${Date.now()}@example.com`,
      password: 'long-enough-password',
      plan: 'pro',
      interval: 'monthly',
    });

    expect(res.status).toBe(201);
    const insert = findTenantInsert();
    expect(insert).toBeDefined();
    expect(insert!.values?.[4]).toBe('usd');
  });

  it('ignores an unsupported currency code and falls back to usd', async () => {
    const app = await mountAuthRouter();

    const res = await request(app).post('/auth/signup').send({
      name: 'Test Org Bogus',
      email: `bogus+${Date.now()}@example.com`,
      password: 'long-enough-password',
      plan: 'pro',
      interval: 'monthly',
      billingCurrency: 'XYZ',
    });

    expect(res.status).toBe(201);
    const insert = findTenantInsert();
    expect(insert).toBeDefined();
    expect(insert!.values?.[4]).toBe('usd');
  });

  it('threads the normalized billing currency into Stripe checkout metadata', async () => {
    const app = await mountAuthRouter();

    await request(app).post('/auth/signup').send({
      name: 'Test Org GBP',
      email: `gbp+${Date.now()}@example.com`,
      password: 'long-enough-password',
      plan: 'pro',
      interval: 'monthly',
      billingCurrency: 'gbp',
    });

    expect(checkoutCreateMock).toHaveBeenCalledTimes(1);
    const args = checkoutCreateMock.mock.calls[0][0] as {
      metadata?: Record<string, string>;
      subscription_data?: { metadata?: Record<string, string> };
    };
    expect(args.metadata?.billingCurrency).toBe('gbp');
    expect(args.subscription_data?.metadata?.billingCurrency).toBe('gbp');
  });
});
