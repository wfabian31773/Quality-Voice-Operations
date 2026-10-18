import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALLER_SPEECH_MAX_PAUSE_MS,
  HANGUP_CEILING_MS,
  HANGUP_GRACE_MS,
  HANGUP_PLAYBACK_PAD_MS,
  HEARD_SILENCE_CHECK_MS,
  PLAYBACK_ECHO_FALLBACK_MS,
  type PlaybackConfirmMode,
  MAX_CALL_DURATION_MS,
  MAX_DURATION_WRAP_UP_INSTRUCTION,
  NEVER_HEARD_GOODBYE_INSTRUCTION,
  NEVER_HEARD_PROMPT_INTERVAL_MS,
  NEVER_HEARD_PROMPTS,
  SILENCE_PROMPT_INSTRUCTION,
  SilenceWatchdog,
  type SilenceWatchdogAction,
  type SilenceWatchdogEndReason,
  VAD_HEARD_MIN_SPEECH_MS,
} from './silenceWatchdog';

function makeWatchdog(opts: PlaybackConfirmMode | { playbackConfirm?: PlaybackConfirmMode; vadSilenceDurationMs?: number } = {}) {
  const { playbackConfirm, vadSilenceDurationMs } = typeof opts === 'string' ? { playbackConfirm: opts, vadSilenceDurationMs: undefined } : opts;
  const said: string[] = [];
  const actions: SilenceWatchdogAction[] = [];
  const endings: SilenceWatchdogEndReason[] = [];
  const hangUps: SilenceWatchdogEndReason[] = [];
  let playbackFallbacks = 0;
  let bargeIns = 0;
  const watchdog = new SilenceWatchdog({
    say: (instruction) => said.push(instruction),
    onEnding: (reason) => endings.push(reason),
    hangUp: (reason) => hangUps.push(reason),
    onAction: (action) => actions.push(action),
    onPlaybackFallback: () => { playbackFallbacks += 1; },
    onBargeIn: () => { bargeIns += 1; },
    playbackConfirm,
    vadSilenceDurationMs,
  });
  const prompts = () => said.filter((s) => s === SILENCE_PROMPT_INSTRUCTION).length;
  // The model answering an instruction: one agent turn.
  const agentTurn = () => {
    watchdog.agentTurnStarted();
    watchdog.agentTurnEnded();
  };
  return {
    watchdog, said, actions, endings, hangUps, prompts, agentTurn,
    playbackFallbacks: () => playbackFallbacks,
    bargeIns: () => bargeIns,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SilenceWatchdog', () => {
  it('never-heard caller: 3 prompts ~8 s apart, then goodbye and hang-up with outcome never_heard', () => {
    const { watchdog, said, actions, endings, hangUps, prompts } = makeWatchdog();
    watchdog.start();

    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS - 1);
    expect(prompts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(prompts()).toBe(1);
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(prompts()).toBe(2);
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(prompts()).toBe(NEVER_HEARD_PROMPTS);
    expect(hangUps).toEqual([]);

    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(said[said.length - 1]).toBe(NEVER_HEARD_GOODBYE_INSTRUCTION);
    // The outcome is only recorded at the actual hang-up.
    expect(endings).toEqual([]);
    expect(hangUps).toEqual([]);

    vi.advanceTimersByTime(HANGUP_GRACE_MS);
    expect(endings).toEqual(['never_heard']);
    expect(hangUps).toEqual(['never_heard']);
    expect(actions).toEqual(['silence_prompt', 'silence_prompt', 'silence_prompt', 'never_heard_hangup']);

    // Nothing after the hang-up.
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS);
    expect(prompts()).toBe(NEVER_HEARD_PROMPTS);
    expect(hangUps).toEqual(['never_heard']);
  });

  it('never-heard: the 8 s count restarts after each prompt is spoken, and agent turns do not reset the 3-prompt budget', () => {
    const { watchdog, hangUps, prompts, agentTurn } = makeWatchdog();
    watchdog.start();
    for (let i = 1; i <= NEVER_HEARD_PROMPTS; i += 1) {
      vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
      expect(prompts()).toBe(i);
      watchdog.agentTurnStarted();
      vi.advanceTimersByTime(5_000); // prompt playing: not silence
      watchdog.agentTurnEnded();
    }
    agentTurn(); // some other agent line: still never heard
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS + HANGUP_GRACE_MS);
    expect(hangUps).toEqual(['never_heard']);
  });

  it('heard caller is never cut: one check after 15 s, then 5+ minutes of silence gives no hang-up and no more prompts', () => {
    const { watchdog, actions, hangUps, prompts, agentTurn } = makeWatchdog();
    watchdog.start();
    watchdog.callerHeard();

    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS - 1);
    expect(prompts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(prompts()).toBe(1);
    expect(actions).toEqual(['silence_check']);

    agentTurn(); // the check itself being spoken does not re-open the budget
    vi.advanceTimersByTime(6 * 60_000);
    expect(prompts()).toBe(1);
    expect(hangUps).toEqual([]);
    expect(actions).toEqual(['silence_check']);
  });

  it('heard caller: the single check is available again after the caller or agent speaks', () => {
    const { watchdog, prompts, agentTurn } = makeWatchdog();
    watchdog.start();
    watchdog.callerHeard();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    agentTurn(); // the check's own response
    expect(prompts()).toBe(1);

    watchdog.callerHeard(); // caller answers
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    agentTurn();
    expect(prompts()).toBe(2);

    agentTurn(); // a real agent turn (e.g. after a tool result)
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    expect(prompts()).toBe(3);
  });

  it('heard stays heard: a later agent turn never puts the caller back on the never-heard ladder', () => {
    const { watchdog, hangUps, prompts, agentTurn } = makeWatchdog();
    watchdog.start();
    watchdog.callerHeard();
    agentTurn();
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS * 4);
    expect(prompts()).toBe(1);
    expect(hangUps).toEqual([]);
  });

  it('re-arm after the greeting: silence is counted from the end of the greeting turn and from each agent turn', () => {
    const { watchdog, prompts } = makeWatchdog();
    watchdog.start();
    watchdog.agentTurnStarted(); // greeting starts right away
    vi.advanceTimersByTime(20_000); // a long greeting is not silence
    expect(prompts()).toBe(0);
    watchdog.agentTurnEnded(); // greeting done: timer starts here
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS - 1);
    expect(prompts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(prompts()).toBe(1);

    // Caller speaks, then the agent answers: the next check counts from the end of that turn.
    watchdog.callerHeard();
    vi.advanceTimersByTime(10_000);
    watchdog.agentTurnStarted();
    vi.advanceTimersByTime(10_000);
    watchdog.agentTurnEnded();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS - 1);
    expect(prompts()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(prompts()).toBe(2);
  });

  it('does not count silence while a tool is running', () => {
    const { watchdog, prompts } = makeWatchdog();
    watchdog.start();
    watchdog.callerHeard();
    watchdog.toolStarted();
    vi.advanceTimersByTime(60_000);
    expect(prompts()).toBe(0);
    watchdog.toolEnded();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    expect(prompts()).toBe(1);
  });

  it('is not armed before start (session not open yet)', () => {
    const { watchdog, said } = makeWatchdog();
    watchdog.callerHeard();
    watchdog.agentTurnEnded();
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS + HANGUP_GRACE_MS);
    expect(said).toEqual([]);
  });

  it('max cap: wrap-up and hang-up at 10 min with outcome max_duration, even for a heard caller', () => {
    const { watchdog, said, actions, endings, hangUps, agentTurn } = makeWatchdog();
    watchdog.start();
    // A heard caller who keeps talking: never silent for 15 s.
    for (let t = 0; t < MAX_CALL_DURATION_MS - 10_000; t += 10_000) {
      watchdog.callerHeard();
      agentTurn();
      vi.advanceTimersByTime(10_000);
    }
    expect(endings).toEqual([]);
    watchdog.callerHeard();
    vi.advanceTimersByTime(10_000);
    expect(endings).toEqual(['max_duration']);
    expect(said[said.length - 1]).toBe(MAX_DURATION_WRAP_UP_INSTRUCTION);
    expect(actions).toEqual(['max_duration_hangup']);
    expect(hangUps).toEqual([]);
    vi.advanceTimersByTime(HANGUP_GRACE_MS);
    expect(hangUps).toEqual(['max_duration']);
  });

  it('stop() clears every timer: no prompt, goodbye or hang-up after close', () => {
    const { watchdog, said, hangUps } = makeWatchdog();
    watchdog.start();
    watchdog.stop();
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS + HANGUP_GRACE_MS);
    expect(said).toEqual([]);
    expect(hangUps).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() during the goodbye grace cancels the pending hang-up', () => {
    const { watchdog, hangUps } = makeWatchdog();
    watchdog.start();
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS * (NEVER_HEARD_PROMPTS + 1));
    watchdog.stop(); // caller hung up during the goodbye
    vi.advanceTimersByTime(HANGUP_GRACE_MS);
    expect(hangUps).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses only fixed instruction text', () => {
    for (const text of [SILENCE_PROMPT_INSTRUCTION, NEVER_HEARD_GOODBYE_INSTRUCTION, MAX_DURATION_WRAP_UP_INSTRUCTION]) {
      expect(text).not.toMatch(/\$\{|\d{4}/);
    }
    expect(SILENCE_PROMPT_INSTRUCTION).toContain('Are you still there?');
  });
});

