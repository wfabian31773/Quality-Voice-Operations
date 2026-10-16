import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isInsideVoiceWindow,
  newYorkMinutes,
  waitForZeroCalls,
  runRelease,
  parseArgs,
  exitCodeFor,
  SERVICE_ORDER,
  type DeployDeps,
} from './deploy';

type Route = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => { status?: number; body: unknown };

function deps(route: Route, startIso: string) {
  let now = new Date(startIso).getTime();
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const lines: string[] = [];
  const d: DeployDeps = {
    fetch: vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body });
      const r = route(url, init);
      const status = r.status ?? 200;
      return { ok: status < 400, status, json: async () => r.body };
    }),
    now: () => new Date(now),
    sleep: async (ms: number) => {
      now += ms;
    },
    log: (l: string) => lines.push(l),
  };
  return { d, calls, lines, advance: (ms: number) => (now += ms) };
}

// 2026-10-16 is EDT (UTC-4): 06:00Z = 02:00 ET (inside), 16:00Z = 12:00 ET (outside).
const INSIDE = '2026-10-16T06:00:00Z';
const OUTSIDE = '2026-10-16T16:00:00Z';

function renderApi(statusFor: (name: string) => string[] = () => ['build_in_progress', 'live']): Route {
  const progress: Record<string, string[]> = {};
  return (url) => {
    const u = new URL(url);
    if (u.pathname === '/v1/services') {
      const name = u.searchParams.get('name')!;
      return { body: [{ service: { id: `srv-${name}`, name } }, { service: { id: 'srv-other', name: `${name}-old` } }] };
    }
    const m = u.pathname.match(/^\/v1\/services\/srv-([a-z-]+)\/deploys(?:\/(.+))?$/);
    if (m) {
      const name = m[1];
      progress[name] ??= [...statusFor(name)];
      const status = progress[name].length > 1 ? progress[name].shift()! : progress[name][0];
      return { body: { id: `dep-${name}`, status } };
    }
    if (u.pathname === '/internal/drain-status') {
      return { body: { draining: false, activeSessions: 0, oldestSessionAgeSec: 0, openStreams: 0 } };
    }
    return { status: 404, body: {} };
  };
}

describe('voice window (America/New_York)', () => {
  it.each([
    ['2026-10-16T04:29:00Z', false], // 00:29 EDT
    ['2026-10-16T04:30:00Z', true], // 00:30 EDT
    ['2026-10-16T10:29:00Z', true], // 06:29 EDT
    ['2026-10-16T10:30:00Z', false], // 06:30 EDT
    ['2026-12-01T05:30:00Z', true], // 00:30 EST (UTC-5)
    ['2026-12-01T04:30:00Z', false], // 23:30 EST
    ['2026-12-01T11:29:00Z', true], // 06:29 EST
  ])('%s → %s', (iso, inside) => {
    expect(isInsideVoiceWindow(new Date(iso))).toBe(inside);
  });

  it('computes local minutes', () => {
    expect(newYorkMinutes(new Date('2026-10-16T06:15:00Z'))).toBe(2 * 60 + 15);
  });
});

describe('zero-calls gate', () => {
  it('waits until 0 active calls, sending the admin token', async () => {
    let n = 2;
    const t = deps(() => ({ body: { draining: false, activeSessions: n--, oldestSessionAgeSec: 30 } }), INSIDE);
    const r = await waitForZeroCalls(t.d, 'https://voice.example.com/', 'tok');
    expect(r.ok).toBe(true);
    expect(t.calls).toHaveLength(3);
    expect(t.calls[0].url).toBe('https://voice.example.com/internal/drain-status');
    expect(t.calls[0].headers['x-admin-token']).toBe('tok');
  });

  it('gives up after 15 minutes', async () => {
    const t = deps(() => ({ body: { draining: false, activeSessions: 1, oldestSessionAgeSec: 99 } }), INSIDE);
    const r = await waitForZeroCalls(t.d, 'https://v', 'tok');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('after 15 min');
    expect(t.calls.length).toBe(31); // every 30 s for 15 min
  });

  it('fails closed on errors and on open (unregistered) streams', async () => {
    const t = deps(() => ({ status: 403, body: {} }), INSIDE);
    expect((await waitForZeroCalls(t.d, 'https://v', 'bad', 60_000)).detail).toContain('HTTP 403');
    const t2 = deps(() => ({ body: { activeSessions: 0, openStreams: 1, oldestSessionAgeSec: 0, draining: false } }), INSIDE);
    expect((await waitForZeroCalls(t2.d, 'https://v', 'tok', 60_000)).ok).toBe(false);
    const t3 = deps(() => { throw new Error('ECONNREFUSED'); }, INSIDE);
    expect((await waitForZeroCalls(t3.d, 'https://v', 'tok', 60_000)).detail).toContain('unreachable');
  });
});

