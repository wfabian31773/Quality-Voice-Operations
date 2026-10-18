/**
 * pass^k for the audio pack, on RT-10's runner (scripts/quality/passK.ts):
 * each scenario runs k times (run r jitters the caller's timing by
 * (r - 1) * jitterMs) and a `core` flow must pass k/k.
 *
 * A scenario the runtime can't pass yet carries `expectedFail` + `pinned`
 * (like the vertical1 pack): it is not `core`, and each of its k runs must
 * fail on exactly the pinned checks. An unexpected pass or a different
 * failure turns the gate red, so the known gap stays visible and a fix
 * (or a regression) is noticed.
 */
import { formatDiff } from '../matcher';
import { formatPassKSummary, runPassK, type PassKReport } from '../passK';
import type { Scenario, ScenarioRunResult, ScenarioStatus } from '../types';
import { VirtualClock } from './clock';
import type { RuntimeModules } from './edges';
import { grade, observe, toCheckFailure, type AudioCheckFailure, type AudioObservation } from './grade';
import { runAudioCall } from './harness';
import type { AudioScenario } from './scenario';

export interface RunStatus {
  run: number;
  status: ScenarioStatus;
  /** Failed check keys, sorted. */
  keys: string[];
  diff: string;
}

export function failedKeys(failures: AudioCheckFailure[]): string[] {
  return [...new Set(failures.map((f) => f.key))].sort();
}

export interface KnownRed {
  id: string;
  plan: string;
  flow: string;
  expectedFail: string;
  pinned: string[];
  k: number;
  /** Runs that failed on exactly the pinned checks. */
  pinnedRuns: number;
  ok: boolean;
  /** The diff of the first pinned run: what fails today, with the observed values. */
  example: string;
  /** Runs that deviated (unexpected pass, or other checks failing). */
  deviations: RunStatus[];
}

export interface AudioGateReport {
  ok: boolean;
  k: number;
  startedAt: string;
  finishedAt: string;
  passK: PassKReport;
  knownRed: KnownRed[];
  /** Every run of every scenario: status and failed check keys. */
  runs: Record<string, RunStatus[]>;
  observations: Record<string, AudioObservation[]>;
}

export function statusOf(scenario: AudioScenario, failures: AudioCheckFailure[]): ScenarioStatus {
  if (!scenario.expectedFail) return failures.length === 0 ? 'passed' : 'failed';
  if (failures.length === 0) return 'unexpected_pass';
  const pinned = [...new Set(scenario.pinned ?? [])].sort();
  return failedKeys(failures).join(',') === pinned.join(',') ? 'expected_fail' : 'failed';
}

function shell(scenario: AudioScenario): Scenario {
  return {
    id: scenario.id,
    template: 'barbershop',
    tools: [],
    tags: scenario.tags,
    seed: 'audio',
    caller: [],
    expect: {},
    expectedFail: scenario.expectedFail,
  };
}

function diffFor(scenario: AudioScenario, status: ScenarioStatus, failures: AudioCheckFailure[]): string {
  const base = formatDiff(scenario.id, failures.map(toCheckFailure));
  if (status === 'unexpected_pass') return `UNEXPECTED PASS ${scenario.id} [${scenario.expectedFail}]: drop expectedFail/pinned and tag it core`;
  if (status === 'failed' && scenario.expectedFail) {
    return `${base}\n  pinned mismatch: expected exactly [${(scenario.pinned ?? []).join(', ')}], got [${failedKeys(failures).join(', ')}]`;
  }
  return base;
}

export interface AudioGateOptions {
  k?: number;
  only?: string[];
}

export async function runAudioGate(rt: RuntimeModules, scenarios: AudioScenario[], opts: AudioGateOptions = {}): Promise<AudioGateReport> {
  const clock = new VirtualClock();
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const observations: Record<string, AudioObservation[]> = {};
  const statuses = new Map<string, RunStatus[]>();
  const startedAt = new Date().toISOString();
  clock.install();
  let report: PassKReport;
  try {
    report = await runPassK(scenarios.map(shell), {
      k: opts.k,
      only: opts.only,
      runOnce: async (shellScenario, run): Promise<ScenarioRunResult> => {
        const scenario = byId.get(shellScenario.id) as AudioScenario;
        const world = await runAudioCall(rt, clock, scenario, run);
        const failures = grade(scenario, world);
        const status = statusOf(scenario, failures);
        const diff = diffFor(scenario, status, failures);
        (observations[scenario.id] ??= []).push(observe(world));
        const list = statuses.get(scenario.id) ?? [];
        list.push({ run, status, keys: failedKeys(failures), diff });
        statuses.set(scenario.id, list);
        return {
          id: scenario.id,
          status,
          expectedFail: scenario.expectedFail,
          failures: failures.map(toCheckFailure),
          diff,
          trace: [],
          snapshot: { bookings: [], tickets: [], transfers: [], waitlist: [] },
        };
      },
    });
  } finally {
    clock.uninstall();
  }
  const knownRed: KnownRed[] = report.flows
    .filter((flow) => byId.get(flow.id)?.expectedFail)
    .map((flow) => {
      const scenario = byId.get(flow.id) as AudioScenario;
      const runs = statuses.get(flow.id) ?? [];
      const pinnedRuns = runs.filter((r) => r.status === 'expected_fail').length;
      return {
        id: flow.id,
        plan: scenario.plan,
        flow: flow.flow,
        expectedFail: scenario.expectedFail as string,
        pinned: scenario.pinned ?? [],
        k: flow.k,
        pinnedRuns,
        ok: pinnedRuns === flow.k,
        example: runs.find((r) => r.status === 'expected_fail')?.diff ?? '',
        deviations: runs.filter((r) => r.status !== 'expected_fail'),
      };
    });
  const gated: PassKReport = { ...report, flows: report.flows.filter((flow) => !byId.get(flow.id)?.expectedFail) };
  return {
    ok: report.ok && knownRed.every((red) => red.ok),
    k: report.k,
    startedAt,
    finishedAt: new Date().toISOString(),
    passK: gated,
    knownRed,
    runs: Object.fromEntries(statuses),
    observations,
  };
}

export function formatAudioGate(report: AudioGateReport, scenarios: AudioScenario[]): string {
  const plan = new Map(scenarios.map((s) => [s.id, s.plan]));
  const lines = [
    `quality:audio pass^${report.k} ok=${report.ok} (offline synthetic caller audio → real routes/stream.ts + openaiSession + XaiRealtimeTransport → fake xAI)`,
    formatPassKSummary(report.passK).replace(/^quality:sim /, 'core gate: '),
  ];
  for (const flow of report.passK.flows) lines.push(`  ${flow.id} = plan ${plan.get(flow.id)}`);
  if (report.knownRed.length > 0) {
    lines.push('known red on this runtime (expectedFail, failing exactly the pinned checks):');
    for (const red of report.knownRed) {
      const mark = red.ok ? 'red ' : 'FAIL';
      lines.push(`  ${mark} ${red.pinnedRuns}/${red.k} pinned  ${red.flow}  ${red.id} = plan ${red.plan}  [${red.expectedFail}]`);
      lines.push(`       pinned: ${red.pinned.join(', ')}`);
      if (red.example) lines.push(...red.example.split('\n').slice(1).map((line) => `     ${line}`));
    }
    for (const red of report.knownRed) {
      for (const deviation of red.deviations) {
        lines.push(`FAIL known-red ${red.id} run ${deviation.run} (${deviation.status}):`);
        lines.push(...deviation.diff.split('\n').map((line) => `    ${line}`));
      }
    }
  }
  return lines.join('\n');
}