/** Runs the 3-prompt ladder up to the goodbye; each prompt is spoken (and played). */
function runNeverHeardLadder(
  w: ReturnType<typeof makeWatchdog>,
  played: () => void = () => {},
) {
  for (let i = 1; i <= NEVER_HEARD_PROMPTS; i += 1) {
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    w.agentTurn();
    played();
  }
  vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
  expect(w.said.at(-1)).toBe(NEVER_HEARD_GOODBYE_INSTRUCTION);
}

describe('SilenceWatchdog: the runtime hold line (RT-HOLD-LINE) is not conversation', () => {
  it('a hold-line turn pauses silence but resets no check count: the heard ladder is unchanged', () => {
    const { watchdog, prompts, agentTurn } = makeWatchdog();
    watchdog.start();
    watchdog.callerHeard();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    expect(prompts()).toBe(1);
    agentTurn(); // the check is spoken; the caller stays quiet
    watchdog.toolStarted();
    watchdog.agentTurnStarted(false); // "One moment while I check that."
    vi.advanceTimersByTime(2_000);
    watchdog.agentTurnEnded();
    watchdog.toolEnded();
    vi.advanceTimersByTime(5 * 60_000);
    expect(prompts()).toBe(1);
  });
});

describe('SilenceWatchdog: caller heard during the never-heard goodbye (P1-2)', () => {
  it('never-heard → goodbye → caller heard within the grace: no hang-up, no outcome, back on the heard path', () => {
    const w = makeWatchdog();
    w.watchdog.start();
    runNeverHeardLadder(w);
    w.agentTurn(); // the goodbye plays
    vi.advanceTimersByTime(HANGUP_GRACE_MS - 1_000);

    w.watchdog.callerHeard(); // "Hello? Yes, I'm here"
    vi.advanceTimersByTime(HANGUP_GRACE_MS);
    expect(w.hangUps).toEqual([]);
    expect(w.endings).toEqual([]);
    expect(w.actions.at(-1)).toBe('never_heard_hangup_cancelled');
    expect(w.watchdog.isHeard).toBe(true);

    // Later silence: the single heard check, never a hang-up.
    const before = w.prompts();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS - HANGUP_GRACE_MS);
    expect(w.prompts()).toBe(before + 1);
    w.agentTurn();
    vi.advanceTimersByTime(5 * 60_000);
    expect(w.prompts()).toBe(before + 1);
    expect(w.hangUps).toEqual([]);
  });

  it('the max-duration cap keeps running after a cancelled never-heard goodbye', () => {
    const w = makeWatchdog();
    w.watchdog.start();
    runNeverHeardLadder(w);
    w.watchdog.callerHeard();
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS);
    expect(w.endings).toEqual(['max_duration']);
    vi.advanceTimersByTime(HANGUP_GRACE_MS);
    expect(w.hangUps).toEqual(['max_duration']);
  });
});

