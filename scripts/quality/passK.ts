/**
 * pass^k: run each scenario k times from a fresh seed and count the runs that
 * pass. A flow is locked in only at k/k. The gate fails when any scenario
 * tagged `core` passes fewer than k of k runs (or when the selection has no
 * core scenario at all, so an empty or mistyped --dir can't go green).
 *
 * Scripted mode is deterministic, so k/k there proves the graders and the
 * fake are stable; the same loop runs an LLM agent (QUALITY_SIM_LLM=1), where
 * k/k is the real reliability bar.
 */
import { runScenario, selectScenarios, type RunOptions } from './runner';
import type { CheckFailure, Scenario, ScenarioRunResult, ScenarioStatus } from './types';

export const DEFAULT_PASS_K = 5;
export const CORE_TAG = 'core';
const FLOW_TAG = 'flow:';

export type PassKRun = {
  run: number;
  status: ScenarioStatus;
  failures: CheckFailure[];
  diff: string;
};

export type FlowResult = {
  id: string;
  flow: string;
  core: boolean;
  k: number;
  passes: number;
  ok: boolean;
  runs: PassKRun[];
};

export type PassKReport = {
  ok: boolean;
  k: number;
  mode: 'scripted' | 'llm';
  startedAt: string;
  finishedAt: string;
  coreFlows: number;
  /** Core flows below k/k, as `flow (id): passes/k`. */
  coreBelowK: string[];
  flows: FlowResult[];
};

export type PassKOptions = Omit<RunOptions, 'agent'> & {
  k?: number;
  /** One run of one scenario; defaults to runScenario with a fresh agent and seed. Tests inject faults here. */
  runOnce?: (scenario: Scenario, run: number) => Promise<ScenarioRunResult>;
};

export function flowOf(scenario: Scenario): string {
  return scenario.tags.find((tag) => tag.startsWith(FLOW_TAG))?.slice(FLOW_TAG.length) ?? scenario.id;
}

export function isCore(scenario: Scenario): boolean {
  return scenario.tags.includes(CORE_TAG);
}

async function safeRun(
  runOnce: (scenario: Scenario, run: number) => Promise<ScenarioRunResult>,
  scenario: Scenario,
  run: number,
): Promise<PassKRun> {
  try {
    const result = await runOnce(scenario, run);
    return { run, status: result.status, failures: result.failures, diff: result.diff };
  } catch (err: unknown) {
    // An agent or harness error is a failed run, never a crash of the gate.
    const message = err instanceof Error ? err.message : String(err);
    return { run, status: 'failed', failures: [], diff: `ERROR ${scenario.id}: ${message}` };
  }
}

export async function runPassK(scenarios: Scenario[], opts: PassKOptions = {}): Promise<PassKReport> {
  const k = opts.k ?? DEFAULT_PASS_K;
  if (!Number.isInteger(k) || k < 1) throw new Error(`pass^k needs a whole k >= 1, got ${k}`);
  const { runOnce: injected, k: _k, ...runOpts } = opts;
  const runOnce = injected ?? ((scenario: Scenario) => runScenario(scenario, runOpts));
  const startedAt = new Date().toISOString();
  const flows: FlowResult[] = [];
  for (const scenario of selectScenarios(scenarios, opts.only)) {
    const runs: PassKRun[] = [];
    for (let run = 1; run <= k; run += 1) runs.push(await safeRun(runOnce, scenario, run));
    const passes = runs.filter((run) => run.status === 'passed').length;
    flows.push({ id: scenario.id, flow: flowOf(scenario), core: isCore(scenario), k, passes, ok: passes === k, runs });
  }
  const core = flows.filter((flow) => flow.core);
  const coreBelowK = core.filter((flow) => !flow.ok).map((flow) => `${flow.flow} (${flow.id}): ${flow.passes}/${k}`);
  return {
    ok: core.length > 0 && coreBelowK.length === 0,
    k,
    mode: opts.mode ?? 'scripted',
    startedAt,
    finishedAt: new Date().toISOString(),
    coreFlows: core.length,
    coreBelowK,
    flows,
  };
}

/** Failed runs grouped by identical diff, so a deterministic failure prints once. */
function failedRunGroups(flow: FlowResult): Array<{ runs: number[]; diff: string }> {
  const groups = new Map<string, number[]>();
  for (const run of flow.runs) {
    if (run.status === 'passed') continue;
    const diff = run.diff || `${run.status} (no diff)`;
    groups.set(diff, [...(groups.get(diff) ?? []), run.run]);
  }
  return [...groups].map(([diff, runs]) => ({ runs, diff }));
}

export function formatPassKSummary(report: PassKReport): string {
  const width = Math.max(4, ...report.flows.map((flow) => flow.flow.length));
  const lines = [
    `quality:sim pass^${report.k} mode=${report.mode} ok=${report.ok} ` +
      `(${report.coreFlows} core flows, ${report.coreBelowK.length} below ${report.k}/${report.k})`,
  ];
  if (report.coreFlows === 0) lines.push('FAIL no scenario tagged `core` was selected; the gate needs at least one');
  for (const flow of report.flows) {
    const mark = flow.ok ? 'ok  ' : flow.core ? 'FAIL' : 'warn';
    lines.push(`  ${mark} ${flow.core ? 'core' : '    '} ${flow.passes}/${flow.k}  ${flow.flow.padEnd(width)}  ${flow.id}`);
  }
  for (const flow of report.flows) {
    if (flow.ok) continue;
    const label = flow.core ? 'FAIL core flow' : 'non-core flow';
    lines.push(`${label} ${flow.flow} (${flow.id}): passed ${flow.passes}/${flow.k} runs, needs ${flow.k}/${flow.k}`);
    for (const group of failedRunGroups(flow)) {
      lines.push(`  run${group.runs.length > 1 ? 's' : ''} ${group.runs.join(', ')}:`);
      lines.push(...group.diff.split('\n').map((line) => `    ${line}`));
    }
  }
  return lines.join('\n');
}

/** The JSON written by --out: per-flow counts and each failed run's failures, no traces. */
export function publicPassKReport(report: PassKReport): PassKReport {
  return {
    ...report,
    flows: report.flows.map((flow) => ({ ...flow, runs: flow.runs.filter((run) => run.status !== 'passed') })),
  };
}