describe('zero-calls gate with a hung endpoint', () => {
  afterEach(() => vi.useRealTimers());

  it('times out each request (≤ 10 s, aborting it), keeps polling and skips at 15 min', async () => {
    vi.useFakeTimers({ now: new Date(INSIDE) });
    const signals: AbortSignal[] = [];
    const d: DeployDeps = {
      fetch: vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise<never>(() => {});
      }),
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: () => {},
    };
    let result: { ok: boolean; detail: string } | undefined;
    void waitForZeroCalls(d, 'https://v', 'tok').then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals[0].aborted).toBe(true);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain('after 15 min');
    expect(result?.detail).toContain('timed out');
    // 10 s timeout + 30 s sleep per poll, then a final poll at the 15 min mark.
    expect((d.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(24);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});

describe('runRelease', () => {
  const base = { forceVoice: false, apiKey: 'rnd_test', voiceBaseUrl: 'https://voice.example.com', adminToken: 'tok' };

  it('dry-run (default) prints the plan and makes no network calls', async () => {
    const t = deps(renderApi(), OUTSIDE);
    const report = await runRelease({ execute: false, forceVoice: false }, t.d);
    expect(t.d.fetch).not.toHaveBeenCalled();
    expect(report.dryRun).toBe(true);
    expect(report.steps.map((s) => s.service)).toEqual([...SERVICE_ORDER]);
    expect(t.lines.join('\n')).toContain('DRY-RUN');
    expect(t.lines.join('\n')).toContain('OUTSIDE the window');
    expect(exitCodeFor(report)).toBe(0);
  });

  it('--execute without RENDER_API_KEY refuses', async () => {
    const t = deps(renderApi(), INSIDE);
    await expect(runRelease({ execute: true, forceVoice: false }, t.d)).rejects.toThrow(/RENDER_API_KEY/);
  });

  it('deploys api → worker → cron → voice inside the window at zero calls', async () => {
    const t = deps(renderApi(), INSIDE);
    const report = await runRelease({ ...base, execute: true, commitId: 'abc123' }, t.d);
    expect(report.steps.map((s) => [s.service, s.outcome])).toEqual(SERVICE_ORDER.map((s) => [s, 'deployed']));
    const posts = t.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual(SERVICE_ORDER.map((s) => `https://api.render.com/v1/services/srv-${s}/deploys`));
    expect(JSON.parse(posts[0].body!)).toEqual({ clearCache: 'do_not_clear', commitId: 'abc123' });
    expect(posts[0].headers.authorization).toBe('Bearer rnd_test');
    const drainIdx = t.calls.findIndex((c) => c.url.endsWith('/internal/drain-status'));
    const voicePostIdx = t.calls.findIndex((c) => c.method === 'POST' && c.url.includes('srv-qvo-voice'));
    expect(drainIdx).toBeGreaterThan(-1);
    expect(drainIdx).toBeLessThan(voicePostIdx);
    expect(exitCodeFor(report)).toBe(0);
  });

  it('skips voice outside the window (never calls drain-status or deploys voice)', async () => {
    const t = deps(renderApi(), OUTSIDE);
    const report = await runRelease({ ...base, execute: true }, t.d);
    expect(report.steps.at(-1)).toMatchObject({ service: 'qvo-voice', outcome: 'skipped' });
    expect(t.calls.some((c) => c.url.includes('srv-qvo-voice'))).toBe(false);
    expect(t.calls.some((c) => c.url.includes('drain-status'))).toBe(false);
    expect(exitCodeFor(report)).toBe(3);
  });

  it('skips voice when calls never reach 0 within 15 min', async () => {
    const api = renderApi();
    const t = deps((url, init) =>
      url.endsWith('/internal/drain-status')
        ? { body: { draining: false, activeSessions: 2, oldestSessionAgeSec: 120 } }
        : api(url, init), INSIDE);
    const report = await runRelease({ ...base, execute: true }, t.d);
    expect(report.steps.at(-1)).toMatchObject({ service: 'qvo-voice', outcome: 'skipped' });
    expect(report.steps.at(-1)!.detail).toContain('2 active call(s)');
    expect(t.calls.some((c) => c.method === 'POST' && c.url.includes('srv-qvo-voice'))).toBe(false);
  });

  it('--force-voice deploys voice outside the window without the zero-calls check', async () => {
    const t = deps(renderApi(), OUTSIDE);
    const report = await runRelease({ ...base, execute: true, forceVoice: true }, t.d);
    expect(report.steps.at(-1)).toMatchObject({ service: 'qvo-voice', outcome: 'deployed' });
    expect(t.calls.some((c) => c.url.includes('drain-status'))).toBe(false);
  });

  it('stops the release when the api deploy fails (e.g. migration)', async () => {
    const t = deps(renderApi((n) => (n === 'qvo-api' ? ['pre_deploy_in_progress', 'pre_deploy_failed'] : ['live'])), INSIDE);
    const report = await runRelease({ ...base, execute: true }, t.d);
    expect(report.steps.map((s) => s.outcome)).toEqual(['failed', 'not-run', 'not-run', 'not-run']);
    expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(exitCodeFor(report)).toBe(1);
  });

  it('fails when a service name is ambiguous or missing', async () => {
    const t = deps((url) => (new URL(url).pathname === '/v1/services' ? { body: [] } : { body: {} }), INSIDE);
    const report = await runRelease({ ...base, execute: true }, t.d);
    expect(report.steps[0]).toMatchObject({ outcome: 'failed' });
    expect(report.steps[0].detail).toContain('found 0');
  });
});

describe('parseArgs', () => {
  it('is dry-run by default', () => {
    expect(parseArgs([])).toEqual({ execute: false, forceVoice: false, commitId: undefined });
    expect(parseArgs(['--execute', '--force-voice', '--commit', 'abc'])).toEqual({ execute: true, forceVoice: true, commitId: 'abc' });
  });
});
