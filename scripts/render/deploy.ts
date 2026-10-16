/**
 * Daily release to Render (PR-00). DRY-RUN BY DEFAULT.
 *
 *   npx tsx scripts/render/deploy.ts                    # print the plan, no network
 *   npx tsx scripts/render/deploy.ts --execute          # deploy (needs RENDER_API_KEY)
 *   npx tsx scripts/render/deploy.ts --execute --commit <sha>
 *   npx tsx scripts/render/deploy.ts --execute --force-voice   # emergencies only
 *
 * Order: qvo-api → qvo-worker → qvo-nightly → qvo-voice. A failed step stops
 * the release. qvo-voice deploys only inside 00:30–06:30 America/New_York
 * and only once `/internal/drain-status` reports 0 active calls (waits up to
 * 15 min, otherwise skips voice and reports it). `--force-voice` overrides
 * both gates.
 *
 * Env (execute only): RENDER_API_KEY (QVO workspace key, never the Azul
 * one), optional RENDER_OWNER_ID (workspace id filter), VOICE_PUBLIC_BASE_URL
 * and ADMIN_INTERNAL_TOKEN for the drain-status gate.
 */

export const RENDER_API_BASE = 'https://api.render.com/v1';
export const SERVICE_ORDER = ['qvo-api', 'qvo-worker', 'qvo-nightly', 'qvo-voice'] as const;
export type ServiceName = (typeof SERVICE_ORDER)[number];

export const VOICE_WINDOW = { startMinutes: 30, endMinutes: 6 * 60 + 30, timeZone: 'America/New_York' } as const;
export const ZERO_CALLS_MAX_WAIT_MS = 15 * 60_000;
export const ZERO_CALLS_POLL_MS = 30_000;
export const DEPLOY_POLL_MS = 15_000;
export const DEPLOY_MAX_WAIT_MS = 45 * 60_000;

const DEPLOY_FAILED_STATUSES = new Set(['build_failed', 'update_failed', 'canceled', 'pre_deploy_failed', 'deactivated']);

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface DeployDeps {
  fetch: FetchLike;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface DeployOptions {
  execute: boolean;
  forceVoice: boolean;
  commitId?: string;
  apiKey?: string;
  ownerId?: string;
  voiceBaseUrl?: string;
  adminToken?: string;
}

export type StepOutcome = 'planned' | 'deployed' | 'failed' | 'skipped' | 'not-run';

export interface DeployReport {
  dryRun: boolean;
  steps: Array<{ service: ServiceName; outcome: StepOutcome; detail: string }>;
}

/** Minutes since local midnight in America/New_York (DST-aware). */
export function newYorkMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: VOICE_WINDOW.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return hour * 60 + minute;
}

/** True inside 00:30 (inclusive) – 06:30 (exclusive) America/New_York. */
export function isInsideVoiceWindow(date: Date): boolean {
  const m = newYorkMinutes(date);
  return m >= VOICE_WINDOW.startMinutes && m < VOICE_WINDOW.endMinutes;
}

export interface DrainStatusBody {
  draining: boolean;
  activeSessions: number;
  oldestSessionAgeSec: number;
  openStreams?: number;
}

/**
 * Poll the live voice instance until it reports 0 active calls (and 0 open
 * streams when reported), for at most `maxWaitMs`. Any error counts as "not
 * zero" so the gate fails closed.
 */
