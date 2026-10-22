/**
 * The onboarding verify-checkout route and the checkout.session.completed
 * webhook race right after the Stripe redirect. On pg-mem:
 *  - a `trialing` row the webhook already wrote for the same Stripe
 *    subscription stays `trialing` (with its trial_end) after
 *    verify-checkout, even while the tenant is still `pending`;
 *  - with no webhook row yet, verify-checkout writes Stripe's status and
 *    trial_end, not a forced 'active'.
 */
import { newDb } from 'pg-mem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  pool: null as unknown as { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; connect: () => Promise<unknown> },
  sessionRetrieveMock: vi.fn(),
  subscriptionRetrieveMock: vi.fn(),
  provisionTenantMock: vi.fn(),
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => h.pool,
  withPrivilegedClient: async (fn: (c: unknown) => Promise<unknown>) => fn(h.pool),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => ({
    checkout: { sessions: { retrieve: h.sessionRetrieveMock } },
    subscriptions: { retrieve: h.subscriptionRetrieveMock },
  }),
  getWebhookSecret: () => 'whsec_test',
}));
vi.mock('../../platform/tenant/provisioning/TenantProvisioningService', () => ({
  provisionTenant: h.provisionTenantMock,
  getProvisioningStatus: vi.fn(),
}));
vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'user-1', tenantId: TENANT, role: 'tenant_owner', isPlatformAdmin: false } as never;
    next();
  },
  invalidateTenantStatusCache: vi.fn(),
}));
vi.mock('../../platform/agent-templates/registry', () => ({ getRegisteredTemplates: () => [] }));
vi.mock('../../platform/activation/ActivationService', () => ({
  getActivationMilestones: vi.fn(), dismissTooltip: vi.fn(), getDismissedTooltips: vi.fn(),
}));
vi.mock('../../platform/billing/tenantCurrency', () => ({ invalidateTenantCurrencyCache: vi.fn() }));
vi.mock('../../platform/audit/AuditService', () => ({ writeAuditLog: vi.fn(), extractIp: () => '127.0.0.1' }));

import type Stripe from 'stripe';
import { handleCheckoutCompleted } from '../../platform/billing/stripe/webhook';
import tenantsRouter from '../../server/admin-api/routes/tenants';

const TENANT = 'tenant-1';
const TRIAL_END_UNIX = Math.floor(Date.UTC(2026, 9, 28) / 1000);
const TRIAL_END_ISO = new Date(TRIAL_END_UNIX * 1000).toISOString();

const SCHEMA = `
  CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'paused', 'cancelled');
  CREATE TYPE billing_interval AS ENUM ('monthly', 'annual');
  CREATE TABLE tenants (id VARCHAR PRIMARY KEY, status VARCHAR(30) NOT NULL);
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
    monthly_call_limit INTEGER,
    monthly_sms_limit INTEGER,
    monthly_ai_minute_limit INTEGER,
    overage_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE billing_events (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR NOT NULL,
    event_type VARCHAR(60) NOT NULL,
    stripe_event_id VARCHAR(60),
    metadata JSONB DEFAULT '{}'
  );
`;

function checkoutSession(subscription = 'sub_1'): Stripe.Checkout.Session {
  return {
    id: 'cs_1',
    customer: 'cus_1',
    subscription,
    status: 'complete',
    payment_status: 'no_payment_required',
    metadata: { tenantId: TENANT, plan: 'pro' },
  } as unknown as Stripe.Checkout.Session;
}

function stripeSub(status: string, trialEnd: number | null, id = 'sub_1') {
  return {
    id,
    status,
    trial_end: trialEnd,
    items: { data: [{ id: 'si_1', price: { id: 'price_pro_monthly_test', recurring: { interval: 'month' } } }] },
  };
}

async function planRow() {
  const { rows } = await h.pool.query(`SELECT * FROM subscriptions WHERE tenant_id = $1`, [TENANT]);
  return rows[0];
}

function iso(v: unknown): string | null {
  return v == null ? null : new Date(v as string).toISOString();
}

async function verifyCheckout() {
  const app = express();
  app.use(express.json());
  app.use(tenantsRouter);
  return request(app).post('/tenants/me/verify-checkout').send({ sessionId: 'cs_1' });
}

beforeEach(async () => {
  const db = newDb();
  db.public.none(SCHEMA);
  const { Pool } = db.adapters.createPg();
  h.pool = new Pool();
  await h.pool.query(`INSERT INTO tenants (id, status) VALUES ($1, 'pending')`, [TENANT]);
  h.sessionRetrieveMock.mockReset().mockResolvedValue(checkoutSession());
  h.subscriptionRetrieveMock.mockReset();
  h.provisionTenantMock.mockReset().mockResolvedValue(undefined);
});

describe('verify-checkout after the checkout webhook', () => {
  it('a webhook-written trialing row stays trialing after verify-checkout (tenant still pending)', async () => {
    h.subscriptionRetrieveMock.mockResolvedValue(stripeSub('trialing', TRIAL_END_UNIX));
    await handleCheckoutCompleted(checkoutSession(), 'evt_co_1');
    expect((await planRow()).status).toBe('trialing');

    const res = await verifyCheckout();

    expect(res.body).toEqual({ status: 'ready' });
    const row = await planRow();
    expect(row.status).toBe('trialing');
    expect(iso(row.trial_end)).toBe(TRIAL_END_ISO);
    expect(row.stripe_subscription_id).toBe('sub_1');
  });

  it('never overwrites the webhook row for the same subscription, even if its own read differs', async () => {
    h.subscriptionRetrieveMock.mockResolvedValueOnce(stripeSub('trialing', TRIAL_END_UNIX));
    await handleCheckoutCompleted(checkoutSession(), 'evt_co_1');

    h.subscriptionRetrieveMock.mockResolvedValueOnce(stripeSub('active', null));
    await verifyCheckout();

    const row = await planRow();
    expect(row.status).toBe('trialing');
    expect(iso(row.trial_end)).toBe(TRIAL_END_ISO);
  });
});

describe('verify-checkout before the checkout webhook', () => {
  it('writes Stripe trialing + trial_end, not active', async () => {
    h.subscriptionRetrieveMock.mockResolvedValue(stripeSub('trialing', TRIAL_END_UNIX));

    await verifyCheckout();

    const row = await planRow();
    expect(row.status).toBe('trialing');
    expect(iso(row.trial_end)).toBe(TRIAL_END_ISO);
    expect(row.plan).toBe('pro');
    expect(h.provisionTenantMock).toHaveBeenCalledWith(TENANT, 'user-1', 'pro');
  });

  it('replaces a row that tracks a different (older) subscription', async () => {
    await h.pool.query(
      `INSERT INTO subscriptions (tenant_id, plan, status, stripe_subscription_id) VALUES ($1, 'starter', 'cancelled', 'sub_old')`,
      [TENANT],
    );
    h.subscriptionRetrieveMock.mockResolvedValue(stripeSub('trialing', TRIAL_END_UNIX));

    await verifyCheckout();

    const row = await planRow();
    expect(row.stripe_subscription_id).toBe('sub_1');
    expect(row.status).toBe('trialing');
  });
});
