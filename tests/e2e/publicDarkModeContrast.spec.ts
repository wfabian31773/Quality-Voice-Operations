/**
 * Task #743: regression coverage for dark-mode contrast on the public
 * marketing site.
 *
 * Dark mode for the public marketing site shipped in task #741 with manual
 * verification only. Future contributors editing public pages can easily
 * reintroduce hardcoded `bg-white` cards or text-color classes that resolve
 * to white-on-white in dark mode (or dark-on-dark in light mode) without
 * anyone noticing until a customer reports it.
 *
 * For each top-level public route this test:
 *   1. Loads the page twice — once with `html.dark` set and `theme=dark` in
 *      `localStorage`, once with the inverse — using `addInitScript` so the
 *      theme is applied BEFORE the first stylesheet evaluates.
 *   2. Walks every visible element with non-empty direct text content,
 *      computes its effective opaque background colour (walking up the
 *      ancestor chain past transparent layers), and computes the WCAG
 *      relative-luminance contrast ratio between the text colour and that
 *      background.
 *   3. Fails the page if ANY such element has a contrast ratio below the
 *      minimum legibility threshold (1.6) — well below WCAG AA (4.5) but
 *      enough to catch the literal "white text on white background" /
 *      "black text on black background" classes of regression the task
 *      calls out, while not flagging design-debatable low-but-readable
 *      contrast.
 *
 * Standalone runner — no `@playwright/test` dependency. Mirrors the pattern
 * established in `tests/e2e/loginRedirectGuard.spec.ts` and
 * `tests/e2e/salesInboxFilters.spec.ts`:
 *
 *   npx tsx tests/e2e/publicDarkModeContrast.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (vite on :5000).
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL          default http://localhost:5000
 *   DARKMODE_MIN_CONTRAST default 1.6
 *   DARKMODE_MAX_FAILURES default 0   (per page+theme; raise to triage)
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const MIN_CONTRAST = Number(process.env.DARKMODE_MIN_CONTRAST ?? '1.6');
const MAX_FAILURES_PER_RUN = Number(process.env.DARKMODE_MAX_FAILURES ?? '0');

const PUBLIC_ROUTES = [
  '/',
  '/product',
  '/features',
  '/pricing',
  '/product/federated-ingest',
  '/product/global-intelligence-network',
  '/industries/vertical-agents',
  '/demo',
  '/docs',
  '/blog',
  '/case-studies',
  '/contact',
  '/signup',
] as const;

type Theme = 'light' | 'dark';

interface ContrastFailure {
  tag: string;
  classes: string;
  textPreview: string;
  textColor: string;
  bgColor: string;
  ratio: number;
}

interface RouteResult {
  route: string;
  theme: Theme;
  passed: boolean;
  failures: ContrastFailure[];
  error?: string;
}

/**
 * Runs in the page context. Walks every element with non-empty direct text
 * content, finds its effective opaque background colour, and computes the
 * WCAG luminance-based contrast ratio against its computed text colour.
 *
 * Returns the worst N offenders so we don't blow up the report on a page
 * that has hundreds of broken elements.
 */
