/**
 * TrialGuard separates the free trial (no Stripe subscription; TRIAL_LIMITS)
 * from a Stripe trial (paid plan in Stripe's trial period; the plan's own
 * limits). Free-trial expiry prefers the subscription's `trial_end`, falling
 * back to the signup-time `tenants.trial_expires_at`. A Stripe trial gets a
 * grace window past `trial_end` while the conversion webhook lands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '../../platform/core/types';

let subRow: Record<string, unknown> | undefined;
let tenantTrialExpiresAt: unknown;
let usageRows: Array<{ metric_type: string; total: string }>;
let agentCount: string;

// Only return the subscription columns the guard's SELECT names, so the
// test fails if the guard stops reading a column it depends on.
function selectedColumns(sql: string, row: Record<string, unknown>): Record<string, unknown> {
  const list = sql.match(/SELECT\s+([\s\S]+?)\s+FROM/i)?.[1] ?? '';
  const cols = list.split(',').map((c) => c.trim());
  return Object.fromEntries(Object.entries(row).filter(([k]) => cols.includes(k)));
}

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string) => {
        if (/FROM subscriptions/.test(sql)) return { rows: subRow ? [selectedColumns(sql, subRow)] : [] };
        if (/FROM tenants/.test(sql)) return { rows: [{ trial_expires_at: tenantTrialExpiresAt }] };
        if (/FROM usage_metrics/.test(sql)) return { rows: usageRows };
        if (/FROM agents/.test(sql)) return { rows: [{ count: agentCount }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    }),
  }),
  withTenantContext: vi.fn(async () => undefined),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  checkTrialAgentLimit,
  checkTrialLimits,
  isStripeTrial,
  isTrialSubscription,
  STRIPE_TRIAL_GRACE_MS,
  stripeTrialLapsed,
} from '../../platform/billing/guardrails/TrialGuard';

const TENANT = 'tenant-trial-guard' as TenantId;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  subRow = undefined;
  tenantTrialExpiresAt = null;
  usageRows = [];
  agentCount = '0';
});

describe('isTrialSubscription / isStripeTrial', () => {
  it('free trial: no row, or trialing with no Stripe subscription', () => {
    expect(isTrialSubscription(undefined)).toBe(true);
    expect(isTrialSubscription({ status: 'trialing' })).toBe(true);
    expect(isTrialSubscription({ status: 'trialing', stripe_subscription_id: null })).toBe(true);
    expect(isStripeTrial({ status: 'trialing', stripe_subscription_id: null })).toBe(false);
  });

  it('Stripe trial: trialing with a Stripe subscription is not the free trial', () => {
    const sub = { status: 'trialing', stripe_subscription_id: 'sub_1' };
    expect(isTrialSubscription(sub)).toBe(false);
    expect(isStripeTrial(sub)).toBe(true);
  });

  it('active/past_due are neither', () => {
    for (const status of ['active', 'past_due']) {
      expect(isTrialSubscription({ status, stripe_subscription_id: 'sub_1' })).toBe(false);
      expect(isStripeTrial({ status, stripe_subscription_id: 'sub_1' })).toBe(false);
    }
  });

  it('stripeTrialLapsed only after trial_end plus the grace window', () => {
    const now = Date.UTC(2026, 9, 21);
    const sub = (endOffset: number) => ({
      status: 'trialing', stripe_subscription_id: 'sub_1', trial_end: new Date(now + endOffset),
    });
    expect(stripeTrialLapsed(sub(DAY), now)).toBe(false);
    expect(stripeTrialLapsed(sub(-HOUR), now)).toBe(false);
    expect(stripeTrialLapsed(sub(-STRIPE_TRIAL_GRACE_MS + HOUR), now)).toBe(false);
    expect(stripeTrialLapsed(sub(-STRIPE_TRIAL_GRACE_MS - HOUR), now)).toBe(true);
    // Free-trial rows never use the grace path.
    expect(stripeTrialLapsed({ status: 'trialing', trial_end: new Date(now - 2 * DAY) }, now)).toBe(false);
  });
});

describe('checkTrialLimits — free trial', () => {
  it('uses the subscription trial_end, not an earlier tenant trial_expires_at', async () => {
    const trialEnd = new Date(Date.now() + 5 * DAY);
    subRow = { status: 'trialing', trial_end: trialEnd, stripe_subscription_id: null };
    tenantTrialExpiresAt = new Date(Date.now() - DAY);

    const result = await checkTrialLimits(TENANT);

    expect(result.isTrial).toBe(true);
    expect(result.allowed).toBe(true);
    expect(result.trialExpiresAt).toBe(trialEnd.toISOString());
  });

  it('blocks once trial_end has passed, with no grace window', async () => {
    subRow = { status: 'trialing', trial_end: new Date(Date.now() - HOUR), stripe_subscription_id: null };
    tenantTrialExpiresAt = new Date(Date.now() + DAY);

    const result = await checkTrialLimits(TENANT);

    expect(result.isTrial).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it('falls back to tenant trial_expires_at when the subscription has no trial_end', async () => {
    const tenantEnd = new Date(Date.now() + 3 * DAY);
    subRow = { status: 'trialing', trial_end: null, stripe_subscription_id: null };
    tenantTrialExpiresAt = tenantEnd;

    const result = await checkTrialLimits(TENANT);

    expect(result.allowed).toBe(true);
    expect(result.trialExpiresAt).toBe(tenantEnd.toISOString());
  });

  it('still enforces TRIAL_LIMITS call and agent caps', async () => {
    subRow = { status: 'trialing', trial_end: new Date(Date.now() + DAY), stripe_subscription_id: null };
    usageRows = [{ metric_type: 'calls_inbound', total: '20' }];
    agentCount = '2';

    expect((await checkTrialLimits(TENANT)).allowed).toBe(false);
    expect((await checkTrialAgentLimit(TENANT)).allowed).toBe(false);
  });
});

describe('checkTrialLimits — unpaid statuses (same rule as checkBudget)', () => {
  it.each(['paused', 'past_due', 'cancelled'])('blocks a %s plan row, including agent creation', async (status) => {
    subRow = { status, trial_end: null, stripe_subscription_id: 'sub_1' };

    const result = await checkTrialLimits(TENANT);

    expect(result.isTrial).toBe(false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(`Subscription is ${status}. Please update your billing to continue.`);
    expect(await checkTrialAgentLimit(TENANT)).toEqual({ allowed: false, reason: result.reason });
  });

  it('allows an active plan row', async () => {
    subRow = { status: 'active', trial_end: null, stripe_subscription_id: 'sub_1' };

    expect((await checkTrialLimits(TENANT)).allowed).toBe(true);
    expect((await checkTrialAgentLimit(TENANT)).allowed).toBe(true);
  });
});

describe('checkTrialLimits — Stripe trial (paid plan)', () => {
  it('is not held to TRIAL_LIMITS: usage past the free-trial caps is allowed', async () => {
    subRow = { status: 'trialing', trial_end: new Date(Date.now() + 5 * DAY), stripe_subscription_id: 'sub_1' };
    usageRows = [
      { metric_type: 'calls_inbound', total: '25' },
      { metric_type: 'tool_executions', total: '40' },
    ];
    agentCount = '5';

    const result = await checkTrialLimits(TENANT);

    expect(result.isTrial).toBe(false);
    expect(result.allowed).toBe(true);
    expect((await checkTrialAgentLimit(TENANT)).allowed).toBe(true);
  });

  it('keeps working inside the grace window after trial_end', async () => {
    subRow = { status: 'trialing', trial_end: new Date(Date.now() - 2 * HOUR), stripe_subscription_id: 'sub_1' };

    const result = await checkTrialLimits(TENANT);

    expect(result.isTrial).toBe(false);
    expect(result.allowed).toBe(true);
  });

  it('blocks once the grace window has passed without a conversion webhook', async () => {
    subRow = {
      status: 'trialing',
      trial_end: new Date(Date.now() - STRIPE_TRIAL_GRACE_MS - HOUR),
      stripe_subscription_id: 'sub_1',
    };

    const result = await checkTrialLimits(TENANT);

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/payment has not been confirmed/);
  });
});
