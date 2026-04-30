import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const ALL_PROD_REQUIRED = [
  'PLATFORM_DB_POOL_URL',
  'OPENAI_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_OUTBOUND_NUMBER',
  'ADMIN_JWT_SECRET',
  'CONNECTOR_ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_STARTER_MONTHLY',
  'STRIPE_PRICE_STARTER_ANNUAL',
  'STRIPE_PRICE_PRO_MONTHLY',
  'STRIPE_PRICE_PRO_ANNUAL',
  'STRIPE_PRICE_ENTERPRISE_MONTHLY',
  'STRIPE_PRICE_ENTERPRISE_ANNUAL',
  'STRIPE_METER_EVENT_CALLS',
  'STRIPE_METER_EVENT_AI_MINUTES',
  'VOICE_GATEWAY_BASE_URL',
  'ADMIN_API_BASE_URL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'EMAIL_FROM',
  'APP_URL',
  'CALCOM_WEBHOOK_SECRET',
  'SALES_NOTIFICATION_EMAIL',
  'VITE_BOOK_DEMO_SCHEDULER_URL',
  'TURNSTILE_SECRET_KEY',
  'ALLOWED_ORIGINS',
] as const;

const ALWAYS_REQUIRED = [
  'OPENAI_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_OUTBOUND_NUMBER',
] as const;

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.APP_ENV;
  delete process.env.NODE_ENV;
  delete process.env.BOOK_DEMO_SCHEDULER_PROVIDER;
  delete process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER;
  for (const v of ALL_PROD_REQUIRED) {
    delete process.env[v];
  }
  for (const v of ALWAYS_REQUIRED) {
    delete process.env[v];
  }
  delete process.env.DATABASE_URL;
  delete process.env.CALENDLY_WEBHOOK_SECRET;
}

function applyAllProductionVars(): void {
  process.env.APP_ENV = 'production';
  for (const v of ALL_PROD_REQUIRED) {
    process.env[v] = `value-for-${v}`;
  }
  for (const v of ALWAYS_REQUIRED) {
    process.env[v] = `value-for-${v}`;
  }
  process.env.CONNECTOR_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.PLATFORM_DB_POOL_URL = 'postgresql://user:pw@db.example.com:6543/postgres';
  process.env.ADMIN_JWT_SECRET = 'rotated-prod-secret';
  process.env.STRIPE_SECRET_KEY = 'sk_live_xxx';
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetEnv();
  vi.resetModules();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  process.env = { ...ORIGINAL_ENV };
});

async function loadValidator(): Promise<typeof import('../../scripts/validate-env')> {
  return import('../../scripts/validate-env');
}

function loggedLines(): string {
  return logSpy.mock.calls.map(args => args.join(' ')).join('\n');
}

describe('validateEnvironment() — production branch', () => {
  it('fails when every production-required var is missing', async () => {
    process.env.APP_ENV = 'production';
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.passed).toBe(false);
    for (const v of ALL_PROD_REQUIRED) {
      expect(result.missing).toContain(v);
    }
    for (const v of ALWAYS_REQUIRED) {
      expect(result.missing).toContain(v);
    }
  });

  it('passes when every production-required var is set', async () => {
    applyAllProductionVars();
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.missing).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails for a single missing required var', async () => {
    applyAllProductionVars();
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.passed).toBe(false);
    expect(result.missing).toEqual(['STRIPE_WEBHOOK_SECRET']);
  });

  it('treats APP_ENV=staging as production-like', async () => {
    process.env.APP_ENV = 'staging';
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.missing).toContain('STRIPE_WEBHOOK_SECRET');
    expect(result.missing).toContain('PLATFORM_DB_POOL_URL');
    expect(result.passed).toBe(false);
  });

  it('does not require DATABASE_URL in production', async () => {
    applyAllProductionVars();
    delete process.env.DATABASE_URL;
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.missing).not.toContain('DATABASE_URL');
    expect(result.passed).toBe(true);
  });
});

