/**
 * POST /auth/signup must start the 7-day trial on its Stripe Checkout
 * session, built by the same `buildTrialSubscriptionData` helper that
 * `createCheckoutSession` uses. Before this, signup built its own
 * session without `trial_period_days` and billed immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const ORIGINAL_ENV = { ...process.env };

const { checkoutCreateMock, trialHelperSpy } = vi.hoisted(() => ({
  checkoutCreateMock: vi.fn(),
  trialHelperSpy: vi.fn(),
}));

vi.mock('../../platform/db', () => {
  const pool = () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string) => {
        const trimmed = sql.trimStart();
        if (trimmed.startsWith('INSERT INTO tenants')) return { rows: [{ id: 'tenant-uuid' }] };
        if (trimmed.startsWith('INSERT INTO users')) return { rows: [{ id: 'user-uuid' }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    }),
  });
  return { getPlatformPool: pool, getPrivilegedPool: pool };
});

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    checkout: { sessions: { create: checkoutCreateMock } },
  }),
}));

vi.mock('../../platform/billing/stripe/plans', () => ({
  getPlanPriceId: () => 'price_test_pro_monthly',
  TRIAL_LIMITS: { durationDays: 7 },
}));

vi.mock('../../platform/billing/stripe/trial', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/billing/stripe/trial')>();
  trialHelperSpy.mockImplementation(actual.buildTrialSubscriptionData);
  return { buildTrialSubscriptionData: trialHelperSpy };
});

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
  checkoutCreateMock.mockReset();
  checkoutCreateMock.mockResolvedValue({ url: 'https://checkout.stripe.test/pay' });
  trialHelperSpy.mockClear();
});

afterEach(() => {
  resetEnv();
});

describe('POST /auth/signup — trial', () => {
  it.each(['starter', 'pro', 'enterprise'] as const)(
    'gives a %s signup checkout a 7-day trial via the shared helper',
    async (plan) => {
      const { default: router } = await import('../../server/admin-api/routes/auth');
      const app = express();
      app.use(express.json());
      app.use(router);

      const res = await request(app).post('/auth/signup').send({
        name: 'Trial Org',
        email: `trial-${plan}+${Date.now()}@example.com`,
        password: 'long-enough-password',
        plan,
        interval: 'monthly',
      });

      expect(res.status).toBe(201);
      expect(trialHelperSpy).toHaveBeenCalledWith(true);
      expect(checkoutCreateMock).toHaveBeenCalledTimes(1);
      const args = checkoutCreateMock.mock.calls[0][0] as {
        subscription_data?: { trial_period_days?: number; metadata?: Record<string, string> };
      };
      expect(args.subscription_data?.trial_period_days).toBe(7);
      expect(args.subscription_data?.metadata?.plan).toBe(plan);
    },
  );
});

describe('buildTrialSubscriptionData', () => {
  it('returns the 7-day trial for a first subscription and nothing otherwise', async () => {
    const { buildTrialSubscriptionData } = await vi.importActual<
      typeof import('../../platform/billing/stripe/trial')
    >('../../platform/billing/stripe/trial');
    expect(buildTrialSubscriptionData(true)).toEqual({ trial_period_days: 7 });
    expect(buildTrialSubscriptionData(false)).toEqual({});
  });
});
