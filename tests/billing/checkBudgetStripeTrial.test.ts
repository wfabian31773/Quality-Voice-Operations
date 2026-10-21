/**
 * checkBudget: a tenant on a paid plan inside Stripe's 7-day trial
 * (`trialing` + `stripe_subscription_id`) gets its plan's limits, not the
 * free-trial TRIAL_LIMITS. The free trial (no Stripe subscription) keeps
 * TRIAL_LIMITS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '../../platform/core/types';

let subRow: Record<string, unknown> | undefined;
let usageRows: Array<{ metric_type: string; total: string }>;

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
        if (/FROM tenants/.test(sql)) return { rows: [{ trial_expires_at: null }] };
        if (/FROM usage_metrics/.test(sql)) return { rows: usageRows };
        if (/FROM agents/.test(sql)) return { rows: [{ count: '0' }] };
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

import { checkBudget } from '../../platform/billing/budget/checkBudget';
import { PLAN_LIMITS, TRIAL_LIMITS } from '../../platform/billing/stripe/plans';
import { STRIPE_TRIAL_GRACE_MS } from '../../platform/billing/guardrails/TrialGuard';

const TENANT = 'tenant-budget-stripe-trial' as TenantId;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const proRow = (overrides: Record<string, unknown> = {}) => ({
  plan: 'pro',
  status: 'trialing',
  stripe_subscription_id: 'sub_pro',
  trial_end: new Date(Date.now() + 5 * DAY),
  monthly_call_limit: PLAN_LIMITS.pro.monthlyCallLimit,
  monthly_ai_minute_limit: PLAN_LIMITS.pro.monthlyAiMinuteLimit,
  overage_enabled: false,
  ...overrides,
});

beforeEach(() => {
  subRow = undefined;
  usageRows = [];
});

describe('checkBudget — Stripe-trialing paid tenant', () => {
  it('passes with Pro limits past the free-trial caps', async () => {
    subRow = proRow();
    usageRows = [
      { metric_type: 'calls_inbound', total: String(TRIAL_LIMITS.maxTotalCalls + 5) },
      { metric_type: 'tool_executions', total: String(TRIAL_LIMITS.maxToolExecutions + 5) },
    ];

    const result = await checkBudget(TENANT);

    expect(result.allowed).toBe(true);
    expect(result.isTrial).toBe(false);
    expect(result.plan).toBe('pro');
    expect(result.status).toBe('trialing');
    expect(result.usage.callLimit).toBe(PLAN_LIMITS.pro.monthlyCallLimit);
    expect(result.usage.aiMinuteLimit).toBe(PLAN_LIMITS.pro.monthlyAiMinuteLimit);
  });

  it('still enforces the Pro monthly call limit', async () => {
    subRow = proRow();
    usageRows = [{ metric_type: 'calls_inbound', total: String(PLAN_LIMITS.pro.monthlyCallLimit) }];

    const result = await checkBudget(TENANT);

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Monthly call limit/);
  });

  it('allows calls inside the grace window after trial_end', async () => {
    subRow = proRow({ trial_end: new Date(Date.now() - 2 * HOUR) });

    expect((await checkBudget(TENANT)).allowed).toBe(true);
  });

  it('blocks once trial_end plus the grace window has passed', async () => {
    subRow = proRow({ trial_end: new Date(Date.now() - STRIPE_TRIAL_GRACE_MS - HOUR) });

    const result = await checkBudget(TENANT);

    expect(result.allowed).toBe(false);
    expect(result.plan).toBe('pro');
    expect(result.isTrial).toBe(false);
  });
});

describe('checkBudget — unpaid statuses', () => {
  it.each(['paused', 'past_due', 'cancelled'])('blocks a %s subscription', async (status) => {
    subRow = proRow({ status, trial_end: null });

    const result = await checkBudget(TENANT);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe(status);
    expect(result.reason).toMatch(new RegExp(`Subscription is ${status}`));
  });
});

describe('checkBudget — free trial', () => {
  it('a trialing row without a Stripe subscription keeps TRIAL_LIMITS', async () => {
    subRow = proRow({ stripe_subscription_id: null, plan: 'starter' });

    const result = await checkBudget(TENANT);

    expect(result.isTrial).toBe(true);
    expect(result.plan).toBe('trial');
    expect(result.usage.callLimit).toBe(TRIAL_LIMITS.maxTotalCalls);
    expect(result.usage.toolExecutionLimit).toBe(TRIAL_LIMITS.maxToolExecutions);
  });

  it('no subscription row is the free trial', async () => {
    const result = await checkBudget(TENANT);

    expect(result.isTrial).toBe(true);
    expect(result.plan).toBe('trial');
  });

  it('blocks a free trial at the TRIAL_LIMITS call cap', async () => {
    subRow = proRow({ stripe_subscription_id: null });
    usageRows = [{ metric_type: 'calls_inbound', total: String(TRIAL_LIMITS.maxTotalCalls) }];

    expect((await checkBudget(TENANT)).allowed).toBe(false);
  });
});
