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
 *   NEVER_HEARD_PROMPTS in total, then a short goodbye and hang-up.
 * - Everyone: MAX_CALL_DURATION_MS cap, spoken wrap-up, then hang-up.
 *
 * Silence is only counted while the agent is not speaking and no tool is
 * running. Pure: no I/O, timers injectable, effects go through callbacks.
 */

export const HEARD_SILENCE_CHECK_MS = 15_000;
export const HEARD_SILENCE_CHECKS = 1;
export const NEVER_HEARD_PROMPT_INTERVAL_MS = 8_000;
export const NEVER_HEARD_PROMPTS = 3;
export const MAX_CALL_DURATION_MS = 10 * 60_000;
/** Time for the goodbye / wrap-up line to play before the call is closed. */
export const HANGUP_GRACE_MS = 8_000;

// Fixed text only; never caller data. "In the language of the conversation"
// keeps Spanish calls in Spanish.
export const SILENCE_PROMPT_INSTRUCTION =
  'The line has gone quiet. Ask the caller briefly, in the language of the conversation: "Are you still there?" Do not say anything else.';
export const NEVER_HEARD_GOODBYE_INSTRUCTION =
  'You have not been able to hear the caller. Say briefly, in the language of the conversation: "I\'m sorry, I can\'t hear you. Please call back anytime. Goodbye." Do not say anything else.';
export const MAX_DURATION_WRAP_UP_INSTRUCTION =
  'This call has reached its time limit. Say briefly, in the language of the conversation: "I\'m sorry, we\'ve reached the time limit for this call. Please call back if you need anything else. Goodbye." Do not say anything else.';

export type SilenceWatchdogAction = 'silence_check' | 'silence_prompt' | 'never_heard_hangup' | 'max_duration_hangup';
export type SilenceWatchdogEndReason = 'never_heard' | 'max_duration';

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
  /** Called before the goodbye is spoken (e.g. to record the call outcome). */
  onEnding?(reason: SilenceWatchdogEndReason): void;
  /** End the call. Called once, HANGUP_GRACE_MS after the goodbye. */
  hangUp(reason: SilenceWatchdogEndReason): void;
  /** One structured log line + call event per action. */
  onAction?(action: SilenceWatchdogAction, counts: SilenceWatchdogCounts): void;
  timers?: SilenceWatchdogTimers;
}

const defaultTimers: SilenceWatchdogTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class SilenceWatchdog {
  private readonly timers: SilenceWatchdogTimers;
  private started = false;
  private ended = false;
  private heard = false;
  private agentSpeaking = false;
  private toolsRunning = 0;
  /** Heard-caller checks since the last caller/agent activity. */
  private heardChecks = 0;
  private neverHeardPrompts = 0;
  /** The next agent turn is the watchdog's own prompt, not new activity. */
  private ownPromptPending = false;
  private silenceTimer: unknown = null;
  private maxTimer: unknown = null;
  private hangupTimer: unknown = null;

  constructor(private readonly deps: SilenceWatchdogDeps) {
    this.timers = deps.timers ?? defaultTimers;
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
    if (this.ended) return;
    this.heard = true;
    this.heardChecks = 0;
    this.arm();
  }

  /** The agent started a response (speaking). */
  agentTurnStarted(): void {
    this.agentSpeaking = true;
    this.clearSilenceTimer();
    if (this.ownPromptPending) {
      this.ownPromptPending = false;
    } else {
      this.heardChecks = 0;
    }
  }

  /** The agent's response finished (done or cancelled): count silence again. */
  agentTurnEnded(): void {
    this.agentSpeaking = false;
    this.arm();
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
    this.clearSilenceTimer();
    if (this.maxTimer !== null) this.timers.clearTimeout(this.maxTimer);
    if (this.hangupTimer !== null) this.timers.clearTimeout(this.hangupTimer);
    this.maxTimer = null;
    this.hangupTimer = null;
  }

  get isHeard(): boolean {
    return this.heard;
  }

  get counts(): SilenceWatchdogCounts {
    return { heard: this.heard, heardChecks: this.heardChecks, neverHeardPrompts: this.neverHeardPrompts };
  }

  private arm(): void {
    this.clearSilenceTimer();
    if (!this.started || this.ended || this.agentSpeaking || this.toolsRunning > 0) return;
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
    // response pauses the timer and re-arms it when it finishes.
    this.arm();
  }

  private end(reason: SilenceWatchdogEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.clearSilenceTimer();
    if (this.maxTimer !== null) this.timers.clearTimeout(this.maxTimer);
    this.maxTimer = null;
    this.deps.onEnding?.(reason);
    this.deps.onAction?.(reason === 'never_heard' ? 'never_heard_hangup' : 'max_duration_hangup', this.counts);
    this.deps.say(reason === 'never_heard' ? NEVER_HEARD_GOODBYE_INSTRUCTION : MAX_DURATION_WRAP_UP_INSTRUCTION);
    this.hangupTimer = this.timers.setTimeout(() => {
      this.hangupTimer = null;
      this.deps.hangUp(reason);
    }, HANGUP_GRACE_MS);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) this.timers.clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }
}
