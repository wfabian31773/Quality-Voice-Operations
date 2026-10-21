/**
 * TrialGuard treats a Stripe `trialing` subscription as a trial and uses
 * the subscription's own `trial_end` (written by the Stripe webhook) for
 * expiry, falling back to the signup-time `tenants.trial_expires_at`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '../../platform/core/types';

let subRow: Record<string, unknown> | undefined;
let tenantTrialExpiresAt: unknown;

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string) => {
        if (/FROM subscriptions/.test(sql)) return { rows: subRow ? [subRow] : [] };
        if (/FROM tenants/.test(sql)) return { rows: [{ trial_expires_at: tenantTrialExpiresAt }] };
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

import { checkTrialLimits, isTrialSubscription } from '../../platform/billing/guardrails/TrialGuard';

const TENANT = 'tenant-trial-guard' as TenantId;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  subRow = undefined;
  tenantTrialExpiresAt = null;
});

describe('TrialGuard with a Stripe trialing subscription', () => {
  it('counts trialing as a trial, active/past_due as not', () => {
    expect(isTrialSubscription({ status: 'trialing' })).toBe(true);
    expect(isTrialSubscription({ status: 'active' })).toBe(false);
    expect(isTrialSubscription({ status: 'past_due' })).toBe(false);
  });

  it('uses the subscription trial_end, not an earlier tenant trial_expires_at', async () => {
    const stripeTrialEnd = new Date(Date.now() + 5 * DAY);
    subRow = { status: 'trialing', trial_end: stripeTrialEnd };
    tenantTrialExpiresAt = new Date(Date.now() - DAY);

    const result = await checkTrialLimits(TENANT);

    expect(result.isTrial).toBe(true);
    expect(result.allowed).toBe(true);
    expect(result.trialExpiresAt).toBe(stripeTrialEnd.toISOString());
  });

  it('blocks once the subscription trial_end has passed', async () => {
    subRow = { status: 'trialing', trial_end: new Date(Date.now() - DAY) };
    tenantTrialExpiresAt = new Date(Date.now() + DAY);

    const result = await checkTrialLimits(TENANT);

    expect(result.isTrial).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it('falls back to tenant trial_expires_at when the subscription has no trial_end', async () => {
    const tenantEnd = new Date(Date.now() + 3 * DAY);
    subRow = { status: 'trialing', trial_end: null };
    tenantTrialExpiresAt = tenantEnd;

    const result = await checkTrialLimits(TENANT);

    expect(result.allowed).toBe(true);
    expect(result.trialExpiresAt).toBe(tenantEnd.toISOString());
  });
});
