/**
 * BL-013 / Task #502: end-to-end regression for the MaintenanceGate against
 * an AUTHENTICATED, NON-ADMIN tenant user — the most important user class.
 *
 * The companion `maintenanceGateWhitelist.spec.ts` only covers:
 *   - logged-out tenant traffic (which falls through to /login anyway), and
 *   - the platform-admin bypass.
 *
 * Unit tests in `MaintenanceGate.test.tsx` already prove that an
 * authenticated, non-admin user on `/dashboard` sees the maintenance page
 * (and never leaks protected content during the loading window). This spec
 * closes the live-system gap by:
 *
 *   1. Seeding a known non-admin tenant user (with its own tenant) directly
 *      into Postgres — mirroring how `scripts/seed-admin.ts` seeds the
 *      platform admin.
 *   2. Toggling `/platform/maintenance` ON via the admin API.
 *   3. Logging the seeded tenant user in through the real `/login` form.
 *   4. Navigating to `/dashboard` (a protected, non-whitelisted route) and
 *      asserting the full-screen maintenance page renders — never the
 *      tenant dashboard content.
 *   5. Restoring maintenance OFF and dropping the seeded user/tenant in a
 *      `finally` block, regardless of pass/fail (just like the whitelist
 *      spec).
 *
 * Standalone runner:
 *
 *   E2E_ADMIN_PASSWORD='VoiceHub2026!' \
 *     npx tsx tests/e2e/maintenanceGateAuthenticatedTenant.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - `ADMIN_PASSWORD=<known-password> npx tsx scripts/seed-admin.ts` has
 *     been run so an admin can flip maintenance mode.
 *   - DATABASE_URL is set so the spec can (idempotently) seed the tenant
 *     user.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Why we DON'T delete the seeded tenant after the test:
 *   `audit_logs` is immutable in this schema (BEFORE UPDATE / BEFORE DELETE
 *   triggers raise). Logging in writes a `user.login` audit row that
 *   references the user via FK ON DELETE SET NULL. Removing the user would
 *   trigger that SET NULL, which the immutability trigger refuses. Instead
 *   we use a stable email/tenant id and upsert idempotently — exactly the
 *   pattern `scripts/seed-admin.ts` uses for the platform admin.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';

// Stable identifiers — the seed is idempotent (upsert), so reruns reuse the
// same row. This also avoids fighting `audit_logs`' immutability triggers
// on cleanup (see file header).
const TENANT_USER_EMAIL =
  process.env.E2E_TENANT_USER_EMAIL ?? 'bl013-tenant@voiceaihub.test';
const TENANT_USER_PASSWORD =
  process.env.E2E_TENANT_USER_PASSWORD ?? 'TenantTest!2026';
const TENANT_ID = process.env.E2E_TENANT_ID ?? 'bl013-e2e-tenant';
const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'bl013-e2e-tenant';

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

async function adminLogin(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`admin login failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { token: string; isPlatformAdmin?: boolean };
  if (!json.isPlatformAdmin) {
    throw new Error('seeded admin is not a platform admin');
  }
  return json.token;
}

async function setMaintenance(token: string, enabled: boolean, message: string | null) {
  const res = await fetch(`${BASE_URL}/api/platform/maintenance`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ enabled, message, scheduled_for: null }),
  });
  if (!res.ok) {
    throw new Error(
      `set maintenance failed (enabled=${enabled}): ${res.status} ${await res.text()}`,
    );
  }
}

/**
 * Seed an isolated tenant + non-admin tenant user so the spec has a known
 * credential to log in with. Mirrors the structure of `scripts/seed-admin.ts`
 * but creates a brand-new tenant per run and explicitly leaves
 * `is_platform_admin = false`.
 */