describe('validateEnvironment() — development branch', () => {
  it('passes when only the always-required + DATABASE_URL vars are set', async () => {
    process.env.APP_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/dev';
    for (const v of ALWAYS_REQUIRED) {
      process.env[v] = `dev-${v}`;
    }
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('does not require any production-only var in development', async () => {
    process.env.APP_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/dev';
    for (const v of ALWAYS_REQUIRED) {
      process.env[v] = `dev-${v}`;
    }
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    for (const v of ALL_PROD_REQUIRED) {
      if ((ALWAYS_REQUIRED as readonly string[]).includes(v)) continue;
      expect(result.missing).not.toContain(v);
    }
    expect(result.passed).toBe(true);
  });

  it('fails in development when an always-required var is missing', async () => {
    process.env.APP_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/dev';
    for (const v of ALWAYS_REQUIRED) {
      process.env[v] = `dev-${v}`;
    }
    delete process.env.OPENAI_API_KEY;
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.passed).toBe(false);
    expect(result.missing).toEqual(['OPENAI_API_KEY']);
  });

  it('defaults the prod/dev branch to development when APP_ENV is unset', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/dev';
    for (const v of ALWAYS_REQUIRED) {
      process.env[v] = `dev-${v}`;
    }
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.missing).toEqual(['APP_ENV']);
    for (const v of ALL_PROD_REQUIRED) {
      if ((ALWAYS_REQUIRED as readonly string[]).includes(v)) continue;
      expect(result.missing).not.toContain(v);
    }
  });
});

describe('validateEnvironment() — optional vars', () => {
  it('does not push optional vars into missing when none of them are set', async () => {
    applyAllProductionVars();
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    const optionalNames = [
      'ADMIN_API_PORT',
      'VOICE_GATEWAY_PORT',
      'PORT',
      'LOG_LEVEL',
      'BUILD_VERSION',
      'TWILIO_COST_PER_MINUTE_CENTS',
      'AI_COST_PER_MINUTE_CENTS',
      'SMS_COST_PER_MESSAGE_CENTS',
      'VOICE_GATEWAY_STREAM_TOKEN',
      'CAMPAIGN_TENANT_MAX_CONCURRENT',
      'DISABLE_PHI_LOGGING',
      'ADMIN_EMAIL',
      'ADMIN_PASSWORD',
      'ADMIN_INTERNAL_TOKEN',
      'OPS_SLACK_WEBHOOK_URL',
      'CALENDLY_WEBHOOK_TOLERANCE_SECONDS',
      'CALENDLY_WEBHOOK_ALLOW_UNSIGNED',
    ];
    for (const v of optionalNames) {
      expect(result.missing).not.toContain(v);
    }
    expect(result.passed).toBe(true);
  });
});

describe('validateEnvironment() — Calendly webhook conditional branch', () => {
  it('does not require CALENDLY_WEBHOOK_SECRET when provider defaults to cal.com', async () => {
    applyAllProductionVars();
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.missing).not.toContain('CALENDLY_WEBHOOK_SECRET');
    expect(result.passed).toBe(true);
  });

  it('requires CALENDLY_WEBHOOK_SECRET in production when BOOK_DEMO_SCHEDULER_PROVIDER=calendly', async () => {
    applyAllProductionVars();
    process.env.BOOK_DEMO_SCHEDULER_PROVIDER = 'calendly';
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.missing).toContain('CALENDLY_WEBHOOK_SECRET');
    expect(result.passed).toBe(false);
  });

  it('also honours the VITE_-prefixed build-time variant', async () => {
    applyAllProductionVars();
    process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER = 'calendly';
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.missing).toContain('CALENDLY_WEBHOOK_SECRET');
    expect(result.passed).toBe(false);
  });

  it('matches the provider value case-insensitively', async () => {
    applyAllProductionVars();
    process.env.BOOK_DEMO_SCHEDULER_PROVIDER = 'Calendly';
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.missing).toContain('CALENDLY_WEBHOOK_SECRET');
  });

  it('passes when provider=calendly and the secret is set', async () => {
    applyAllProductionVars();
    process.env.BOOK_DEMO_SCHEDULER_PROVIDER = 'calendly';
    process.env.CALENDLY_WEBHOOK_SECRET = 'cw-secret';
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.missing).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('does not enforce the Calendly secret in development even when provider=calendly', async () => {
    process.env.APP_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/dev';
    for (const v of ALWAYS_REQUIRED) {
      process.env[v] = `dev-${v}`;
    }
    process.env.BOOK_DEMO_SCHEDULER_PROVIDER = 'calendly';
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.missing).not.toContain('CALENDLY_WEBHOOK_SECRET');
    expect(result.passed).toBe(true);
  });
});

