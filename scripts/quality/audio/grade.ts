/**
 * Graders for an audio run, on end state: the recorded call outcome, the
 * floor and database writes, the watchdog's call events, what the gateway
 * sent Twilio (`clear`, `mark`, media) and what the caller actually heard
 * (the fake Twilio playback buffer). Each failure carries a stable key; an
 * expectedFail scenario pins the exact keys that must fail.
 */
import type { CheckFailure } from '../types';
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

  if (e.bargeIn || e.lateToolResultDropped !== undefined) failures.push(...gradeBargeIn(scenario, world));
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
