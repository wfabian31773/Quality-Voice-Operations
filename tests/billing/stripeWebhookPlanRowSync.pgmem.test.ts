/**
 * Runs the Stripe webhook's plan-row SQL on pg-mem:
 *  - subscription.updated / .created / .deleted only touch the tenant's
 *    plan row for the subscription it tracks (or when none is tracked yet),
 *    and never for marketplace subscriptions;
 *  - subscription.updated re-reads the subscription from Stripe so a stale
 *    or out-of-order payload can't roll the row back;
 *  - invoice.payment_succeeded's $0-invoice branch keeps a trial trialing.
 */
import { newDb } from 'pg-mem';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pool: null as unknown as { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>; connect: () => Promise<unknown> },
  retrieveMock: vi.fn(),
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => h.pool,
  withPrivilegedClient: async (fn: (c: unknown) => Promise<unknown>) => fn(h.pool),
  withTenantContext: async () => undefined,
}));
vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({ subscriptions: { retrieve: h.retrieveMock } }),
  getWebhookSecret: () => 'whsec_test',
}));
vi.mock('../../platform/tenant/provisioning/TenantProvisioningService', () => ({ provisionTenant: vi.fn() }));

import type Stripe from 'stripe';
import { handleStripeEvent } from '../../platform/billing/stripe/webhook';

const SCHEMA = `
  CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'paused', 'cancelled');
  CREATE TYPE billing_interval AS ENUM ('monthly', 'annual');
  CREATE TYPE billing_event_type AS ENUM (
    'subscription_created', 'subscription_updated', 'subscription_cancelled',
    'invoice_paid', 'invoice_failed', 'usage_charged', 'credit_applied', 'refund_issued'
  );
  CREATE TABLE subscriptions (
    tenant_id VARCHAR PRIMARY KEY,
    plan VARCHAR(50) NOT NULL DEFAULT 'starter',
    status subscription_status NOT NULL DEFAULT 'trialing',
    billing_interval billing_interval NOT NULL DEFAULT 'monthly',
    stripe_customer_id VARCHAR(60),
    stripe_subscription_id VARCHAR(60),
    stripe_price_id VARCHAR(60),
    current_period_start TIMESTAMP,
    current_period_end TIMESTAMP,
    trial_end TIMESTAMP,
    cancelled_at TIMESTAMP,
    monthly_call_limit INTEGER,
    monthly_sms_limit INTEGER,
    monthly_ai_minute_limit INTEGER,
    overage_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    downgrade_completed_at TIMESTAMP,
    downgrade_completed_to_plan VARCHAR(50),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE billing_events (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR NOT NULL,
    event_type billing_event_type NOT NULL,
    stripe_event_id VARCHAR(60),
    metadata JSONB DEFAULT '{}'
  );
  CREATE TABLE marketplace_purchases (
    id VARCHAR PRIMARY KEY,
    stripe_subscription_id VARCHAR(60),
    subscription_status VARCHAR(30),
    completed_at TIMESTAMP
  );
`;

const TENANT = 'tenant-1';
const CUSTOMER = 'cus_1';
const TRIAL_END_UNIX = Math.floor(Date.UTC(2026, 9, 28) / 1000);
const PRICE_IDS: Record<string, string> = {
  STRIPE_PRICE_STARTER_MONTHLY: 'price_starter_monthly_test',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_monthly_test',
};
const originalEnv: Record<string, string | undefined> = {};
let seq = 0;

