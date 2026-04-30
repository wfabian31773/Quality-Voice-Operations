/**
 * Live (un-mocked) browser smoke for the Billing config health tile on
 * the Platform Admin dashboard. The deterministic sister spec —
 * `platformAdminBillingHealth.spec.ts` — intercepts
 * `/api/platform/billing-config-health` with synthetic data so it stays
 * green in CI; this spec leaves the request alone and asserts the
 * panel summary tile renders **"All prices healthy"** against the real
 * verifier path.
 *
 * Designed for the scheduled `billing-health-live-stripe.yml` workflow:
 * a nightly job hits the un-mocked endpoint with the dev Stripe account
 * configured, so a Stripe price id rotated outside the env vars (drift
 * the deploy-time `verify:stripe-prices` script catches but doesn't
 * surface visually) trips a Slack alert and a GitHub tracking issue
 * the same way the in-process `StripePriceVerificationScheduler` does.
 *
 * Runner shape mirrors `tests/e2e/platformAdminBillingHealth.spec.ts`.
 * Run: `npx tsx tests/e2e/platformAdminBillingHealthLive.spec.ts`.
 * Requires the Platform Dev workflow running with real `STRIPE_*` env
 * vars, the admin seeded via `scripts/seed-admin.ts`, and `npx
 * playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL        default http://localhost:5000
 *   E2E_ADMIN_EMAIL     default admin@voiceaihub.dev
 *   E2E_ADMIN_PASSWORD  default test-password-123
 *   E2E_ARTIFACT_DIR    default .ci-logs/screenshots
 */
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';

const SPEC_NAME = 'platform-admin-billing-health-live';
const PAGE_TIMEOUT_MS = 30_000;

// Snapshot of the live `/api/platform/billing-config-health` response,
// captured in-page via fetch(). Kept structural-only (status + counts
// + per-row failure detail) so the workflow can format a Slack/GitHub
// alert without re-exporting the full server-side type.
interface LivePriceRow {
  envKey: string;
  plan: string;
  kind: string;
  interval: string | null;
  status: string;
  priceId: string | null;
  message?: string;
}

interface LiveBillingHealthSnapshot {
  summary: {
    total: number;
    ok: number;
    failed: number;
    status: 'ok' | 'failed' | 'no-stripe-key';
    message?: string;
  };
  results: LivePriceRow[];
  generatedAt: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.toString().endsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function expectVisible(page: Page, locator: Locator, label: string): Promise<void> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    throw new Error(`expected ${label} to be visible (${(err as Error).message})`);
  }
}

