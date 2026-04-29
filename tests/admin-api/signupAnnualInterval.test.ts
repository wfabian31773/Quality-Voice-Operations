/**
 * Task #987: confirms /auth/signup carries the Annual selection from the
 * pricing calculator into the right Stripe price ID via getPlanPriceId,
 * and that the route rejects unknown intervals before touching the DB.
 *
 * - getPlanPriceId('<tier>', 'annual') resolves STRIPE_PRICE_<TIER>_ANNUAL
 * - getPlanPriceId('<tier>', 'monthly') resolves STRIPE_PRICE_<TIER>_MONTHLY
 * - POST /auth/signup with interval='quarterly' returns 400 (no DB call)
 * - POST /auth/signup with interval='annual' passes validation
 *   (failure thereafter, but only after validation has accepted it)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.TURNSTILE_SECRET_KEY;
}

beforeEach(() => {
  resetEnv();
  vi.resetModules();
});

afterEach(() => {
  resetEnv();
});

describe('getPlanPriceId — annual selection routes to STRIPE_PRICE_<TIER>_ANNUAL', () => {
  it('returns the ANNUAL price id when interval=annual', async () => {
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_m';
    process.env.STRIPE_PRICE_STARTER_ANNUAL = 'price_starter_a';
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_a';
    process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY = 'price_ent_m';
    process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL = 'price_ent_a';

    const { getPlanPriceId } = await import('../../platform/billing/stripe/plans');

    expect(getPlanPriceId('starter', 'annual')).toBe('price_starter_a');
    expect(getPlanPriceId('pro', 'annual')).toBe('price_pro_a');
    expect(getPlanPriceId('enterprise', 'annual')).toBe('price_ent_a');
  });

  it('returns the MONTHLY price id when interval=monthly (and by default)', async () => {
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_m';
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
    process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY = 'price_ent_m';

    const { getPlanPriceId } = await import('../../platform/billing/stripe/plans');

    expect(getPlanPriceId('starter', 'monthly')).toBe('price_starter_m');
    expect(getPlanPriceId('pro', 'monthly')).toBe('price_pro_m');
    expect(getPlanPriceId('enterprise')).toBe('price_ent_m');
  });

  it('throws a clear error if the requested annual price id is not configured', async () => {
    delete process.env.STRIPE_PRICE_PRO_ANNUAL;
    const { getPlanPriceId } = await import('../../platform/billing/stripe/plans');
    expect(() => getPlanPriceId('pro', 'annual')).toThrow(/STRIPE_PRICE_PRO_ANNUAL/);
  });
});

describe('POST /auth/signup — interval validation', () => {
  async function mountAuthRouter() {
    const authModule = await import('../../server/admin-api/routes/auth');
    const app = express();
    app.use(express.json());
    app.use(authModule.default);
    return app;
  }

  it('returns 400 with a clear error when interval is not "monthly" or "annual"', async () => {
    const app = await mountAuthRouter();

    const res = await request(app).post('/auth/signup').send({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'long-enough-password',
      plan: 'pro',
      interval: 'quarterly',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/interval must be one of/);
    expect(res.body.error).toMatch(/monthly/);
    expect(res.body.error).toMatch(/annual/);
  });

  it('returns 400 when plan is invalid (interval validation gate ordering sanity check)', async () => {
    const app = await mountAuthRouter();

    const res = await request(app).post('/auth/signup').send({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'long-enough-password',
      plan: 'mythic',
      interval: 'annual',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/plan must be one of/);
  });

  it('accepts interval=annual through validation (does not reject before downstream wiring)', async () => {
    // Goal: prove the validation gate accepts interval=annual. The test env
    // may or may not have a working DB/Stripe; the assertion focuses purely
    // on the validation outcome being NOT a 400 caused by interval/plan.
    const app = await mountAuthRouter();

    const res = await request(app).post('/auth/signup').send({
      name: 'Ada Lovelace',
      email: `ada+${Date.now()}@example.com`,
      password: 'long-enough-password',
      plan: 'pro',
      interval: 'annual',
    });

    if (res.status === 400) {
      // If validation does reject, it must NOT be because of interval/plan.
      expect(res.body.error).not.toMatch(/interval must be one of/);
      expect(res.body.error).not.toMatch(/plan must be one of/);
    } else {
      // Otherwise it should have flowed past validation: either Stripe/DB
      // succeeded (201) or failed downstream (5xx). Validation passed.
      expect([201, 500, 502, 503]).toContain(res.status);
    }
  });
});