describe('SilenceWatchdog: caller speech (server VAD) pauses the timers', () => {
  it('a caller speaking for 30 s gets no prompt and no hang-up; speech_stopped re-arms (heard: the 15 s check)', () => {
    const w = makeWatchdog();
    w.watchdog.start();
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS - 2_000);
    w.watchdog.callerSpeechStarted();
    vi.advanceTimersByTime(30_000);
    expect(w.prompts()).toBe(0);
    expect(w.hangUps).toEqual([]);

    w.watchdog.callerSpeechStopped(); // no transcript, but audible: heard
    expect(w.watchdog.isHeard).toBe(true);
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS - 1);
    expect(w.prompts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(w.prompts()).toBe(1);
  });

  it('a long utterance cannot run the ladder down to a hang-up', () => {
    const w = makeWatchdog();
    w.watchdog.start();
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    w.agentTurn();
    w.watchdog.callerSpeechStarted();
    vi.advanceTimersByTime(CALLER_SPEECH_MAX_PAUSE_MS - 1);
    expect(w.prompts()).toBe(1);
    expect(w.hangUps).toEqual([]);
  });

  it('a missing speech_stopped never pauses the watchdog forever (CALLER_SPEECH_MAX_PAUSE_MS), and is not "heard"', () => {
    const w = makeWatchdog();
    w.watchdog.start();
    w.watchdog.callerSpeechStarted();
    vi.advanceTimersByTime(CALLER_SPEECH_MAX_PAUSE_MS);
    expect(w.prompts()).toBe(0);
    expect(w.watchdog.isHeard).toBe(false); // noise holding VAD open is not a caller
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(w.prompts()).toBe(1);
  });

  it('a blip during the never-heard goodbye cancels the hang-up without marking the caller heard', () => {
    const w = makeWatchdog();
    w.watchdog.start();
    runNeverHeardLadder(w);
    w.watchdog.callerSpeechStarted();
    vi.advanceTimersByTime(VAD_HEARD_MIN_SPEECH_MS - 100);
    expect(w.hangUps).toEqual([]);
    expect(w.endings).toEqual([]);

    // Too short to be a caller and no transcript: the never-heard ladder resumes from speech_stopped.
    w.watchdog.callerSpeechStopped();
    expect(w.watchdog.isHeard).toBe(false);
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(w.said.filter((s) => s === NEVER_HEARD_GOODBYE_INSTRUCTION)).toHaveLength(2);
    vi.advanceTimersByTime(HANGUP_GRACE_MS);
    expect(w.hangUps).toEqual(['never_heard']);
    expect(w.endings).toEqual(['never_heard']);
  });

  it('a caller audible during the never-heard goodbye is heard: no hang-up, the heard ladder from then on', () => {
    const w = makeWatchdog();
    w.watchdog.start();
    runNeverHeardLadder(w);
    w.watchdog.callerSpeechStarted();
    vi.advanceTimersByTime(1_500); // "Hello? Yes, I'm here", never transcribed
    w.watchdog.callerSpeechStopped();
    expect(w.watchdog.isHeard).toBe(true);
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS - 60_000);
    expect(w.hangUps).toEqual([]);
    expect(w.said.filter((s) => s === NEVER_HEARD_GOODBYE_INSTRUCTION)).toHaveLength(1);
    expect(w.actions.slice(-2)).toEqual(['never_heard_hangup_cancelled', 'silence_check']);
  });
});

