/**
 * Task #1398 — End-to-end regression for the per-invoice discount
 * badges that mount inside an expanded recurring marketplace
 * purchase's renewal-invoice sub-history.
 *
 * Background:
 *   Task #1389 added an expandable renewal-invoice list under each
 *   recurring marketplace purchase row in `client-app/src/pages/
 *   Marketplace.tsx`. Each sub-row carries its own coupon-aware
 *   discount chip (driven by the per-invoice `discounts[]` returned
 *   by `/api/marketplace/purchases/:id/invoices`), so a tenant can
 *   see when a coupon expired mid-subscription or stacked on a
 *   renewal — the parent purchase row only stores the latest
 *   invoice's discount, hiding that drift.
 *
 * Existing coverage:
 *   - `tests/marketplace/marketplacePurchaseListInvoices.test.ts`
 *     pins the service-level shaping of the renewal invoices
 *     (date / amount / discount snapshot per invoice).
 *   - `tests/e2e/marketplacePurchaseDiscountBadge.spec.ts` covers
 *     the parent row's coupon chip end-to-end.
 *
 * What this spec adds: a UI-level guard that the React renderer in
 * `PurchaseRow` + `PurchaseInvoiceItem` actually wires the chevron
 * to the lazy fetch, mounts a per-invoice chip ONLY on invoices
 * carrying a discount, and points each "Receipt PDF" link at the
 * sub-row's own invoice PDF (not the parent row's most recent
 * invoice). A renderer-only regression — e.g. dropping the
 * `discounts.map(...)` chip, swapping `invoice.invoicePdf` for the
 * parent row's PDF, or breaking the chevron toggle — would slip
 * past the unit test because the API mapping itself is unchanged.
 *
 * The spec drives a real browser, fulfils the purchases list with
 * a single recurring purchase, fulfils that purchase's invoices
 * endpoint with two renewal invoices (one discounted, one not),
 * clicks the chevron, and asserts:
 *   1. The `marketplace-purchase-invoices` panel mounts only after
 *      the chevron is clicked (not on initial render).
 *   2. Two invoice sub-rows render.
 *   3. Exactly one `marketplace-purchase-invoice-discount-badge`
 *      chip mounts (on the discounted renewal only).
 *   4. The discounted chip surfaces the promo code label + tooltip
 *      with the human coupon name.
 *   5. Each Receipt PDF link points at its own invoice PDF, NOT
 *      the parent purchase's most-recent invoice PDF.
 *   6. Clicking the chevron a second time collapses the panel.
 *
 * Run:  npm run test:e2e:marketplace-purchase-invoice-history
 *
 * Pre-requisites:
 *   - Platform Dev workflow is running (admin API on :3002, vite on :5000).
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL        default http://localhost:5000
 *   E2E_ARTIFACT_DIR    default .ci-logs/screenshots
 *   DATABASE_URL / PLATFORM_DB_POOL_URL — must point at the same DB
 *                       as the running Platform Dev workflow.
 */
import { chromium, type Browser, type Page, type Route } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'marketplace-purchase-invoice-history';

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';

// Stable purchase id used in both the list payload and the invoices
// payload — keeping them in sync is what proves the chevron's lazy
// fetch is wired to the row id (not, say, the template id).
const PURCHASE_ID = 'mkt_purchase_sub_invhist_001';

// PDF URLs deliberately distinguish the renewal invoices from one
// another so we can assert each Receipt PDF anchor points at its
// OWN invoice rather than the parent row's most-recent PDF.
const RENEWAL_DISCOUNT_PDF = 'https://stripe.test/pdfs/in_renewal_discounted.pdf';
const RENEWAL_PLAIN_PDF = 'https://stripe.test/pdfs/in_renewal_plain.pdf';

const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '');
})();

