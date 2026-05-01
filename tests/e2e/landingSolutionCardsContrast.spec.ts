/**
 * Task #1484: regression coverage for the public Landing page Solution feature
 * cards.
 *
 * The original implementation used `glass-card-light` (a hard-coded white
 * surface) and `text-text-primary/60` body copy. In dark mode that rendered as
 * a near-white card with low-contrast slate text — manually verified to be
 * worse than 4.5:1 against the dark page background. This spec locks in the
 * fix so any future contributor who reintroduces a hard-coded light surface
 * for these cards is caught before merge.
 *
 * For each Solution card on `/` in dark mode this spec:
 *   1. Loads the marketing landing page with `html.dark` and `theme=dark` in
 *      `localStorage` set BEFORE the first stylesheet evaluates.
 *   2. Reads the computed background colour of the card and the computed text
 *      colour of every direct text descendant (heading, body copy).
 *   3. Computes the WCAG luminance-based contrast ratio between text and
 *      effective opaque card background.
 *   4. Fails the run if ANY text inside ANY Solution card has a contrast
 *      ratio below 4.5:1 (WCAG 2.2 AA for normal text).
 *
 * Standalone runner — no `@playwright/test` dependency. Mirrors the pattern
 * established in `tests/e2e/publicDarkModeContrast.spec.ts`:
 *
 *   npx tsx tests/e2e/landingSolutionCardsContrast.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (vite on :5000).
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL                 default http://localhost:5000
 *   SOLUTION_CARDS_MIN_CONTRAST  default 4.5
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const MIN_CONTRAST = Number(process.env.SOLUTION_CARDS_MIN_CONTRAST ?? '4.5');

interface CardTextSample {
  cardIndex: number;
  role: string;
  textPreview: string;
  textColor: string;
  bgColor: string;
  ratio: number;
}

interface RunResult {
  cardCount: number;
  samples: CardTextSample[];
  failures: CardTextSample[];
  error?: string;
}

function buildProbe(): string {
  return `(() => {
    function parseColor(str) {
      if (!str) return null;
      const m = str.match(/rgba?\\(([^)]+)\\)/i);
      if (!m) return null;
      const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
      if (parts.length < 3) return null;
      const [r, g, b] = parts;
      const a = parts.length >= 4 ? parts[3] : 1;
      return [r, g, b, a];
    }

    function relLuminance([r, g, b]) {
      const ch = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    }

    function contrast(c1, c2) {
      const l1 = relLuminance(c1);
      const l2 = relLuminance(c2);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function over(fg, bg) {
      const a = fg[3];
      return [
        Math.round(fg[0] * a + bg[0] * (1 - a)),
        Math.round(fg[1] * a + bg[1] * (1 - a)),
        Math.round(fg[2] * a + bg[2] * (1 - a)),
        1,
      ];
    }

    function effectiveBackground(el) {
      const stack = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const cs = getComputedStyle(cur);
        const bg = parseColor(cs.backgroundColor);
        if (bg && bg[3] > 0) {
          stack.push(bg);
          if (bg[3] >= 0.999) break;
        }
        cur = cur.parentElement;
      }
      if (!stack.length || stack[stack.length - 1][3] < 0.999) {
        const rootCs = getComputedStyle(document.documentElement);
        const rootBg = parseColor(rootCs.backgroundColor);
        if (rootBg && rootBg[3] >= 0.999) {
          stack.push(rootBg);
        } else {
          stack.push([255, 255, 255, 1]);
        }
      }
      let base = stack.pop();
      while (stack.length) {
        const layer = stack.pop();
        base = over(layer, base);
      }
      return base;
    }

    function directText(el) {
      let t = '';
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent) t += n.textContent;
      }
      return t.trim();
    }

    const cards = Array.from(document.querySelectorAll('[data-testid="solution-card"]'));
    const samples = [];
    cards.forEach((card, cardIndex) => {
      const textEls = card.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, li');
      textEls.forEach((el) => {
        const text = directText(el);
        if (!text) return;
        const cs = getComputedStyle(el);
        const fg = parseColor(cs.color);
        if (!fg || fg[3] === 0) return;
        const bg = effectiveBackground(el);
        const fgOnBg = fg[3] < 1 ? over(fg, bg) : fg;
        const ratio = contrast(fgOnBg, bg);
        samples.push({
          cardIndex,
          role: el.tagName.toLowerCase(),
          textPreview: text.slice(0, 80),
          textColor: 'rgba(' + fg.join(',') + ')',
          bgColor: 'rgba(' + bg.join(',') + ')',
          ratio: Math.round(ratio * 100) / 100,
        });
      });
    });
    return { cardCount: cards.length, samples };
  })()`;
}

async function applyDarkTheme(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('theme', 'dark');
    } catch {
      /* ignore */
    }
    document.documentElement.classList.add('dark');
  });
}

async function run(): Promise<void> {
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const result: RunResult = { cardCount: 0, samples: [], failures: [] };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await applyDarkTheme(ctx);
    const page: Page = await ctx.newPage();
    try {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle', timeout: 30_000 });
      // Belt-and-braces in case the zustand store reset the class on hydrate.
      await page.evaluate(() => {
        try {
          localStorage.setItem('theme', 'dark');
        } catch {
          /* ignore */
        }
        document.documentElement.classList.add('dark');
      });
      // Scroll the Solution section into view so RevealSection finishes its
      // intersection-observer enter transition before we read styles.
      await page.evaluate(() => {
        const grid = document.querySelector('[data-testid="solution-cards-grid"]');
        if (grid) grid.scrollIntoView({ block: 'center' });
      });
      await page.waitForTimeout(400);

      const data = (await page.evaluate(buildProbe())) as {
        cardCount: number;
        samples: CardTextSample[];
      };
      result.cardCount = data.cardCount;
      result.samples = data.samples;
      result.failures = data.samples.filter((s) => s.ratio < MIN_CONTRAST);
    } catch (err) {
      result.error = (err as Error).message;
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  // eslint-disable-next-line no-console
  console.log(`\nLanding Solution cards (dark mode) — min contrast = ${MIN_CONTRAST}`);
  // eslint-disable-next-line no-console
  console.log(`  cards detected: ${result.cardCount}`);
  // eslint-disable-next-line no-console
  console.log(`  text samples checked: ${result.samples.length}`);

  if (result.error) {
    // eslint-disable-next-line no-console
    console.error(`  error: ${result.error}`);
    process.exit(1);
  }

  if (result.cardCount === 0) {
    // eslint-disable-next-line no-console
    console.error('  FAIL: no [data-testid="solution-card"] elements found on /. Did the markup change?');
    process.exit(1);
  }

  if (result.samples.length === 0) {
    // eslint-disable-next-line no-console
    console.error('  FAIL: solution cards rendered but no text content was sampled.');
    process.exit(1);
  }

  if (result.failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`  FAIL: ${result.failures.length} text element(s) below ${MIN_CONTRAST}:1 contrast`);
    for (const f of result.failures) {
      // eslint-disable-next-line no-console
      console.error(
        `    • card[${f.cardIndex}] <${f.role}> "${f.textPreview}"\n` +
          `      color=${f.textColor}  bg=${f.bgColor}  contrast=${f.ratio}`,
      );
    }
    process.exit(1);
  }

  const worst = result.samples.reduce((acc, s) => (s.ratio < acc ? s.ratio : acc), Infinity);
  // eslint-disable-next-line no-console
  console.log(`  PASS — worst observed contrast: ${worst}:1`);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('e2e test failed:', err);
  process.exit(1);
});
