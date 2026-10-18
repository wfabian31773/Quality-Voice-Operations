/**
 * RT-11: synthetic caller audio through the real voice transport path, pass^5.
 *
 * The harness runs in a child process the way production loads code
 * (`node --import tsx`, CJS; see spawn.ts and scripts/quality/audio/edges.ts):
 * fake Twilio side → routes/stream.ts → openaiSession → XaiRealtimeTransport
 * → fake xAI server, on a virtual clock. Every scenario is core and passes
 * 5/5: S03 (dialler), S12 (barge-in: after the agent's turn has streamed, and
 * mid-stream; a backchannel during a slow tool), S17 (audible, never
 * transcribed) and S18 (the runtime hold line: a slow tool gets one, a fast
 * tool none). The mutation block proves
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
const S12_BACKCHANNEL = 's12-backchannel-during-tool';
const S17 = 's17-audible-never-transcribed';
const S18_SLOW = 's18-slow-tool-hold-line';
const S18_FAST = 's18-fast-tool-no-hold-line';
const ALL = [S03, S12, S12_MID, S12_BACKCHANNEL, S17, S18_FAST, S18_SLOW];
const TIMING_FIXTURE_DIR = path.join(__dirname, 'fixtures/timing');
const TIMEOUT_MS = 60_000;

const scenarios = loadAudioScenarioDir(SCENARIO_DIR);

function statuses(report: AudioGateReport, id: string): string[] {
  return (report.runs[id] ?? []).map((run) => `${run.status}:${run.keys.join('+')}`);
}

const five = (value: string) => Array.from({ length: 5 }, () => value);

describe('audio pack: shape', () => {
  it('covers plan S03, S12 (two barge-in interleavings, a backchannel), S17, S18 (hold line: slow, fast); ids match files; all core, none known red', () => {
    expect(scenarios.map((s) => s.plan).sort()).toEqual(['S03', 'S12', 'S12', 'S12', 'S17', 'S18', 'S18']);
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

  it('exits 0: S03, the three S12 flows, S17 and the two S18 flows are core 5/5; nothing is known red', () => {
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

  it('S12 backchannel: the result lands while the reply to "thanks" is in flight, then is voiced exactly once, after it', () => {
    for (const obs of report.observations[S12_BACKCHANNEL]) {
      expect(obs.utterances).toBe(2);
      expect(obs.clears).toEqual([]);
      expect(obs.responses.map((r) => `${r.kind}:${r.status}`)).toEqual(['greeting:completed', 'reply:completed', 'reply:completed', 'after_tool:completed']);
      const [, , thanksReply, voiced] = obs.responses;
      // The reply to "thanks" was created before the output item existed, so it couldn't carry it.
      expect(obs.functionOutputs).toHaveLength(1);
      expect(obs.functionOutputs[0].at).toBeGreaterThan(thanksReply.createdAt);
      // The output was withheld while that reply was in flight: no response.create right after it...
      expect(voiced.createdAt).toBeGreaterThan(obs.functionOutputs[0].at);
      expect(obs.functionOutputs[0].followedBy).toBe(voiced.no);
      // ...and exactly one, with no "active response" error from the provider.
      expect(obs.clientEvents.filter((e) => e.endsWith(' response.create'))).toHaveLength(2); // greeting + the voiced result
      expect(obs.providerErrors).toEqual([]);
      expect(obs.heardChecks).toEqual([]);
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

  it('S18 slow tool: one hold line ~0.8 s after the call, before the result, heard in full; the answer follows it, no overlap', () => {
    for (const obs of report.observations[S18_SLOW]) {
      expect(obs.responses.map((r) => `${r.kind}:${r.status}`)).toEqual(['greeting:completed', 'reply:completed', 'hold_line:completed', 'after_tool:completed']);
      expect(obs.responses[2].text).toBe('One moment while I check that.');
      const [timing] = obs.toolTimings;
      expect(obs.toolTimings).toHaveLength(1);
      const requested = (timing.holdLineAt as number) - timing.callAt;
      expect(requested).toBeGreaterThanOrEqual(800);
      expect(requested).toBeLessThanOrEqual(900);
      expect(timing.holdLineAt as number).toBeLessThan(timing.resultAt as number);
      // The caller hears it ~0.3 s later (the provider's first-audio latency), and the answer only after it.
      expect(timing.firstAudioAt).toBe(timing.holdLineHeardAt);
      expect(timing.answerAudioAt as number).toBeGreaterThan(timing.holdLineHeardAt as number);
      expect(obs.providerErrors).toEqual([]);
      expect(obs.clears).toEqual([]);
    }
  });

  it('S18 fast tool: no hold line at all; the answer is the first thing heard after the call', () => {
    for (const obs of report.observations[S18_FAST]) {
      expect(obs.responses.map((r) => r.kind)).toEqual(['greeting', 'reply', 'after_tool']);
      const [timing] = obs.toolTimings;
      expect(timing.holdLineAt).toBeUndefined();
      expect((timing.resultAt as number) - timing.callAt).toBeLessThan(800);
      expect(timing.firstAudioAt).toBe(timing.answerAudioAt);
      expect(obs.providerErrors).toEqual([]);
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

  it('control: the same stress on the old harness (runtime import() left to the loader) still bites, now in the queued bookkeeping', () => {
    const report = oldHarness.report as AudioGateReport;
    const timedOut = (obs: AudioGateReport['observations'][string][number]) => obs.runtimeErrors.some((line) => line.includes('Bookkeeping write timed out'));
    // Before RT-HOLD-LINE part 2 the tool path awaited the meter's import(), so the 1 s loader delay pushed
    // S12's tool result past the hangup. The meter is now a queued write: the tool result no longer waits on
    // it (S12 stays green), but its import still waits on real time while the virtual clock runs past the
    // write's bound, so every tool call's meter write times out. The synced harness never does.
    for (const id of [S12, S12_BACKCHANNEL, S18_SLOW, S18_FAST]) {
      for (const obs of report.observations[id]) expect(timedOut(obs), id).toBe(true);
      for (const obs of (idle.report as AudioGateReport).observations[id]) expect(timedOut(obs), id).toBe(false);
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
      's12-no-deferred-voicing',
      's17-no-vad-heard',
      's18-no-hold-line-trigger',
      's18-hold-line-deaf-to-result',
      'transport-no-in-flight-guard',
    ];
    const run = await runHarness(MUTANTS, [`--mutants=${names.join(',')}`]);
    reports = new Map(run.reports.map((r) => [r.mutant, { code: r.code, report: r.report }]));
    if (reports.size !== names.length) throw new Error(`mutants missing\n${run.stdout}\n${run.stderr}`);
  }, TIMEOUT_MS * 2);

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
    // S12 backchannel stays green since RT-HOLD-LINE §4: the result's create now waits
    // behind the in-flight reply to "thanks" (one create path) instead of colliding with it.
    onlyRed(report, { [S12]: 'failed:barge_in.answers+barge_in.late_tool_result' });
    for (const obs of report.observations[S12]) {
      expect(obs.responses.map((r) => r.kind)).toEqual(['greeting', 'reply', 'after_tool', 'reply']);
    }
    for (const obs of report.observations[S12_BACKCHANNEL]) expect(obs.providerErrors).toEqual([]);
  });

  it('a withheld result never voiced on its own → S12 backchannel 0/5: the confirmation is never spoken; S12 unchanged', () => {
    const { code, report } = get('s12-no-deferred-voicing');
    expect(code).toBe(1);
    onlyRed(report, { [S12_BACKCHANNEL]: 'failed:tool_result.voiced' });
    for (const obs of report.observations[S12_BACKCHANNEL]) {
      expect(obs.responses.map((r) => r.kind)).toEqual(['greeting', 'reply', 'reply']);
      expect(obs.functionOutputs).toHaveLength(1);
      expect(obs.functionOutputs[0].followedBy).toBeUndefined();
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

  it('no hold-line trigger → S18 slow 0/5: the caller sits through the lookup in silence; S18 fast unchanged', () => {
    const { code, report } = get('s18-no-hold-line-trigger');
    expect(code).toBe(1);
    onlyRed(report, { [S18_SLOW]: 'failed:hold_line.count' });
    for (const obs of report.observations[S18_SLOW]) {
      expect(obs.responses.map((r) => r.kind)).toEqual(['greeting', 'reply', 'after_tool']);
    }
  });

  it('the hold line deaf to the result → S18 fast 0/5: a hold line after the answer; S18 slow unchanged', () => {
    const { code, report } = get('s18-hold-line-deaf-to-result');
    expect(code).toBe(1);
    onlyRed(report, {
      [S18_FAST]: 'failed:hold_line.after_result+hold_line.count',
      // Deaf to agent audio, it also talks while her "let me check" is still playing.
      [S12_BACKCHANNEL]: 'failed:tool_result.voiced',
    });
    for (const obs of report.observations[S18_FAST]) {
      expect(obs.responses.map((r) => r.kind)).toEqual(['greeting', 'reply', 'after_tool', 'hold_line']);
    }
  });

  it('no one-response-at-a-time guard in the transport → a create on top of a response in flight, rejected by the provider', () => {
    const { code, report } = get('transport-no-in-flight-guard');
    expect(code).toBe(1);
    onlyRed(report, { [S12_BACKCHANNEL]: 'failed:tool_result.voiced' });
    for (const obs of report.observations[S12_BACKCHANNEL]) {
      // Rejected, re-sent once, rejected again: never a loop.
      expect(obs.providerErrors).toEqual([expect.stringContaining('response.create while'), expect.stringContaining('response.create while')]);
    }
  });
});

describe('audio pack: per-tool timing with 250 ms per DB statement (RT-HOLD-LINE report)', () => {
  type Observation = AudioGateReport['observations'][string][number];
  type Timing = Observation['toolTimings'][number];
  const BOOKKEEPING = 's18-timing-db-250ms';
  const CATALOG = 's18-catalog-cache-db-250ms';
  /**
   * Each path's observation per fixture: this PR; the PR with only the queue
   * taken off (bookkeeping-inline, the mutation proof); 31996d53 (part 1:
   * hold line, bookkeeping inline, no read cache); a3d2a94c (inline, no
   * cache, no hold line).
   */
  let paths: Record<'after' | 'inline' | 'part1' | 'a3d2a94c', Record<string, Observation>>;

  /** The PR's timing assertion, as a function so the mutation proof can show it fails without the queue. */
  const resultSentMs = (t: Timing) => (t.resultAt as number) - t.callAt;
  const RESULT_SENT_BUDGET_MS = 1_000;

  beforeAll(async () => {
    const args = [`--dir=${TIMING_FIXTURE_DIR}`, '--pass-k=1'];
    const [after, mutants] = await Promise.all([
      runHarness(CLI, [...args, '--json']),
      runHarness(MUTANTS, ['--mutants=bookkeeping-inline,part1-path,a3d2a94c-path', ...args]),
    ]);
    const pick = (report: AudioGateReport | undefined) =>
      Object.fromEntries([BOOKKEEPING, CATALOG].map((id) => [id, report?.observations[id]?.[0] as Observation]));
    const mutant = (name: string) => mutants.reports.find((r) => r.mutant === name)?.report;
    paths = { after: pick(after.report), inline: pick(mutant('bookkeeping-inline')), part1: pick(mutant('part1-path')), a3d2a94c: pick(mutant('a3d2a94c-path')) };
    for (const [name, byId] of Object.entries(paths)) {
      for (const id of [BOOKKEEPING, CATALOG]) {
        if (!byId[id]?.toolTimings?.length) {
          throw new Error(`no timing for ${name} ${id} (exit ${after.code} / ${mutants.code})\n${after.stdout.slice(-3000)}\n${after.stderr.slice(-3000)}\n${mutants.stdout.slice(-3000)}\n${mutants.stderr.slice(-3000)}`);
        }
      }
    }
    const row = (label: string, t: Timing) => ({
      label,
      tool: t.tool,
      'call→result sent': resultSentMs(t),
      'call→hold line asked': t.holdLineAt === undefined ? null : t.holdLineAt - t.callAt,
      'call→first agent audio heard': (t.firstAudioAt as number) - t.callAt,
      'call→answer audio heard': (t.answerAudioAt as number) - t.callAt,
    });
    const LABELS = { a3d2a94c: 'a3d2a94c (inline, no hold line)', part1: '31996d53 (part 1: hold line, inline)', after: 'after (part 2: queued)' } as const;
    const rows = (id: string) => (['a3d2a94c', 'part1', 'after'] as const).flatMap((p) =>
      paths[p][id].toolTimings.map((t, i) => row(`${LABELS[p]}${paths[p][id].toolTimings.length > 1 ? ` call ${i + 1}` : ''}`, t)));
    console.info(`RT-HOLD-LINE harness timings (ms), db.slow 250 ms/statement:\n${JSON.stringify({
      [BOOKKEEPING]: rows(BOOKKEEPING),
      [CATALOG]: rows(CATALOG),
      catalogReadsReachingTheDb: Object.fromEntries((['a3d2a94c', 'part1', 'after'] as const).map((p) => [p, paths[p][CATALOG].catalogReads])),
    }, null, 2)}`);
  }, TIMEOUT_MS * 2);

  it(`tool call → result sent is under ${RESULT_SENT_BUDGET_MS} ms (from 3000): the bookkeeping writes no longer sit on the critical path`, () => {
    const [after] = paths.after[BOOKKEEPING].toolTimings;
    expect(resultSentMs(after)).toBeLessThan(RESULT_SENT_BUDGET_MS);
    // The answer follows straight away: no hold line was needed.
    expect(after.holdLineAt).toBeUndefined();
    expect(after.firstAudioAt).toBe(after.answerAudioAt);
    expect((after.answerAudioAt as number) - after.callAt).toBeLessThan(RESULT_SENT_BUDGET_MS);
  });

  it('mutation proof: with the writes awaited inline again (bookkeeping-inline) the same assertion fails: 3000 ms, as on 31996d53 and a3d2a94c', () => {
    // 12 statements at 250 ms: the row insert, its completion and the meter (the harness fakes the state/event writes).
    for (const path of ['inline', 'part1', 'a3d2a94c'] as const) {
      const [timing] = paths[path][BOOKKEEPING].toolTimings;
      expect(resultSentMs(timing), path).toBe(3_000);
      expect(resultSentMs(timing) < RESULT_SENT_BUDGET_MS, path).toBe(false);
    }
    // Part 1's hold line covered the wait; a3d2a94c's caller sat through it.
    expect(paths.part1[BOOKKEEPING].toolTimings[0].holdLineAt).toBeDefined();
    expect(paths.a3d2a94c[BOOKKEEPING].toolTimings[0].holdLineAt).toBeUndefined();
  });

  it('the same rows are still written, after the result went back and before teardown wrote the final call state', () => {
    for (const path of ['after', 'part1'] as const) {
      const obs = paths[path][BOOKKEEPING];
      expect(obs.toolRows, path).toBe(1);
      expect(obs.toolRowsCompletedAt, path).toHaveLength(1);
      expect(obs.toolRowsCompletedAt[0], path).toBeLessThan(obs.finalizedAt as number);
    }
    const after = paths.after[BOOKKEEPING];
    expect(after.toolRowsCompletedAt[0]).toBeGreaterThan(after.toolTimings[0].resultAt as number);
  });

  it('a repeated catalog read: one DB read, two tool rows; the repeat comes back at once', () => {
    const obs = paths.after[CATALOG];
    expect(obs.toolTimings.map((t) => t.tool)).toEqual(['scheduling_list_services', 'scheduling_list_services']);
    expect(obs.catalogReads).toBe(1);
    expect(obs.toolRows).toBe(2);
    expect(obs.toolRowsCompletedAt).toHaveLength(2);
    const [first, repeat] = obs.toolTimings;
    // The first read is the action's own queries (slow at 250 ms each); the repeat is the call cache.
    expect(resultSentMs(repeat)).toBeLessThan(RESULT_SENT_BUDGET_MS);
    expect(resultSentMs(repeat)).toBeLessThan(resultSentMs(first));
    // Without the cache (31996d53, a3d2a94c) both reads reached the database.
    expect(paths.part1[CATALOG].catalogReads).toBe(2);
    expect(paths.a3d2a94c[CATALOG].catalogReads).toBe(2);
    expect(paths.part1[CATALOG].toolRows).toBe(2);
  });
});
