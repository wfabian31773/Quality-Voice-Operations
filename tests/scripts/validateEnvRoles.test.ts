// PR-00 (Render): role-based env validation in scripts/validate-env.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const SECRET = 'SENTINEL-SECRET-VALUE-0123456789abcdef';

// Minimal production env per role (values are sentinels, never printed).
const COMMON = {
  APP_ENV: 'production',
  PLATFORM_DB_POOL_URL: `postgresql://u:${SECRET}@pooler.example.com:6543/postgres`,
  CONNECTOR_ENCRYPTION_KEY: 'a'.repeat(64),
  QVO_PII_LOOKUP_HMAC_KEY: `${SECRET}-hmac`,
  QVO_PII_LOOKUP_HMAC_KEY_VERSION: '2026-10-render',
};
const VOICE = {
  ...COMMON,
  XAI_API_KEY: SECRET,
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: SECRET,
  TWILIO_OUTBOUND_NUMBER: '+15550000000',
  VOICE_GATEWAY_STREAM_TOKEN: `${SECRET}-stream-token`,
  VOICE_PUBLIC_BASE_URL: 'https://voice.example.com',
  ADMIN_INTERNAL_TOKEN: SECRET,
  ALLOWED_ORIGINS: 'https://api.example.com',
};
const STRIPE = {
  STRIPE_SECRET_KEY: `sk_live_${SECRET}`,
  STRIPE_PRICE_STARTER_MONTHLY: 'price_1', STRIPE_PRICE_STARTER_ANNUAL: 'price_2',
  STRIPE_PRICE_PRO_MONTHLY: 'price_3', STRIPE_PRICE_PRO_ANNUAL: 'price_4',
  STRIPE_PRICE_ENTERPRISE_MONTHLY: 'price_5', STRIPE_PRICE_ENTERPRISE_ANNUAL: 'price_6',
  STRIPE_METER_EVENT_CALLS: 'calls', STRIPE_METER_EVENT_AI_MINUTES: 'ai_minutes',
  STRIPE_PRICE_STARTER_AI_MINUTES: 'price_7', STRIPE_PRICE_PRO_AI_MINUTES: 'price_8', STRIPE_PRICE_ENTERPRISE_AI_MINUTES: 'price_9',
};
const EMAIL = { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: SECRET, EMAIL_FROM: 'ops@example.com', APP_URL: 'https://api.example.com' };
const CRON = { ...COMMON, ...STRIPE, ...EMAIL };
const WORKER = {
  ...CRON,
  TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: SECRET, TWILIO_OUTBOUND_NUMBER: '+15550000000',
  ADMIN_JWT_SECRET: SECRET, VOICE_GATEWAY_BASE_URL: 'https://voice.example.com', ADMIN_API_BASE_URL: 'https://api.example.com',
  WORKER_LEADER_DB_URL: `postgresql://u:${SECRET}@pooler.example.com:5432/postgres`,
};
const API = {
  ...CRON,
  XAI_API_KEY: SECRET, TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: SECRET, TWILIO_OUTBOUND_NUMBER: '+15550000000',
  ADMIN_JWT_SECRET: SECRET, STRIPE_WEBHOOK_SECRET: `whsec_${SECRET}`,
  VOICE_GATEWAY_BASE_URL: 'https://voice.example.com', VOICE_GATEWAY_STREAM_TOKEN: `${SECRET}-stream-token`,
  ADMIN_API_BASE_URL: 'https://api.example.com', CALCOM_WEBHOOK_SECRET: SECRET, SALES_NOTIFICATION_EMAIL: 's@example.com',
  VITE_BOOK_DEMO_SCHEDULER_URL: 'https://cal.com/x', TURNSTILE_SECRET_KEY: SECRET, ALLOWED_ORIGINS: 'https://api.example.com',
};

let logSpy: ReturnType<typeof vi.spyOn>;

function setEnv(vars: Record<string, string>): void {
  process.env = { PATH: ORIGINAL_ENV.PATH, ...vars };
}

async function load() {
  return import('../../scripts/validate-env');
}

function output(): string {
  return logSpy.mock.calls.map((a) => a.join(' ')).join('\n');
}

beforeEach(() => {
  vi.resetModules();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  process.env = { ...ORIGINAL_ENV };
});