function buildContrastProbe(minContrast: number, maxReport: number): string {
  return `(() => {
    const MIN = ${minContrast};
    const MAX_REPORT = ${maxReport};

    function parseColor(str) {
      if (!str) return null;
      // rgba(r, g, b, a) | rgb(r, g, b)
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

    // Composite a foreground rgba over a background rgb (assumes bg is opaque).
    function over(fg, bg) {
      const a = fg[3];
      return [
        Math.round(fg[0] * a + bg[0] * (1 - a)),
        Math.round(fg[1] * a + bg[1] * (1 - a)),
        Math.round(fg[2] * a + bg[2] * (1 - a)),
        1,
      ];
    }

    // Pull every rgb()/rgba() colour stop out of a computed background-image
    // value (linear-gradient, radial-gradient, conic-gradient, multi-layer,
    // etc.). Used so that hero sections relying on bg-gradient-to-* register
    // as opaque without needing a manual bg-* backstop class — the original
    // probe only inspected backgroundColor, which left such sections looking
    // "transparent" and falling through to the document body's white.
    function parseGradientStops(bgImage) {
      if (!bgImage || bgImage === 'none') return [];
      const stops = [];
      const re = /rgba?\\([^)]+\\)/gi;
      let m;
      while ((m = re.exec(bgImage)) !== null) {
        const parsed = parseColor(m[0]);
        if (parsed) stops.push(parsed);
      }
      return stops;
    }

    // Common public-hero pattern: <section class="relative">
    //   <div class="absolute inset-0 bg-gradient-to-..."></div>
    //   <div class="relative">…content…</div>
    // </section>
    // The gradient div is a SIBLING of the content div, not an ancestor of
    // the text inside, so an ancestor-only walk misses it. Recognise direct
    // children that fully fill their parent (position:absolute|fixed with
    // inset:0) as a visual backstop layer.
    function findFillBackstop(parent) {
      for (const child of parent.children) {
        const ccs = getComputedStyle(child);
        if (ccs.position !== 'absolute' && ccs.position !== 'fixed') continue;
        if (ccs.top !== '0px' || ccs.left !== '0px' || ccs.right !== '0px' || ccs.bottom !== '0px') continue;
        const childBg = parseColor(ccs.backgroundColor);
        if (childBg && childBg[3] >= 0.999) return childBg;
        const childStops = parseGradientStops(ccs.backgroundImage);
        const co = childStops.find((s) => s[3] >= 0.999);
        if (co) return co;
      }
      return null;
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
        // Element-level gradient (e.g. <section class="bg-gradient-to-br ...">).
        const stops = parseGradientStops(cs.backgroundImage);
        const opaqueGradient = stops.find((s) => s[3] >= 0.999);
        if (opaqueGradient) {
          stack.push(opaqueGradient);
          break;
        }
        // Child-fill backstop (e.g. absolute inset-0 gradient div).
        const fillBg = findFillBackstop(cur);
        if (fillBg) {
          stack.push(fillBg);
          break;
        }
        cur = cur.parentElement;
      }
      // Fallback to documentElement background, then white.
      if (!stack.length || stack[stack.length - 1][3] < 0.999) {
        const rootCs = getComputedStyle(document.documentElement);
        const rootBg = parseColor(rootCs.backgroundColor);
        if (rootBg && rootBg[3] >= 0.999) {
          stack.push(rootBg);
        } else {
          stack.push([255, 255, 255, 1]);
        }
      }
      // Composite back-to-front: the deepest opaque base, then each layer above it.
      let base = stack.pop();
      while (stack.length) {
        const layer = stack.pop();
        base = over(layer, base);
      }
      return base;
    }

    function isHidden(el) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return true;
      if (parseFloat(cs.opacity) === 0) return true;
      // 0-area elements aren't visible to a user.
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return true;
      return false;
    }

    function hasAncestorHidden(el) {
      let cur = el.parentElement;
      while (cur && cur.nodeType === 1) {
        const cs = getComputedStyle(cur);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    }

    function directText(el) {
      let t = '';
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent) t += n.textContent;
      }
      return t.trim();
    }

    const failures = [];
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      const text = directText(el);
      if (!text) continue;
      // Skip <script>/<style>/<noscript>/<template> etc.
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
      if (isHidden(el) || hasAncestorHidden(el)) continue;

      const cs = getComputedStyle(el);
      const fg = parseColor(cs.color);
      if (!fg) continue;
      // Skip fully-transparent text — invisible by design (e.g. screen-reader-only).
      if (fg[3] === 0) continue;

      const bg = effectiveBackground(el);
      const fgOnBg = fg[3] < 1 ? over(fg, bg) : fg;
      const ratio = contrast(fgOnBg, bg);
      if (ratio < MIN) {
        failures.push({
          tag,
          classes: (el.className && typeof el.className === 'string') ? el.className.slice(0, 120) : '',
          textPreview: text.slice(0, 80),
          textColor: 'rgba(' + fg.join(',') + ')',
          bgColor: 'rgba(' + bg.join(',') + ')',
          ratio: Math.round(ratio * 100) / 100,
        });
      }
    }
    failures.sort((a, b) => a.ratio - b.ratio);
    return failures.slice(0, MAX_REPORT);
  })()`;
}