export async function waitForZeroCalls(
  deps: DeployDeps,
  voiceBaseUrl: string,
  adminToken: string,
  maxWaitMs = ZERO_CALLS_MAX_WAIT_MS,
  pollMs = ZERO_CALLS_POLL_MS,
): Promise<{ ok: boolean; detail: string }> {
  const started = deps.now().getTime();
  const url = `${voiceBaseUrl.replace(/\/+$/, '')}/internal/drain-status`;
  let last = 'no response yet';
  for (;;) {
    try {
      const res = await deps.fetch(url, { headers: { 'x-admin-token': adminToken, accept: 'application/json' } });
      if (!res.ok) {
        last = `drain-status HTTP ${res.status}`;
      } else {
        const body = (await res.json()) as DrainStatusBody;
        const calls = Number(body.activeSessions ?? NaN);
        const streams = Number(body.openStreams ?? 0);
        if (calls === 0 && streams === 0) return { ok: true, detail: '0 active calls' };
        last = `${Number.isFinite(calls) ? calls : '?'} active call(s), oldest ${body.oldestSessionAgeSec ?? '?'}s`;
      }
    } catch (err) {
      last = `drain-status unreachable (${err instanceof Error ? err.message : String(err)})`;
    }
    const elapsed = deps.now().getTime() - started;
    if (elapsed >= maxWaitMs) {
      return { ok: false, detail: `still not idle after ${Math.round(maxWaitMs / 60_000)} min: ${last}` };
    }
    deps.log(`  voice: waiting for 0 calls (${last})`);
    await deps.sleep(Math.min(pollMs, maxWaitMs - elapsed));
  }
}

async function renderApi<T>(deps: DeployDeps, apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await deps.fetch(`${RENDER_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Render API ${method} ${path.split('?')[0]} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function findServiceId(deps: DeployDeps, apiKey: string, name: string, ownerId?: string): Promise<string> {
  const qs = new URLSearchParams({ name, limit: '20' });
  if (ownerId) qs.set('ownerId', ownerId);
  const rows = await renderApi<Array<{ service?: { id: string; name: string } }>>(deps, apiKey, 'GET', `/services?${qs}`);
  const matches = rows.map((r) => r.service).filter((s): s is { id: string; name: string } => !!s && s.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one Render service named ${name}, found ${matches.length}`);
  }
  return matches[0].id;
}

export async function deployService(
  deps: DeployDeps,
  apiKey: string,
  serviceId: string,
  commitId?: string,
): Promise<{ ok: boolean; detail: string }> {
  const deploy = await renderApi<{ id: string; status: string }>(deps, apiKey, 'POST', `/services/${serviceId}/deploys`, {
    clearCache: 'do_not_clear',
    ...(commitId ? { commitId } : {}),
  });
  const started = deps.now().getTime();
  let status = deploy.status;
  for (;;) {
    if (status === 'live') return { ok: true, detail: `deploy ${deploy.id} live` };
    if (DEPLOY_FAILED_STATUSES.has(status)) return { ok: false, detail: `deploy ${deploy.id} ${status}` };
    if (deps.now().getTime() - started >= DEPLOY_MAX_WAIT_MS) {
      return { ok: false, detail: `deploy ${deploy.id} still ${status} after ${DEPLOY_MAX_WAIT_MS / 60_000} min` };
    }
    await deps.sleep(DEPLOY_POLL_MS);
    const current = await renderApi<{ status: string }>(deps, apiKey, 'GET', `/services/${serviceId}/deploys/${deploy.id}`);
    status = current.status;
  }
}

export function describePlan(opts: DeployOptions, now: Date): string[] {
  const inWindow = isInsideVoiceWindow(now);
  const commit = opts.commitId ? `commit ${opts.commitId}` : 'latest commit of the tracked branch';
  return [
    `Render release plan (${opts.execute ? 'EXECUTE' : 'DRY-RUN — nothing will be deployed'}), ${commit}:`,
    '  1. qvo-api      deploy (pre-deploy runs `npm run db:migrate`; a failure cancels the deploy and stops the release)',
    '  2. qvo-worker   deploy (old worker releases the leader lock before the new one starts schedulers)',
    '  3. qvo-nightly  deploy (next 07:30 UTC run uses the new build)',
    `  4. qvo-voice    ${
      opts.forceVoice
        ? 'deploy NOW (--force-voice: window and zero-calls gates overridden)'
        : `deploy only inside 00:30–06:30 America/New_York (now ${inWindow ? 'INSIDE' : 'OUTSIDE'} the window) ` +
          'and after /internal/drain-status reports 0 active calls (wait ≤ 15 min, else skip and report)'
    }`,
  ];
}

