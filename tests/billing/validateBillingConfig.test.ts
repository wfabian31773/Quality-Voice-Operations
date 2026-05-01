import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { validateBillingConfig } from '../../platform/billing/stripe/plans';

const ORIGINAL_ENV = { ...process.env };

const ALL_BILLING_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_STARTER_MONTHLY',
  'STRIPE_PRICE_STARTER_ANNUAL',
  'STRIPE_PRICE_PRO_MONTHLY',
  'STRIPE_PRICE_PRO_ANNUAL',
  'STRIPE_PRICE_ENTERPRISE_MONTHLY',
  'STRIPE_PRICE_ENTERPRISE_ANNUAL',
  'STRIPE_METER_EVENT_AI_MINUTES',
  'STRIPE_PRICE_STARTER_AI_MINUTES',
  'STRIPE_PRICE_PRO_AI_MINUTES',
  'STRIPE_PRICE_ENTERPRISE_AI_MINUTES',
] as const;

function resetBillingEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  for (const name of ALL_BILLING_VARS) {
    delete process.env[name];
  }
}

function applyBaseBillingEnv(): void {
  process.env.STRIPE_SECRET_KEY = 'sk_live_xxx';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_xxx';
  process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_m';
  process.env.STRIPE_PRICE_STARTER_ANNUAL = 'price_starter_a';
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
  process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_a';
  process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY = 'price_ent_m';
  process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL = 'price_ent_a';
}

beforeEach(() => {
  resetBillingEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('validateBillingConfig() — per-tier metered AI-minutes hard error (Task #1321)', () => {
  it('does not error about STRIPE_PRICE_<TIER>_AI_MINUTES when STRIPE_METER_EVENT_AI_MINUTES is unset', () => {
    applyBaseBillingEnv();
    // STRIPE_METER_EVENT_AI_MINUTES intentionally unset — deployments that
    // have not opted into per-tier metered pricing should not see errors
    // for the metered AI-minutes price ids.

    const result = validateBillingConfig();

    expect(result.errors.some(e => e.includes('_AI_MINUTES'))).toBe(false);
    expect(result.warnings.some(w => w.includes('_AI_MINUTES'))).toBe(false);
    expect(result.valid).toBe(true);
  });

  it('emits one error per tier when STRIPE_METER_EVENT_AI_MINUTES is set but no tier price is configured', () => {
    applyBaseBillingEnv();
    process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';

    const result = validateBillingConfig();

    const aiMinutesErrors = result.errors.filter(e => e.includes('_AI_MINUTES'));
    expect(aiMinutesErrors).toHaveLength(3);
    expect(aiMinutesErrors.some(e => e.includes('STRIPE_PRICE_STARTER_AI_MINUTES'))).toBe(true);
    expect(aiMinutesErrors.some(e => e.includes('STRIPE_PRICE_PRO_AI_MINUTES'))).toBe(true);
    expect(aiMinutesErrors.some(e => e.includes('STRIPE_PRICE_ENTERPRISE_AI_MINUTES'))).toBe(true);
    // Per Task #1321 these are hard validation failures (no longer warnings)
    // — `valid` is false and admin-api/start.ts will exit in production.
    expect(result.valid).toBe(false);
    // And nothing about AI-minutes should appear in `warnings` anymore — the
    // entire concern moved to `errors`.
    expect(result.warnings.some(w => w.includes('_AI_MINUTES'))).toBe(false);
  });

  it('only errors about tiers whose STRIPE_PRICE_<TIER>_AI_MINUTES is missing', () => {
    applyBaseBillingEnv();
    process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai_metered';

    const result = validateBillingConfig();

    const aiMinutesErrors = result.errors.filter(e => e.includes('_AI_MINUTES'));
    expect(aiMinutesErrors).toHaveLength(2);
    expect(aiMinutesErrors.some(e => e.includes('STRIPE_PRICE_STARTER_AI_MINUTES'))).toBe(true);
    expect(aiMinutesErrors.some(e => e.includes('STRIPE_PRICE_ENTERPRISE_AI_MINUTES'))).toBe(true);
    expect(aiMinutesErrors.some(e => e.includes('STRIPE_PRICE_PRO_AI_MINUTES'))).toBe(false);
  });

  it('emits no AI-minutes errors when every per-tier metered price id is configured', () => {
    applyBaseBillingEnv();
    process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
    process.env.STRIPE_PRICE_STARTER_AI_MINUTES = 'price_starter_ai_metered';
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai_metered';
    process.env.STRIPE_PRICE_ENTERPRISE_AI_MINUTES = 'price_ent_ai_metered';

    const result = validateBillingConfig();

    expect(result.errors.some(e => e.includes('_AI_MINUTES'))).toBe(false);
    expect(result.warnings.some(w => w.includes('_AI_MINUTES'))).toBe(false);
    expect(result.valid).toBe(true);
  });

  it('always returns an `errors` array (even when empty) so callers can iterate without a null guard', () => {
    applyBaseBillingEnv();

    const result = validateBillingConfig();

    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