describe('SilenceWatchdog: VAD speech marks the caller heard (S17: audible, never transcribed)', () => {
  /** One server-VAD utterance: speech_started, `ms` later speech_stopped. */
  const utter = (w: ReturnType<typeof makeWatchdog>, ms: number) => {
    w.watchdog.callerSpeechStarted();
    vi.advanceTimersByTime(ms);
    w.watchdog.callerSpeechStopped();
  };

  it('VAD_HEARD_MIN_SPEECH_MS is 300 ms', () => {
    expect(VAD_HEARD_MIN_SPEECH_MS).toBe(300);
  });

  it('an utterance of at least the minimum, with no transcript: heard ladder (one check at 15 s, then wait to the cap), no never-heard prompts', () => {
    const w = makeWatchdog();
    w.watchdog.start();
    utter(w, VAD_HEARD_MIN_SPEECH_MS);
    expect(w.watchdog.isHeard).toBe(true);
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    expect(w.actions).toEqual(['silence_check']);
    w.agentTurn(); // the check is spoken
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS - VAD_HEARD_MIN_SPEECH_MS - HEARD_SILENCE_CHECK_MS - 1);
    expect(w.actions).toEqual(['silence_check']);
    expect(w.hangUps).toEqual([]);
    expect(w.endings).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.endings).toEqual(['max_duration']);
  });

  it('dialler noise stays never heard: blips under the minimum never mark heard, the ladder runs to never_heard', () => {
    const w = makeWatchdog();
    w.watchdog.start();
    for (let i = 0; i < 5; i += 1) utter(w, VAD_HEARD_MIN_SPEECH_MS - 1);
    expect(w.watchdog.isHeard).toBe(false);
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS * (NEVER_HEARD_PROMPTS + 1) + HANGUP_GRACE_MS);
    expect(w.prompts()).toBe(NEVER_HEARD_PROMPTS);
    expect(w.hangUps).toEqual(['never_heard']);
    expect(w.endings).toEqual(['never_heard']);
  });

  it("the VAD's trailing silence is not speech: a blip plus silence_duration_ms stays never heard", () => {
    const silenceDurationMs = 500;
    const w = makeWatchdog({ vadSilenceDurationMs: silenceDurationMs });
    w.watchdog.start();
    utter(w, silenceDurationMs + VAD_HEARD_MIN_SPEECH_MS - 1);
    expect(w.watchdog.isHeard).toBe(false);
    utter(w, silenceDurationMs + VAD_HEARD_MIN_SPEECH_MS);
    expect(w.watchdog.isHeard).toBe(true);
  });

  it('a speech_stopped without its speech_started marks nothing', () => {
    const w = makeWatchdog();
    w.watchdog.start();
    vi.advanceTimersByTime(5_000);
    w.watchdog.callerSpeechStopped();
    expect(w.watchdog.isHeard).toBe(false);
  });
});

