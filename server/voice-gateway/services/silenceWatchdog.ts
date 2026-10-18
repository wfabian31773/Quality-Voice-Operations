/**
 * Runtime-owned silence watchdog (VA-15). Runs on every call, for every
 * agent, independent of the ReasoningEngine and its shadow/enforce mode.
 *
 * - "Heard" = the caller produced at least one transcribed line this call.
 *   Once heard, always heard (handoffs keep the same session and watchdog).
 * - Heard caller: after HEARD_SILENCE_CHECK_MS of mutual silence, one
 *   "are you still there?" check. No further prompt until the caller or the
 *   agent speaks again. A heard caller is never hung up on for silence.
 * - Never-heard caller: a prompt every NEVER_HEARD_PROMPT_INTERVAL_MS,
 *   NEVER_HEARD_PROMPTS in total, then a short goodbye and hang-up. If the
 *   caller is heard (or starts speaking) before the hang-up, it is cancelled.
 * - Everyone: MAX_CALL_DURATION_MS cap, spoken wrap-up, then hang-up.
 *
 * Silence is only counted while the agent is not speaking, its audio has
 * finished playing, no tool is running and the caller is not mid-utterance.
 * Pure: no I/O, timers injectable, effects go through callbacks.
 */

export const HEARD_SILENCE_CHECK_MS = 15_000;
export const HEARD_SILENCE_CHECKS = 1;
export const NEVER_HEARD_PROMPT_INTERVAL_MS = 8_000;
export const NEVER_HEARD_PROMPTS = 3;
export const MAX_CALL_DURATION_MS = 10 * 60_000;
/**
 * Time for the goodbye / wrap-up line to play before the call is closed.
 * 'response_done' mode: counted from sending the goodbye. 'twilio_mark' mode:
 * the fallback when the goodbye's playback echo never arrives, counted from
 * the goodbye's response.done.
 */
export const HANGUP_GRACE_MS = 8_000;
/**
 * 'twilio_mark' mode: re-arm anyway if Twilio has not echoed the turn's mark
 * this long after response.done. The model streams audio faster than real
 * time, so at response.done Twilio holds at most the whole turn's audio; a
 * long agent turn (~50 words) plays in 15-20 s. 20 s covers nearly every
 * turn, and a lost echo still gets a prompt within 20 s + the silence window.
 */
export const PLAYBACK_ECHO_FALLBACK_MS = 20_000;
/** 'twilio_mark' mode: pause after the goodbye's playback echo before closing. */
export const HANGUP_PLAYBACK_PAD_MS = 1_500;
/**
 * 'twilio_mark' mode: hard ceiling from sending the goodbye to the hang-up,
 * in case the goodbye is never produced or played (model latency + stream,
 * then the grace).
 */
export const HANGUP_CEILING_MS = PLAYBACK_ECHO_FALLBACK_MS + HANGUP_GRACE_MS;
/**
 * Caller speech (server VAD speech_started) pauses the watchdog until
 * speech_stopped. If speech_stopped is lost (or line noise holds VAD open),
 * re-arm after this long. Server VAD ends a turn after 500 ms of silence, so
 * one real utterance this long is very rare on a receptionist line.
 */
export const CALLER_SPEECH_MAX_PAUSE_MS = 45_000;

// Fixed text only; never caller data. "In the language of the conversation"
// keeps Spanish calls in Spanish.
export const SILENCE_PROMPT_INSTRUCTION =
  'The line has gone quiet. Ask the caller briefly, in the language of the conversation: "Are you still there?" Do not say anything else.';
export const NEVER_HEARD_GOODBYE_INSTRUCTION =
  'You have not been able to hear the caller. Say briefly, in the language of the conversation: "I\'m sorry, I can\'t hear you. Please call back anytime. Goodbye." Do not say anything else.';