describe('validateEnvironment() — OAuth state-signing branch (Task #995)', () => {
  it('logs the OAuth FAIL line in production when both ADMIN_JWT_SECRET and CONNECTOR_ENCRYPTION_KEY are missing', async () => {
    applyAllProductionVars();
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
    const { validateEnvironment } = await loadValidator();
    validateEnvironment();

    const logs = loggedLines();
    expect(logs).toMatch(/Connector OAuth state signing/);
    expect(logs).toMatch(/ADMIN_JWT_SECRET or CONNECTOR_ENCRYPTION_KEY/);
    expect(logs).toMatch(/\/connectors\/oauth/);
  });

  it('does not push a synthetic name into missing for the OAuth branch', async () => {
    // Downstream consumers (log scrapers, runbook tooling) treat `missing`
    // as a list of literal env-var names, so the OAuth branch must rely on
    // ADMIN_JWT_SECRET being in `missing` already rather than inserting a
    // compound name.
    applyAllProductionVars();
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    for (const name of result.missing) {
      expect(name).not.toMatch(/\s/);
      expect(name).not.toMatch(/\bor\b/i);
    }
    expect(result.missing).toContain('ADMIN_JWT_SECRET');
    expect(result.missing).toContain('CONNECTOR_ENCRYPTION_KEY');
  });

  it('does not log the OAuth FAIL line when ADMIN_JWT_SECRET is set', async () => {
    applyAllProductionVars();
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
    const { validateEnvironment } = await loadValidator();
    validateEnvironment();

    expect(loggedLines()).not.toMatch(/Connector OAuth state signing/);
  });

  it('does not log the OAuth FAIL line when CONNECTOR_ENCRYPTION_KEY is set', async () => {
    applyAllProductionVars();
    delete process.env.ADMIN_JWT_SECRET;
    const { validateEnvironment } = await loadValidator();
    validateEnvironment();

    expect(loggedLines()).not.toMatch(/Connector OAuth state signing/);
  });

  it('does not log the OAuth FAIL line in development even when both secrets are missing', async () => {
    process.env.APP_ENV = 'development';
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/dev';
    for (const v of ALWAYS_REQUIRED) {
      process.env[v] = `dev-${v}`;
    }
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(loggedLines()).not.toMatch(/Connector OAuth state signing/);
    expect(result.passed).toBe(true);
  });
});

describe('validateEnvironment() — warnings', () => {
  it('warns when STRIPE_SECRET_KEY looks like a test key in production', async () => {
    applyAllProductionVars();
    process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.warnings.some(w => w.includes('STRIPE_SECRET_KEY'))).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('warns when ADMIN_JWT_SECRET still has the auto-generated dev prefix in production', async () => {
    applyAllProductionVars();
    process.env.ADMIN_JWT_SECRET = 'qvo-dev-abcdef';
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.warnings.some(w => w.includes('ADMIN_JWT_SECRET'))).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('warns when PLATFORM_DB_POOL_URL is not on port 6543', async () => {
    applyAllProductionVars();
    process.env.PLATFORM_DB_POOL_URL = 'postgresql://user:pw@db.example.com:5432/postgres';
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.warnings.some(w => w.includes('PLATFORM_DB_POOL_URL'))).toBe(true);
  });

  it('warns when CONNECTOR_ENCRYPTION_KEY is shorter than 64 hex chars', async () => {
    applyAllProductionVars();
    process.env.CONNECTOR_ENCRYPTION_KEY = 'tooshort';
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.warnings.some(w => w.includes('CONNECTOR_ENCRYPTION_KEY'))).toBe(true);
  });

  it('emits no warnings when all production vars are healthy', async () => {
    applyAllProductionVars();
    const { validateEnvironment } = await loadValidator();
    const result = validateEnvironment();

    expect(result.warnings).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('validateEnvironment() — exitOnFailure option', () => {
  it('does not call process.exit when validation passes', async () => {
    applyAllProductionVars();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const { validateEnvironment } = await loadValidator();
      const result = validateEnvironment({ exitOnFailure: true });
      expect(result.passed).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('calls process.exit(1) when validation fails and exitOnFailure=true', async () => {
    process.env.APP_ENV = 'production';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const { validateEnvironment } = await loadValidator();
      const result = validateEnvironment({ exitOnFailure: true });
      expect(result.passed).toBe(false);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('does not call process.exit on failure when exitOnFailure is omitted', async () => {
    process.env.APP_ENV = 'production';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const { validateEnvironment } = await loadValidator();
      const result = validateEnvironment();
      expect(result.passed).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
