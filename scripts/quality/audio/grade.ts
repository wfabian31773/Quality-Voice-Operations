/**
 * Graders for an audio run, on end state: the recorded call outcome, the
 * floor and database writes, the watchdog's call events, what the gateway
 * sent Twilio (`clear`, `mark`, media) and what the caller actually heard
 * (the fake Twilio playback buffer). Each failure carries a stable key; an
 * expectedFail scenario pins the exact keys that must fail.
 */
import type { CheckFailure } from '../types';
import { HOLD_LINE_PHRASES } from '../../../server/voice-gateway/services/holdLine';
import type { ResponseRecord } from './fakeXai';
import { FRAME_MS } from './mulaw';
import type { AudioScenario, Range } from './scenario';
import type { CallWorld } from './world';

export interface AudioCheckFailure {
  key: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

/** End-state checks map to `endState`; transport/ladder checks to `invariant` (the RT-10 report shape). */
const END_STATE_KEYS = new Set(['outcome', 'ended_by', 'call.not_cut', 'floor', 'db.bookings', 'db.tickets', 'tools.calls']);

export function toCheckFailure(failure: AudioCheckFailure): CheckFailure {
  return {
    check: END_STATE_KEYS.has(failure.key) ? 'endState' : 'invariant',
    message: `${failure.key}: ${failure.message}`,
    expected: failure.expected,
    actual: failure.actual,
  };
}

/** What a run observed, in plain numbers (also printed in the CLI's --json report). */
export interface AudioObservation {
  utterances: number;
  outcome?: string;
  endedBy?: 'agent' | 'caller';
  endedAt?: number;
  neverHeardPrompts: number[];
  heardChecks: number[];
  goodbyeAt?: number;
  responses: Array<Pick<ResponseRecord, 'no' | 'kind' | 'trigger' | 'createdAt' | 'status'> & { text: string }>;
  clears: number[];
  marksSent: number;
  marksEchoed: number;
  floor: string[];
  ticketWrites: number;
  bookingWrites: number;
  toolCalls: number;
  functionOutputs: Array<{ callId: string; at: number; followedBy?: number }>;
  /** Client → provider events (no audio appends), for diagnosis. */
  clientEvents: string[];
  providerErrors: string[];
  /** Last runtime error log lines (synthetic call data only). */
  runtimeErrors: string[];
  /** Per tool call, on the call's timeline (ms): what the caller waited through. */
  toolTimings: ToolTimingObservation[];
  /** tool_invocations rows inserted, and when each was completed (the queued bookkeeping landing). */
  toolRows: number;
  toolRowsCompletedAt: number[];
  /** Catalog reads that reached the database (a call-stable read served from the call cache doesn't). */
  catalogReads: number;
  /** When teardown wrote the final call state (finalizeCallSession). */
  finalizedAt?: number;
}

export interface ToolTimingObservation {
  tool: string;
  /** The model's function call reached the runtime. */
  callAt: number;
  /** Its function_call_output reached the provider. */
  resultAt?: number;
  /** A hold line covering this call was asked for / first heard. */
  holdLineAt?: number;
  holdLineHeardAt?: number;
  /** First agent audio the caller heard after the call (any response). */
  firstAudioAt?: number;
  /** First audio of the response that voiced the result. */
  answerAudioAt?: number;
}

/** First audible (not cleared) frame of a response. */
function firstHeard(world: CallWorld, response: number): number | undefined {
  return world.twilio.frames.find((f) => f.response === response && !f.cleared)?.start;
}

function toolTimings(world: CallWorld): ToolTimingObservation[] {
  const responses = world.xai.responses;
  return responses.filter((r) => r.tool && r.toolCallAt !== undefined).map((asked, index, calls) => {
    const callAt = asked.toolCallAt as number;
    const nextCallAt = calls[index + 1]?.toolCallAt ?? Infinity;
    const output = world.xai.functionOutputs.find((o) => o.callId === asked.tool?.callId);
    const holdLine = responses.find((r) => r.kind === 'hold_line' && r.createdAt >= callAt && r.createdAt < nextCallAt);
    const answer = output?.followedBy !== undefined
      ? responses.find((r) => r.no === output.followedBy)
      : responses.find((r) => output !== undefined && r.createdAt >= output.at && r.kind !== 'hold_line');
    return {
      tool: asked.tool?.name ?? '',
      callAt,
      resultAt: output?.at,
      holdLineAt: holdLine?.createdAt,
      holdLineHeardAt: holdLine ? firstHeard(world, holdLine.no) : undefined,
      firstAudioAt: world.twilio.frames.find((f) => !f.cleared && f.start >= callAt)?.start,
      answerAudioAt: answer ? firstHeard(world, answer.no) : undefined,
    };
  });
}

const WATCHDOG_KINDS = new Set(['silence_prompt', 'never_heard_goodbye', 'max_duration_wrap']);

function endedBy(world: CallWorld): { by?: 'agent' | 'caller'; at?: number } {
  const { serverClosedAt, callerHungUpAt } = world.twilio;
  if (serverClosedAt !== undefined && (callerHungUpAt === undefined || serverClosedAt <= callerHungUpAt)) {
    return { by: 'agent', at: serverClosedAt };
  }
  if (callerHungUpAt !== undefined) return { by: 'caller', at: callerHungUpAt };
  return {};
}

const writes = (world: CallWorld, table: string): number =>
  world.db.filter((s) => new RegExp(`^INSERT INTO ${table}\\b`, 'i').test(s.sql)).length;

export function observe(world: CallWorld): AudioObservation {
  const ended = endedBy(world);
  return {
    utterances: world.xai.utterances.length,
    outcome: world.outcomes[0]?.outcome,
    endedBy: ended.by,
    endedAt: ended.at,
    neverHeardPrompts: world.event('silence_prompt').map((e) => e.at),
    heardChecks: world.event('silence_check').map((e) => e.at),
    goodbyeAt: world.event('never_heard_hangup')[0]?.at,
    responses: world.xai.responses.map((r) => ({ no: r.no, kind: r.kind, trigger: r.trigger, createdAt: r.createdAt, status: r.status, text: r.text })),
    clears: [...world.twilio.clears],
    marksSent: world.twilio.marksSent.length,
    marksEchoed: world.twilio.marksEchoed.length,
    floor: [...world.floorOutcomes],
    ticketWrites: writes(world, 'tickets'),
    bookingWrites: writes(world, 'bookings'),
    toolCalls: world.xai.functionOutputs.length,
    functionOutputs: world.xai.functionOutputs.map((o) => ({ ...o })),
    clientEvents: world.xai.clientEvents.map((c) => `${c.at} ${c.type}`),
    providerErrors: [...world.xai.errors],
    runtimeErrors: world.logs.filter((line) => line.startsWith('error')).slice(-10).map((line) => line.slice(0, 300)),
    toolTimings: toolTimings(world),
    toolRows: writes(world, 'tool_invocations'),
    toolRowsCompletedAt: world.db.filter((s) => /^UPDATE tool_invocations\b/i.test(s.sql)).map((s) => s.at),
    catalogReads: world.db.filter((s) => /\bFROM scheduling_appointment_types\b/i.test(s.sql)).length,
    finalizedAt: world.finalized[0]?.at,
  };
}

/** Quiet before `at`: since the last agent audio played or the caller last spoke. */
function quietBefore(world: CallWorld, at: number): number {
  const audio = world.twilio.lastAudioEndBefore(at) ?? 0;
  const speech = world.xai.utterances
    .filter((u) => u.startedAt <= at)
    .map((u) => (u.stoppedAt !== undefined && u.stoppedAt <= at ? u.stoppedAt : at))
    .reduce((a, b) => Math.max(a, b), 0);
  return at - Math.max(audio, speech);
}

function inRange(value: number, range: Range): boolean {
  return value >= range.min && value <= range.max;
}

export function grade(scenario: AudioScenario, world: CallWorld): AudioCheckFailure[] {
  const e = scenario.expect;
  const obs = observe(world);
  const failures: AudioCheckFailure[] = [];
  const check = (key: string, ok: boolean, message: string, expected?: unknown, actual?: unknown) => {
    if (!ok) failures.push({ key, message, expected, actual });
  };

  if (e.utterances !== undefined) {
    check('vad.utterances', obs.utterances === e.utterances, 'caller utterances the provider VAD detected', e.utterances, obs.utterances);
  }
  if (e.outcome !== undefined) check('outcome', obs.outcome === e.outcome, 'recorded call outcome', e.outcome, obs.outcome ?? null);
  if (e.endedBy !== undefined) {
    check('ended_by', obs.endedBy === e.endedBy, 'who ended the call', e.endedBy, obs.endedBy ? `${obs.endedBy} at ${obs.endedAt} ms` : null);
  }
  if (e.neverHeardPrompts !== undefined) {
    check('ladder.never_heard_prompts', obs.neverHeardPrompts.length === e.neverHeardPrompts, 'never-heard prompts', e.neverHeardPrompts, obs.neverHeardPrompts.length);
  }
  if (e.promptSpacingMs) {
    const gaps = [...obs.neverHeardPrompts, ...(obs.goodbyeAt !== undefined ? [obs.goodbyeAt] : [])].map((at) => quietBefore(world, at));
    const bad = gaps.filter((gap) => !inRange(gap, e.promptSpacingMs as Range));
    check('ladder.prompt_spacing', gaps.length > 0 && bad.length === 0, 'quiet before each never-heard prompt and the goodbye (ms)', e.promptSpacingMs, gaps);
  }
  if (e.goodbyePlayed !== undefined) {
    const goodbye = world.xai.responses.find((r) => r.kind === 'never_heard_goodbye');
    const frames = goodbye ? world.twilio.frames.filter((f) => f.response === goodbye.no && !f.cleared) : [];
    const heardMs = frames.reduce((sum, f) => sum + (f.end - f.start), 0);
    const lastEnd = frames.reduce((max, f) => Math.max(max, f.end), 0);
    const lengthMs = goodbye ? goodbye.frames * FRAME_MS : 0;
    const played = goodbye !== undefined && heardMs >= lengthMs && lastEnd <= (obs.endedAt ?? Infinity);
    check('ladder.goodbye_played', played === e.goodbyePlayed, 'goodbye played in full before the hang-up', e.goodbyePlayed, goodbye ? { heardMs, lengthMs, endedAt: obs.endedAt } : 'no goodbye');
  }
  if (e.heardChecks !== undefined) {
    check('ladder.heard_checks', obs.heardChecks.length === e.heardChecks, 'heard-caller "are you still there?" checks', e.heardChecks, obs.heardChecks.length);
  }
  if (e.heardCheckAfterMs) {
    const gaps = obs.heardChecks.map((at) => quietBefore(world, at));
    check('ladder.heard_check_after', gaps.every((gap) => inRange(gap, e.heardCheckAfterMs as Range)), 'quiet before each heard-caller check (ms)', e.heardCheckAfterMs, gaps);
  }
  if (e.stillUpAtMs !== undefined) {
    const cutAt = obs.endedBy === 'agent' ? obs.endedAt : undefined;
    check('call.not_cut', cutAt === undefined || cutAt >= e.stillUpAtMs, 'call still up (not hung up by the agent) at this point (ms)', e.stillUpAtMs, cutAt ?? 'not cut');
  }
  if (e.floor !== undefined) {
    const filed = obs.floor.includes('filed');
    check('floor', (e.floor === 'filed') === filed && obs.floor.length > 0, 'hangup floor', e.floor, obs.floor);
  }
  if (e.tickets !== undefined) check('db.tickets', obs.ticketWrites === e.tickets, 'ticket rows written', e.tickets, obs.ticketWrites);
  if (e.bookings !== undefined) check('db.bookings', obs.bookingWrites === e.bookings, 'booking rows written', e.bookings, obs.bookingWrites);
  if (e.toolCalls !== undefined) check('tools.calls', obs.toolCalls === e.toolCalls, 'tool calls the runtime ran', e.toolCalls, obs.toolCalls);
  if (e.toolResultsVoiced !== undefined) {
    const voiced = world.xai.responses.filter((r) => r.kind === 'after_tool').map((r) => {
      const frames = world.twilio.frames.filter((f) => f.response === r.no && !f.cleared);
      const heardMs = frames.reduce((sum, f) => sum + (f.end - f.start), 0);
      const lastEnd = frames.reduce((max, f) => Math.max(max, f.end), 0);
      return { no: r.no, heard: heardMs >= r.frames * FRAME_MS && lastEnd <= (obs.endedAt ?? Infinity), heardMs, createdAt: r.createdAt };
    });
    check(
      'tool_result.voiced',
      voiced.length === e.toolResultsVoiced && voiced.every((v) => v.heard),
      'tool results spoken to the caller (a response of their own, heard in full)',
      e.toolResultsVoiced,
      voiced.map((v) => `resp_${v.no} at ${v.createdAt} ms, heard ${Math.round(v.heardMs)} ms${v.heard ? '' : ' (not in full)'}`),
    );
  }

  if (e.holdLine) failures.push(...gradeHoldLine(scenario, world, obs));
  if (e.noOverlap) {
    const spans = world.xai.responses.map((r) => ({ id: r.id, from: r.createdAt, to: r.doneAt ?? Infinity }));
    const overlaps = spans.flatMap((a, i) => spans.slice(i + 1).filter((b) => b.from < a.to && a.from < b.to).map((b) => `${a.id}+${b.id}`));
    check('responses.overlap', overlaps.length === 0 && obs.providerErrors.length === 0, 'never two responses in flight at once', 'none', [...overlaps, ...obs.providerErrors]);
  }

  if (e.bargeIn || e.lateToolResultDropped !== undefined) failures.push(...gradeBargeIn(scenario, world));
  return failures;
}

function gradeHoldLine(scenario: AudioScenario, world: CallWorld, obs: AudioObservation): AudioCheckFailure[] {
  const e = scenario.expect.holdLine as NonNullable<AudioScenario['expect']['holdLine']>;
  const failures: AudioCheckFailure[] = [];
  const holdLines = world.xai.responses.filter((r) => r.kind === 'hold_line');
  if (holdLines.length !== e.count) {
    failures.push({ key: 'hold_line.count', message: 'hold lines the runtime spoke', expected: e.count, actual: holdLines.map((r) => `${r.id} at ${r.createdAt} ms`) });
  }
  // Each hold line covers the latest tool call before it.
  const covered = holdLines.map((r) => ({ r, timing: [...obs.toolTimings].reverse().find((t) => t.callAt <= r.createdAt) }));
  const late = covered.filter(({ r, timing }) => !timing || (timing.resultAt !== undefined && r.createdAt >= timing.resultAt));
  if (late.length > 0) {
    failures.push({
      key: 'hold_line.after_result',
      message: 'a hold line asked for after its tool result came back (or with no tool call)',
      expected: 'before the result',
      actual: late.map(({ r, timing }) => `${r.id} at ${r.createdAt} ms, result at ${timing?.resultAt ?? 'none'} ms`),
    });
  }
  if (e.requestedAfterToolMs) {
    const range = e.requestedAfterToolMs;
    const gaps = covered.filter(({ timing }) => timing).map(({ r, timing }) => r.createdAt - (timing as ToolTimingObservation).callAt);
    if (!gaps.every((gap) => inRange(gap, range))) {
      failures.push({ key: 'hold_line.timing', message: 'hold line asked for this long after the tool call (ms)', expected: range, actual: gaps });
    }
  }
  const phrase = HOLD_LINE_PHRASES[scenario.lang];
  const wrong = holdLines.filter((r) => {
    const heardMs = world.twilio.frames.filter((f) => f.response === r.no && !f.cleared).reduce((sum, f) => sum + (f.end - f.start), 0);
    return r.text !== phrase || heardMs < r.frames * FRAME_MS;
  });
  if (wrong.length > 0) {
    failures.push({ key: 'hold_line.heard', message: `hold line heard in full, in the call's language ("${phrase}")`, expected: phrase, actual: wrong.map((r) => `${r.id}: "${r.text}" ${r.status}`) });
  }
  return failures;
}

function gradeBargeIn(scenario: AudioScenario, world: CallWorld): AudioCheckFailure[] {
  const failures: AudioCheckFailure[] = [];
  const e = scenario.expect;
  // The barge-in: the first caller utterance that starts while agent audio is playing.
  const barge = world.xai.utterances
    .map((u) => ({ u, response: world.twilio.responseAudibleAt(u.startedAt, true) }))
    .find((x) => x.response !== undefined);
  if (!barge) {
    return [{ key: 'barge_in.happened', message: 'no caller utterance started while agent audio was playing', expected: 'a barge-in', actual: null }];
  }
  const at = barge.u.startedAt;
  const nextUtterance = world.xai.utterances.find((u) => u.index === barge.u.index + 1)?.startedAt ?? Infinity;
  if (e.bargeIn) {
    const within = e.bargeIn.clearWithinMs;
    const clear = world.twilio.clears.find((t) => t >= at && t <= at + within);
    if (clear === undefined) {
      failures.push({ key: 'barge_in.clear', message: `Twilio clear within ${within} ms of speech_started (${at} ms)`, expected: `clear at ${at}..${at + within} ms`, actual: world.twilio.clears });
    }
    const stale = world.twilio.audibleMsAfter(barge.response as number, at + within);
    if (stale > e.bargeIn.staleAudioMs) {
      failures.push({ key: 'barge_in.stale_audio', message: `interrupted turn (response ${barge.response}) still audible after the barge-in (ms)`, expected: `<= ${e.bargeIn.staleAudioMs}`, actual: Math.round(stale) });
    }
    const answers = world.xai.responses.filter((r) => r.createdAt > at && r.createdAt < nextUtterance && !WATCHDOG_KINDS.has(r.kind));
    // Each answer must be the model's reply to the barge-in itself, not a stale line.
    const onTopic = answers.every((r) => r.kind === 'reply' && r.utterance === barge.u.index);
    if (answers.length !== e.bargeIn.answers || !onTopic) {
      failures.push({
        key: 'barge_in.answers',
        message: 'agent responses after the barge-in (each must be the reply to it)',
        expected: `${e.bargeIn.answers} reply to utterance ${barge.u.index}`,
        actual: answers.map((r) => `${r.id} ${r.kind}${r.utterance !== undefined ? ` to utterance ${r.utterance}` : ''} (${r.trigger}) at ${r.createdAt} ms`),
      });
    }
  }
  if (e.lateToolResultDropped !== undefined) {
    const late = world.xai.functionOutputs.filter((o) => {
      const asked = world.xai.responses.find((r) => r.tool?.callId === o.callId);
      return asked !== undefined && asked.createdAt < at && o.at >= at;
    });
    const spoken = late.filter((o) => o.followedBy !== undefined);
    const ok = late.length > 0 && (spoken.length === 0) === e.lateToolResultDropped;
    failures.push(
      ...(ok
        ? []
        : [{
            key: 'barge_in.late_tool_result',
            message: late.length === 0
              ? 'no tool result came back after the barge-in (scenario did not exercise it)'
              : 'a tool result from before the barge-in started its own response',
            expected: 'tool result after barge-in, no response of its own',
            actual: late.map((o) => `${o.callId} at ${o.at} ms → ${o.followedBy ? `resp_${o.followedBy}` : 'no response'}`),
          }]),
    );
  }
  return failures;
}
