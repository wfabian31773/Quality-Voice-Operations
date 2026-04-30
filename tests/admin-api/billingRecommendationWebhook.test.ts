// Verifies the Stripe webhook is the source of truth for the
// recommendation-banner "switch_completed" event. The tenant-facing
// /billing/recommendation-event route deliberately rejects this event
// type (see billingRecommendationEvents.test.ts) so a malicious client
// can't inflate the conversion count — the row is only written when
// Stripe confirms the checkout.session.completed and its session
// metadata carries the recommendation snapshot stamped at checkout
// creation time (see platform/billing/stripe/checkout.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Stripe from 'stripe';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
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
    subscriptions: {
      retrieve: vi.fn(async () => ({
        items: { data: [{ price: { id: 'price_pro_monthly', recurring: { interval: 'month' } } }] },
        current_period_start: 1700000000,
        current_period_end: 1702000000,
      })),
    },
  }),
  getWebhookSecret: () => 'whsec_test',
}));

vi.mock('../../platform/billing/stripe/plans', () => ({
  getPlanFromPriceId: () => 'pro',
  PLAN_LIMITS: {
    starter: { monthlyCallLimit: 1, monthlySmsLimit: 1, monthlyAiMinuteLimit: 1, overageEnabled: false },
    pro: { monthlyCallLimit: 10, monthlySmsLimit: 10, monthlyAiMinuteLimit: 10, overageEnabled: true },
    enterprise: { monthlyCallLimit: 100, monthlySmsLimit: 100, monthlyAiMinuteLimit: 100, overageEnabled: true },
  },
}));

vi.mock('../../platform/tenant/provisioning/TenantProvisioningService', () => ({
  provisionTenant: vi.fn(),
}));

vi.mock('../../platform/analytics/WebsiteConversionService', () => ({
  recordConversionEvent: vi.fn(),
  getVisitorAttribution: vi.fn(async () => null),
}));

import { handleStripeEvent } from '../../platform/billing/stripe/webhook';

function buildSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: 'cs_test_rec_1',
    customer: 'cus_test_1',
    subscription: 'sub_test_1',
    metadata: {
      tenantId: 'tenant-rec',
      plan: 'pro',
      ...(overrides.metadata as Record<string, string> | undefined),
    },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function buildEvent(session: Stripe.Checkout.Session): Stripe.Event {
  return {
    id: `evt_${session.id}`,
    type: 'checkout.session.completed',
    data: { object: session },
  } as unknown as Stripe.Event;
}

