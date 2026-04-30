import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

/**
 * Coverage for the demo-scheduler runtime-switching contract:
 *   - `setDemoSchedulerSettings` validation rules
 *   - `getActiveCalcomWebhookSecret` / `getActiveCalendlyWebhookSecret`
 *     env-first / DB-fallback ordering and decrypt round-trip
 *   - `GET /book-demo/config` cache headers + JSON shape
 *   - `GET /platform/demo-scheduler-settings` never leaks plaintext secrets
 *   - Cal.com / Calendly webhook routes accepting signatures verified against
 *     the DB-stored secret when no env var is present.
 *
 * Pattern adapted from `tests/marketing/calcomBookingWebhook.test.ts`.
 */

// ---------------------------------------------------------------------------
// In-memory pool stub modelling the subset of `platform_settings` queries
// the demo-scheduler service issues.
// ---------------------------------------------------------------------------

interface SettingsRow {
  key: string;
  value: unknown;
  updated_by: string | null;
}

function createMemoryPool() {
  const store = new Map<string, SettingsRow>();

  function query(sql: string, params: unknown[] = []): { rows: any[]; rowCount: number } {
    const text = sql.trim();
    if (/^SELECT\s+value\s+FROM\s+platform_settings\s+WHERE\s+key\s*=\s*\$1/i.test(text)) {
      const key = String(params[0]);
      const row = store.get(key);
      return row ? { rows: [{ value: row.value }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/^INSERT\s+INTO\s+platform_settings/i.test(text)) {
      const key = String(params[0]);
      const rawValue = params[1];
      const updatedBy = params[2] == null ? null : String(params[2]);
      const value = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
      store.set(key, { key, value, updated_by: updatedBy });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unsupported SQL in test pool: ${text}`);
  }

  return {
    pool: { query: async (sql: string, params?: unknown[]) => query(sql, params ?? []) },
    store,
  };
}

// ---------------------------------------------------------------------------
// Service-level tests
// ---------------------------------------------------------------------------

describe('demo-scheduler-settings service — setDemoSchedulerSettings validation', () => {
  const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY,
    BOOK_DEMO_SCHEDULER_PROVIDER: process.env.BOOK_DEMO_SCHEDULER_PROVIDER,
    VITE_BOOK_DEMO_SCHEDULER_PROVIDER: process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER,
    VITE_BOOK_DEMO_SCHEDULER_URL: process.env.VITE_BOOK_DEMO_SCHEDULER_URL,
  };

  let pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> };
  let store: Map<string, SettingsRow>;

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    process.env.ENCRYPTION_MASTER_KEY = 'unit-test-master-key-do-not-reuse';
    delete process.env.BOOK_DEMO_SCHEDULER_PROVIDER;
    delete process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER;
    delete process.env.VITE_BOOK_DEMO_SCHEDULER_URL;

    const made = createMemoryPool();
    pool = made.pool;
    store = made.store;

    vi.doMock('../../platform/db', () => ({ getPlatformPool: () => pool }));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../platform/db');
  });

  it('rejects an unknown provider value', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await expect(
      svc.setDemoSchedulerSettings({ provider: 'google-calendar' as never }, 'admin-1'),
    ).rejects.toBeInstanceOf(svc.DemoSchedulerSettingsValidationError);
    expect(store.size).toBe(0);
  });

  it('accepts both whitelisted providers (cal.com, calendly)', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    const calcom = await svc.setDemoSchedulerSettings({ provider: 'cal.com' }, 'admin-1');
    expect(calcom.provider).toBe('cal.com');
    const calendly = await svc.setDemoSchedulerSettings({ provider: 'calendly' }, 'admin-1');
    expect(calendly.provider).toBe('calendly');
  });

  it('rejects a non-https embed URL when running in production-like env', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
    vi.resetModules();
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await expect(
      svc.setDemoSchedulerSettings({ embedUrl: 'http://insecure.example.com/embed' }, 'admin-1'),
    ).rejects.toBeInstanceOf(svc.DemoSchedulerSettingsValidationError);
    await expect(
      svc.setDemoSchedulerSettings({ embedUrl: 'not a url at all' }, 'admin-1'),
    ).rejects.toBeInstanceOf(svc.DemoSchedulerSettingsValidationError);
    // https still passes in prod.
    const ok = await svc.setDemoSchedulerSettings(
      { embedUrl: 'https://cal.com/team/qvo/30min' },
      'admin-1',
    );
    expect(ok.embedUrl).toBe('https://cal.com/team/qvo/30min');
  });

  it('rejects an embed URL that fails to parse even in dev', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await expect(
      svc.setDemoSchedulerSettings({ embedUrl: '   ' }, 'admin-1'),
    ).rejects.toBeInstanceOf(svc.DemoSchedulerSettingsValidationError);
  });

  it('rejects a webhook secret shorter than 16 characters', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await expect(
      svc.setDemoSchedulerSettings({ calcomWebhookSecret: 'short-secret' }, 'admin-1'),
    ).rejects.toBeInstanceOf(svc.DemoSchedulerSettingsValidationError);
    await expect(
      svc.setDemoSchedulerSettings({ calendlyWebhookSecret: 'also-too-short' }, 'admin-1'),
    ).rejects.toBeInstanceOf(svc.DemoSchedulerSettingsValidationError);
  });

  it('encrypts and persists a new secret >= 16 characters and round-trips via decrypt', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    const plaintext = 'cal-com-secret-aaaaaaaaaa';
    const stored = await svc.setDemoSchedulerSettings(
      { calcomWebhookSecret: plaintext },
      'admin-1',
    );
    expect(stored.calcomWebhookSecretEncrypted).toBeTruthy();
    expect(stored.calcomWebhookSecretEncrypted).not.toContain(plaintext);
    expect(svc.decryptSchedulerSecret(stored.calcomWebhookSecretEncrypted!)).toBe(plaintext);
    expect((store.get('demo_scheduler')!.value as Record<string, unknown>).calcomWebhookSecretEncrypted)
      .toBe(stored.calcomWebhookSecretEncrypted);
  });

  it('at the service layer, an empty/whitespace-only secret string is treated as a validation error (too-short), NOT as "leave unchanged"', async () => {
    // The "empty=keep" contract called out in the task description lives in
    // the route layer (`PUT /platform/demo-scheduler-settings` skips the
    // patch field when the trimmed value is falsy — see the matching admin
    // route test below). At the service layer itself, any string the
    // caller passes is treated as a rotation attempt: empty/whitespace
    // strings fail the ≥16-char rule. This test pins that contract so a
    // future refactor that moves the empty-handling into the service layer
    // is forced to be a deliberate change rather than a silent shift.
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await expect(
      svc.setDemoSchedulerSettings({ calcomWebhookSecret: '' }, 'admin-1'),
    ).rejects.toBeInstanceOf(svc.DemoSchedulerSettingsValidationError);
    await expect(
      svc.setDemoSchedulerSettings({ calendlyWebhookSecret: '   ' }, 'admin-1'),
    ).rejects.toBeInstanceOf(svc.DemoSchedulerSettingsValidationError);
  });

  it('treats an omitted secret patch field as "leave unchanged" and explicit null as "clear"', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    const initial = await svc.setDemoSchedulerSettings(
      { calcomWebhookSecret: 'initial-secret-aaaaaaaaaa', calendlyWebhookSecret: 'initial-cal-aaaaaaaaaa' },
      'admin-1',
    );
    const initialCalcomCipher = initial.calcomWebhookSecretEncrypted!;
    const initialCalendlyCipher = initial.calendlyWebhookSecretEncrypted!;

    // Patch with neither secret field present — both ciphertexts must persist.
    const after = await svc.setDemoSchedulerSettings({ provider: 'calendly' }, 'admin-1');
    expect(after.calcomWebhookSecretEncrypted).toBe(initialCalcomCipher);
    expect(after.calendlyWebhookSecretEncrypted).toBe(initialCalendlyCipher);
    expect(after.provider).toBe('calendly');

    // Explicit null clears just the targeted secret.
    const cleared = await svc.setDemoSchedulerSettings(
      { calcomWebhookSecret: null },
      'admin-1',
    );
    expect(cleared.calcomWebhookSecretEncrypted).toBeNull();
    expect(cleared.calendlyWebhookSecretEncrypted).toBe(initialCalendlyCipher);
  });

  it('toAdminView never exposes the encrypted ciphertext or any plaintext-shaped field', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    const plaintext = 'super-secret-plaintext-1234567890';
    await svc.setDemoSchedulerSettings({ calcomWebhookSecret: plaintext }, 'admin-1');
    const settings = await svc.getDemoSchedulerSettings();
    const view = svc.toAdminView(settings);
    expect(view).toEqual({
      provider: settings.provider,
      embedUrl: settings.embedUrl,
      calcomWebhookSecretConfigured: true,
      calendlyWebhookSecretConfigured: false,
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain(settings.calcomWebhookSecretEncrypted!);
  });
});

describe('demo-scheduler-settings service — webhook secret resolver', () => {
  const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY,
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
    CALENDLY_WEBHOOK_SECRET: process.env.CALENDLY_WEBHOOK_SECRET,
  };

  let pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> };

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    process.env.ENCRYPTION_MASTER_KEY = 'unit-test-master-key-do-not-reuse';
    delete process.env.CALCOM_WEBHOOK_SECRET;
    delete process.env.CALENDLY_WEBHOOK_SECRET;

    const made = createMemoryPool();
    pool = made.pool;
    vi.doMock('../../platform/db', () => ({ getPlatformPool: () => pool }));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../platform/db');
  });

  it('getActiveCalcomWebhookSecret prefers the env var over the DB ciphertext', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await svc.setDemoSchedulerSettings(
      { calcomWebhookSecret: 'db-stored-cal-secret-aaaaaa' },
      'admin-1',
    );
    process.env.CALCOM_WEBHOOK_SECRET = 'env-wins-secret-aaaaaaaaaa';
    expect(await svc.getActiveCalcomWebhookSecret()).toBe('env-wins-secret-aaaaaaaaaa');
  });

  it('getActiveCalcomWebhookSecret falls back to the DB-stored ciphertext when no env var is set', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    const plaintext = 'db-only-cal-secret-aaaaaaaaaaaa';
    await svc.setDemoSchedulerSettings({ calcomWebhookSecret: plaintext }, 'admin-1');
    expect(await svc.getActiveCalcomWebhookSecret()).toBe(plaintext);
  });

  it('getActiveCalcomWebhookSecret returns null when neither env nor DB has a secret', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    expect(await svc.getActiveCalcomWebhookSecret()).toBeNull();
  });

  it('treats a whitespace-only env var as unset and falls through to the DB', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    const plaintext = 'db-only-cal-secret-bbbbbbbbbbbb';
    await svc.setDemoSchedulerSettings({ calcomWebhookSecret: plaintext }, 'admin-1');
    process.env.CALCOM_WEBHOOK_SECRET = '   ';
    expect(await svc.getActiveCalcomWebhookSecret()).toBe(plaintext);
  });

  it('getActiveCalendlyWebhookSecret prefers the env var over the DB ciphertext', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await svc.setDemoSchedulerSettings(
      { calendlyWebhookSecret: 'db-stored-cdly-secret-aaaaaa' },
      'admin-1',
    );
    process.env.CALENDLY_WEBHOOK_SECRET = 'env-wins-cdly-secret-aaaaaaaa';
    expect(await svc.getActiveCalendlyWebhookSecret()).toBe('env-wins-cdly-secret-aaaaaaaa');
  });

  it('getActiveCalendlyWebhookSecret falls back to DB-stored ciphertext when no env var', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    const plaintext = 'db-only-cdly-secret-aaaaaaaaaaaa';
    await svc.setDemoSchedulerSettings({ calendlyWebhookSecret: plaintext }, 'admin-1');
    expect(await svc.getActiveCalendlyWebhookSecret()).toBe(plaintext);
  });

  it('getActiveCalendlyWebhookSecret returns null when neither env nor DB has a secret', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    expect(await svc.getActiveCalendlyWebhookSecret()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Public config endpoint — cache headers + JSON shape
// ---------------------------------------------------------------------------

describe('GET /book-demo/config — public scheduler config endpoint', () => {
  const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY,
    BOOK_DEMO_SCHEDULER_PROVIDER: process.env.BOOK_DEMO_SCHEDULER_PROVIDER,
    VITE_BOOK_DEMO_SCHEDULER_PROVIDER: process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER,
    VITE_BOOK_DEMO_SCHEDULER_URL: process.env.VITE_BOOK_DEMO_SCHEDULER_URL,
  };

  let pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> };

  async function buildApp(): Promise<express.Express> {
    const router = (await import('../../server/admin-api/routes/contact')).default;
    const app = express();
    app.use(express.json());
    app.use('/', router);
    return app;
  }

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    process.env.ENCRYPTION_MASTER_KEY = 'unit-test-master-key-do-not-reuse';
    delete process.env.BOOK_DEMO_SCHEDULER_PROVIDER;
    delete process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER;
    delete process.env.VITE_BOOK_DEMO_SCHEDULER_URL;

    const made = createMemoryPool();
    pool = made.pool;
    vi.doMock('../../platform/db', () => ({ getPlatformPool: () => pool }));
    // Stub the marketing-leads service so loading the contact router doesn't
    // require the full DB-backed lead store.
    vi.doMock('../../server/admin-api/services/marketing-leads', () => ({
      findLeadById: vi.fn(async () => null),
      findLatestLeadByEmail: vi.fn(async () => null),
      attachBookingToLeadById: vi.fn(async () => ({ leadId: null, duplicate: false })),
      attachBookingToLead: vi.fn(async () => ({ leadId: null, duplicate: false })),
      notifyBookingConfirmed: vi.fn(async () => {}),
      recordLead: vi.fn(async () => ({ id: 1 })),
    }));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../platform/db');
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  it('returns only `provider` and `embedUrl` (no secret material) and sets a short cache TTL', async () => {
    const app = await buildApp();
    // Persist a customised config including a secret. The response must NOT
    // surface that secret in any form.
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await svc.setDemoSchedulerSettings(
      {
        provider: 'cal.com',
        embedUrl: 'https://cal.com/qvo/test',
        calcomWebhookSecret: 'public-config-must-hide-this-aaaa',
      },
      'admin-1',
    );

    const r = await request(app).get('/book-demo/config');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      provider: 'cal.com',
      embedUrl: 'https://cal.com/qvo/test',
    });
    expect(Object.keys(r.body).sort()).toEqual(['embedUrl', 'provider']);
    expect(r.headers['cache-control']).toMatch(/public.*max-age=30/);
    const serialized = JSON.stringify(r.body);
    expect(serialized).not.toContain('public-config-must-hide-this-aaaa');
    expect(serialized).not.toContain('Encrypted');
  });

  it('falls back to the env-resolved defaults when no DB row exists', async () => {
    process.env.BOOK_DEMO_SCHEDULER_PROVIDER = 'calendly';
    process.env.VITE_BOOK_DEMO_SCHEDULER_URL = 'https://calendly.com/qvo-team/30min';
    const app = await buildApp();
    const r = await request(app).get('/book-demo/config');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      provider: 'calendly',
      embedUrl: 'https://calendly.com/qvo-team/30min',
    });
  });
});

// ---------------------------------------------------------------------------
// Admin GET endpoint — never returns plaintext secret material
// ---------------------------------------------------------------------------

describe('Admin /platform/demo-scheduler-settings routes — real router contract', () => {
  const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY,
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
    CALENDLY_WEBHOOK_SECRET: process.env.CALENDLY_WEBHOOK_SECRET,
    BOOK_DEMO_SCHEDULER_PROVIDER: process.env.BOOK_DEMO_SCHEDULER_PROVIDER,
    VITE_BOOK_DEMO_SCHEDULER_PROVIDER: process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER,
    VITE_BOOK_DEMO_SCHEDULER_URL: process.env.VITE_BOOK_DEMO_SCHEDULER_URL,
  };

  let pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> };

  /**
   * Mount the real `platformAdmin` router with auth + rbac middleware
   * stubbed to no-ops (and an `req.user` shim so the PUT handler's
   * `req.user!.userId` access works). Mocking `platform/db` keeps the rest
   * of the router from touching a real Postgres while still exercising the
   * actual route handlers in `server/admin-api/routes/platformAdmin.ts`.
   */
  async function buildAdminApp(): Promise<express.Express> {
    const router = (await import('../../server/admin-api/routes/platformAdmin')).default;
    const app = express();
    app.use(express.json());
    app.use('/', router);
    return app;
  }

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    process.env.ENCRYPTION_MASTER_KEY = 'unit-test-master-key-do-not-reuse';
    delete process.env.CALCOM_WEBHOOK_SECRET;
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    delete process.env.BOOK_DEMO_SCHEDULER_PROVIDER;
    delete process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER;
    delete process.env.VITE_BOOK_DEMO_SCHEDULER_URL;

    const made = createMemoryPool();
    pool = made.pool;
    vi.doMock('../../platform/db', () => ({
      getPlatformPool: () => pool,
      // Other platformAdmin routes call withPrivilegedClient/withTenantContext;
      // we don't exercise those in this suite but provide stubs so the
      // module imports cleanly.
      withPrivilegedClient: async (fn: (c: unknown) => Promise<unknown>) =>
        fn({ query: pool.query }),
      withTenantContext: async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
        fn({ query: pool.query }),
    }));

    // No-op auth + rbac so the demo-scheduler routes are reachable. The PUT
    // handler reads `req.user!.userId`, so seed a fake admin identity.
    vi.doMock('../../server/admin-api/middleware/auth', () => ({
      requireAuth: (req: any, _res: any, next: any) => {
        req.user = { userId: 'admin-test-user', tenantId: 'platform', role: 'platform_admin' };
        next();
      },
    }));
    vi.doMock('../../server/admin-api/middleware/rbac', () => ({
      requirePlatformAdmin: (_req: any, _res: any, next: any) => next(),
    }));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../platform/db');
    vi.doUnmock('../../server/admin-api/middleware/auth');
    vi.doUnmock('../../server/admin-api/middleware/rbac');
  });

  it('GET returns only the configured booleans, never the ciphertext or plaintext', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    const calPlain = 'cal-plaintext-must-not-leak-aaaa';
    const cdlyPlain = 'cdly-plaintext-must-not-leak-aaaa';
    const stored = await svc.setDemoSchedulerSettings(
      {
        provider: 'cal.com',
        embedUrl: 'https://cal.com/qvo/admin-test',
        calcomWebhookSecret: calPlain,
        calendlyWebhookSecret: cdlyPlain,
      },
      'admin-1',
    );

    const app = await buildAdminApp();
    const r = await request(app).get('/platform/demo-scheduler-settings');
    expect(r.status).toBe(200);
    expect(r.body.settings).toEqual({
      provider: 'cal.com',
      embedUrl: 'https://cal.com/qvo/admin-test',
      calcomWebhookSecretConfigured: true,
      calendlyWebhookSecretConfigured: true,
    });
    // Defence in depth: scan the entire serialised response body for any
    // plaintext or ciphertext material that could have leaked through.
    const serialized = JSON.stringify(r.body);
    expect(serialized).not.toContain(calPlain);
    expect(serialized).not.toContain(cdlyPlain);
    expect(serialized).not.toContain(stored.calcomWebhookSecretEncrypted!);
    expect(serialized).not.toContain(stored.calendlyWebhookSecretEncrypted!);
    expect(serialized).not.toMatch(/Encrypted/);
  });

  it('GET reports both secret-configured booleans as false when nothing is stored', async () => {
    const app = await buildAdminApp();
    const r = await request(app).get('/platform/demo-scheduler-settings');
    expect(r.status).toBe(200);
    expect(r.body.settings.calcomWebhookSecretConfigured).toBe(false);
    expect(r.body.settings.calendlyWebhookSecretConfigured).toBe(false);
  });

  it('GET surfaces env-fallback hints without echoing the env secrets themselves', async () => {
    process.env.CALCOM_WEBHOOK_SECRET = 'env-side-cal-secret-aaaaaaaaaa';
    process.env.CALENDLY_WEBHOOK_SECRET = 'env-side-cdly-secret-aaaaaaaaa';
    const app = await buildAdminApp();
    const r = await request(app).get('/platform/demo-scheduler-settings');
    expect(r.status).toBe(200);
    expect(r.body.fallbacks.envCalcomSecretConfigured).toBe(true);
    expect(r.body.fallbacks.envCalendlySecretConfigured).toBe(true);
    const serialized = JSON.stringify(r.body);
    expect(serialized).not.toContain('env-side-cal-secret-aaaaaaaaaa');
    expect(serialized).not.toContain('env-side-cdly-secret-aaaaaaaaa');
  });

  it('PUT treats an empty-string secret as "leave existing ciphertext unchanged"', async () => {
    // Seed a real ciphertext so we can prove the empty-string PUT didn't
    // disturb it.
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    const original = await svc.setDemoSchedulerSettings(
      {
        calcomWebhookSecret: 'pre-existing-cal-secret-aaaaaaaa',
        calendlyWebhookSecret: 'pre-existing-cdly-secret-aaaaaaa',
      },
      'admin-seed',
    );
    expect(original.calcomWebhookSecretEncrypted).toBeTruthy();
    expect(original.calendlyWebhookSecretEncrypted).toBeTruthy();

    const app = await buildAdminApp();

    // Empty strings AND whitespace-only strings should both be treated as
    // "no change", matching the route's documented "empty=keep" contract
    // so admins re-saving the form without re-typing the secret can't wipe
    // it out by accident.
    const r = await request(app)
      .put('/platform/demo-scheduler-settings')
      .send({
        provider: 'calendly',
        calcomWebhookSecret: '',
        calendlyWebhookSecret: '   ',
      });
    expect(r.status).toBe(200);
    expect(r.body.settings).toEqual({
      provider: 'calendly',
      embedUrl: original.embedUrl,
      calcomWebhookSecretConfigured: true,
      calendlyWebhookSecretConfigured: true,
    });

    // Round-trip the stored ciphertext to confirm the *original* plaintext
    // is what's still on file, not anything derived from the empty PUT body.
    const after = await svc.getDemoSchedulerSettings();
    expect(after.calcomWebhookSecretEncrypted).toBe(original.calcomWebhookSecretEncrypted);
    expect(after.calendlyWebhookSecretEncrypted).toBe(original.calendlyWebhookSecretEncrypted);
    expect(svc.decryptSchedulerSecret(after.calcomWebhookSecretEncrypted!)).toBe(
      'pre-existing-cal-secret-aaaaaaaa',
    );
    expect(svc.decryptSchedulerSecret(after.calendlyWebhookSecretEncrypted!)).toBe(
      'pre-existing-cdly-secret-aaaaaaa',
    );
  });

  it('PUT clears a stored secret when the body sends explicit null', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await svc.setDemoSchedulerSettings(
      { calcomWebhookSecret: 'will-be-cleared-aaaaaaaaaaaa' },
      'admin-seed',
    );

    const app = await buildAdminApp();
    const r = await request(app)
      .put('/platform/demo-scheduler-settings')
      .send({ calcomWebhookSecret: null });
    expect(r.status).toBe(200);
    expect(r.body.settings.calcomWebhookSecretConfigured).toBe(false);

    const after = await svc.getDemoSchedulerSettings();
    expect(after.calcomWebhookSecretEncrypted).toBeNull();
  });

  it('PUT rotates a stored secret to a new plaintext (>=16 chars) and never echoes the new value back', async () => {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await svc.setDemoSchedulerSettings(
      { calcomWebhookSecret: 'old-rotating-secret-aaaaaaaaa' },
      'admin-seed',
    );

    const newPlain = 'rotated-secret-aaaaaaaaaaaaaa';
    const app = await buildAdminApp();
    const r = await request(app)
      .put('/platform/demo-scheduler-settings')
      .send({ calcomWebhookSecret: newPlain });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(newPlain);

    const after = await svc.getDemoSchedulerSettings();
    expect(svc.decryptSchedulerSecret(after.calcomWebhookSecretEncrypted!)).toBe(newPlain);
  });

  it('PUT rejects a non-string provider with 400 from the route layer', async () => {
    const app = await buildAdminApp();
    const r = await request(app)
      .put('/platform/demo-scheduler-settings')
      .send({ provider: 'google-calendar' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'provider must be "cal.com" or "calendly"' });
  });

  it('PUT rejects a non-string embedUrl with 400 from the route layer', async () => {
    const app = await buildAdminApp();
    const r = await request(app)
      .put('/platform/demo-scheduler-settings')
      .send({ embedUrl: 12345 });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'embedUrl must be a string' });
  });

  it('PUT rejects a non-string-non-null secret value with 400 from the route layer', async () => {
    const app = await buildAdminApp();
    const r1 = await request(app)
      .put('/platform/demo-scheduler-settings')
      .send({ calcomWebhookSecret: 12345 });
    expect(r1.status).toBe(400);
    expect(r1.body).toEqual({ error: 'calcomWebhookSecret must be a string or null' });

    const r2 = await request(app)
      .put('/platform/demo-scheduler-settings')
      .send({ calendlyWebhookSecret: { rotated: true } });
    expect(r2.status).toBe(400);
    expect(r2.body).toEqual({ error: 'calendlyWebhookSecret must be a string or null' });
  });

  it('PUT surfaces service-layer validation errors as 400 (e.g. too-short rotated secret)', async () => {
    const app = await buildAdminApp();
    const r = await request(app)
      .put('/platform/demo-scheduler-settings')
      .send({ calcomWebhookSecret: 'too-short' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at least 16 characters/);
  });
});

// ---------------------------------------------------------------------------
// Webhook routes accept signatures verified against a DB-only secret
// ---------------------------------------------------------------------------

describe('Webhook routes — DB-only signing secret (no env var present)', () => {
  const WEBHOOK_PATH = '/book-demo/calendar-webhook';
  const ORIGINAL = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
    ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY,
    CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
    CALCOM_WEBHOOK_ALLOW_UNSIGNED: process.env.CALCOM_WEBHOOK_ALLOW_UNSIGNED,
    CALENDLY_WEBHOOK_SECRET: process.env.CALENDLY_WEBHOOK_SECRET,
    CALENDLY_WEBHOOK_ALLOW_UNSIGNED: process.env.CALENDLY_WEBHOOK_ALLOW_UNSIGNED,
  };

  let pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> };
  let mocks: {
    findLeadById: ReturnType<typeof vi.fn>;
    findLatestLeadByEmail: ReturnType<typeof vi.fn>;
    attachBookingToLeadById: ReturnType<typeof vi.fn>;
    attachBookingToLead: ReturnType<typeof vi.fn>;
    notifyBookingConfirmed: ReturnType<typeof vi.fn>;
    recordLead: ReturnType<typeof vi.fn>;
  };

  async function buildApp(): Promise<express.Express> {
    const router = (await import('../../server/admin-api/routes/contact')).default;
    const app = express();
    app.use(WEBHOOK_PATH, express.raw({ type: 'application/json' }));
    app.use(express.json());
    app.use('/', router);
    return app;
  }

  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    process.env.ENCRYPTION_MASTER_KEY = 'unit-test-master-key-do-not-reuse';
    delete process.env.CALCOM_WEBHOOK_SECRET;
    delete process.env.CALCOM_WEBHOOK_ALLOW_UNSIGNED;
    delete process.env.CALENDLY_WEBHOOK_SECRET;
    delete process.env.CALENDLY_WEBHOOK_ALLOW_UNSIGNED;

    const made = createMemoryPool();
    pool = made.pool;
    vi.doMock('../../platform/db', () => ({ getPlatformPool: () => pool }));

    mocks = {
      findLeadById: vi.fn(async (id: number) => ({
        id,
        email: 'attendee@example.com',
        payload: {},
        name: 'Attendee',
        company: 'Acme',
      })),
      findLatestLeadByEmail: vi.fn(async () => null),
      attachBookingToLeadById: vi.fn(async (id: number) => ({ leadId: id, duplicate: false })),
      attachBookingToLead: vi.fn(async () => ({ leadId: null, duplicate: false })),
      notifyBookingConfirmed: vi.fn(async () => {}),
      recordLead: vi.fn(async () => ({ id: 1 })),
    };
    vi.doMock('../../server/admin-api/services/marketing-leads', () => ({
      findLeadById: mocks.findLeadById,
      findLatestLeadByEmail: mocks.findLatestLeadByEmail,
      attachBookingToLeadById: mocks.attachBookingToLeadById,
      attachBookingToLead: mocks.attachBookingToLead,
      notifyBookingConfirmed: mocks.notifyBookingConfirmed,
      recordLead: mocks.recordLead,
    }));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
    vi.restoreAllMocks();
    vi.doUnmock('../../platform/db');
    vi.doUnmock('../../server/admin-api/services/marketing-leads');
  });

  async function seedDbSecret(field: 'calcomWebhookSecret' | 'calendlyWebhookSecret', plaintext: string) {
    const svc = await import('../../server/admin-api/services/demo-scheduler-settings');
    await svc.setDemoSchedulerSettings({ [field]: plaintext } as never, 'admin-1');
  }

  it('Cal.com webhook accepts an envelope signed with the DB-stored secret when no env var is set', async () => {
    const dbSecret = 'db-only-cal-webhook-secret-aaaaaa';
    await seedDbSecret('calcomWebhookSecret', dbSecret);
    const app = await buildApp();

    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-db-1',
        bookingId: 'bid-db-1',
        startTime: '2026-05-01T10:00:00Z',
        endTime: '2026-05-01T10:30:00Z',
        attendees: [{ email: 'attendee@example.com', name: 'Attendee', timeZone: 'UTC' }],
        metadata: { leadId: 42 },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', dbSecret).update(`${ts}.${body}`).digest('hex');

    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', `t=${ts},v1=${sig}`)
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 42, duplicate: false });
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
  });

  it('Cal.com webhook still rejects a signature signed with a different secret when only the DB secret is configured', async () => {
    await seedDbSecret('calcomWebhookSecret', 'db-only-cal-webhook-secret-bbbbbb');
    const app = await buildApp();

    const body = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'uid-db-2',
        bookingId: 'bid-db-2',
        attendees: [{ email: 'attendee@example.com' }],
        metadata: { leadId: 1 },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const wrongSig = crypto
      .createHmac('sha256', 'a-different-secret-entirely')
      .update(`${ts}.${body}`)
      .digest('hex');

    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('x-cal-signature-256', `t=${ts},v1=${wrongSig}`)
      .send(body);

    expect(r.status).toBe(401);
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  it('Calendly webhook accepts a signature signed with the DB-stored secret when no env var is set', async () => {
    const dbSecret = 'db-only-cdly-webhook-secret-aaaaaa';
    await seedDbSecret('calendlyWebhookSecret', dbSecret);
    const app = await buildApp();

    const body = JSON.stringify({
      event: 'invitee.created',
      payload: {
        email: 'invitee@example.com',
        name: 'Invitee Person',
        uri: 'https://api.calendly.com/scheduled_events/EVT/invitees/INV',
        cancel_url: 'https://calendly.com/cancellations/INV',
        reschedule_url: 'https://calendly.com/reschedulings/INV',
        timezone: 'America/Los_Angeles',
        tracking: { utm_content: 'lead-77' },
        scheduled_event: {
          uri: 'https://api.calendly.com/scheduled_events/EVT',
          name: '30 Minute Meeting',
          start_time: '2026-05-01T10:00:00Z',
          end_time: '2026-05-01T10:30:00Z',
          location: { type: 'zoom', join_url: 'https://zoom.us/j/abc' },
        },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', dbSecret).update(`${ts}.${body}`).digest('hex');

    mocks.findLeadById = vi.fn(async (id: number) => ({
      id,
      email: 'invitee@example.com',
      payload: {},
      name: 'Invitee Person',
      company: 'Acme',
    }));
    // Re-mock with the updated handle so the route sees the new behaviour.
    vi.doMock('../../server/admin-api/services/marketing-leads', () => ({
      findLeadById: mocks.findLeadById,
      findLatestLeadByEmail: mocks.findLatestLeadByEmail,
      attachBookingToLeadById: mocks.attachBookingToLeadById,
      attachBookingToLead: mocks.attachBookingToLead,
      notifyBookingConfirmed: mocks.notifyBookingConfirmed,
      recordLead: mocks.recordLead,
    }));

    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', `t=${ts},v1=${sig}`)
      .send(body);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, leadId: 77, duplicate: false });
    expect(mocks.attachBookingToLeadById).toHaveBeenCalledTimes(1);
    expect(mocks.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
  });

  it('Calendly webhook still rejects a signature signed with a different secret when only the DB secret is configured', async () => {
    await seedDbSecret('calendlyWebhookSecret', 'db-only-cdly-webhook-secret-bbbbbb');
    const app = await buildApp();

    const body = JSON.stringify({
      event: 'invitee.created',
      payload: {
        email: 'invitee@example.com',
        uri: 'https://api.calendly.com/scheduled_events/EVT/invitees/INV',
        scheduled_event: { uri: 'https://api.calendly.com/scheduled_events/EVT' },
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const wrongSig = crypto
      .createHmac('sha256', 'an-unrelated-secret-totally')
      .update(`${ts}.${body}`)
      .digest('hex');

    const r = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Calendly-Webhook-Signature', `t=${ts},v1=${wrongSig}`)
      .send(body);

    expect(r.status).toBe(401);
    expect(mocks.attachBookingToLeadById).not.toHaveBeenCalled();
    expect(mocks.notifyBookingConfirmed).not.toHaveBeenCalled();
  });
});
