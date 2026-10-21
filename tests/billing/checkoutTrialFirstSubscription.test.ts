import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '../../platform/core/types';

const sessionsCreate = vi.fn();
let subscriptionRow: Record<string, string | null> | undefined;

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string) => {
        const t = sql.trimStart();
        if (t.startsWith('BEGIN') || t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) {
          return { rows: [] };
        }
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

import { createCheckoutSession } from '../../platform/billing/stripe/checkout';

const TENANT: TenantId = 'tenant-trial-first-sub';

function trialDays(): unknown {
  return sessionsCreate.mock.calls[0][0].subscription_data.trial_period_days;
}

beforeEach(() => {
  sessionsCreate.mockReset();
  sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
});

describe('createCheckoutSession trial', () => {
  it.each(['starter', 'pro', 'enterprise'] as const)(
    'gives a first-time %s checkout a 7-day trial',
    async (plan) => {
      subscriptionRow = undefined;
      await createCheckoutSession({ tenantId: TENANT, plan: plan, interval: 'monthly', successUrl: 'https://s', cancelUrl: 'https://c', customerEmail: 'owner@example.com' });
      expect(trialDays()).toBe(7);
    },
  );

  it('gives no trial when the tenant already has a Stripe customer (upgrade or switch)', async () => {
    subscriptionRow = { stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' };
    await createCheckoutSession({ tenantId: TENANT, plan: 'enterprise', interval: 'monthly', successUrl: 'https://s', cancelUrl: 'https://c', customerEmail: 'owner@example.com' });
    expect(trialDays()).toBeUndefined();
  });

  it('gives no trial when a prior subscription id exists', async () => {
    subscriptionRow = { stripe_customer_id: null, stripe_subscription_id: 'sub_old' };
    await createCheckoutSession({ tenantId: TENANT, plan: 'pro', interval: 'monthly', successUrl: 'https://s', cancelUrl: 'https://c', customerEmail: 'owner@example.com' });
    expect(trialDays()).toBeUndefined();
  });
});