describe("SilenceWatchdog: barge-in ('twilio_mark')", () => {
  it('caller speech while the last turn is still playing: onBargeIn once, the cleared turn is released, nothing arms until speech_stopped', () => {
    const w = makeWatchdog({ playbackConfirm: 'twilio_mark' });
    w.watchdog.start();
    w.watchdog.callerHeard();
    w.agentTurn(); // streamed (response.done); Twilio still playing it
    w.watchdog.callerSpeechStarted();
    expect(w.bargeIns()).toBe(1);
    w.watchdog.callerSpeechStarted(); // a second speech_started on the same turn: no second clear
    expect(w.bargeIns()).toBe(1);
    // The cleared turn's mark echo finds nothing pending.
    expect(w.watchdog.agentPlaybackDone()).toBe(false);
    // Not early: the caller is talking (even past the echo fallback).
    vi.advanceTimersByTime(PLAYBACK_ECHO_FALLBACK_MS + HEARD_SILENCE_CHECK_MS);
    expect(w.prompts()).toBe(0);
    expect(w.playbackFallbacks()).toBe(0);
    // Not late: silence counts from speech_stopped, not from a fallback.
    w.watchdog.callerSpeechStopped();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS - 1);
    expect(w.prompts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(w.prompts()).toBe(1);
  });

  it('caller speech while the model is still streaming: onBargeIn; the cancelled turn needs no echo to re-arm', () => {
    const w = makeWatchdog({ playbackConfirm: 'twilio_mark' });
    w.watchdog.start();
    w.watchdog.callerHeard();
    w.watchdog.agentTurnStarted();
    w.watchdog.callerSpeechStarted();
    expect(w.bargeIns()).toBe(1);
    w.watchdog.agentTurnEnded(); // response.done (cancelled): its audio was dropped, nothing plays
    expect(w.watchdog.agentPlaybackDone()).toBe(false);
    w.watchdog.callerSpeechStopped();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS);
    expect(w.prompts()).toBe(1);
    expect(w.playbackFallbacks()).toBe(0);
  });

  it('caller speech with no agent audio playing or queued: no barge-in', () => {
    const w = makeWatchdog({ playbackConfirm: 'twilio_mark' });
    w.watchdog.start();
    w.agentTurn();
    w.watchdog.agentPlaybackDone(); // the turn has played
    w.watchdog.callerSpeechStarted();
    w.watchdog.callerSpeechStopped();
    expect(w.bargeIns()).toBe(0);
  });

  it('a new agent turn can be barged in on again', () => {
    const w = makeWatchdog({ playbackConfirm: 'twilio_mark' });
    w.watchdog.start();
    w.agentTurn();
    w.watchdog.callerSpeechStarted();
    w.watchdog.callerSpeechStopped();
    w.agentTurn(); // the answer to the barge-in
    w.watchdog.callerSpeechStarted();
    expect(w.bargeIns()).toBe(2);
  });

  it('caller speech over the never-heard goodbye: the goodbye is cleared and the hang-up cancelled', () => {
    const w = makeWatchdog({ playbackConfirm: 'twilio_mark' });
    w.watchdog.start();
    w.agentTurn();
    w.watchdog.agentPlaybackDone();
    runNeverHeardLadder(w, () => w.watchdog.agentPlaybackDone());
    w.agentTurn(); // the goodbye streamed, still playing
    w.watchdog.callerSpeechStarted();
    expect(w.bargeIns()).toBe(1);
    vi.advanceTimersByTime(HANGUP_CEILING_MS);
    expect(w.hangUps).toEqual([]);
  });
});