export async function runRelease(opts: DeployOptions, deps: DeployDeps): Promise<DeployReport> {
  const report: DeployReport = { dryRun: !opts.execute, steps: [] };
  for (const line of describePlan(opts, deps.now())) deps.log(line);

  if (!opts.execute) {
    for (const service of SERVICE_ORDER) report.steps.push({ service, outcome: 'planned', detail: 'dry-run' });
    deps.log('Dry-run only. Re-run with --execute (and RENDER_API_KEY for the QVO workspace) to deploy.');
    return report;
  }
  if (!opts.apiKey) throw new Error('--execute requires RENDER_API_KEY');

  let stopped = false;
  for (const service of SERVICE_ORDER) {
    if (stopped) {
      report.steps.push({ service, outcome: 'not-run', detail: 'an earlier step failed' });
      continue;
    }

    if (service === 'qvo-voice' && !opts.forceVoice) {
      if (!isInsideVoiceWindow(deps.now())) {
        report.steps.push({ service, outcome: 'skipped', detail: 'outside the 00:30–06:30 America/New_York window' });
        deps.log('  qvo-voice: SKIPPED (outside the off-hours window)');
        continue;
      }
      if (!opts.voiceBaseUrl || !opts.adminToken) {
        report.steps.push({ service, outcome: 'skipped', detail: 'VOICE_PUBLIC_BASE_URL / ADMIN_INTERNAL_TOKEN not set; cannot check active calls' });
        deps.log('  qvo-voice: SKIPPED (cannot check active calls)');
        continue;
      }
      const idle = await waitForZeroCalls(deps, opts.voiceBaseUrl, opts.adminToken);
      if (!idle.ok) {
        report.steps.push({ service, outcome: 'skipped', detail: idle.detail });
        deps.log(`  qvo-voice: SKIPPED (${idle.detail})`);
        continue;
      }
      if (!isInsideVoiceWindow(deps.now())) {
        report.steps.push({ service, outcome: 'skipped', detail: 'window closed while waiting for 0 calls' });
        deps.log('  qvo-voice: SKIPPED (window closed while waiting)');
        continue;
      }
    }

    try {
      const id = await findServiceId(deps, opts.apiKey, service, opts.ownerId);
      deps.log(`  ${service}: deploying`);
      const result = await deployService(deps, opts.apiKey, id, opts.commitId);
      report.steps.push({ service, outcome: result.ok ? 'deployed' : 'failed', detail: result.detail });
      deps.log(`  ${service}: ${result.ok ? 'DEPLOYED' : 'FAILED'} (${result.detail})`);
      if (!result.ok) stopped = true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      report.steps.push({ service, outcome: 'failed', detail });
      deps.log(`  ${service}: FAILED (${detail})`);
      stopped = true;
    }
  }
  return report;
}

export function parseArgs(argv: string[]): Pick<DeployOptions, 'execute' | 'forceVoice' | 'commitId'> {
  const i = argv.indexOf('--commit');
  return {
    execute: argv.includes('--execute'),
    forceVoice: argv.includes('--force-voice'),
    commitId: i >= 0 ? argv[i + 1] : undefined,
  };
}

/** 0 = everything deployed (or dry-run), 1 = a step failed, 3 = voice skipped. */
export function exitCodeFor(report: DeployReport): number {
  if (report.steps.some((s) => s.outcome === 'failed')) return 1;
  if (report.steps.some((s) => s.outcome === 'skipped')) return 3;
  return 0;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const deps: DeployDeps = {
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
  };
  runRelease(
    {
      ...args,
      apiKey: args.execute ? process.env.RENDER_API_KEY : undefined,
      ownerId: process.env.RENDER_OWNER_ID,
      voiceBaseUrl: process.env.VOICE_PUBLIC_BASE_URL,
      adminToken: process.env.ADMIN_INTERNAL_TOKEN,
    },
    deps,
  )
    .then((report) => {
      console.log('\nSummary:');
      for (const s of report.steps) console.log(`  ${s.service.padEnd(12)} ${s.outcome.padEnd(9)} ${s.detail}`);
      process.exit(exitCodeFor(report));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