interface SeedResult {
  runId: string;
  fixtureEmail: string;
  fixtureUserId: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
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

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.toString().endsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function seed(pool: pg.Pool): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8);
  const fixtureEmail = `mkt-purchase-invhist-e2e-${runId}@voiceaihub.dev`;
  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 12);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, role, is_platform_admin, is_active, email_verified)
     VALUES ($1, $2, $3, 'tenant_owner', false, true, true)
     ON CONFLICT (email) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       is_platform_admin = false,
       is_active = true,
       email_verified = true,
       updated_at = NOW()
     RETURNING id`,
    [ADMIN_TENANT_ID, fixtureEmail, passwordHash],
  );
  const fixtureUserId = rows[0]?.id;
  assert(fixtureUserId, `Failed to upsert fixture user ${fixtureEmail}`);

  await pool.query(
    `INSERT INTO user_roles (user_id, tenant_id, role)
     VALUES ($1, $2, 'tenant_owner')
     ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
    [fixtureUserId, ADMIN_TENANT_ID],
  );

  return { runId, fixtureEmail, fixtureUserId };
}

async function cleanup(pool: pg.Pool, seedData: SeedResult): Promise<void> {
  await pool
    .query(
      `UPDATE users
          SET is_active = false,
              email = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [seedData.fixtureUserId, `${seedData.fixtureEmail}.deleted-${Date.now()}`],
    )
    .catch((err) => console.warn(`[e2e] cleanup user soft-delete failed:`, err));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');
    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [seedData.fixtureUserId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.warn(`[e2e] cleanup user_roles failed:`, err);
  } finally {
    client.release();
  }
}

// One recurring purchase. The parent row carries no discount of its
// own — that way the only `marketplace-purchase-discount-badge` chip
// candidates on the page must come from the EXPANDED invoice
// sub-rows, eliminating any cross-talk between the parent chip and
// the per-invoice chip when we count them.
function buildPurchasesResponse(): unknown {
  const now = new Date().toISOString();
  return {
    purchases: [
      {
        id: PURCHASE_ID,
        templateId: 'tmpl_loyalty_pack',
        templateName: 'Loyalty Pack',
        status: 'completed',
        purchasedAt: now,
        completedAt: now,
        createdAt: now,
        amountCents: 9_900,
        currency: 'usd',
        // `recurring` is derived in the renderer from `priceModel`
        // (`monthly_subscription`), not from a top-level boolean —
        // setting `priceModel` correctly is what makes the chevron
        // / expandable branch render at all (see PurchaseRow).
        priceModel: 'monthly_subscription',
        recurring: true,
        subscriptionStatus: 'active',
        stripeSubscriptionId: 'sub_marketplace_invhist_xyz',
        discount: null,
      },
    ],
  };
}

// Two renewal invoices. The first carries a percent-off promo code,
// the second carries no discount at all — so the renderer must mount
// EXACTLY ONE per-invoice chip even though both invoices render. The
// PDFs are distinct so we can prove each anchor links at its own
// invoice rather than re-using the parent row's most-recent PDF.
function buildInvoicesResponse(): unknown {
  return {
    invoices: [
      {
        id: 'in_renewal_discounted',
        number: 'INV-DISC-0001',
        date: '2026-04-01T00:00:00.000Z',
        amountCents: 8_910, // 9_900 - 10%
        currency: 'usd',
        status: 'paid',
        invoicePdf: RENEWAL_DISCOUNT_PDF,
        hostedInvoiceUrl: 'https://stripe.test/invoice/in_renewal_discounted',
        description: 'April renewal',
        discounts: [
          {
            couponId: 'coupon_market10',
            name: 'Marketplace Promo',
            percentOff: 10,
            amountOffCents: null,
            currency: null,
            promotionCode: 'MARKET10',
          },
        ],
      },
      {
        id: 'in_renewal_plain',
        number: 'INV-PLAIN-0002',
        date: '2026-03-01T00:00:00.000Z',
        amountCents: 9_900,
        currency: 'usd',
        status: 'paid',
        invoicePdf: RENEWAL_PLAIN_PDF,
        hostedInvoiceUrl: 'https://stripe.test/invoice/in_renewal_plain',
        description: 'March renewal',
        discounts: [],
      },
    ],
  };
}

async function run(): Promise<void> {
  if (!DB_URL) {
    console.error('[e2e] DATABASE_URL (dev) or PLATFORM_DB_POOL_URL (prod) must be set');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  let browser: Browser | undefined;
  let page: Page | undefined;
  let seedData: SeedResult | undefined;

  try {
    seedData = await seed(pool);
    console.log(`[e2e] seeded fixture user=${seedData.fixtureEmail} runId=${seedData.runId}`);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    // Track invoice-endpoint hits so we can prove the lazy fetch is
    // gated on the chevron click. The handler must be installed
    // BEFORE the page is navigated so the cached query never sees a
    // real (potentially empty) response.
    let invoicesFetchCount = 0;

    await context.route('**/api/marketplace/purchases', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildPurchasesResponse()),
      });
    });

    // Match the per-purchase invoices route specifically. We anchor
    // on the literal purchase id so an unrelated `/purchases/...`
    // call (e.g. `/purchase-access`) can't accidentally satisfy the
    // glob.
    await context.route(
      `**/api/marketplace/purchases/${PURCHASE_ID}/invoices`,
      async (route: Route) => {
        invoicesFetchCount += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(buildInvoicesResponse()),
        });
      },
    );

    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    await page.goto(`${BASE_URL}/marketplace/purchases`, { waitUntil: 'networkidle' });

    // The parent purchase row should mount, but the invoices panel
    // must NOT be in the DOM yet — the lazy fetch is gated on the
    // chevron toggle. This is the regression guard for "renderer
    // dropped the `enabled: expandable && expanded` gate".
    const purchaseRow = page.locator('[data-testid="marketplace-purchase-row"]').first();
    await purchaseRow.waitFor({ state: 'visible', timeout: 15_000 });
    const initialPanelCount = await page
      .locator('[data-testid="marketplace-purchase-invoices"]')
      .count();
    assert(
      initialPanelCount === 0,
      `invoices panel must not mount before chevron is clicked, got ${initialPanelCount}`,
    );
    assert(
      invoicesFetchCount === 0,
      `invoices endpoint must not be hit before chevron is clicked, got ${invoicesFetchCount}`,
    );

    // Click the chevron to expand the row. The button uses an
    // `aria-expanded` toggle so the same locator works for the
    // collapse step further down.
    const chevron = purchaseRow.locator('[data-testid="marketplace-purchase-expand"]');
    await chevron.waitFor({ state: 'visible', timeout: 5_000 });
    await chevron.click();

    const panel = purchaseRow.locator('[data-testid="marketplace-purchase-invoices"]');
    await panel.waitFor({ state: 'visible', timeout: 10_000 });
    assert(
      (await chevron.getAttribute('aria-expanded')) === 'true',
      'chevron aria-expanded should flip to "true" after click',
    );

    // The lazy fetch must have fired exactly once. We don't assert
    // === 1 strictly because React-Query may legitimately retry on a
    // transient failure; what matters is that it fired at all
    // AFTER the click and not before it.
    assert(
      invoicesFetchCount >= 1,
      `invoices endpoint must be hit after chevron click, got ${invoicesFetchCount}`,
    );

    // Wait for the actual invoice rows (the panel itself shows a
    // skeleton placeholder while the fetch is in flight, and the
    // "no invoices yet" empty state would also clear the skeleton —
    // anchoring on the row testid avoids both red herrings).
    const invoiceRows = panel.locator('[data-testid="marketplace-purchase-invoice-row"]');
    await invoiceRows.first().waitFor({ state: 'visible', timeout: 10_000 });
    const invoiceRowCount = await invoiceRows.count();
    assert(
      invoiceRowCount === 2,
      `expected exactly two renewal invoice rows, got ${invoiceRowCount}`,
    );

    // EXACTLY ONE per-invoice discount chip — only the first
    // renewal carries a discount in the fixture, so a regression
    // that mounts a chip on every invoice (or none) would surface
    // here. We scope to `panel` so any future addition of a parent
    // chip can't pollute the count.
    const invoiceBadges = panel.locator(
      '[data-testid="marketplace-purchase-invoice-discount-badge"]',
    );
    const invoiceBadgeCount = await invoiceBadges.count();
    assert(
      invoiceBadgeCount === 1,
      `expected exactly one per-invoice discount badge, got ${invoiceBadgeCount}`,
    );

    // The chip on the discounted renewal must surface the promo
    // code label (preferred over the bare coupon name when both
    // are present), and its tooltip must include the full coupon
    // attribution + percent-off — the same shape as the parent
    // chip's tooltip contract from Task #1373.
    const badge = invoiceBadges.first();
    const badgeText = (await badge.innerText()).trim();
    assert(
      /MARKET10/i.test(badgeText),
      `per-invoice badge should show promo code 'MARKET10', got: ${JSON.stringify(badgeText)}`,
    );
    assert(
      /10% off/i.test(badgeText),
      `per-invoice badge should show '10% off', got: ${JSON.stringify(badgeText)}`,
    );
    const badgeTooltip = (await badge.getAttribute('aria-label')) ?? '';
    assert(
      /Marketplace Promo/i.test(badgeTooltip),
      `per-invoice badge tooltip should include coupon name 'Marketplace Promo', got: ${JSON.stringify(badgeTooltip)}`,
    );
    assert(
      /10% off/i.test(badgeTooltip),
      `per-invoice badge tooltip should include '10% off', got: ${JSON.stringify(badgeTooltip)}`,
    );

    // Each Receipt PDF anchor must point at its OWN invoice's PDF
    // — the regression target here is "renderer accidentally re-uses
    // the parent purchase's most-recent invoice PDF for every
    // sub-row", which would silently make every Download Receipt
    // link resolve to the same file.
    const pdfLinks = panel.locator('[data-testid="marketplace-purchase-invoice-pdf"]');
    const pdfLinkCount = await pdfLinks.count();
    assert(
      pdfLinkCount === 2,
      `expected one Receipt PDF link per invoice (2 total), got ${pdfLinkCount}`,
    );
    const firstPdfHref = await pdfLinks.nth(0).getAttribute('href');
    const secondPdfHref = await pdfLinks.nth(1).getAttribute('href');
    assert(
      firstPdfHref === RENEWAL_DISCOUNT_PDF,
      `first invoice's Receipt PDF should be ${RENEWAL_DISCOUNT_PDF}, got ${JSON.stringify(firstPdfHref)}`,
    );
    assert(
      secondPdfHref === RENEWAL_PLAIN_PDF,
      `second invoice's Receipt PDF should be ${RENEWAL_PLAIN_PDF}, got ${JSON.stringify(secondPdfHref)}`,
    );
    // Distinct-PDF regression target ("parent PDF reused for every
    // sub-row") is already implied by the two equality asserts above
    // since RENEWAL_DISCOUNT_PDF !== RENEWAL_PLAIN_PDF; no extra
    // assert needed.

    // Click the chevron a second time — the panel must collapse so
    // a regression that wires the toggle as one-way (e.g. always
    // setting expanded=true) is also caught.
    await chevron.click();
    await panel.waitFor({ state: 'detached', timeout: 5_000 });
    assert(
      (await chevron.getAttribute('aria-expanded')) === 'false',
      'chevron aria-expanded should flip back to "false" after second click',
    );

    console.log(`[e2e] ${SPEC_NAME}: PASS`);
  } catch (err) {
    console.error(`[e2e] ${SPEC_NAME}: FAIL — ${(err as Error).message}`);
    await captureFailureScreenshot(page);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    if (seedData) {
      await cleanup(pool, seedData);
    }
    await pool.end().catch(() => {});
  }
}

run().catch((err) => {
  console.error(`[e2e] ${SPEC_NAME}: unhandled — ${(err as Error).message}`);
  process.exitCode = 1;
});
