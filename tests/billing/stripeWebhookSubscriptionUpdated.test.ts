/**
 * Coverage for `handleSubscriptionUpdated` in
 * `platform/billing/stripe/webhook.ts` (Task #1202 follow-up).
 *
 * Specifically: when Stripe transitions a Subscription Schedule into
 * its second phase (the lower-tier price queued by
 * /billing/schedule-downgrade), the customer.subscription.updated
 * event must result in BOTH `billing_interval` AND `stripe_price_id`
 * being persisted on the local subscriptions row — not just `plan`
 * and limits. Without that, the Billing UI would keep showing the
 * old interval after the swap takes effect, and downstream code that
 * keys off `stripe_price_id` would compute against the wrong price.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { queryMock, releaseMock, connectMock, subscriptionsRetrieveMock } = vi.hoisted(() => {
  const q = vi.fn();
  const r = vi.fn();
  return {
    queryMock: q,
    releaseMock: r,
    connectMock: vi.fn(async () => ({ query: q, release: r })),
    subscriptionsRetrieveMock: vi.fn(),
  };
});

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    subscriptions: { retrieve: subscriptionsRetrieveMock },
  }),
  getWebhookSecret: () => 'whsec_test',
}));

vi.mock('../../platform/tenant/provisioning/TenantProvisioningService', () => ({
  provisionTenant: vi.fn(),
}));

import type Stripe from 'stripe';
import { PLAN_LIMITS } from '../../platform/billing/stripe/plans';
import { handleStripeEvent } from '../../platform/billing/stripe/webhook';

interface CapturedUpdate {
  sql: string;
  values: unknown[];
}

function captureSubscriptionUpdate(options: { priorPlan?: string } = {}): {
  updates: CapturedUpdate[];
  inserts: CapturedUpdate[];
} {
  const updates: CapturedUpdate[] = [];
  const inserts: CapturedUpdate[] = [];
  queryMock.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
    // The webhook resolves customer→tenant via this SELECT.
    if (/SELECT tenant_id FROM subscriptions WHERE stripe_customer_id/i.test(sql)) {
      return { rows: [{ tenant_id: 'tenant-1' }], rowCount: 1 };
    }
    // Pre-UPDATE prior-plan read used by the tier-downgrade detection
    // in handleSubscriptionUpdated. Must match BEFORE the generic
    // `SELECT ... FROM subscriptions` fallback so the downgrade test
    // can inject a higher-tier prior plan.
    if (/SELECT\s+plan\s+FROM\s+subscriptions\s+WHERE\s+tenant_id/i.test(sql)) {
      return options.priorPlan
        ? { rows: [{ plan: options.priorPlan }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // checkout.session.completed branch reads back the tenant status to
    // decide whether to provision; return 'active' so it skips that path.
    if (/SELECT status FROM tenants WHERE id/i.test(sql)) {
      return { rows: [{ status: 'active' }], rowCount: 1 };
    }
    // Webhook idempotency check + insert into billing_events.
    if (/FROM billing_events/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO billing_events/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO subscriptions/i.test(sql)) {
      inserts.push({ sql, values: values ?? [] });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE subscriptions SET/i.test(sql)) {
      updates.push({ sql, values: values ?? [] });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE marketplace_purchases/i.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  return { updates, inserts };
}

function makeCheckoutEvent(
  priceId: string,
  interval: 'month' | 'year',
  options: { id?: string; plan?: string } = {},
): Stripe.Event {
  return {
    id: options.id ?? `evt_co_${Math.random().toString(36).slice(2)}`,
    object: 'event',
    api_version: '2026-02-25.clover',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        customer: 'cus_1',
        subscription: 'sub_1',
        metadata: { tenantId: 'tenant-1', plan: options.plan ?? 'pro' },
      },
    } as unknown as Stripe.Event.Data,
  } as unknown as Stripe.Event;
}

function makeUpdatedEvent(
  priceId: string,
  interval: 'month' | 'year',
  options: { id?: string; status?: string } = {},
): Stripe.Event {
  return {
    id: options.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    object: 'event',
    api_version: '2026-02-25.clover',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_1',
        customer: 'cus_1',
        status: options.status ?? 'active',
        current_period_start: Math.floor(Date.UTC(2026, 5, 1) / 1000),
        current_period_end: Math.floor(Date.UTC(2026, 6, 1) / 1000),
        items: {
          data: [
            {
              id: 'si_1',
              price: {
                id: priceId,
                recurring: { interval, interval_count: 1 },
              },
            },
          ],
        },
      },
    } as unknown as Stripe.Event.Data,
  } as unknown as Stripe.Event;
}

describe('handleStripeEvent — customer.subscription.updated', () => {
  const ORIGINAL_PRICE_IDS = {
    STRIPE_PRICE_PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY,
    STRIPE_PRICE_PRO_ANNUAL: process.env.STRIPE_PRICE_PRO_ANNUAL,
    STRIPE_PRICE_ENTERPRISE_MONTHLY: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY,
    STRIPE_PRICE_ENTERPRISE_ANNUAL: process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL,
    STRIPE_PRICE_STARTER_MONTHLY: process.env.STRIPE_PRICE_STARTER_MONTHLY,
    STRIPE_PRICE_STARTER_ANNUAL: process.env.STRIPE_PRICE_STARTER_ANNUAL,
  };

  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();

    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual_test';
    process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY = 'price_enterprise_monthly_test';
    process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL = 'price_enterprise_annual_test';
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_monthly_test';
    process.env.STRIPE_PRICE_STARTER_ANNUAL = 'price_starter_annual_test';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL_PRICE_IDS)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
  });

  it('persists billing_interval=annual + stripe_price_id when a scheduled monthly→annual swap fires', async () => {
    const { updates } = captureSubscriptionUpdate();

    await handleStripeEvent(
      makeUpdatedEvent('price_pro_annual_test', 'year', { id: 'evt_swap_to_annual' }),
    );

    expect(updates).toHaveLength(1);
    const { sql, values } = updates[0];

    // The UPDATE statement must touch billing_interval AND stripe_price_id.
    // Cast to billing_interval enum is required by Postgres.
    expect(sql).toMatch(/billing_interval = \$\d+::billing_interval/);
    expect(sql).toMatch(/stripe_price_id = \$\d+/);

    // And the bound values must include the new interval + price.
    expect(values).toContain('annual');
    expect(values).toContain('price_pro_annual_test');
    expect(values).toContain('pro');
    expect(values).toContain(PLAN_LIMITS.pro.monthlyAiMinuteLimit);
  });

  it('persists billing_interval=monthly when a scheduled annual→monthly swap fires', async () => {
    const { updates } = captureSubscriptionUpdate();

    await handleStripeEvent(
      makeUpdatedEvent('price_pro_monthly_test', 'month', { id: 'evt_swap_to_monthly' }),
    );

    expect(updates).toHaveLength(1);
    const { sql, values } = updates[0];

    expect(sql).toMatch(/billing_interval = \$\d+::billing_interval/);
    expect(values).toContain('monthly');
    expect(values).toContain('price_pro_monthly_test');
  });

  it('also persists the new plan + limits for a tier downgrade (Enterprise→Pro annual)', async () => {
    const { updates } = captureSubscriptionUpdate();

    await handleStripeEvent(
      makeUpdatedEvent('price_pro_annual_test', 'year', { id: 'evt_tier_and_interval_swap' }),
    );

    expect(updates).toHaveLength(1);
    const { values } = updates[0];

    // Plan tier + interval BOTH update — covers the most disruptive
    // scheduled-downgrade case where a customer goes from Enterprise
    // monthly to Pro annual at period end.
    expect(values).toContain('pro');
    expect(values).toContain('annual');
    expect(values).toContain(PLAN_LIMITS.pro.monthlyCallLimit);
    expect(values).toContain(PLAN_LIMITS.pro.monthlySmsLimit);
    expect(values).toContain(PLAN_LIMITS.pro.monthlyAiMinuteLimit);
  });

  // -- Task #1366 — downgrade-completion banner signal ----------------
  // The webhook stamps `downgrade_completed_at` and
  // `downgrade_completed_to_plan` when a strict tier downgrade
  // (rank decrease) lands on the local subscription row, so the
  // Billing UI can fire a one-time "Your downgrade to <Plan> is now
  // active" banner.

  it('stamps downgrade_completed_at + downgrade_completed_to_plan on a strict tier downgrade (enterprise→pro)', async () => {
    const { updates } = captureSubscriptionUpdate({ priorPlan: 'enterprise' });

    await handleStripeEvent(
      makeUpdatedEvent('price_pro_annual_test', 'year', { id: 'evt_strict_tier_downgrade' }),
    );

    expect(updates).toHaveLength(1);
    const { sql, values } = updates[0];

    // Both columns must update — they're consumed together by the
    // banner's renderer and the acknowledge endpoint nulls them as a
    // pair, so partial population would leave the UI in a wedged state.
    expect(sql).toMatch(/downgrade_completed_at\s*=\s*NOW\(\)/);
    expect(sql).toMatch(/downgrade_completed_to_plan\s*=\s*\$\d+/);
    expect(values).toContain('pro');
  });

  it('stamps the downgrade-completed columns on pro→starter as well', async () => {
    const { updates } = captureSubscriptionUpdate({ priorPlan: 'pro' });

    await handleStripeEvent(
      makeUpdatedEvent('price_starter_monthly_test', 'month', { id: 'evt_pro_to_starter' }),
    );

    expect(updates).toHaveLength(1);
    const { sql, values } = updates[0];
    expect(sql).toMatch(/downgrade_completed_at\s*=\s*NOW\(\)/);
    expect(sql).toMatch(/downgrade_completed_to_plan\s*=\s*\$\d+/);
    expect(values).toContain('starter');
  });

  it('does NOT stamp the downgrade-completed columns on a same-tier interval-only swap (pro monthly→annual)', async () => {
    // The most common non-downgrade event: Stripe transitions a
    // schedule's interval phase but the tier rank is unchanged. The
    // banner must not fire for these or the user would see an
    // erroneous "downgrade is now active" message after switching
    // to annual billing on the same plan.
    const { updates } = captureSubscriptionUpdate({ priorPlan: 'pro' });

    await handleStripeEvent(
      makeUpdatedEvent('price_pro_annual_test', 'year', { id: 'evt_pro_interval_swap' }),
    );

    expect(updates).toHaveLength(1);
    const { sql } = updates[0];
    expect(sql).not.toMatch(/downgrade_completed_at/);
    expect(sql).not.toMatch(/downgrade_completed_to_plan/);
  });

  it('does NOT stamp the downgrade-completed columns on a strict tier upgrade (starter→pro)', async () => {
    // Defensive: a webhook with a higher-tier new price than the
    // prior local plan should never look like a downgrade. The
    // tier-upgrade banner is driven entirely by the client-side
    // sessionStorage marker, not these columns.
    const { updates } = captureSubscriptionUpdate({ priorPlan: 'starter' });

    await handleStripeEvent(
      makeUpdatedEvent('price_pro_monthly_test', 'month', { id: 'evt_starter_to_pro' }),
    );

    expect(updates).toHaveLength(1);
    const { sql } = updates[0];
    expect(sql).not.toMatch(/downgrade_completed_at/);
    expect(sql).not.toMatch(/downgrade_completed_to_plan/);
  });

  it('does NOT stamp the downgrade-completed columns when the prior plan is unknown', async () => {
    // Without a prior plan we can't tell whether this is a downgrade
    // — defensively skip the stamp rather than risk firing the
    // banner spuriously on a fresh row.
    const { updates } = captureSubscriptionUpdate(); // no priorPlan

    await handleStripeEvent(
      makeUpdatedEvent('price_starter_monthly_test', 'month', { id: 'evt_no_prior_plan' }),
    );

    expect(updates).toHaveLength(1);
    const { sql } = updates[0];
    expect(sql).not.toMatch(/downgrade_completed_at/);
    expect(sql).not.toMatch(/downgrade_completed_to_plan/);
  });
});

describe('handleStripeEvent — checkout.session.completed', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    subscriptionsRetrieveMock.mockReset();
  });

  it('normalizes Stripe interval=year to billing_interval=annual on initial checkout', async () => {
    // Without the normalization helper, this INSERT would either store
    // raw 'year' (rejected by the billing_interval enum cast) or fall
    // back to the COALESCE default of 'monthly', which is the bug the
    // reviewer flagged on the upgrade/switch-to-annual path.
    const { inserts } = captureSubscriptionUpdate();
    subscriptionsRetrieveMock.mockResolvedValue({
      id: 'sub_1',
      current_period_start: Math.floor(Date.UTC(2026, 5, 1) / 1000),
      current_period_end: Math.floor(Date.UTC(2027, 5, 1) / 1000),
      items: {
        data: [
          {
            id: 'si_1',
            price: { id: 'price_pro_annual_test', recurring: { interval: 'year' } },
          },
        ],
      },
    });

    await handleStripeEvent(makeCheckoutEvent('price_pro_annual_test', 'year'));

    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toContain('annual');
    expect(inserts[0].values).toContain('price_pro_annual_test');
    // 'year' must NEVER reach the database — the enum doesn't accept it.
    expect(inserts[0].values).not.toContain('year');
  });

  it('normalizes Stripe interval=month to billing_interval=monthly on initial checkout', async () => {
    const { inserts } = captureSubscriptionUpdate();
    subscriptionsRetrieveMock.mockResolvedValue({
      id: 'sub_1',
      current_period_start: Math.floor(Date.UTC(2026, 5, 1) / 1000),
      current_period_end: Math.floor(Date.UTC(2026, 6, 1) / 1000),
      items: {
        data: [
          {
            id: 'si_1',
            price: { id: 'price_pro_monthly_test', recurring: { interval: 'month' } },
          },
        ],
      },
    });

    await handleStripeEvent(makeCheckoutEvent('price_pro_monthly_test', 'month'));

    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toContain('monthly');
    expect(inserts[0].values).toContain('price_pro_monthly_test');
    expect(inserts[0].values).not.toContain('month');
  });
});