// Pull the JSON the panel just rendered out of the page so the workflow
// can attach a structured failure summary (counts + per-row detail) to
// its Slack/GitHub alert without re-running the verifier separately.
async function fetchLiveSnapshot(page: Page): Promise<LiveBillingHealthSnapshot> {
  const json = await page.evaluate(async () => {
    const res = await fetch('/api/platform/billing-config-health', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    return { status: res.status, text };
  });
  if (json.status !== 200) {
    throw new Error(
      `/api/platform/billing-config-health returned HTTP ${json.status}: ${json.text.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(json.text) as LiveBillingHealthSnapshot;
  } catch (err) {
    throw new Error(
      `failed to parse /api/platform/billing-config-health JSON: ${(err as Error).message}`,
    );
  }
}

async function writeSnapshot(snapshot: LiveBillingHealthSnapshot | null): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true }).catch(() => undefined);
  const snapshotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-snapshot.json`);
  await writeFile(snapshotPath, JSON.stringify(snapshot ?? {}, null, 2)).catch((err) => {
    console.warn(`[e2e] failed to write snapshot to ${snapshotPath}: ${(err as Error).message}`);
  });
}

async function captureScreenshot(page: Page | undefined, suffix: string): Promise<string | null> {
  if (!page) return null;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${suffix}.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    return shotPath;
  } catch (err) {
    console.warn(`[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
    return null;
  }
}

function summariseFailures(snapshot: LiveBillingHealthSnapshot): string {
  const broken = snapshot.results.filter((r) => r.status !== 'ok');
  if (broken.length === 0) return '';
  return broken
    .map((r) => {
      const detail = r.message ? ` — ${r.message}` : '';
      const intervalSuffix = r.interval ? ` ${r.interval}` : '';
      return `  - ${r.envKey} (${r.plan}${intervalSuffix}): ${r.status}${detail}`;
    })
    .join('\n');
}

async function run(): Promise<void> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let snapshot: LiveBillingHealthSnapshot | null = null;
  let failureReason: string | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();

    await login(page);
    console.log(`[e2e] logged in as ${ADMIN_EMAIL}`);

    await page.goto(`${BASE_URL}/admin/dashboard`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });

    if (/\/login(\?|$)/.test(page.url())) {
      throw new Error(`redirected to /login (lost session?) — landed at ${page.url()}`);
    }

    await expectVisible(
      page,
      page.getByRole('heading', { name: 'Platform Administration' }),
      'Platform Administration heading',
    );

    const tab = page.getByRole('tab', { name: 'Billing config health' });
    await expectVisible(page, tab, 'Billing config health tab');
    await tab.click();

    await expectVisible(
      page,
      page.getByRole('heading', { name: 'Billing config health' }),
      'Billing config health panel heading',
    );

    // Capture the JSON the panel just rendered — used for the Slack /
    // tracking-issue body on failure, and dropped as an artifact on
    // every run so success captures are auditable too.
    snapshot = await fetchLiveSnapshot(page);
    await writeSnapshot(snapshot);
    console.log(
      `[e2e] live snapshot: status=${snapshot.summary.status} ok=${snapshot.summary.ok}/${snapshot.summary.total} failed=${snapshot.summary.failed}`,
    );

    // The "Status" summary tile renders "All prices healthy" only when
    // `summary.status === 'ok'`. `no-stripe-key` swaps in "Stripe key
    // not set" and `failed` swaps in "<n> failed", so failing on the
    // text mismatch surfaces the same regression the verifier would.
    if (snapshot.summary.status !== 'ok') {
      failureReason = `summary.status=${snapshot.summary.status} (expected "ok"). ${snapshot.summary.message ?? ''}`.trim();
    }

    // Visual contract: the Status summary tile actually renders "All
    // prices healthy". Scoped to the tile (anchored by its "Status"
    // micro-label) because the panel ALSO renders "All prices healthy"
    // in the "Last scheduled run" line just above the tile grid — a
    // page-wide getByText would silently pass even if the tile itself
    // regressed to "<n> failed".
    const statusTile = page
      .locator('div.rounded-xl')
      .filter({ has: page.getByText('Status', { exact: true }) })
      .first();
    await expectVisible(page, statusTile, 'Status summary tile container');
    await expectVisible(
      page,
      statusTile.getByText('All prices healthy', { exact: true }),
      '"All prices healthy" status tile copy',
    );

    if (!failureReason) {
      const screenshot = await captureScreenshot(page, 'success');
      console.log(`[e2e] PASS — billing-health tile reports "All prices healthy" against live API`);
      if (screenshot) console.log(`[e2e] success screenshot: ${screenshot}`);
    }
  } catch (err) {
    failureReason = (err as Error).message;
  } finally {
    if (failureReason) {
      const shotPath = await captureScreenshot(page, 'failure');
      // Always re-write the snapshot file so the failure-body step
      // can rely on it existing.
      await writeSnapshot(snapshot);
      console.error(`[e2e] FAIL ${SPEC_NAME}: ${failureReason}`);
      if (shotPath) console.error(`[e2e]   screenshot: ${shotPath}`);
      if (snapshot) {
        const failures = summariseFailures(snapshot);
        if (failures) console.error(`[e2e]   failing rows:\n${failures}`);
      }
    }
    if (browser) await browser.close().catch(() => undefined);
  }

  if (failureReason) {
    assert(false, `live billing-health smoke failed: ${failureReason}`);
  }
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
