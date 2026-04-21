import { chromium } from 'playwright';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5000';
const VIDEO_DIR = '.local/_videos';
const OUT_DIR = 'client-app/public/docs/videos';

await rm(VIDEO_DIR, { recursive: true, force: true });
await mkdir(VIDEO_DIR, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
});

await context.addInitScript(() => {
  try {
    localStorage.setItem(
      'qvo-cookie-consent-v1',
      JSON.stringify({ essential: true, analytics: true, marketing: true, decided: true, decidedAt: new Date().toISOString() })
    );
  } catch {}
});

async function recordWalkthrough(steps, name) {
  const page = await context.newPage();
  for (const step of steps) {
    if (step.url) {
      try {
        await page.goto(BASE + step.url, { waitUntil: 'networkidle', timeout: 15000 });
      } catch {
        await page.goto(BASE + step.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
      await page.waitForTimeout(step.wait || 1500);
    }
    if (step.scrollTo !== undefined) {
      await page.evaluate(
        (y) => window.scrollTo({ top: y, behavior: 'smooth' }),
        step.scrollTo
      );
      await page.waitForTimeout(step.wait || 1800);
    }
  }
  await page.close();
  // Find the produced webm
  const files = (await readdir(VIDEO_DIR)).filter((f) => f.endsWith('.webm'));
  const latest = files.sort().pop();
  if (!latest) throw new Error('no recording');
  const src = join(VIDEO_DIR, latest);
  const out = join(OUT_DIR, `${name}.mp4`);
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i', src,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      out,
    ]);
    ff.stderr.on('data', () => {});
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + code))));
  });
  await rm(src, { force: true });
  console.log('saved', out);
}

await recordWalkthrough(
  [
    { url: '/signup', wait: 2200 },
    { scrollTo: 200, wait: 1500 },
    { url: '/demo', wait: 2200 },
    { scrollTo: 600, wait: 2000 },
    { scrollTo: 1100, wait: 1800 },
    { scrollTo: 1500, wait: 1800 },
  ],
  'quickstart-walkthrough'
);

await browser.close();