export const MAX_DURATION_WRAP_UP_INSTRUCTION =
  'This call has reached its time limit. Say briefly, in the language of the conversation: "I\'m sorry, we\'ve reached the time limit for this call. Please call back if you need anything else. Goodbye." Do not say anything else.';

export type SilenceWatchdogAction =
  | 'silence_check'
  | 'silence_prompt'
  | 'never_heard_hangup'
  | 'never_heard_hangup_cancelled'
  | 'max_duration_hangup';
export type SilenceWatchdogEndReason = 'never_heard' | 'max_duration';
/**
 * When an agent turn counts as finished for silence purposes:
 * - 'response_done': at the model's response.done (transports without
 *   playback marks, e.g. the browser widget);
 * - 'twilio_mark': when the transport confirms playback finished
 *   (agentPlaybackDone(), Twilio `mark` echo), with PLAYBACK_ECHO_FALLBACK_MS.
 */
export type PlaybackConfirmMode = 'twilio_mark' | 'response_done';

/** Counts only: no transcript text, names or numbers. */
export interface SilenceWatchdogCounts {
  heard: boolean;
  heardChecks: number;
  neverHeardPrompts: number;
}

export interface SilenceWatchdogTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SilenceWatchdogDeps {
  /** Speak a fixed model instruction (prompt, goodbye or wrap-up). */
  say(instruction: string): void;
  /**
   * Record the call outcome. max_duration: when the wrap-up is sent.
   * never_heard: right before hangUp, so a call that continues never has it.
   */
  onEnding?(reason: SilenceWatchdogEndReason): void;
  /** End the call. Called at most once, after the goodbye has played. */
  hangUp(reason: SilenceWatchdogEndReason): void;
  /** One structured log line + call event per action. */
  onAction?(action: SilenceWatchdogAction, counts: SilenceWatchdogCounts): void;
  /** 'twilio_mark' mode: no playback echo arrived in time; re-armed anyway. */
  onPlaybackFallback?(counts: SilenceWatchdogCounts): void;
  /** Default 'response_done'. */
  playbackConfirm?: PlaybackConfirmMode;
  timers?: SilenceWatchdogTimers;
}

