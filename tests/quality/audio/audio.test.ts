/**
 * RT-11: synthetic caller audio through the real voice transport path, pass^5.
 *
 * The harness runs in a child process the way production loads code
 * (`node --import tsx`, CJS; see spawn.ts and scripts/quality/audio/edges.ts):
 * fake Twilio side → routes/stream.ts → openaiSession → XaiRealtimeTransport
 * → fake xAI server, on a virtual clock. On today's runtime S03 passes 5/5;
 * S12 (barge-in) and S17 (audible, never transcribed) are known red, pinned
 * to the exact checks the missing guards fail. The mutation block proves each
 * check is live: breaking a guard turns S03 red, and emulating the missing
 * guards (in memory, in this test process) turns S12/S17 green.
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AudioGateReport } from '../../../scripts/quality/audio/gate';
import { loadAudioScenarioDir } from '../../../scripts/quality/audio/scenario';
import { CLI, MUTANTS, runHarness, type HarnessRun } from './spawn';

const SCENARIO_DIR = path.join(__dirname, 'scenarios');
const RED_FIXTURE_DIR = path.join(__dirname, 'fixtures/red');
const S03 = 's03-dialler-never-heard';
const S12 = 's12-barge-in';
const S17 = 's17-audible-never-transcribed';
const TIMEOUT_MS = 60_000;

const scenarios = loadAudioScenarioDir(SCENARIO_DIR);

function statuses(report: AudioGateReport, id: string): string[] {
  return (report.runs[id] ?? []).map((run) => `${run.status}:${run.keys.join('+')}`);
}

const five = (value: string) => Array.from({ length: 5 }, () => value);

describe('audio pack: shape', () => {
  it('covers plan S03, S12, S17; ids match files; core iff not known red', () => {
    expect(scenarios.map((s) => s.plan).sort()).toEqual(['S03', 'S12', 'S17']);
    for (const s of scenarios) {
      expect(s.tags).toEqual(expect.arrayContaining(['audio', 'template:barbershop']));
      expect(s.tags.some((tag) => tag.startsWith('flow:'))).toBe(true);
      expect(s.tags.includes('core')).toBe(!s.expectedFail);
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

  it('exits 0: S03 5/5, S12 and S17 red 5/5 on exactly their pinned checks', () => {
    expect(run.code, run.stdout).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.k).toBe(5);
    expect(report.passK.coreBelowK).toEqual([]);
    expect(report.passK.flows.map((f) => `${f.id} ${f.passes}/${f.k}`)).toEqual([`${S03} 5/5`]);
    expect(report.knownRed.map((red) => `${red.id} ${red.pinnedRuns}/${red.k}`)).toEqual([`${S12} 5/5`, `${S17} 5/5`]);
    expect(run.stdout).toContain('ok   core 5/5  never-heard  s03-dialler-never-heard');
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

  it('S12: the barge-in reached the provider VAD while the agent was playing; no clear, stale audio, a double answer', () => {
    const red = report.knownRed.find((r) => r.id === S12);
    expect(red?.pinned).toEqual(['barge_in.clear', 'barge_in.stale_audio', 'barge_in.answers', 'barge_in.late_tool_result']);
    expect(statuses(report, S12)).toEqual(five('expected_fail:barge_in.answers+barge_in.clear+barge_in.late_tool_result+barge_in.stale_audio'));
    for (const obs of report.observations[S12]) {
      expect(obs.utterances).toBe(2);
      expect(obs.clears).toEqual([]);
      expect(obs.responses.map((r) => r.kind)).toEqual(['greeting', 'reply', 'after_tool', 'reply']);
      expect(obs.bookingWrites).toBe(0);
    }
    expect(red?.example).toMatch(/interrupted turn \(response 2\) still audible after the barge-in \(ms\)\n\s+expected: "<= 0"\n\s+actual:\s+\d{4}/);
  });

  it('S17: audible but never transcribed is treated as never heard today: prompted at 8 s and cut', () => {
    expect(statuses(report, S17)).toEqual(
      five('expected_fail:call.not_cut+ended_by+ladder.heard_checks+ladder.never_heard_prompts+outcome+vad.utterances'),
    );
    for (const obs of report.observations[S17]) {
      expect(obs.outcome).toBe('never_heard');
      expect(obs.neverHeardPrompts).toHaveLength(3);
      expect(obs.heardChecks).toEqual([]);
      // Nothing invented: no tool call, no booking or ticket row, no floor ticket.
      expect(obs.toolCalls).toBe(0);
      expect(obs.ticketWrites + obs.bookingWrites).toBe(0);
      // The floor's "heard" is transcript-based too, so it skips; with no caller words there is nothing to file anyway.
      expect(obs.floor).toEqual(['never_heard']);
    }
  });

  it('is deterministic: the same failure signature in every run (timing jitter included)', () => {
    for (const id of [S03, S12, S17]) expect(new Set(statuses(report, id)).size).toBe(1);
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

describe('audio pack: mutation proof (in-memory overrides, no runtime edit)', () => {
  let reports: Map<string, { code: number; report: AudioGateReport }>;

  beforeAll(async () => {
    const names = [
      's03-ladder-skips-a-prompt',
      's03-silence-from-response-done',
      's12-reference-fix',
      's12-reference-fix-without-clear',
      's12-reference-fix-without-late-result-drop',
      's17-reference-fix',
      'all-reference-fixes',
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

  it('S12 passes 5/5 with a reference barge-in guard (clear + drop the interrupted turn and its late result): the gate flags the unexpected pass', () => {
    const { code, report } = get('s12-reference-fix');
    expect(code).toBe(1);
    expect(statuses(report, S12)).toEqual(five('unexpected_pass:'));
    expect(statuses(report, S03)).toEqual(five('passed:'));
    // The reference guard clears on every caller speech_started: one per caller turn.
    for (const obs of report.observations[S12]) expect(obs.clears).toHaveLength(2);
  });

  it('each S12 check is live on its own: no clear → clear + stale audio; no late-result drop → double answer', () => {
    expect(statuses(get('s12-reference-fix-without-clear').report, S12)).toEqual(five('failed:barge_in.clear+barge_in.stale_audio'));
    expect(statuses(get('s12-reference-fix-without-late-result-drop').report, S12)).toEqual(
      five('failed:barge_in.answers+barge_in.late_tool_result'),
    );
  });

  it('S17 passes 5/5 when VAD speech marks the caller heard (one check at 15 s per pause, never cut); S03 still passes', () => {
    const { code, report } = get('s17-reference-fix');
    expect(code).toBe(1);
    expect(statuses(report, S17)).toEqual(five('unexpected_pass:'));
    expect(statuses(report, S03)).toEqual(five('passed:'));
    for (const obs of report.observations[S17]) {
      expect(obs.outcome).toBe('caller_hangup');
      expect(obs.heardChecks).toHaveLength(2);
      expect(obs.neverHeardPrompts).toEqual([]);
    }
  });

  it('with every reference guard in place, all three audio flows pass 5/5', () => {
    const { report } = get('all-reference-fixes');
    expect(statuses(report, S03)).toEqual(five('passed:'));
    expect(statuses(report, S12)).toEqual(five('unexpected_pass:'));
    expect(statuses(report, S17)).toEqual(five('unexpected_pass:'));
  });
});
