/**
 * Self-contained browser proof for GTM-007 / WP5.
 *
 * Serves the real public application and executes the actual deterministic
 * healthcare scenario runner behind its public API boundary. This proves the
 * guided experience without Twilio/OpenAI credentials; live audio remains WP6.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { executeHealthcareDemoScenario } from '../../platform/demo/healthcareDemoScenario';
import type { HealthcareDemoScenarioKind } from '../../shared/demo/healthcareDemo';

const WEB_PORT = 5180;
const API_PORT = 3013;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const FIXED_NOW = new Date('2026-07-12T17:30:00.000Z');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length === 0
    ? {}
    : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const apiServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${API_PORT}`);
  if (req.method === 'OPTIONS') return json(res, {});
  if (req.method === 'POST' && url.pathname === '/demo/healthcare/run') {
    const body = await readBody(req);
    if (body.scenario !== 'appointment_request' && body.scenario !== 'safe_escalation') {
      return json(res, { error: 'invalid scenario' }, 400);
    }
    return json(res, await executeHealthcareDemoScenario(
      body.scenario as HealthcareDemoScenarioKind,
      { now: FIXED_NOW },
    ));
  }
  if (req.method === 'POST' && (url.pathname === '/conversion/event' || url.pathname === '/demo/track-cta')) {
    return json(res, { ok: true });
  }
  return json(res, {});
});

async function main() {
  await new Promise<void>((resolve, reject) => {
    apiServer.once('error', reject);
    apiServer.listen(API_PORT, '127.0.0.1', resolve);
  });

  const vite = await createViteServer({
    configFile: new URL('../../client-app/vite.config.ts', import.meta.url).pathname,
    server: {
      port: WEB_PORT,
      strictPort: true,
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${API_PORT}`,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  });
  await vite.listen();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(`${BASE_URL}/demo`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'One call. One staff-ready outcome.' }).waitFor();
    assert(await page.getByText(/choose an agent|agent marketplace|deploy your own AI voice agents/i).count() === 0, 'generic agent gallery must not render');
    assert(await page.getByText('Master Voice Agent 1.0.0', { exact: true }).count() === 1, 'locked core version must be visible');
    assert(await page.getByText(/not a live phone call/i).count() === 1, 'guided disclosure must be visible');

    await page.getByRole('button', { name: 'Run appointment workflow' }).click();
    await page.getByTestId('healthcare-outcome-card').waitFor({ state: 'visible', timeout: 10_000 });
    assert(await page.getByText('Spanish → English', { exact: true }).count() === 1, 'appointment proof must show the code switch');
    assert(await page.getByText(/Sunday, July 12, 2026/).count() === 1, 'appointment proof must use injected clinic-local date');
    assert(await page.getByText('Production tool contract confirmed', { exact: true }).count() >= 1, 'production tool proof must render');
    assert(await page.getByRole('link', { name: /open follow-up ticket/i }).count() === 0, 'public demo must not expose an internal ticket route');
    assert(!/appointment (?:is |was )?booked|HIPAA compliant|recovered \$/i.test(await page.locator('body').innerText()), 'unsupported claims must not render');

    await page.getByRole('button', { name: 'Reset demo' }).click();
    assert(await page.getByTestId('healthcare-outcome-card').count() === 0, 'reset must clear the deterministic result');
    await page.getByRole('button', { name: /safe escalation/i }).click();
    await page.getByRole('button', { name: 'Run safe escalation' }).click();
    await page.getByText(/I can't diagnose this/i).waitFor({ state: 'visible', timeout: 10_000 });
    assert(await page.getByText(/911 or emergency services now/i).count() === 1, 'safe escalation must name emergency services');
    assert(await page.getByText(/A human follow-up task was created/i).count() === 1, 'safe escalation must create human follow-up evidence');
    assert(!/transfer(?:red)? successfully|transfer completed/i.test(await page.locator('body').innerText()), 'false transfer claims must not render');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'One call. One staff-ready outcome.' }).waitFor();
    assert(await page.getByRole('button', { name: 'Run appointment workflow' }).count() === 1, 'mobile view must retain the primary guided action');
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(mobileOverflow <= 1, `mobile view must not introduce horizontal overflow (delta ${mobileOverflow}px)`);
    assert(pageErrors.length === 0, `browser must have no page errors: ${pageErrors.join('; ')}`);

    console.log('PASS healthcare-first GTM demo browser proof');
    const inspectionHoldMs = Number(process.env.E2E_INSPECTION_HOLD_MS ?? 0);
    if (inspectionHoldMs > 0) await page.waitForTimeout(inspectionHoldMs);
  } finally {
    await Promise.race([browser.close(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    await Promise.race([vite.close(), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    await Promise.race([
      new Promise<void>((resolve) => apiServer.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
