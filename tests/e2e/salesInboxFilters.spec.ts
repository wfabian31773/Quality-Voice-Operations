/**
 * Browser-level regression test for the new Sales Inbox filters
 * ("Acted on by" + "Inactive for X days").
 *
 * Covers gaps that the SQL-level unit tests in
 * `tests/admin-api/marketingLeadsFilters.test.ts` cannot — namely that the
 * actual /admin/sales-inbox page:
 *
 *   1. Wires the `actedOnBy` text input and the `inactiveDays` numeric input
 *      through to `GET /api/platform/marketing-leads` query string.
 *   2. Re-renders the table with only the matching rows.
 *   3. Forwards both filters into the `Download CSV` request URL.
 *   4. Populates the autocomplete <datalist> from
 *      `GET /api/platform/marketing-lead-authors`.
 *   5. Rejects negative values from the numeric input on the client side.
 *
 * Runs against a real Chromium browser via the `playwright` runtime API
 * (no @playwright/test dependency required). Standalone — no test runner.
 *
 *   npx tsx tests/e2e/salesInboxFilters.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow is running (admin API on :3002, vite on :5000).
 *   - `ADMIN_PASSWORD=<known-password> npx tsx scripts/seed-admin.ts` has been
 *     run, so the platform-admin login below succeeds.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL         default http://localhost:5000  (vite dev preview)
 *   E2E_ADMIN_EMAIL      default admin@voiceaihub.dev
 *   E2E_ADMIN_PASSWORD   default test-password-123
 *   PLATFORM_DB_POOL_URL or DATABASE_URL  (used to seed/cleanup test rows)
 */
import { chromium, type Browser, type Page, type Request } from 'playwright';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';
import { loginViaUi } from './helpers/login';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';
const DB_URL = process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'sales-inbox-filters';

if (!DB_URL) {
  console.error('PLATFORM_DB_POOL_URL or DATABASE_URL must be set to seed test data');
  process.exit(1);
}

interface SeedResult {
  runId: string;
  company: string;
  author: string;
  otherAuthor: string;
  leadAEmail: string;
  leadBEmail: string;
  leadCEmail: string;
  leadIds: { a: number; b: number; c: number };
}

async function seed(pool: pg.Pool): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8);
  const company = `qa-co-${runId}`;
  const author = `qa-author-${runId}@example.com`;
  const otherAuthor = `qa-other-${runId}@example.com`;
  const leadAEmail = `qa-lead-a-${runId}@example.com`;
  const leadBEmail = `qa-lead-b-${runId}@example.com`;
  const leadCEmail = `qa-lead-c-${runId}@example.com`;

  // Lead A: recent event by `author`            -> matches actedOnBy=<author>
  // Lead B: recent event by a different author  -> excluded by actedOnBy
  // Lead C: 60d-old event only                  -> matches inactiveDays=7
  const result = await pool.query<{ a: string; b: string; c: string }>(
    `
    WITH a AS (
      INSERT INTO marketing_leads (source, name, email, company)
      VALUES ('contact', 'QA Lead A', $1, $4) RETURNING id
    ),
    b AS (
      INSERT INTO marketing_leads (source, name, email, company)
      VALUES ('contact', 'QA Lead B', $2, $4) RETURNING id
    ),
    c AS (
      INSERT INTO marketing_leads (source, name, email, company)
      VALUES ('contact', 'QA Lead C', $3, $4) RETURNING id
    ),
    ev_a AS (
      INSERT INTO marketing_lead_events (lead_id, event_type, new_status, author, created_at)
      SELECT id, 'status_change', 'contacted', $5, NOW() FROM a
    ),
    ev_b AS (
      INSERT INTO marketing_lead_events (lead_id, event_type, new_status, author, created_at)
      SELECT id, 'status_change', 'contacted', $6, NOW() FROM b
    ),
    ev_c AS (
      INSERT INTO marketing_lead_events (lead_id, event_type, new_status, author, created_at)
      SELECT id, 'status_change', 'contacted', $6, NOW() - INTERVAL '60 days' FROM c
    )
    SELECT (SELECT id::text FROM a) AS a, (SELECT id::text FROM b) AS b, (SELECT id::text FROM c) AS c;
    `,
    [leadAEmail, leadBEmail, leadCEmail, company, author, otherAuthor],
  );
  const row = result.rows[0];

  return {
    runId,
    company,
    author,
    otherAuthor,
    leadAEmail,
    leadBEmail,
    leadCEmail,
    leadIds: { a: Number(row.a), b: Number(row.b), c: Number(row.c) },
  };
}