describe('validateEnvironment — per role (production)', () => {
  it.each([
    ['voice', VOICE],
    ['api', API],
    ['worker', WORKER],
    ['cron', CRON],
  ] as const)('role %s passes with only its own required set', async (role, vars) => {
    setEnv(vars);
    const { validateEnvironment } = await load();
    const r = validateEnvironment({ role });
    expect(r.missing).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('voice requires its own names and nothing api-only', async () => {
    setEnv({ ...COMMON });
    const { validateEnvironment } = await load();
    const r = validateEnvironment({ role: 'voice' });
    expect(r.missing.sort()).toEqual(
      ['ADMIN_INTERNAL_TOKEN', 'ALLOWED_ORIGINS', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_OUTBOUND_NUMBER',
        'VOICE_GATEWAY_STREAM_TOKEN', 'VOICE_PUBLIC_BASE_URL', 'XAI_API_KEY'].sort(),
    );
    expect(r.missing).not.toContain('STRIPE_SECRET_KEY');
    expect(r.missing).not.toContain('APP_URL');
  });

  it('api requires APP_URL, VOICE_GATEWAY_BASE_URL, ADMIN_JWT_SECRET and Stripe', async () => {
    const { APP_URL: _a, VOICE_GATEWAY_BASE_URL: _v, ADMIN_JWT_SECRET: _j, STRIPE_SECRET_KEY: _s, ...rest } = API;
    setEnv(rest);
    const { validateEnvironment } = await load();
    const r = validateEnvironment({ role: 'api' });
    expect(r.missing.sort()).toEqual(['ADMIN_JWT_SECRET', 'APP_URL', 'STRIPE_SECRET_KEY', 'VOICE_GATEWAY_BASE_URL']);
  });

  it('worker requires the session-mode leader lock URL', async () => {
    const { WORKER_LEADER_DB_URL: _w, ...rest } = WORKER;
    setEnv(rest);
    const { validateEnvironment } = await load();
    expect(validateEnvironment({ role: 'worker' }).missing).toEqual(['WORKER_LEADER_DB_URL']);
  });

  it('role all (Replit default) keeps the pre-PR-00 requirements and ignores the new split-only names', async () => {
    setEnv({ ...API });
    const { validateEnvironment } = await load();
    const r = validateEnvironment();
    expect(r.passed).toBe(true);
    expect(r.missing).not.toContain('VOICE_PUBLIC_BASE_URL');
    expect(r.missing).not.toContain('WORKER_LEADER_DB_URL');
    setEnv({ ...VOICE });
    const r2 = validateEnvironment();
    expect(r2.missing).toContain('STRIPE_SECRET_KEY'); // unchanged: all roles need everything
  });

  it('reads the role from QVO_PROCESS_ROLE', async () => {
    setEnv({ ...VOICE, QVO_PROCESS_ROLE: 'voice' });
    const { validateEnvironment } = await load();
    expect(validateEnvironment().passed).toBe(true);
    expect(output()).toContain('role: voice');
  });
});

describe('Render guards', () => {
  it('RENDER=true without APP_URL fails with a clear message, whatever the role', async () => {
    setEnv({ ...VOICE, RENDER: 'true', VOICE_GATEWAY_BASE_URL: 'https://voice.example.com' });
    const { validateEnvironment } = await load();
    const r = validateEnvironment({ role: 'voice' });
    expect(r.passed).toBe(false);
    expect(r.missing).toEqual(['APP_URL']);
    expect(output()).toContain('FAIL  APP_URL — required on Render (no REPLIT_DEV_DOMAIN fallback)');
  });

  it('RENDER=true requires VOICE_GATEWAY_BASE_URL even in development', async () => {
    setEnv({ RENDER: 'true', APP_ENV: 'development', APP_URL: 'https://api.example.com', DATABASE_URL: 'postgres://x' });
    const { validateEnvironment } = await load();
    const r = validateEnvironment({ role: 'cron' });
    expect(r.missing).toEqual(['VOICE_GATEWAY_BASE_URL']);
  });

  it('warns that Replit-only names are ignored on Render', async () => {
    setEnv({ ...VOICE, RENDER: 'true', APP_URL: 'https://a', VOICE_GATEWAY_BASE_URL: 'https://v', REPLIT_DEV_DOMAIN: 'x.replit.dev' });
    const { validateEnvironment } = await load();
    const r = validateEnvironment({ role: 'voice' });
    expect(r.passed).toBe(true);
    expect(r.warnings).toContain('REPLIT_DEV_DOMAIN is set but ignored on Render (Replit-only)');
  });

  it('warns (never fails) on Azul-only names', async () => {
    setEnv({
      ...VOICE,
      SUPABASE_DATABASE_URL: `postgres://azul:${SECRET}@x/y`,
      TICKETING_SYSTEM_URL: 'https://ticketing.example.com',
      TICKETING_API_KEY: SECRET,
      AZUL_VISION_ONCALL_NUMBER: '+15551234567',
    });
    const { validateEnvironment } = await load();
    const r = validateEnvironment({ role: 'voice' });
    expect(r.passed).toBe(true);
    for (const n of ['SUPABASE_DATABASE_URL', 'TICKETING_SYSTEM_URL', 'TICKETING_API_KEY', 'AZUL_VISION_ONCALL_NUMBER']) {
      expect(r.warnings.some((w) => w.startsWith(`${n} is set but is an Azul-owned name`))).toBe(true);
    }
  });

  it('never prints a secret value', async () => {
    setEnv({ ...API, RENDER: 'true', SUPABASE_DATABASE_URL: SECRET, REPLIT_DEV_DOMAIN: SECRET });
    const { validateEnvironment } = await load();
    const r = validateEnvironment({ role: 'api' });
    expect(output()).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