const defaultTimers: SilenceWatchdogTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class SilenceWatchdog {
  private readonly timers: SilenceWatchdogTimers;
  private readonly playbackConfirm: PlaybackConfirmMode;
  private started = false;
  private ended = false;
  private endReason: SilenceWatchdogEndReason | null = null;
  /** The goodbye / wrap-up response has started (first agent turn after end). */
  private goodbyeStarted = false;
  private hungUp = false;
  private heard = false;
  private agentSpeaking = false;
  /** 'twilio_mark': the last agent turn's audio may still be playing. */
  private awaitingPlayback = false;
  private callerSpeaking = false;
  private toolsRunning = 0;
  /** Heard-caller checks since the last caller/agent activity. */
  private heardChecks = 0;
  private neverHeardPrompts = 0;
  /** The next agent turn is the watchdog's own prompt, not new activity. */
  private ownPromptPending = false;
  private silenceTimer: unknown = null;
  private maxTimer: unknown = null;
  private hangupTimer: unknown = null;
  private playbackTimer: unknown = null;
  private speechTimer: unknown = null;

  constructor(private readonly deps: SilenceWatchdogDeps) {
    this.timers = deps.timers ?? defaultTimers;
    this.playbackConfirm = deps.playbackConfirm ?? 'response_done';
  }

  /** Session is live (socket open): start the max-duration cap and arm. */
  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.maxTimer = this.timers.setTimeout(() => this.end('max_duration'), MAX_CALL_DURATION_MS);
    this.arm();
  }

  /** A non-empty caller transcript arrived. */
  callerHeard(): void {
    if (this.ended && !this.cancelNeverHeardHangUp()) return;
    this.heard = true;
    this.heardChecks = 0;
    this.arm();
  }

  /**
   * Server VAD: the caller started speaking. Pauses the watchdog and cancels
   * a pending never-heard hang-up, but does not mark the caller heard; that
   * needs a transcript.
   */
  callerSpeechStarted(): void {
    if (this.ended && !this.cancelNeverHeardHangUp()) return;
    this.callerSpeaking = true;
    this.clearSilenceTimer();
    this.clearTimer('speechTimer');
    this.speechTimer = this.timers.setTimeout(() => {
      this.speechTimer = null;
      this.callerSpeechStopped();
    }, CALLER_SPEECH_MAX_PAUSE_MS);
  }

  /** Server VAD: the caller stopped speaking. Count silence again. */
  callerSpeechStopped(): void {
    this.callerSpeaking = false;
    this.clearTimer('speechTimer');
    this.arm();
  }

  /** The agent started a response (speaking). */
  agentTurnStarted(): void {
    this.agentSpeaking = true;
    this.awaitingPlayback = false;
    this.clearTimer('playbackTimer');
    this.clearSilenceTimer();
    if (this.ended) this.goodbyeStarted = true;
    if (this.ownPromptPending) {
      this.ownPromptPending = false;
    } else {
      this.heardChecks = 0;
    }
  }

  /**
   * The agent's response finished (done or cancelled). 'response_done' mode:
   * count silence again now. 'twilio_mark' mode: wait for agentPlaybackDone().
   */
  agentTurnEnded(): void {
    this.agentSpeaking = false;
    if (this.hungUp) return;
    if (this.playbackConfirm === 'response_done') {
      this.onPlaybackConfirmed();
      return;
    }
    this.awaitingPlayback = true;
    this.clearTimer('playbackTimer');
    const endingTurn = this.ended && this.goodbyeStarted;
    this.playbackTimer = this.timers.setTimeout(() => {
      this.playbackTimer = null;
      if (!this.awaitingPlayback) return;
      this.deps.onPlaybackFallback?.(this.counts);
      // The goodbye has had HANGUP_GRACE_MS since it was fully sent.
      if (endingTurn) this.hangUpNow();
      else this.onPlaybackConfirmed();
    }, endingTurn ? HANGUP_GRACE_MS : PLAYBACK_ECHO_FALLBACK_MS);
  }

  /**
   * 'twilio_mark' mode: the transport confirmed the latest agent turn's audio
   * finished playing. Returns false if no playback was pending.
   */
  agentPlaybackDone(): boolean {
    if (!this.awaitingPlayback) return false;
    this.clearTimer('playbackTimer');
    this.onPlaybackConfirmed();
    return true;
  }

  toolStarted(): void {
    this.toolsRunning += 1;
    this.clearSilenceTimer();
  }

  toolEnded(): void {
    this.toolsRunning = Math.max(0, this.toolsRunning - 1);
    this.arm();
  }

  /** Session closed / cleaned up: clear every timer, never act again. */
  stop(): void {
    this.ended = true;
    this.hungUp = true;
    this.clearSilenceTimer();
    this.clearTimer('maxTimer');
    this.clearTimer('hangupTimer');
    this.clearTimer('playbackTimer');
    this.clearTimer('speechTimer');
  }

  get isHeard(): boolean {
    return this.heard;
  }

  get counts(): SilenceWatchdogCounts {
    return { heard: this.heard, heardChecks: this.heardChecks, neverHeardPrompts: this.neverHeardPrompts };
  }

  private onPlaybackConfirmed(): void {
    this.awaitingPlayback = false;
    if (!this.ended) {
      this.arm();
      return;
    }
    // The goodbye finished playing: close shortly after. In 'response_done'
    // mode the HANGUP_GRACE_MS timer from end() stays in charge.
    if (this.playbackConfirm === 'twilio_mark' && this.goodbyeStarted && this.hangupTimer !== null) {
      this.clearTimer('hangupTimer');
      this.hangupTimer = this.timers.setTimeout(() => this.hangUpNow(), HANGUP_PLAYBACK_PAD_MS);
    }
  }

  private arm(): void {
    this.clearSilenceTimer();
    if (!this.started || this.ended || this.agentSpeaking || this.awaitingPlayback) return;
    if (this.toolsRunning > 0 || this.callerSpeaking) return;
    if (this.heard) {
      if (this.heardChecks >= HEARD_SILENCE_CHECKS) return;
      this.silenceTimer = this.timers.setTimeout(() => this.onHeardSilence(), HEARD_SILENCE_CHECK_MS);
    } else {
      this.silenceTimer = this.timers.setTimeout(() => this.onNeverHeardSilence(), NEVER_HEARD_PROMPT_INTERVAL_MS);
    }
  }

  private onHeardSilence(): void {
    this.silenceTimer = null;
    if (this.ended) return;
    this.heardChecks += 1;
    this.prompt('silence_check');
  }

  private onNeverHeardSilence(): void {
    this.silenceTimer = null;
    if (this.ended) return;
    if (this.neverHeardPrompts >= NEVER_HEARD_PROMPTS) {
      this.end('never_heard');
      return;
    }
    this.neverHeardPrompts += 1;
    this.prompt('silence_prompt');
  }

  private prompt(action: 'silence_check' | 'silence_prompt'): void {
    this.ownPromptPending = true;
    this.deps.onAction?.(action, this.counts);
    this.deps.say(SILENCE_PROMPT_INSTRUCTION);
    // Re-armed now in case the model never answers; the prompt's own
    // response pauses the timer and re-arms it when it finishes playing.
    this.arm();
  }

  private end(reason: SilenceWatchdogEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    this.goodbyeStarted = false;
    this.clearSilenceTimer();
    // never_heard can still be cancelled (caller heard in the grace), so the
    // max-duration cap keeps running for it.
    if (reason === 'max_duration') {
      this.clearTimer('maxTimer');
      this.deps.onEnding?.(reason);
    }
    this.deps.onAction?.(reason === 'never_heard' ? 'never_heard_hangup' : 'max_duration_hangup', this.counts);
    this.deps.say(reason === 'never_heard' ? NEVER_HEARD_GOODBYE_INSTRUCTION : MAX_DURATION_WRAP_UP_INSTRUCTION);
    this.hangupTimer = this.timers.setTimeout(
      () => this.hangUpNow(),
      this.playbackConfirm === 'twilio_mark' ? HANGUP_CEILING_MS : HANGUP_GRACE_MS,
    );
  }

  private hangUpNow(): void {
    if (this.hungUp || this.endReason === null) return;
    this.hungUp = true;
    const reason = this.endReason;
    this.clearTimer('hangupTimer');
    this.clearTimer('playbackTimer');
    if (reason === 'never_heard') {
      this.clearTimer('maxTimer');
      this.deps.onEnding?.(reason);
    }
    this.deps.hangUp(reason);
  }

  /**
   * Caller activity during the never-heard goodbye grace: cancel the hang-up
   * and resume the call. Returns true if it was cancelled.
   */
  private cancelNeverHeardHangUp(): boolean {
    if (this.endReason !== 'never_heard' || this.hungUp || this.hangupTimer === null) return false;
    this.clearTimer('hangupTimer');
    this.clearTimer('playbackTimer');
    this.ended = false;
    this.endReason = null;
    this.goodbyeStarted = false;
    this.awaitingPlayback = false;
    this.deps.onAction?.('never_heard_hangup_cancelled', this.counts);
    return true;
  }

  private clearSilenceTimer(): void {
    this.clearTimer('silenceTimer');
  }

  private clearTimer(name: 'silenceTimer' | 'maxTimer' | 'hangupTimer' | 'playbackTimer' | 'speechTimer'): void {
    if (this[name] !== null) this.timers.clearTimeout(this[name]);
    this[name] = null;
  }
}