async function applyTheme(ctx: BrowserContext, theme: Theme): Promise<void> {
  // Run BEFORE any page script so the html.dark class is set before the
  // first stylesheet computes layout — matches what useTheme does on cold
  // load (see client-app/src/lib/theme.ts).
  await ctx.addInitScript(
    (t: string) => {
      try {
        localStorage.setItem('theme', t);
      } catch {
        /* localStorage may be unavailable on about:blank */
      }
      if (t === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    },
    theme,
  );
}

async function checkRoute(
  browser: Browser,
  route: string,
  theme: Theme,
): Promise<RouteResult> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await applyTheme(ctx, theme);
  const page: Page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}${route}`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    // Belt-and-braces: ensure the dark class survived hydration. The
    // useTheme zustand store reads localStorage in module scope, but a
    // future refactor could move it; reapply just in case so a misbehaving
    // store doesn't mask a real contrast bug.
    await page.evaluate((t) => {
      try {
        localStorage.setItem('theme', t);
      } catch {
        /* ignore */
      }
      document.documentElement.classList.toggle('dark', t === 'dark');
    }, theme);
    // Settle for any post-hydration style transitions.
    await page.waitForTimeout(250);

    const probe = buildContrastProbe(MIN_CONTRAST, 25);
    const failures = (await page.evaluate(probe)) as ContrastFailure[];
    return {
      route,
      theme,
      failures,
      passed: failures.length <= MAX_FAILURES_PER_RUN,
    };
  } catch (err) {
    return {
      route,
      theme,
      failures: [],
      passed: false,
      error: (err as Error).message,
    };
  } finally {
    await ctx.close();
  }
}

function formatFailure(f: ContrastFailure): string {
  return (
    `      • <${f.tag}${f.classes ? ` class="${f.classes}"` : ''}>` +
    `\n        text="${f.textPreview}"` +
    `\n        color=${f.textColor}  bg=${f.bgColor}  contrast=${f.ratio}`
  );
}

async function run(): Promise<void> {
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const results: RouteResult[] = [];
  try {
    for (const route of PUBLIC_ROUTES) {
      for (const theme of ['light', 'dark'] as const) {
        // eslint-disable-next-line no-console
        process.stdout.write(`  · ${theme.padEnd(5)} ${route} ... `);
        const result = await checkRoute(browser, route, theme);
        results.push(result);
        // eslint-disable-next-line no-console
        console.log(result.passed ? 'OK' : `FAIL (${result.failures.length} contrast issues${result.error ? `, error: ${result.error}` : ''})`);
      }
    }
  } finally {
    await browser.close();
  }

  let failed = 0;
  for (const r of results) {
    if (r.passed) continue;
    failed += 1;
    // eslint-disable-next-line no-console
    console.error(`\n[FAIL] ${r.theme} ${r.route}${r.error ? ` — ${r.error}` : ''}`);
    for (const f of r.failures.slice(0, 10)) {
      // eslint-disable-next-line no-console
      console.error(formatFailure(f));
    }
    if (r.failures.length > 10) {
      // eslint-disable-next-line no-console
      console.error(`      … and ${r.failures.length - 10} more`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n${results.length - failed}/${results.length} route+theme combinations passed ` +
      `(min contrast = ${MIN_CONTRAST}).`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('e2e test failed:', err);
  process.exit(1);
});