describe('handleStripeEvent — recommendation switch_completed attribution', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('inserts a switch_completed row when the session metadata carries the recommendation snapshot', async () => {
    const session = buildSession({
      metadata: {
        tenantId: 'tenant-rec',
        plan: 'pro',
        recommendationSource: 'billing_estimator_recommendation',
        recommendationCurrentTier: 'enterprise',
        recommendationRecommendedTier: 'pro',
        recommendationMonthlySavingsCents: '30000',
        recommendationTrailingWindowMonths: '6',
      } as unknown as Stripe.Metadata,
    });

    await handleStripeEvent(buildEvent(session));

    const recInsert = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(recInsert).toBeDefined();
    const [, params] = recInsert as [string, unknown[]];
    expect(params[0]).toBe('tenant-rec');
    expect(params[1]).toBe('enterprise');
    expect(params[2]).toBe('pro');
    expect(params[3]).toBe(30000);
    expect(params[4]).toBe(6);
  });

  it('does not insert a switch_completed row when recommendation metadata is absent', async () => {
    await handleStripeEvent(buildEvent(buildSession()));

    const recInsert = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(recInsert).toBeUndefined();
  });

  it('skips the insert if recommendation tier metadata is malformed', async () => {
    const session = buildSession({
      metadata: {
        tenantId: 'tenant-rec',
        plan: 'pro',
        recommendationSource: 'billing_estimator_recommendation',
        recommendationCurrentTier: 'gold',
        recommendationRecommendedTier: 'pro',
      } as unknown as Stripe.Metadata,
    });

    await handleStripeEvent(buildEvent(session));

    const recInsert = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(recInsert).toBeUndefined();
  });

  it('writes a discount_switch_completed row when session metadata carries upgradeDiscount* fields', async () => {
    // The SELECT on subscriptions runs BEFORE the UPSERT so current_tier
    // reflects the prior plan, not the new one.
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT plan FROM subscriptions/i.test(sql)) {
        return { rows: [{ plan: 'starter' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const session = buildSession({
      metadata: {
        tenantId: 'tenant-rec',
        plan: 'pro',
        upgradeDiscountCouponId: 'cou_promo20',
        upgradeDiscountPromotionCode: 'PROMO20',
      } as unknown as Stripe.Metadata,
    });

    await handleStripeEvent(buildEvent(session));

    const inserts = queryMock.mock.calls.filter(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    const discountInsert = inserts.find(([sql]) =>
      /'discount_switch_completed'/i.test(String(sql)),
    );
    expect(discountInsert).toBeDefined();
    const [, params] = discountInsert as [string, unknown[]];
    expect(params[0]).toBe('tenant-rec');
    // params order: tenant_id, current_tier, recommended_tier, metadata,
    // coupon_id, promotion_code (the SQL itself names the event_type).
    expect(params[1]).toBe('starter');
    expect(params[2]).toBe('pro');
    expect(params[4]).toBe('cou_promo20');
    expect(params[5]).toBe('PROMO20');
  });

  it('prefers recommendationCurrentTier over the prior subscription plan when both are present', async () => {
    // When the tenant clicked through the recommendation banner AND
    // had an active discount badge, both attribution rows should
    // agree on current_tier — so the discount row uses the
    // recommendation snapshot's tier rather than the prior plan.
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT plan FROM subscriptions/i.test(sql)) {
        return { rows: [{ plan: 'pro' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const session = buildSession({
      metadata: {
        tenantId: 'tenant-rec',
        plan: 'pro',
        recommendationSource: 'billing_estimator_recommendation',
        recommendationCurrentTier: 'enterprise',
        recommendationRecommendedTier: 'pro',
        recommendationMonthlySavingsCents: '15000',
        upgradeDiscountCouponId: 'cou_promo20',
      } as unknown as Stripe.Metadata,
    });

    await handleStripeEvent(buildEvent(session));

    const inserts = queryMock.mock.calls.filter(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    const discountInsert = inserts.find(([sql]) =>
      /'discount_switch_completed'/i.test(String(sql)),
    );
    expect(discountInsert).toBeDefined();
    const [, params] = discountInsert as [string, unknown[]];
    // current_tier from recommendation snapshot ('enterprise'), NOT the
    // prior plan from subscriptions ('pro').
    expect(params[1]).toBe('enterprise');
    expect(params[4]).toBe('cou_promo20');
    expect(params[5]).toBeNull();
  });

  it('does not insert a discount_switch_completed row when no upgradeDiscount* metadata is present', async () => {
    await handleStripeEvent(buildEvent(buildSession()));

    const inserts = queryMock.mock.calls.filter(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    const discountInsert = inserts.find(([sql]) =>
      /'discount_switch_completed'/i.test(String(sql)),
    );
    expect(discountInsert).toBeUndefined();
  });

  it('skips on duplicate Stripe event id (webhook idempotency dedupe)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/FROM billing_events WHERE stripe_event_id/i.test(sql)) {
        return { rows: [{}], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const session = buildSession({
      metadata: {
        tenantId: 'tenant-rec',
        plan: 'pro',
        recommendationSource: 'billing_estimator_recommendation',
        recommendationCurrentTier: 'enterprise',
        recommendationRecommendedTier: 'pro',
        recommendationMonthlySavingsCents: '30000',
      } as unknown as Stripe.Metadata,
    });

    await handleStripeEvent(buildEvent(session));

    const recInsert = queryMock.mock.calls.find(([sql]) =>
      /INSERT INTO billing_recommendation_events/i.test(String(sql)),
    );
    expect(recInsert).toBeUndefined();
  });
});