describe("SilenceWatchdog: 'twilio_mark' playback confirmation", () => {
  it('does not fire while playback is unconfirmed, even 15 s+ after response.done; fires 8 s / 15 s after the echo', () => {
    const w = makeWatchdog('twilio_mark');
    w.watchdog.start();
    w.agentTurn(); // greeting: response.created + response.done, audio still playing
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS + 1_000);
    expect(w.prompts()).toBe(0);
    expect(w.watchdog.agentPlaybackDone()).toBe(true); // mark echo
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS - 1);
    expect(w.prompts()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(w.prompts()).toBe(1);

    // The prompt's own playback: the next 8 s counts from its echo.
    w.agentTurn();
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS * 2);
    expect(w.prompts()).toBe(1);
    w.watchdog.agentPlaybackDone();
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(w.prompts()).toBe(2);

    // Heard caller: 15 s from the echo of the agent's reply.
    w.watchdog.callerHeard();
    w.agentTurn();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS + 1_000);
    expect(w.prompts()).toBe(2);
    w.watchdog.agentPlaybackDone();
    vi.advanceTimersByTime(HEARD_SILENCE_CHECK_MS - 1);
    expect(w.prompts()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(w.prompts()).toBe(3);
  });

  it('an echo with no playback pending is ignored', () => {
    const w = makeWatchdog('twilio_mark');
    w.watchdog.start();
    expect(w.watchdog.agentPlaybackDone()).toBe(false);
    w.watchdog.agentTurnStarted(); // agent speaking: a late echo must not arm
    expect(w.watchdog.agentPlaybackDone()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(w.prompts()).toBe(0);
  });

  it('re-arms anyway (and logs) when no echo arrives within PLAYBACK_ECHO_FALLBACK_MS', () => {
    const w = makeWatchdog('twilio_mark');
    w.watchdog.start();
    w.agentTurn();
    vi.advanceTimersByTime(PLAYBACK_ECHO_FALLBACK_MS - 1);
    expect(w.playbackFallbacks()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(w.playbackFallbacks()).toBe(1);
    vi.advanceTimersByTime(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(w.prompts()).toBe(1);
  });

  it('goodbye grace starts at the goodbye\'s echo (+ pad), not when it is sent', () => {
    const w = makeWatchdog('twilio_mark');
    w.watchdog.start();
    w.agentTurn();
    w.watchdog.agentPlaybackDone();
    runNeverHeardLadder(w, () => w.watchdog.agentPlaybackDone());
    w.agentTurn(); // goodbye streamed (response.done), still playing
    vi.advanceTimersByTime(HANGUP_GRACE_MS - 1); // a long goodbye is not clipped
    expect(w.hangUps).toEqual([]);
    w.watchdog.agentPlaybackDone(); // goodbye played
    vi.advanceTimersByTime(HANGUP_PLAYBACK_PAD_MS - 1);
    expect(w.hangUps).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.hangUps).toEqual(['never_heard']);
    expect(w.endings).toEqual(['never_heard']);
  });

  it('goodbye with a lost echo: hang-up HANGUP_GRACE_MS after its response.done; never produced: HANGUP_CEILING_MS', () => {
    const lost = makeWatchdog('twilio_mark');
    lost.watchdog.start();
    lost.watchdog.callerHeard(); // heard: only the cap can end the call
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS);
    expect(lost.said.at(-1)).toBe(MAX_DURATION_WRAP_UP_INSTRUCTION);
    lost.agentTurn();
    vi.advanceTimersByTime(HANGUP_GRACE_MS - 1);
    expect(lost.hangUps).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(lost.hangUps).toEqual(['max_duration']);

    const silent = makeWatchdog('twilio_mark');
    silent.watchdog.start();
    silent.watchdog.callerHeard();
    vi.advanceTimersByTime(MAX_CALL_DURATION_MS + HANGUP_CEILING_MS - 1);
    expect(silent.hangUps).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(silent.hangUps).toEqual(['max_duration']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller heard after the goodbye echo but within the pad is not hung up', () => {
    const w = makeWatchdog('twilio_mark');
    w.watchdog.start();
    runNeverHeardLadder(w, () => w.watchdog.agentPlaybackDone());
    w.agentTurn();
    w.watchdog.agentPlaybackDone();
    w.watchdog.callerHeard();
    vi.advanceTimersByTime(HANGUP_CEILING_MS);
    expect(w.hangUps).toEqual([]);
    expect(w.endings).toEqual([]);
  });

  it('stop() clears the playback and speech timers too', () => {
    const w = makeWatchdog('twilio_mark');
    w.watchdog.start();
    w.agentTurn();
    w.watchdog.callerSpeechStarted();
    w.watchdog.stop();
    w.agentTurn();
    expect(vi.getTimerCount()).toBe(0);
  });
});
