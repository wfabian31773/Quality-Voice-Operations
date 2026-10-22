import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '../../platform/core/types';

const { sessionsCreate, trialHelperSpy } = vi.hoisted(() => ({
  sessionsCreate: vi.fn(),
  trialHelperSpy: vi.fn(),
}));
let subscriptionRow: Record<string, string | null> | undefined;
let tenantTrialExpiresAt: string | null;

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string) => {
        const t = sql.trimStart();
        if (t.startsWith('BEGIN') || t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) {
          return { rows: [] };
        }
        if (/FROM tenants/.test(sql)) return { rows: [{ trial_expires_at: tenantTrialExpiresAt }] };
        return { rows: subscriptionRow ? [subscriptionRow] : [] };
      }),
      release: vi.fn(),
    }),
  }),
  withTenantContext: vi.fn(async () => undefined),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../platform/billing/stripe/plans', () => ({
  getPlanPriceId: () => 'price_test',
  TRIAL_LIMITS: { durationDays: 7 },
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    customers: { retrieve: vi.fn(async () => ({ deleted: false, discount: null })) },
    subscriptions: { list: vi.fn(async () => ({ data: [] })) },
    checkout: { sessions: { create: sessionsCreate } },
  }),
}));

vi.mock('../../platform/billing/stripe/trial', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/billing/stripe/trial')>();
  trialHelperSpy.mockImplementation(actual.buildTrialSubscriptionData);
  return { buildTrialSubscriptionData: trialHelperSpy };
});

import { createCheckoutSession } from '../../platform/billing/stripe/checkout';

const TENANT: TenantId = 'tenant-trial-first-sub';

function trialDays(): unknown {
  return sessionsCreate.mock.calls[0][0].subscription_data.trial_period_days;
}

beforeEach(() => {
  sessionsCreate.mockReset();
  trialHelperSpy.mockClear();
  tenantTrialExpiresAt = null;
  sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
});

describe('createCheckoutSession trial', () => {
  it.each(['starter', 'pro', 'enterprise'] as const)(
    'gives a first-time %s checkout a 7-day trial',
    async (plan) => {
      subscriptionRow = undefined;
      await createCheckoutSession({ tenantId: TENANT, plan: plan, interval: 'monthly', successUrl: 'https://s', cancelUrl: 'https://c', customerEmail: 'owner@example.com' });
      expect(trialDays()).toBe(7);
      expect(trialHelperSpy).toHaveBeenCalledWith(expect.objectContaining({ isFirstSubscription: true }));
    },
  );

  it('gives no trial when the tenant already has a Stripe customer (upgrade or switch)', async () => {
    subscriptionRow = { stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' };
    await createCheckoutSession({ tenantId: TENANT, plan: 'enterprise', interval: 'monthly', successUrl: 'https://s', cancelUrl: 'https://c', customerEmail: 'owner@example.com' });
    expect(trialDays()).toBeUndefined();
    expect(sessionsCreate.mock.calls[0][0].subscription_data).not.toHaveProperty('trial_period_days');
    expect(trialHelperSpy).toHaveBeenCalledWith(expect.objectContaining({ isFirstSubscription: false }));
  });

  it('gives no trial when a prior subscription id exists', async () => {
    subscriptionRow = { stripe_customer_id: null, stripe_subscription_id: 'sub_old' };
    await createCheckoutSession({ tenantId: TENANT, plan: 'pro', interval: 'monthly', successUrl: 'https://s', cancelUrl: 'https://c', customerEmail: 'owner@example.com' });
    expect(trialDays()).toBeUndefined();
  });

  it('gives no second trial once the signup free trial (trial_expires_at) has run out', async () => {
    subscriptionRow = undefined;
    tenantTrialExpiresAt = new Date(Date.now() - 60_000).toISOString();
    await createCheckoutSession({ tenantId: TENANT, plan: 'pro', interval: 'monthly', successUrl: 'https://s', cancelUrl: 'https://c', customerEmail: 'owner@example.com' });
    expect(trialDays()).toBeUndefined();
    expect(trialHelperSpy).toHaveBeenCalledWith({ isFirstSubscription: true, freeTrialExpiresAt: tenantTrialExpiresAt });
  });

  it('still gives the trial while the signup free trial has not run out', async () => {
    subscriptionRow = undefined;
    tenantTrialExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await createCheckoutSession({ tenantId: TENANT, plan: 'pro', interval: 'monthly', successUrl: 'https://s', cancelUrl: 'https://c', customerEmail: 'owner@example.com' });
    expect(trialDays()).toBe(7);
  });
});
