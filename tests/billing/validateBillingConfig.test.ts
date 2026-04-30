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

describe('validateBillingConfig() — per-tier metered AI-minutes warning', () => {
  it('does not warn about STRIPE_PRICE_<TIER>_AI_MINUTES when STRIPE_METER_EVENT_AI_MINUTES is unset', () => {
    applyBaseBillingEnv();
    // STRIPE_METER_EVENT_AI_MINUTES intentionally unset — pre-migration
    // deployments should not see warnings for the metered AI-minutes price ids.

    const result = validateBillingConfig();

    expect(result.warnings.some(w => w.includes('_AI_MINUTES'))).toBe(false);
    expect(result.valid).toBe(true);
  });

  it('emits one warning per tier when STRIPE_METER_EVENT_AI_MINUTES is set but no tier price is configured', () => {
    applyBaseBillingEnv();
    process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';

    const result = validateBillingConfig();

    const aiMinutesWarnings = result.warnings.filter(w => w.includes('_AI_MINUTES'));
    expect(aiMinutesWarnings).toHaveLength(3);
    expect(aiMinutesWarnings.some(w => w.includes('STRIPE_PRICE_STARTER_AI_MINUTES'))).toBe(true);
    expect(aiMinutesWarnings.some(w => w.includes('STRIPE_PRICE_PRO_AI_MINUTES'))).toBe(true);
    expect(aiMinutesWarnings.some(w => w.includes('STRIPE_PRICE_ENTERPRISE_AI_MINUTES'))).toBe(true);
    // Warnings are non-fatal in the sense that they don't break boot, but
    // `valid` is the simple "no warnings at all" flag — admin-api/start.ts
    // logs every warning when valid is false, so the AI-minutes warning gets
    // surfaced through the existing logging path.
    expect(result.valid).toBe(false);
  });

  it('only warns about tiers whose STRIPE_PRICE_<TIER>_AI_MINUTES is missing', () => {
    applyBaseBillingEnv();
    process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai_metered';

    const result = validateBillingConfig();

    const aiMinutesWarnings = result.warnings.filter(w => w.includes('_AI_MINUTES'));
    expect(aiMinutesWarnings).toHaveLength(2);
    expect(aiMinutesWarnings.some(w => w.includes('STRIPE_PRICE_STARTER_AI_MINUTES'))).toBe(true);
    expect(aiMinutesWarnings.some(w => w.includes('STRIPE_PRICE_ENTERPRISE_AI_MINUTES'))).toBe(true);
    expect(aiMinutesWarnings.some(w => w.includes('STRIPE_PRICE_PRO_AI_MINUTES'))).toBe(false);
  });

  it('emits no AI-minutes warnings when every per-tier metered price id is configured', () => {
    applyBaseBillingEnv();
    process.env.STRIPE_METER_EVENT_AI_MINUTES = 'ai_minutes';
    process.env.STRIPE_PRICE_STARTER_AI_MINUTES = 'price_starter_ai_metered';
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai_metered';
    process.env.STRIPE_PRICE_ENTERPRISE_AI_MINUTES = 'price_ent_ai_metered';

    const result = validateBillingConfig();

    expect(result.warnings.some(w => w.includes('_AI_MINUTES'))).toBe(false);
    expect(result.valid).toBe(true);
  });
});