async function cleanup(pool: pg.Pool, company: string): Promise<void> {
  // marketing_lead_events.lead_id is FK with ON DELETE CASCADE.
  await pool.query(`DELETE FROM marketing_leads WHERE company = $1`, [company]);
}

interface CapturedRequest {
  url: string;
  method: string;
  status?: number;
}

function captureLeadsRequests(page: Page): CapturedRequest[] {
  const seen: CapturedRequest[] = [];
  page.on('request', (req: Request) => {
    const u = req.url();
    if (/\/api\/platform\/marketing-leads(\.csv)?(\?|$)/.test(u)) {
      seen.push({ url: u, method: req.method() });
    }
  });
  page.on('response', async (res) => {
    const u = res.url();
    if (/\/api\/platform\/marketing-leads(\.csv)?(\?|$)/.test(u)) {
      const last = [...seen].reverse().find((r) => r.url === u && r.status === undefined);
      if (last) last.status = res.status();
    }
  });
  return seen;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function findRequestMatching(reqs: CapturedRequest[], includes: string[]): CapturedRequest | undefined {
  return reqs.find((r) => includes.every((s) => r.url.includes(s)));
}

async function login(page: Page): Promise<void> {
  await loginViaUi(page, ADMIN_EMAIL, ADMIN_PASSWORD, { waitUntil: 'networkidle' });
}

async function visibleEmails(page: Page): Promise<string[]> {
  // Lead emails render inside a <a href="mailto:..."> in each row of the table.
  const hrefs = await page.locator('table a[href^="mailto:"]').evaluateAll((els) =>
    (els as HTMLAnchorElement[]).map((el) => el.textContent?.trim() ?? ''),
  );
  return hrefs.filter(Boolean);
}

async function waitForRowCount(page: Page, expected: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const emails = await visibleEmails(page);
    last = emails.length;
    if (last === expected) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Expected ${expected} rows, last saw ${last}`);
}

/**
 * Returns a promise that resolves once a leads-list request matching every
 * substring in `mustInclude` (and none in `mustExclude`) has completed with
 * status 200. We use this instead of fixed sleeps so the test reacts to real
 * network activity rather than a guessed debounce window.
 */
function waitForLeadsRequest(
  page: Page,
  opts: { mustInclude: string[]; mustExclude?: string[]; csv?: boolean; timeoutMs?: number },
) {
  const re = opts.csv
    ? /\/api\/platform\/marketing-leads\.csv(\?|$)/
    : /\/api\/platform\/marketing-leads(\?|$)/;
  return page.waitForResponse(
    (res) => {
      const u = res.url();
      if (!re.test(u)) return false;
      if (res.status() !== 200) return false;
      if (!opts.mustInclude.every((s) => u.includes(s))) return false;
      if (opts.mustExclude?.some((s) => u.includes(s))) return false;
      return true;
    },
    { timeout: opts.timeoutMs ?? 10_000 },
  );
}

async function captureFailureScreenshot(page: Page | undefined): Promise<void> {
  if (!page) return;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-failure.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[e2e]   screenshot: ${shotPath}`);
  } catch (err) {
    console.warn(`[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
  }
}

async function run(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
  let browser: Browser | undefined;
  let page: Page | undefined;
  let seedData: SeedResult | undefined;
  try {
    seedData = await seed(pool);
    const { company, author, leadAEmail, leadBEmail, leadCEmail } = seedData;
    console.log(`[e2e] seeded test rows under company=${company}`);

    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    const requests = captureLeadsRequests(page);

    await login(page);
    console.log(`[e2e] logged in as ${ADMIN_EMAIL}`);

    await page.goto(`${BASE_URL}/admin/sales-inbox`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Sales Inbox');

    // 1. Scope the table to just our test rows via the search field. Wait
    //    for the actual response that carried `q=<company>` rather than
    //    sleeping a debounce window.
    const searchResponded = waitForLeadsRequest(page, {
      mustInclude: [`q=${encodeURIComponent(company)}`],
    });
    await page.fill('#lead-search', company);
    await searchResponded;
    await waitForRowCount(page, 3);
    const initialEmails = (await visibleEmails(page)).sort();
    assert(
      initialEmails.includes(leadAEmail) &&
        initialEmails.includes(leadBEmail) &&
        initialEmails.includes(leadCEmail),
      `expected all 3 seeded leads, got ${JSON.stringify(initialEmails)}`,
    );

    // 2. Apply actedOnBy and verify the actual request that carried it.
    const actedResponded = waitForLeadsRequest(page, {
      mustInclude: [
        `actedOnBy=${encodeURIComponent(author)}`,
        `q=${encodeURIComponent(company)}`,
      ],
    });
    await page.fill('#lead-acted-on-by', author);
    const actedRes = await actedResponded;
    await waitForRowCount(page, 1);
    assert(
      actedRes.url().includes(`actedOnBy=${encodeURIComponent(author)}`),
      `no /platform/marketing-leads response had actedOnBy=${author} & q=${company}`,
    );
    const visible = await visibleEmails(page);
    assert(
      visible.length === 1 && visible[0] === leadAEmail,
      `actedOnBy filter should leave only Lead A, got ${JSON.stringify(visible)}`,
    );
    console.log('[e2e] actedOnBy filter wired correctly');

    // 3. Verify the autocomplete <datalist> was populated from the
    //    /platform/marketing-lead-authors endpoint.
    const datalistValues = await page
      .locator('#lead-acted-on-by-options option')
      .evaluateAll((opts) => (opts as HTMLOptionElement[]).map((o) => o.value));
    assert(
      datalistValues.includes(author),
      `datalist should include ${author}, got ${JSON.stringify(datalistValues)}`,
    );

    // 4. Clear actedOnBy, set inactiveDays=7, re-verify URL + row.
    //    NOTE: clearing actedOnBy returns the query string to a value that
    //    was already fetched on initial render (`?q=<company>`), so React
    //    Query will serve the cached response and no new network request
    //    will fire. Wait on the DOM (row count rebounds to 3) instead of a
    //    network round-trip to avoid a deterministic timeout here.
    await page.fill('#lead-acted-on-by', '');
    await waitForRowCount(page, 3);
    const inactiveResponded = waitForLeadsRequest(page, {
      mustInclude: ['inactiveDays=7', `q=${encodeURIComponent(company)}`],
      mustExclude: [`actedOnBy=${encodeURIComponent(author)}`],
    });
    await page.fill('#lead-inactive-days', '7');
    const inactiveRes = await inactiveResponded;
    await waitForRowCount(page, 1);
    assert(
      !inactiveRes.url().includes(`actedOnBy=${encodeURIComponent(author)}`),
      'actedOnBy should have been cleared',
    );
    const visibleC = await visibleEmails(page);
    assert(
      visibleC.length === 1 && visibleC[0] === leadCEmail,
      `inactiveDays filter should leave only Lead C, got ${JSON.stringify(visibleC)}`,
    );
    console.log('[e2e] inactiveDays filter wired correctly');

    // 5. Negative numeric input is rejected by the controlled component.
    //    No network round-trip is needed — just a controlled-input check.
    await page.fill('#lead-inactive-days', '');
    await page.fill('#lead-inactive-days', '-3');
    await page.locator('#lead-inactive-days').evaluate((el) => (el as HTMLInputElement).blur());
    const inactiveVal = await page.locator('#lead-inactive-days').inputValue();
    assert(
      inactiveVal === '' || /^\d+$/.test(inactiveVal),
      `negative inactive-days should be stripped, got "${inactiveVal}"`,
    );

    // 6. Both filters set; click Download CSV; verify request URL has both
    //    new params AND returns 200. We wait for the in-flight list refetch
    //    that combines both filters before clicking, then capture the CSV
    //    response.
    const bothResponded = waitForLeadsRequest(page, {
      mustInclude: [
        'inactiveDays=7',
        `actedOnBy=${encodeURIComponent(author)}`,
        `q=${encodeURIComponent(company)}`,
      ],
    });
    await page.fill('#lead-inactive-days', '7');
    await page.fill('#lead-acted-on-by', author);
    await bothResponded;

    const csvResponded = waitForLeadsRequest(page, {
      mustInclude: [
        `actedOnBy=${encodeURIComponent(author)}`,
        'inactiveDays=7',
        `q=${encodeURIComponent(company)}`,
      ],
      csv: true,
    });
    await page.locator('button[title="Download the current filtered view as a CSV file"]').click();
    const csvRes = await csvResponded;
    const csvUrl = csvRes.url();
    assert(csvUrl.includes(`actedOnBy=${encodeURIComponent(author)}`), `CSV URL missing actedOnBy: ${csvUrl}`);
    assert(csvUrl.includes('inactiveDays=7'), `CSV URL missing inactiveDays: ${csvUrl}`);
    assert(csvUrl.includes(`q=${encodeURIComponent(company)}`), `CSV URL missing q: ${csvUrl}`);
    assert(csvRes.status() === 200, `CSV download status was ${csvRes.status()}`);
    console.log('[e2e] CSV download URL forwards both new params correctly');

    console.log('[e2e] PASS');
  } catch (err) {
    await captureFailureScreenshot(page);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (seedData) {
      await cleanup(pool, seedData.company).catch((err) =>
        console.warn(`[e2e] cleanup failed for ${seedData?.company}:`, err),
      );
    }
    await pool.end().catch(() => undefined);
  }
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
