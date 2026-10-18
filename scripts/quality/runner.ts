import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeToolProvider, FILE_FLOOR, localDate, resetFakeTokens } from './fakeToolProvider';
import { checkInvariants } from './invariants';
import { loadScenarioYaml } from './loadScenario';
import { evaluateExpect, formatDiff } from './matcher';
import { createTenantStore, type TenantStore } from './seed';
import { ScriptedAgent, type SimAgent } from './scriptedAgent';
import { createLlmAgent } from './llmAgent';
import { createScenarioReasoning, GuardedToolProvider, observeCallerTurn } from './reasoningHarness';
import type {
  ReasoningObservation,
  RunReport,
  Scenario,
  ScenarioRunResult,
  ScenarioStatus,
  ToolCallContext,
  TraceEvent,
} from './types';

export type RunMode = 'scripted' | 'llm';

export type RunOptions = {
  mode?: RunMode;
  now?: Date;
  store?: TenantStore;
  agent?: SimAgent;
  only?: string[];
  /** Force the reasoning mode of scenarios that set `reasoning` (e.g. replay a shadow scenario in enforce). */
  reasoningMode?: ReasoningObservation['mode'];
};

/** Top-level tool-argument keys the runtime takes the caller's name from (callInvariants.ts NAME_ARG_KEYS). */
const NAME_ARG_KEYS = ['callerName', 'customerName', 'customer_name', 'contactName', 'contact_name'];

/**
 * The live teardown (server/voice-gateway/services/callInvariants.ts): skip
 * when a write, commit or transfer returned ok on the call; otherwise run
 * tickets.file_floor once, as the system actor, with the caller's lines.
 */
async function runFloor(fake: FakeToolProvider, trace: TraceEvent[], ctx: ToolCallContext): Promise<void> {
  const tools = trace.filter((event): event is Extract<TraceEvent, { type: 'tool' }> => event.type === 'tool');
  if (tools.some((event) => event.result.ok && event.name.endsWith('.commit'))) return;
  let callerName: string | undefined;
  for (const event of tools) {
    for (const key of NAME_ARG_KEYS) {
      const value = event.input[key];
      if (typeof value === 'string' && value.trim()) callerName = value.trim();
    }
  }
  const input = {
    callId: ctx.callId,
    callerLines: trace.flatMap((event) => (event.type === 'caller' && event.turn.text ? [event.turn.text] : [])),
    ...(callerName ? { callerName } : {}),
  };
  const result = await fake.invoke(FILE_FLOOR, input, { ...ctx, actor: { type: 'system', id: 'voice-runtime' } });
  trace.push({ type: 'tool', name: FILE_FLOOR, input, result });
}

function classify(scenario: Scenario, failures: ReturnType<typeof evaluateExpect>): ScenarioStatus {
  const passed = failures.length === 0;
  if (scenario.expectedFail) return passed ? 'unexpected_pass' : 'expected_fail';
  return passed ? 'passed' : 'failed';
}

export async function runScenario(scenario: Scenario, opts: RunOptions = {}): Promise<ScenarioRunResult> {
  resetFakeTokens();
  const store = opts.store ?? (await createTenantStore({ seed: scenario.seed }));
  await store.seed(scenario.seed);
  // The trusted caller ID is call state (call_sessions), not agent input.
  if (scenario.callerId !== undefined) store.state.callerNumber = scenario.callerId;
  const now = opts.now ?? (scenario.now ? new Date(scenario.now) : new Date('2026-10-20T14:00:00-04:00'));
  const callId = `call-${scenario.id}`;
  const fake = new FakeToolProvider(store.state, scenario.tools);
  const reasoning = scenario.reasoning
    ? createScenarioReasoning(scenario.reasoning, {
      callId,
      tenantId: store.state.tenantId,
      callerNumber: store.state.callerNumber,
      toolNames: fake.listTools().map((tool) => tool.name),
      modeOverride: opts.reasoningMode,
    })
    : undefined;
  const tools = new GuardedToolProvider(fake, { reasoning, faults: scenario.toolFaults });
  const agent =
    opts.agent ??
    (opts.mode === 'llm'
      ? createLlmAgent()
      : new ScriptedAgent(scenario, store.state.callerNumber ? { callerId: store.state.callerNumber } : {}));
  const ctx: ToolCallContext = {
    tenantId: store.state.tenantId,
    actor: { type: 'agent', id: 'quality-sim', role: 'agent' },
    now,
    tenantTimezone: store.state.timezone,
    callId,
  };
  const trace: TraceEvent[] = [];
  try {
    for (let i = 0; i < scenario.caller.length; i += 1) {
      const turn = scenario.caller[i];
      trace.push({ type: 'caller', turn });
      if (reasoning) observeCallerTurn(reasoning, turn);
      const output = await agent.handleTurn(i, tools, ctx);
      trace.push(...output.events);
    }
    if (scenario.floor) await runFloor(fake, trace, ctx);
    if (store.flush) await store.flush();
    const snapshot = store.snapshot();
    const timeZone = store.state.timezone;
    const failures = [
      ...evaluateExpect(
        scenario.expect,
        trace,
        snapshot,
        { date: localDate(now.toISOString(), timeZone), timeZone },
        { reasoning: reasoning?.observation, toolAttempts: tools.attempts, scenario },
      ),
      ...checkInvariants({ callId, trace, snapshot, state: store.state }),
    ];
    const status = classify(scenario, failures);
    return {
      id: scenario.id,
      status,
      expectedFail: scenario.expectedFail,
      failures,
      diff: formatDiff(scenario.id, failures),
      trace,
      snapshot,
      reasoning: reasoning?.observation,
      toolAttempts: { ...tools.attempts },
    };
  } finally {
    if (!opts.store) await store.close();
  }
}

export function loadScenarioDir(dir: string): Scenario[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort();
  return files.map((name) => {
    const full = path.join(dir, name);
    return loadScenarioYaml(readFileSync(full, 'utf8'), name);
  });
}

export function selectScenarios(scenarios: Scenario[], only?: string[]): Scenario[] {
  if (!only || only.length === 0) return scenarios;
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const missing = only.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`unknown scenario id(s): ${missing.join(', ')}`);
  }
  return only.map((id) => byId.get(id)!);
}

export async function runScenarios(scenarios: Scenario[], opts: RunOptions = {}): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const selected = selectScenarios(scenarios, opts.only);
  const results: ScenarioRunResult[] = [];
  for (const scenario of selected) {
    results.push(await runScenario(scenario, opts));
  }
  const passed = results.filter((result) => result.status === 'passed').map((result) => result.id);
  const failed = results.filter((result) => result.status === 'failed').map((result) => result.id);
  const expectedFailed = results
    .filter((result) => result.status === 'expected_fail')
    .map((result) => ({ id: result.id, expectedFail: result.expectedFail ?? '' }));
  const unexpectedPassed = results
    .filter((result) => result.status === 'unexpected_pass')
    .map((result) => ({ id: result.id, expectedFail: result.expectedFail ?? '' }));
  return {
    ok: failed.length === 0 && unexpectedPassed.length === 0,
    mode: opts.mode ?? 'scripted',
    startedAt,
    finishedAt: new Date().toISOString(),
    passed,
    failed,
    expectedFailed,
    unexpectedPassed,
    results,
  };
}