beforeAll(() => {
  for (const [k, v] of Object.entries(PRICE_IDS)) {
    originalEnv[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  const db = newDb();
  db.public.none(SCHEMA);
  const { Pool } = db.adapters.createPg();
  h.pool = new Pool();
  h.retrieveMock.mockReset();
});

async function seedPlanRow(row: { status: string; stripe_subscription_id: string | null; plan?: string }) {
  await h.pool.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, stripe_customer_id, stripe_subscription_id)
     VALUES ($1, $2, $3::subscription_status, $4, $5)`,
    [TENANT, row.plan ?? 'pro', row.status, CUSTOMER, row.stripe_subscription_id],
  );
}

async function planRow() {
  const { rows } = await h.pool.query(`SELECT * FROM subscriptions WHERE tenant_id = $1`, [TENANT]);
  return rows[0];
}

function stripeSub(opts: {
  id: string;
  status: string;
  priceId?: string;
  trialEnd?: number | null;
  metadata?: Record<string, string>;
}) {
  return {
    id: opts.id,
    customer: CUSTOMER,
    status: opts.status,
    trial_end: opts.trialEnd ?? null,
    metadata: opts.metadata ?? {},
    items: { data: [{ id: 'si_1', price: { id: opts.priceId ?? 'price_pro_monthly_test', recurring: { interval: 'month' } } }] },
  };
}

function event(type: string, object: unknown): Stripe.Event {
  return { id: `evt_${type}_${++seq}`, type, data: { object } } as unknown as Stripe.Event;
}

describe('customer.subscription.updated — which subscription owns the plan row', () => {
  it('syncs the tenant plan subscription', async () => {
    await seedPlanRow({ status: 'trialing', stripe_subscription_id: 'sub_plan' });
    const sub = stripeSub({ id: 'sub_plan', status: 'active', trialEnd: TRIAL_END_UNIX });
    h.retrieveMock.mockResolvedValue(sub);

    await handleStripeEvent(event('customer.subscription.updated', sub));

    const row = await planRow();
    expect(row.status).toBe('active');
    expect(row.trial_end).not.toBeNull();
  });

  it('syncs a row that tracks no subscription yet', async () => {
    await seedPlanRow({ status: 'trialing', stripe_subscription_id: null });
    const sub = stripeSub({ id: 'sub_new', status: 'active' });
    h.retrieveMock.mockResolvedValue(sub);

    await handleStripeEvent(event('customer.subscription.updated', sub));

    expect((await planRow()).status).toBe('active');
  });

  it('ignores a foreign subscription on the same customer (old sub left after an upgrade)', async () => {
    await seedPlanRow({ status: 'trialing', stripe_subscription_id: 'sub_pro', plan: 'pro' });
    const oldStarter = stripeSub({ id: 'sub_old_starter', status: 'past_due', priceId: 'price_starter_monthly_test' });
    h.retrieveMock.mockResolvedValue(oldStarter);

    await handleStripeEvent(event('customer.subscription.updated', oldStarter));

    const row = await planRow();
    expect(row.status).toBe('trialing');
    expect(row.plan).toBe('pro');
    const { rows } = await h.pool.query(`SELECT * FROM billing_events`);
    expect(rows).toHaveLength(0);
  });

  it('ignores a marketplace subscription for the plan row but still updates marketplace_purchases', async () => {
    await seedPlanRow({ status: 'active', stripe_subscription_id: null });
    await h.pool.query(`INSERT INTO marketplace_purchases (id, stripe_subscription_id) VALUES ('mp1', 'sub_mkt')`);
    const mkt = stripeSub({ id: 'sub_mkt', status: 'past_due', metadata: { type: 'marketplace_purchase' } });
    h.retrieveMock.mockResolvedValue(mkt);

    await handleStripeEvent(event('customer.subscription.updated', mkt));

    expect((await planRow()).status).toBe('active');
    const { rows } = await h.pool.query(`SELECT subscription_status FROM marketplace_purchases WHERE id = 'mp1'`);
    expect(rows[0].subscription_status).toBe('past_due');
  });

  it('ignores an older marketplace subscription with no metadata.type, found via marketplace_purchases', async () => {
    await seedPlanRow({ status: 'active', stripe_subscription_id: null });
    await h.pool.query(`INSERT INTO marketplace_purchases (id, stripe_subscription_id) VALUES ('mp1', 'sub_mkt_legacy')`);
    const legacy = stripeSub({ id: 'sub_mkt_legacy', status: 'canceled' });
    h.retrieveMock.mockResolvedValue(legacy);

    await handleStripeEvent(event('customer.subscription.updated', legacy));

    expect((await planRow()).status).toBe('active');
  });
});

describe('customer.subscription.updated — stale / out-of-order payloads', () => {
  it('writes the subscription state re-read from Stripe, not the stale payload', async () => {
    await seedPlanRow({ status: 'active', stripe_subscription_id: 'sub_plan' });
    const stalePayload = stripeSub({ id: 'sub_plan', status: 'trialing', trialEnd: TRIAL_END_UNIX });
    h.retrieveMock.mockResolvedValue(stripeSub({ id: 'sub_plan', status: 'active', trialEnd: TRIAL_END_UNIX }));

    await handleStripeEvent(event('customer.subscription.updated', stalePayload));

    expect(h.retrieveMock).toHaveBeenCalledWith('sub_plan');
    expect((await planRow()).status).toBe('active');
  });

  it('falls back to the payload when Stripe cannot be reached', async () => {
    await seedPlanRow({ status: 'trialing', stripe_subscription_id: 'sub_plan' });
    h.retrieveMock.mockRejectedValue(new Error('stripe down'));

    await handleStripeEvent(event('customer.subscription.updated', stripeSub({ id: 'sub_plan', status: 'past_due' })));

    expect((await planRow()).status).toBe('past_due');
  });
});

describe('customer.subscription.created', () => {
  it('gets the same sync as updated (e.g. corrects the checkout fallback to active)', async () => {
    await seedPlanRow({ status: 'active', stripe_subscription_id: 'sub_plan' });
    const sub = stripeSub({ id: 'sub_plan', status: 'trialing', trialEnd: TRIAL_END_UNIX });
    h.retrieveMock.mockResolvedValue(sub);

    await handleStripeEvent(event('customer.subscription.created', sub));

    const row = await planRow();
    expect(row.status).toBe('trialing');
    expect(row.trial_end).not.toBeNull();
  });
});

describe('customer.subscription.deleted', () => {
  it('cancels the plan row for its own subscription', async () => {
    await seedPlanRow({ status: 'active', stripe_subscription_id: 'sub_plan' });

    await handleStripeEvent(event('customer.subscription.deleted', stripeSub({ id: 'sub_plan', status: 'canceled' })));

    const row = await planRow();
    expect(row.status).toBe('cancelled');
    expect(row.cancelled_at).not.toBeNull();
  });

  it('leaves the plan row alone when a foreign subscription is deleted', async () => {
    await seedPlanRow({ status: 'active', stripe_subscription_id: 'sub_pro' });

    await handleStripeEvent(event('customer.subscription.deleted', stripeSub({ id: 'sub_old_starter', status: 'canceled' })));

    expect((await planRow()).status).toBe('active');
    const { rows } = await h.pool.query(`SELECT * FROM billing_events`);
    expect(rows).toHaveLength(0);
  });

  it('leaves the plan row alone for a marketplace subscription but marks the purchase canceled', async () => {
    await seedPlanRow({ status: 'active', stripe_subscription_id: null });
    await h.pool.query(`INSERT INTO marketplace_purchases (id, stripe_subscription_id) VALUES ('mp1', 'sub_mkt')`);

    await handleStripeEvent(event('customer.subscription.deleted', stripeSub({
      id: 'sub_mkt', status: 'canceled', metadata: { type: 'marketplace_purchase' },
    })));

    expect((await planRow()).status).toBe('active');
    const { rows } = await h.pool.query(`SELECT subscription_status FROM marketplace_purchases WHERE id = 'mp1'`);
    expect(rows[0].subscription_status).toBe('canceled');
  });
});

describe('invoice.payment_succeeded — $0 trial invoice', () => {
  const invoice = (amountPaid: number) => ({ id: `in_${++seq}`, customer: CUSTOMER, amount_paid: amountPaid, currency: 'usd' });

  it('a $0 invoice keeps a trialing row trialing', async () => {
    await seedPlanRow({ status: 'trialing', stripe_subscription_id: 'sub_plan' });
    await handleStripeEvent(event('invoice.payment_succeeded', invoice(0)));
    expect((await planRow()).status).toBe('trialing');
  });

  it('a non-zero invoice flips trialing to active', async () => {
    await seedPlanRow({ status: 'trialing', stripe_subscription_id: 'sub_plan' });
    await handleStripeEvent(event('invoice.payment_succeeded', invoice(34900)));
    expect((await planRow()).status).toBe('active');
  });

  it('a $0 invoice on a past_due row flips it to active', async () => {
    await seedPlanRow({ status: 'past_due', stripe_subscription_id: 'sub_plan' });
    await handleStripeEvent(event('invoice.payment_succeeded', invoice(0)));
    expect((await planRow()).status).toBe('active');
  });
});
