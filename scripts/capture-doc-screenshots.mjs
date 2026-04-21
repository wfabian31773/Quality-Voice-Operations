import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5000';
const OUT_DIR = 'client-app/public/docs/screenshots';

const shots = [
  { path: '/signup', file: 'quickstart-signup.jpg', scrollTo: 0 },
  { path: '/integrations', file: 'integrations-catalog.jpg', scrollTo: 700 },
  { path: '/demo', file: 'demo-templates.jpg', scrollTo: 600 },
  { path: '/demo', file: 'demo-transcript-panels.jpg', scrollTo: 1400 },
  { path: '/demo', file: 'demo-active-call.jpg', scrollTo: 1000 },
  { path: '/features', file: 'features-architecture.jpg', scrollTo: 600 },
  { path: '/features', file: 'features-detail.jpg', scrollTo: 1400 },
  { path: '/product', file: 'product-section-2.jpg', scrollTo: 1800 },
  { path: '/ai-agents', file: 'agents-showcase.jpg', scrollTo: 400 },
];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});

await context.addInitScript(() => {
  try {
    localStorage.setItem(
      'qvo-cookie-consent-v1',
      JSON.stringify({ essential: true, analytics: true, marketing: true, decided: true, decidedAt: new Date().toISOString() })
    );
  } catch {}
});

await mkdir(OUT_DIR, { recursive: true });

const page = await context.newPage();
for (const s of shots) {
  const url = BASE + s.path;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  }
  await page.waitForTimeout(800);
  if (s.scrollTo) {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), s.scrollTo);
    await page.waitForTimeout(400);
  }
  const out = `${OUT_DIR}/${s.file}`;
  await mkdir(dirname(out), { recursive: true });
  await page.screenshot({ path: out, type: 'jpeg', quality: 85, fullPage: false });
  console.log('saved', out);
}

await browser.close();