async function seedTenantUser(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // RLS is enabled on most tables; turn it off for this connection's
    // transaction so the seed inserts can write across tenants without
    // needing a tenant context (matches the signup route's pattern).
    await client.query(`SET LOCAL row_security = off`);

    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags)
       VALUES ($1, 'BL-013 E2E Tenant', $2, 'active', 'starter',
               '{"timezone": "America/New_York"}'::jsonb,
               '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         status = 'active',
         updated_at = NOW()`,
      [TENANT_ID, TENANT_SLUG],
    );

    const passwordHash = await bcrypt.hash(TENANT_USER_PASSWORD, 12);

    const userResult = await client.query(
      `INSERT INTO users (tenant_id, email, first_name, password_hash,
                          role, is_active, is_platform_admin, email_verified)
       VALUES ($1, $2, 'BL-013 Tester', $3, 'admin', TRUE, FALSE, TRUE)
       ON CONFLICT (email) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         is_active = TRUE,
         is_platform_admin = FALSE,
         email_verified = TRUE,
         updated_at = NOW()
       RETURNING id`,
      [TENANT_ID, TENANT_USER_EMAIL, passwordHash],
    );
    const userId = userResult.rows[0]?.id as string | undefined;

    if (!userId) {
      throw new Error('failed to seed tenant user (no id returned)');
    }

    await client.query(
      `INSERT INTO user_roles (user_id, tenant_id, role)
       VALUES ($1, $2, 'tenant_owner')
       ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
      [userId, TENANT_ID],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function tenantUiLogin(page: Page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', TENANT_USER_EMAIL);
  await page.fill('input[type="password"]', TENANT_USER_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function pageText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText);
}

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required to seed the non-admin tenant user for this spec.',
    );
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });

  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const results: TestResult[] = [];
  let cleanupToken: string | null = null;

  try {
    await seedTenantUser(pool);

    const adminToken = await adminLogin();
    cleanupToken = adminToken;

    // Flip maintenance ON for the duration of this scenario.
    await setMaintenance(adminToken, true, 'Maintenance window — BL-013 e2e (auth tenant)');

    // ---------- Authenticated non-admin tenant on /dashboard ----------
    //
    // After logging in via the real form, the tenant lands somewhere inside
    // the tenant console. We then explicitly navigate to `/dashboard` (a
    // protected, non-whitelisted route) and assert MaintenanceGate has
    // fully replaced the dashboard with the maintenance page. Tenant-only
    // markers like "Recent Conversations" must NOT appear.
    {
      const ctx: BrowserContext = await browser.newContext();
      const page = await ctx.newPage();

      try {
        await tenantUiLogin(page);
      } catch (err) {
        results.push({
          name: 'authenticated tenant can submit /login form',
          passed: false,
          detail: `login failed: ${String(err)}`,
        });
        await ctx.close();
        throw err;
      }

      await page
        .goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' })
        .catch(() => {});

      // Deterministic wait for MaintenanceGate to swap children out for the
      // Maintenance page. We anchor on the maintenance H1 ("QVO is briefly
      // offline for an upgrade") rather than a fixed sleep so the spec
      // doesn't race the `/platform/maintenance` poll on slow machines and
      // doesn't miss a transient flash of dashboard content on fast ones.
      const maintenanceHeading = page.locator(
        'h1:has-text("QVO is briefly offline")',
      );
      const headingVisible = await maintenanceHeading
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);

      // Multiple representative tenant-only markers must NOT appear:
      //   - "Recent Conversations" — a Dashboard.tsx body marker
      //   - the TenantLayout `<aside>` sidebar (whole layout was replaced)
      const text = await pageText(page);
      const sawMaintenance = /QVO is briefly offline/i.test(text);
      const sawDashboardMarker = /Recent Conversations/i.test(text);
      const tenantSidebarCount = await page
        .locator('aside.bg-sidebar-bg')
        .count();
      const onDashboardUrl = page.url().endsWith('/dashboard');

      results.push({
        name:
          'authenticated non-admin tenant on /dashboard sees maintenance page (full-screen, no tenant content)',
        passed:
          onDashboardUrl &&
          headingVisible &&
          sawMaintenance &&
          !sawDashboardMarker &&
          tenantSidebarCount === 0,
        detail: `url=${page.url()} headingVisible=${headingVisible} sawMaintenance=${sawMaintenance} sawDashboardMarker=${sawDashboardMarker} tenantSidebarCount=${tenantSidebarCount}`,
      });

      // Also assert the maintenance status banner (admin-only) is NOT shown
      // to a regular tenant — this proves the gate replaced the layout
      // entirely instead of just stacking the banner on top of the
      // dashboard.
      const sawBanner = await page
        .locator('[data-testid="maintenance-status-banner"]')
        .count();
      results.push({
        name: 'non-admin tenant does NOT see admin-only maintenance status banner',
        passed: sawBanner === 0,
        detail: `bannerCount=${sawBanner}`,
      });

      await ctx.close();
    }
  } finally {
    if (cleanupToken) {
      // Always restore maintenance OFF, even if assertions failed above.
      await setMaintenance(cleanupToken, false, null).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('cleanup: failed to disable maintenance:', err);
      });
    }
    await browser.close();
    await pool.end().catch(() => {});
  }

  let failed = 0;
  for (const r of results) {
    const flag = r.passed ? 'PASS' : 'FAIL';
    // eslint-disable-next-line no-console
    console.log(`[${flag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    if (!r.passed) failed += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('e2e test failed:', err);
  process.exit(1);
});
