/**
 * RT-11: synthetic caller audio through the real voice transport path, pass^5.
 *
 * The harness runs in a child process the way production loads code
 * (`node --import tsx`, CJS; see spawn.ts and scripts/quality/audio/edges.ts):
 * fake Twilio side → routes/stream.ts → openaiSession → XaiRealtimeTransport
 * → fake xAI server, on a virtual clock. Every scenario is core and passes
 * 5/5: S03 (dialler), S12 (barge-in: after the agent's turn has streamed, and
 * mid-stream) and S17 (audible, never transcribed). The mutation block proves
 * each runtime guard is what keeps its scenario green: removing it (in
 * memory, in the harness process) turns the scenario red.
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AudioGateReport } from '../../../scripts/quality/audio/gate';
import { loadAudioScenarioDir } from '../../../scripts/quality/audio/scenario';
import { CLI, MUTANTS, runHarness, STRESS, type HarnessRun } from './spawn';

const SCENARIO_DIR = path.join(__dirname, 'scenarios');
const RED_FIXTURE_DIR = path.join(__dirname, 'fixtures/red');
const S03 = 's03-dialler-never-heard';
const S12 = 's12-barge-in';
const S12_MID = 's12-barge-in-mid-stream';
const S17 = 's17-audible-never-transcribed';
const ALL = [S03, S12, S12_MID, S17];
const TIMEOUT_MS = 60_000;

const scenarios = loadAudioScenarioDir(SCENARIO_DIR);

function statuses(report: AudioGateReport, id: string): string[] {
  return (report.runs[id] ?? []).map((run) => `${run.status}:${run.keys.join('+')}`);
}

const five = (value: string) => Array.from({ length: 5 }, () => value);

describe('audio pack: shape', () => {
  it('covers plan S03, S12 (two interleavings), S17; ids match files; all core, none known red', () => {
    expect(scenarios.map((s) => s.plan).sort()).toEqual(['S03', 'S12', 'S12', 'S17']);
    expect(scenarios.map((s) => s.id).sort()).toEqual([...ALL].sort());
    for (const s of scenarios) {
      expect(s.tags).toEqual(expect.arrayContaining(['audio', 'core', 'template:barbershop']));
      expect(s.tags.some((tag) => tag.startsWith('flow:'))).toBe(true);
      expect(s.expectedFail).toBeUndefined();
      expect(s.pinned).toBeUndefined();
      // Graded on end state: every scenario pins the outcome/ended-by or the barge-in result, plus DB writes.
      expect(s.expect.bookings).toBe(0);
      expect(s.expect.outcome ?? s.expect.bargeIn).toBeDefined();
    }
  });
});

describe('audio pack: pass^5 on the real stream/session code', () => {
  let run: HarnessRun;
  let report: AudioGateReport;

  beforeAll(async () => {
    run = await runHarness(CLI, ['--pass-k=5', '--json']);
    if (!run.report) throw new Error(`no report\n${run.stdout}\n${run.stderr}`);
    report = run.report;
  }, TIMEOUT_MS);

  it('exits 0: S03, both S12 interleavings and S17 are core 5/5; nothing is known red', () => {
    expect(run.code, run.stdout).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.k).toBe(5);
    expect(report.passK.coreBelowK).toEqual([]);
    expect(report.passK.flows.map((f) => `${f.id} ${f.passes}/${f.k}`).sort()).toEqual(ALL.map((id) => `${id} 5/5`).sort());
    expect(report.knownRed).toEqual([]);
    for (const id of ALL) expect(statuses(report, id)).toEqual(five('passed:'));
    for (const id of ALL) expect(run.stdout).toMatch(new RegExp(`ok {3}core 5/5 {2}\\S+ +${id}\\n`));
    expect(run.stdout).not.toContain('known red');
  });

  it('S03: never heard → 3 prompts ~8 s after playback, a goodbye played in full, never_heard, no floor', () => {
    for (const obs of report.observations[S03]) {
      expect(obs.utterances).toBe(0);
      expect(obs.outcome).toBe('never_heard');
      expect(obs.endedBy).toBe('agent');
      expect(obs.neverHeardPrompts).toHaveLength(3);
      expect(obs.responses.map((r) => r.kind)).toEqual(['greeting', 'silence_prompt', 'silence_prompt', 'silence_prompt', 'never_heard_goodbye']);
      expect(obs.floor).toEqual(['never_heard']);
      expect(obs.ticketWrites + obs.bookingWrites).toBe(0);
      // Each turn got a mark and Twilio echoed it (the ladder counts from the echo).
      expect(obs.marksEchoed).toBe(obs.marksSent);
      expect(obs.marksSent).toBe(5);
    }
  });

  it('S12: one Twilio clear at the barge-in, the late tool result is handed over without a response, one answer', () => {
    for (const obs of report.observations[S12]) {
      expect(obs.utterances).toBe(2);
      // Only the barge-in clears; the first caller turn starts after the greeting has played.
      expect(obs.clears).toHaveLength(1);
      expect(obs.responses.map((r) => r.kind)).toEqual(['greeting', 'reply', 'reply']);
      // The slow lookup still ran and its output reached the model, after the caller started talking.
      expect(obs.functionOutputs).toHaveLength(1);
      expect(obs.functionOutputs[0].followedBy).toBeUndefined();
      expect(obs.functionOutputs[0].at).toBeGreaterThan(obs.clears[0]);
      expect(obs.clientEvents.filter((e) => e.endsWith(' conversation.item.create'))).toHaveLength(1);
      expect(obs.bookingWrites).toBe(0);
    }
  });

  it('S12 mid-stream: the interrupted answer is cancelled, its late deltas dropped, one clear, one answer', () => {
    for (const obs of report.observations[S12_MID]) {
      expect(obs.utterances).toBe(2);
      expect(obs.clears).toHaveLength(1);
      expect(obs.responses.map((r) => `${r.kind}:${r.status}`)).toEqual(['greeting:completed', 'reply:cancelled', 'reply:completed']);
      expect(obs.outcome).toBe('caller_hangup');
      expect(obs.toolCalls).toBe(0);
    }
  });

  it('S17: an audible caller with no transcript gets the heard ladder: 2 checks at 15 s, never cut, caller_hangup, floor files nothing', () => {
    for (const obs of report.observations[S17]) {
      expect(obs.utterances).toBe(3);
      expect(obs.outcome).toBe('caller_hangup');
      expect(obs.endedBy).toBe('caller');
      expect(obs.neverHeardPrompts).toEqual([]);
      expect(obs.heardChecks).toHaveLength(2);
      expect(obs.clears).toEqual([]);
      // Nothing invented: no tool call, no booking or ticket row.
      expect(obs.toolCalls).toBe(0);
      expect(obs.ticketWrites + obs.bookingWrites).toBe(0);
      // The floor is unchanged: its "heard" is transcript-based, and with no caller words there is nothing to file.
      expect(obs.floor).toEqual(['never_heard']);
    }
  });

  it('is deterministic: the same status in every run (timing jitter included)', () => {
    for (const id of ALL) expect(new Set(statuses(report, id)).size).toBe(1);
  });
});

describe('audio pack: the same result on a loaded box and in any env', () => {
  let idle: HarnessRun;
  let stressed: HarnessRun;
  let oldHarness: HarnessRun;
  let pollutedEnv: HarnessRun;

  beforeAll(async () => {
    // All four at once: the parallel children add real CPU load on top of the stress entry's own.
    [idle, stressed, oldHarness, pollutedEnv] = await Promise.all([
      runHarness(CLI, ['--pass-k=5', '--json']),
      runHarness(STRESS, []),
      runHarness(STRESS, ['--keep-dynamic-imports']),
      // A runner-like env: another TZ, CI and NODE_ENV set, and whatever this vitest process has.
      runHarness(CLI, ['--pass-k=5', '--json'], { ...process.env, TZ: 'Pacific/Kiritimati', CI: 'true', NODE_ENV: 'production' }),
    ]);
    for (const [name, run] of Object.entries({ idle, stressed, oldHarness, pollutedEnv })) {
      if (!run.report) throw new Error(`${name}: no report\n${run.stdout}\n${run.stderr}`);
    }
  }, TIMEOUT_MS);

  it('stressed (slow loader thread, starved event loop, real I/O in the DB edge): pass^5 unchanged, every observation identical to idle', () => {
    expect(stressed.code, stressed.stdout).toBe(0);
    const [a, b] = [idle.report as AudioGateReport, stressed.report as AudioGateReport];
    for (const id of ALL) expect(statuses(b, id)).toEqual(statuses(a, id));
    expect(b.observations).toEqual(a.observations);
  });

  it('control: the same stress on the old harness (runtime import() left to the loader) reproduces the flake: the slow tool result never lands during the call', () => {
    const report = oldHarness.report as AudioGateReport;
    expect(oldHarness.code).toBe(1);
    // The 1 s loader delay pushes the tool result past the hangup, so S12 no longer exercises the late-result rule.
    for (const run of report.runs[S12]) {
      expect(run.status).toBe('failed');
      expect(run.keys).toContain('barge_in.late_tool_result');
    }
    for (const obs of report.observations[S12]) {
      expect(obs.responses.map((r) => r.kind)).toEqual(['greeting', 'reply', 'reply']);
      expect(obs.functionOutputs).toEqual([]);
    }
    // The other scenarios make no tool call, so they never hit the import: same as idle.
    for (const id of [S03, S12_MID, S17]) expect(report.observations[id]).toEqual((idle.report as AudioGateReport).observations[id]);
  });

  it('a polluted env (TZ, CI, NODE_ENV, the test process env) gives the identical report: the harness clears its env first', () => {
    expect(pollutedEnv.code, pollutedEnv.stdout).toBe(0);
    expect((pollutedEnv.report as AudioGateReport).observations).toEqual((idle.report as AudioGateReport).observations);
  });
});

describe('audio pack: the CLI exits non-zero when a core flow fails', () => {
  it('a core flow graded with the wrong expectation is 0/5 and exits 1', async () => {
    const run = await runHarness(CLI, [`--dir=${RED_FIXTURE_DIR}`, '--pass-k=5', '--json']);
    expect(run.code).toBe(1);
    expect(run.report?.passK.coreBelowK).toEqual(['never-heard (s03-red-fixture): 0/5']);
    expect(run.stdout).toContain('FAIL core flow never-heard (s03-red-fixture): passed 0/5 runs, needs 5/5');
    expect(run.stdout).toContain('ladder.never_heard_prompts: never-heard prompts');
  }, TIMEOUT_MS);
});

describe('audio pack: mutation proof (each runtime guard removed in memory, no runtime edit)', () => {
  let reports: Map<string, { code: number; report: AudioGateReport }>;

  beforeAll(async () => {
    const names = [
      's03-ladder-skips-a-prompt',
      's03-silence-from-response-done',
      's12-no-clear',
      's12-no-stale-audio-drop',
      's12-no-late-result-rule',
      's17-no-vad-heard',
    ];
    const run = await runHarness(MUTANTS, [`--mutants=${names.join(',')}`]);
    reports = new Map(run.reports.map((r) => [r.mutant, { code: r.code, report: r.report }]));
    if (reports.size !== names.length) throw new Error(`mutants missing\n${run.stdout}\n${run.stderr}`);
  }, TIMEOUT_MS);

  const get = (name: string) => reports.get(name) as { code: number; report: AudioGateReport };

  it('S03 goes red 0/5 when the never-heard ladder skips a prompt', () => {
    const { code, report } = get('s03-ladder-skips-a-prompt');
    expect(code).toBe(1);
    expect(report.passK.coreBelowK).toEqual([`never-heard (${S03}): 0/5`]);
    expect(statuses(report, S03)).toEqual(five('failed:ladder.never_heard_prompts'));
  });

  it('S03 goes red 0/5 when silence is counted from response.done instead of the Twilio mark echo', () => {
    const { code, report } = get('s03-silence-from-response-done');
    expect(code).toBe(1);
    expect(statuses(report, S03)).toEqual(five('failed:ladder.prompt_spacing'));
  });

  /** Only the named scenarios fail; every other one still passes 5/5. */
  const onlyRed = (report: AudioGateReport, red: Record<string, string>) => {
    for (const id of ALL) expect(statuses(report, id), id).toEqual(five(red[id] ?? 'passed:'));
  };

  it('no Twilio clear on barge-in → both S12 interleavings 0/5: no clear, the interrupted turn stays audible', () => {
    const { code, report } = get('s12-no-clear');
    expect(code).toBe(1);
    onlyRed(report, {
      [S12]: 'failed:barge_in.clear+barge_in.stale_audio',
      [S12_MID]: 'failed:barge_in.clear+barge_in.stale_audio',
    });
    for (const obs of report.observations[S12]) expect(obs.clears).toEqual([]);
  });

  it('interrupted turn\'s late deltas not dropped → S12 mid-stream 0/5 on stale audio alone (the clear is still sent)', () => {
    const { code, report } = get('s12-no-stale-audio-drop');
    expect(code).toBe(1);
    onlyRed(report, { [S12_MID]: 'failed:barge_in.stale_audio' });
    for (const obs of report.observations[S12_MID]) expect(obs.clears).toHaveLength(1);
  });

  it('a tool result the caller spoke over starts its own response → S12 0/5: a stale answer before the real one', () => {
    const { code, report } = get('s12-no-late-result-rule');
    expect(code).toBe(1);
    onlyRed(report, { [S12]: 'failed:barge_in.answers+barge_in.late_tool_result' });
    for (const obs of report.observations[S12]) {
      expect(obs.responses.map((r) => r.kind)).toEqual(['greeting', 'reply', 'after_tool', 'reply']);
    }
  });

  it('"heard" from a transcript only → S17 0/5: never-heard prompts every 8 s and cut mid-pause; S03 unchanged', () => {
    const { code, report } = get('s17-no-vad-heard');
    expect(code).toBe(1);
    onlyRed(report, {
      [S17]: 'failed:call.not_cut+ended_by+ladder.heard_checks+ladder.never_heard_prompts+outcome+vad.utterances',
    });
    for (const obs of report.observations[S17]) {
      expect(obs.outcome).toBe('never_heard');
      expect(obs.neverHeardPrompts).toHaveLength(3);
    }
  });
});
